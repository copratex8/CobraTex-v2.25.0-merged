import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser } from './helpers';
import { createBom, createProductionOrder, postProductionOrder, reverseProductionOrder, getProductionOrderById } from '@/modules/manufacturing/manufacturingService';
import { saveOrderCompletion, previewOrderCompletion, reportWaste, reportOrderYield } from '@/modules/manufacturing/textileService';

/**
 * غزل قطن: 1000 كجم قطن × 50 = 50,000 + تحويل 5,000. الهالك القياسي 5% = 50 كجم.
 * هالك فعلي: نويل 40 (قيمة استرداد 30) + كنس 20 + فاقد غير مرئي 10 = 70 → غير عادي 20 كجم.
 * المتوقع (مطابق لاختبار الدوال النقية): استرداد 1,200، خسارة غير عادية 657.1420، تكلفة المخرجات 53,142.8580 لـ 900 كجم.
 */
async function fixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId: rawCat } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const yarnInv = await pool.query(`INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1031','مخزون غزل','Yarn Inventory','asset') RETURNING id`, [stack.companyId]);
  const { categoryId: yarnCat } = await createItemCategoryWithAccounts(stack.companyId, yarnInv.rows[0].id, cogsAccountId);
  const wasteInv = await pool.query(`INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1032','مخزون هالك','Waste Inventory','asset') RETURNING id`, [stack.companyId]);
  const { categoryId: wasteCat } = await createItemCategoryWithAccounts(stack.companyId, wasteInv.rows[0].id, cogsAccountId);
  const wip = await pool.query(`INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1050','تحت التشغيل','WIP','asset') RETURNING id`, [stack.companyId]);
  const absorb = await pool.query(`INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5030','محمَّلة','Absorbed','expense') RETURNING id`, [stack.companyId]);
  const abn = await pool.query(`INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5040','هالك غير عادي','Abnormal','expense') RETURNING id`, [stack.companyId]);
  const W = wip.rows[0].id;
  const rules: Array<[string, any]> = [
    ['manufacturing_consume', { debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: W, creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY' }],
    ['manufacturing_output', { debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: W }],
    ['manufacturing_conversion', { debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: absorb.rows[0].id }],
    ['manufacturing_waste_recovery', { debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: W }],
    ['manufacturing_abnormal_loss', { debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: abn.rows[0].id, creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: W }],
  ];
  for (const [operationType, r] of rules) await createPostingRule(stack.ctx, { operationType, ...r });

  const { itemId: cotton } = await createBaseItem(stack.companyId);
  const { itemId: yarn } = await createBaseItem(stack.companyId);
  const { itemId: noilItem } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [rawCat, cotton]);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [yarnCat, yarn]);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [wasteCat, noilItem]);
  await recordInMovement(stack.ctx, { branchId: stack.branchId, warehouseId: stack.warehouseId, itemId: cotton, quantity: '1000', unitCost: '50', movementDate: '2026-04-01', sourceDocumentType: 'opening' });

  const mk = async (code: string, recoverable: boolean, itemId: string | null, value: string) =>
    (await pool.query(
      `INSERT INTO waste_types(company_id, code, name_ar, name_en, is_recoverable, recovery_item_id, recovery_unit_value) VALUES ($1,$2,$2,$2,$3,$4,$5) RETURNING id`,
      [stack.companyId, code, recoverable, itemId, value])).rows[0].id as string;
  const noilType = await mk('NOIL', true, noilItem, '30');
  const sweepType = await mk('SWEEP', false, null, '0');
  const invisType = await mk('INVIS', false, null, '0');

  const bom = await createBom(stack.ctx, {
    code: 'BOM-SPIN-1', nameAr: 'غزل 30', nameEn: 'Yarn 30s', outputItemId: yarn, outputQuantity: '900',
    lines: [{ componentItemId: cotton, quantity: '1000', isMainMaterial: true }],
    operations: [{ name: 'تشغيل', costType: 'labor', costAmount: '5000' }],
  });
  const order = await createProductionOrder(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, bomId: bom.id, fiscalPeriodId, orderDate: '2026-04-05', plannedOutputQuantity: '900',
  });
  return { stack, cotton, yarn, noilItem, noilType, sweepType, invisType, order, absorbId: absorb.rows[0].id, wipId: W, abnId: abn.rows[0].id };
}

const completion = (f: Awaited<ReturnType<typeof fixture>>) => ({
  standardWastePercent: '5',
  outputs: [{ outputItemId: f.yarn, grade: 'A', quantity: '900' }],
  wastes: [
    { wasteTypeId: f.noilType, quantity: '40' },
    { wasteTypeId: f.sweepType, quantity: '20' },
    { wasteTypeId: f.invisType, quantity: '10' },
  ],
});

describe('الغزل والنسيج: هالك عادي/غير عادي واسترداد الهوالك', () => {
  it('الترحيل: يحسب الهالك غير العادي ويقيّده، ويُدخل النويل للمخزن، ويوزّع التكلفة، والقيد متوازن وحساب WIP صافيه صفر', async () => {
    const f = await fixture('tx-waste');
    await saveOrderCompletion(f.stack.ctx, f.order.id, completion(f));
    const preview = await previewOrderCompletion(f.stack.ctx, f.order.id);
    expect(preview.abnormalLossTotal).toBe('657.1420');

    const posted = await postProductionOrder(f.stack.ctx, f.order.id);
    expect(posted.totalCost).toBe('55000.0000');
    const o = await getProductionOrderById(f.stack.ctx, f.order.id) as any;
    expect(Number(o.abnormal_loss_total)).toBeCloseTo(657.142, 3);
    expect(Number(o.recovered_value_total)).toBeCloseTo(1200, 3);
    expect(Number(o.waste_quantity_total)).toBeCloseTo(70, 3);
    expect(Number(o.outputs[0].line_cost)).toBeCloseTo(53142.858, 3);

    const bal = async (item: string) => (await pool.query(`SELECT quantity_on_hand q, weighted_average_cost c FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND batch_id IS NULL`, [f.stack.companyId, item])).rows[0];
    expect(Number((await bal(f.yarn)).q)).toBe(900);
    expect(Number((await bal(f.noilItem)).q)).toBe(40);
    expect(Number((await bal(f.noilItem)).c)).toBeCloseTo(30, 4);
    expect(Number((await bal(f.cotton)).q)).toBe(0);

    const lines = (await pool.query(`SELECT account_id, sum(debit) d, sum(credit) c FROM journal_entry_lines WHERE journal_entry_id=$1 GROUP BY account_id`, [posted.journalEntryId])).rows;
    const tot = lines.reduce((a, r) => ({ d: a.d + Number(r.d), c: a.c + Number(r.c) }), { d: 0, c: 0 });
    expect(tot.d).toBeCloseTo(tot.c, 4);
    const wip = lines.find((r) => r.account_id === f.wipId);
    expect(Number(wip.d)).toBeCloseTo(Number(wip.c), 3);
    expect(Number(lines.find((r) => r.account_id === f.abnId).d)).toBeCloseTo(657.142, 3);
    expect(Number(lines.find((r) => r.account_id === f.absorbId).c)).toBeCloseTo(5000, 3);

    const rep = await reportOrderYield(f.stack.ctx, f.order.id);
    expect(rep.yieldPercent).toBe('90.000');
    expect(rep.actualWastePercent).toBe('7.000');
    const w = await reportWaste(f.stack.ctx, {});
    expect(w.byType.length).toBe(3);
  });

  it('العكس: يعيد الخامة ويسحب المخرجات والنويل ويعكس القيد', async () => {
    const f = await fixture('tx-reverse');
    await saveOrderCompletion(f.stack.ctx, f.order.id, completion(f));
    await postProductionOrder(f.stack.ctx, f.order.id);
    await reverseProductionOrder(f.stack.ctx, f.order.id, 'اختبار');
    const q = async (item: string) => Number((await pool.query(`SELECT quantity_on_hand q FROM stock_balances WHERE company_id=$1 AND item_id=$2 AND batch_id IS NULL`, [f.stack.companyId, item])).rows[0].q);
    expect(await q(f.cotton)).toBe(1000);
    expect(await q(f.yarn)).toBe(0);
    expect(await q(f.noilItem)).toBe(0);
  });

  it('هالك داخل النسبة القياسية: لا خسارة غير عادية، وتبقى كل التكلفة في المنتج (بعد خصم الاسترداد)', async () => {
    const f = await fixture('tx-normal');
    await saveOrderCompletion(f.stack.ctx, f.order.id, {
      standardWastePercent: '10', outputs: [{ outputItemId: f.yarn, grade: 'A', quantity: '900' }],
      wastes: [{ wasteTypeId: f.noilType, quantity: '40' }, { wasteTypeId: f.sweepType, quantity: '20' }],
    });
    await postProductionOrder(f.stack.ctx, f.order.id);
    const o = await getProductionOrderById(f.stack.ctx, f.order.id) as any;
    expect(Number(o.abnormal_loss_total)).toBe(0);
    expect(Number(o.outputs[0].line_cost)).toBeCloseTo(55000 - 1200, 3);
  });

  it('صلاحيات: مستخدم بلا textile.completion.manage لا يسجّل الإنتاج الفعلي', async () => {
    const f = await fixture('tx-rbac');
    const u = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['manufacturing.order.view']);
    await expect(saveOrderCompletion((u as any).ctx, f.order.id, completion(f))).rejects.toThrow();
  });
});
