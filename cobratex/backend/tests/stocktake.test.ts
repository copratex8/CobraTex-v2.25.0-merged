import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { createStocktake, postStocktake, reverseStocktake, getStocktakeById } from '@/modules/inventory/stocktakeService';
import {
  createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser,
} from './helpers';

async function setupFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId: itemA } = await createBaseItem(stack.companyId);
  const { itemId: itemB } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id IN ($2,$3)`, [categoryId, itemA, itemB]);

  const variance = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5020','فروق الجرد','Inventory Variance','expense') RETURNING id`,
    [stack.companyId],
  );
  await createPostingRule(stack.ctx, {
    operationType: 'inventory_adjustment_increase', debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: variance.rows[0].id,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'inventory_adjustment_decrease', debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: variance.rows[0].id,
    creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });

  // رصيد افتتاحي: صنف A = 100 وحدة بتكلفة 10، صنف B = 50 وحدة بتكلفة 20
  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId: itemA, quantity: '100', unitCost: '10',
    movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });
  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId: itemB, quantity: '50', unitCost: '20',
    movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });

  return { stack, itemA, itemB, fiscalPeriodId };
}

async function getBalance(companyId: string, warehouseId: string, itemId: string) {
  const { rows } = await pool.query(
    `SELECT quantity_on_hand, weighted_average_cost FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NULL`,
    [companyId, warehouseId, itemId],
  );
  return rows[0];
}

describe('الجرد المخزني (Stocktake) — لم يكن له أي مستند إطلاقًا رغم دعم محرك المخزون لأنواعه', () => {
  it('فائض وعجز معًا: الترحيل يصرف/يضيف الكمية الفعلية، ويُنشئ قيدًا متوازنًا، وتُحدَّث الأرصدة', async () => {
    const { stack, itemA, itemB, fiscalPeriodId } = await setupFixture('stk-post');
    const st = await createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [
        { itemId: itemA, countedQuantity: '120' }, // فائض +20
        { itemId: itemB, countedQuantity: '40' }, // عجز -10
      ],
    });
    expect(st.status).toBe('draft');

    const detail = await getStocktakeById(stack.ctx, st.id);
    const lineA = detail.lines.find((l: { item_id: string }) => l.item_id === itemA)!;
    const lineB = detail.lines.find((l: { item_id: string }) => l.item_id === itemB)!;
    expect(Number(lineA.variance_quantity)).toBe(20);
    expect(Number(lineA.system_quantity)).toBe(100);
    expect(Number(lineB.variance_quantity)).toBe(-10);

    const posted = await postStocktake(stack.ctx, st.id);
    expect(posted.adjustedLineCount).toBe(2);

    const balA = await getBalance(stack.companyId, stack.warehouseId, itemA);
    const balB = await getBalance(stack.companyId, stack.warehouseId, itemB);
    expect(Number(balA.quantity_on_hand)).toBe(120);
    expect(Number(balB.quantity_on_hand)).toBe(40);

    const lines = await pool.query(`SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE journal_entry_id=$1`, [posted.journalEntryId]);
    expect(Number(lines.rows[0].d)).toBeCloseTo(Number(lines.rows[0].c), 4);
    expect(Number(lines.rows[0].d)).toBeGreaterThan(0);

    const journal = await pool.query(`SELECT status FROM journal_entries WHERE id=$1`, [posted.journalEntryId]);
    expect(journal.rows[0].status).toBe('posted');
  });

  it('سطر بفرق صفري لا يُنشئ له حركة مخزون ولا يدخل في القيد', async () => {
    const { stack, itemA, itemB, fiscalPeriodId } = await setupFixture('stk-zero-line');
    const st = await createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [
        { itemId: itemA, countedQuantity: '100' }, // مطابق تمامًا — بلا فرق
        { itemId: itemB, countedQuantity: '55' }, // فائض +5
      ],
    });
    const posted = await postStocktake(stack.ctx, st.id);
    expect(posted.adjustedLineCount).toBe(1);
    const balA = await getBalance(stack.companyId, stack.warehouseId, itemA);
    expect(Number(balA.quantity_on_hand)).toBe(100); // لم يتغيَّر
  });

  it('يرفض ترحيل جرد كل أسطره مطابقة تمامًا (لا فرق فعلي إطلاقًا)', async () => {
    const { stack, itemA, fiscalPeriodId } = await setupFixture('stk-all-zero');
    const st = await createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [{ itemId: itemA, countedQuantity: '100' }],
    });
    await expect(postStocktake(stack.ctx, st.id)).rejects.toThrow();
  });

  it('يرفض إنشاء جرد بلا أي سطر، ويرفض كمية معدودة سالبة', async () => {
    const { stack, itemA, fiscalPeriodId } = await setupFixture('stk-validation');
    await expect(createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01', lines: [],
    })).rejects.toThrow();
    await expect(createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [{ itemId: itemA, countedQuantity: '-5' }],
    })).rejects.toThrow();
  });

  it('عكس جرد مرحَّل: يستعيد الأرصدة الأصلية تمامًا (فائض يُصرَف، عجز يُعاد)، ويعكس القيد', async () => {
    const { stack, itemA, itemB, fiscalPeriodId } = await setupFixture('stk-reverse');
    const st = await createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [{ itemId: itemA, countedQuantity: '120' }, { itemId: itemB, countedQuantity: '40' }],
    });
    await postStocktake(stack.ctx, st.id);
    const reversed = await reverseStocktake(stack.ctx, st.id, 'خطأ في العدّ الفعلي');
    expect(reversed.status).toBe('reversed');

    const balA = await getBalance(stack.companyId, stack.warehouseId, itemA);
    const balB = await getBalance(stack.companyId, stack.warehouseId, itemB);
    expect(Number(balA.quantity_on_hand)).toBe(100);
    expect(Number(balB.quantity_on_hand)).toBe(50);

    const detail = await getStocktakeById(stack.ctx, st.id);
    const stRow = await pool.query(`SELECT journal_entry_id FROM stocktakes WHERE id=$1`, [st.id]);
    const journal = await pool.query(`SELECT status FROM journal_entries WHERE id=$1`, [stRow.rows[0].journal_entry_id]);
    expect(journal.rows[0].status).toBe('reversed');
    expect(detail.lines.length).toBeGreaterThan(0);
  });

  it('عكس بلا سبب يُرفض؛ عكس جرد غير مرحَّل (مسودة) يُرفض؛ ترحيل مزدوج يُرفض', async () => {
    const { stack, itemA, fiscalPeriodId } = await setupFixture('stk-lifecycle-guards');
    const st = await createStocktake(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [{ itemId: itemA, countedQuantity: '110' }],
    });
    await expect(reverseStocktake(stack.ctx, st.id, '')).rejects.toThrow();
    await expect(reverseStocktake(stack.ctx, st.id, 'سبب ما')).rejects.toThrow(); // لم يُرحَّل بعد

    await postStocktake(stack.ctx, st.id);
    await expect(postStocktake(stack.ctx, st.id)).rejects.toThrow(); // مرحَّل بالفعل
  });

  it('RBAC: مستخدم بلا inventory.stocktake.create يُرفض عند الإنشاء', async () => {
    const { stack, itemA, fiscalPeriodId } = await setupFixture('stk-rbac');
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    await expect(createStocktake(limited.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [{ itemId: itemA, countedQuantity: '110' }],
    })).rejects.toThrow();
  });

  it('عزل الشركات: جرد شركة A غير مرئي لشركة B (NotFoundError)', async () => {
    const { stack: stack1, itemA, fiscalPeriodId } = await setupFixture('stk-iso-1');
    const { stack: stack2 } = await setupFixture('stk-iso-2');
    const st = await createStocktake(stack1.ctx, {
      branchId: stack1.branchId, warehouseId: stack1.warehouseId, fiscalPeriodId, countDate: '2026-02-01',
      lines: [{ itemId: itemA, countedQuantity: '110' }],
    });
    await expect(getStocktakeById(stack2.ctx, st.id)).rejects.toThrow();
  });
});
