import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser } from './helpers';
import {
  createBom, createProductionOrder, postProductionOrder, reverseProductionOrder, getProductionOrderById, getBomById, updateOperationCosts, listBoms,
} from '@/modules/manufacturing/manufacturingService';
import { updateManufacturingEnabled } from '@/modules/tenancy/tenancyService';

const app = createApp();

/**
 * تجهيز: صنف خام (مثال: خيط) بفئته الخاصة، وصنف مُنتَج (مثال: قماش) بفئة أخرى منفصلة تمامًا —
 * حسابا مخزون مختلفان عمدًا، حتى يختبر تحقُّق توازن القيد المحاسبي مطابقةً حقيقية بين حسابين
 * مختلفين لا مجرد رقمين متطابقين صدفةً. حساب "تحت التشغيل" وسيط مشترك بينهما (راجع تعليق
 * manufacturingService.postProductionOrder للتفصيل الكامل لسبب هذا التصميم).
 */
async function setupFixture(prefix: string, rawQty: string, rawCost: string) {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId: rawInventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId: rawCategoryId } = await createItemCategoryWithAccounts(stack.companyId, rawInventoryAccountId, cogsAccountId);

  const outputInventoryAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1031','مخزون القماش','Fabric Inventory','asset') RETURNING id`,
    [stack.companyId],
  );
  const { categoryId: outputCategoryId } = await createItemCategoryWithAccounts(stack.companyId, outputInventoryAccount.rows[0].id, cogsAccountId);

  const wipAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1050','تحت التشغيل - التصنيع','Manufacturing WIP','asset') RETURNING id`,
    [stack.companyId],
  );
  await createPostingRule(stack.ctx, {
    operationType: 'manufacturing_consume', debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: wipAccount.rows[0].id,
    creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'manufacturing_output', debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: wipAccount.rows[0].id,
  });

  // حساب تحميل تكاليف التحويل (عمالة/تشغيل) + قاعدته — يقابل ما يزرعه bootstrap للشركات الجديدة.
  const absorptionAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5030','تكاليف تصنيع محمَّلة','Manufacturing Costs Absorbed','expense') RETURNING id`,
    [stack.companyId],
  );
  await createPostingRule(stack.ctx, {
    operationType: 'manufacturing_conversion', debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: absorptionAccount.rows[0].id,
  });

  const { itemId: rawItemId, uomId } = await createBaseItem(stack.companyId);
  const { itemId: outputItemId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [rawCategoryId, rawItemId]);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [outputCategoryId, outputItemId]);

  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId: rawItemId, quantity: rawQty, unitCost: rawCost,
    movementDate: '2026-04-01', sourceDocumentType: 'opening',
  });

  return {
    stack, rawItemId, outputItemId, uomId, fiscalPeriodId, outputCategoryId,
    rawInventoryAccountId, outputInventoryAccountId: outputInventoryAccount.rows[0].id, wipAccountId: wipAccount.rows[0].id,
    absorptionAccountId: absorptionAccount.rows[0].id,
  };
}

async function getBalance(companyId: string, warehouseId: string, itemId: string) {
  const { rows } = await pool.query(
    `SELECT quantity_on_hand, weighted_average_cost FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NULL`,
    [companyId, warehouseId, itemId],
  );
  return rows[0];
}

describe('التصنيع (BOM + أوامر تصنيع) — بلا قيد على صناعة بعينها (يصلح للغزل/النسيج كأي نشاط آخر)', () => {
  it('إنشاء BOM (خيط → قماش) ثم أمر تصنيع: الاستهلاك والإنتاج بالتكلفة الصحيحة، وتحديث الأرصدة', async () => {
    const f = await setupFixture('mfg-basic', '100', '10'); // 100 وحدة خيط بتكلفة 10 لكل وحدة = 1000
    const bom = await createBom(f.stack.ctx, {
      code: 'BOM-FABRIC-1', nameAr: 'نسيج قماش قطني', nameEn: 'Cotton Fabric Weaving', outputItemId: f.outputItemId,
      outputQuantity: '1', lines: [{ componentItemId: f.rawItemId, quantity: '4' }], // 4 وحدات خيط تنتج 1 وحدة قماش
    });

    const order = await createProductionOrder(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
      orderDate: '2026-04-05', plannedOutputQuantity: '20', // ينتج 20 وحدة قماش → يستهلك 80 وحدة خيط
    });
    expect(order.status).toBe('draft');

    const posted = await postProductionOrder(f.stack.ctx, order.id);
    expect(posted.totalCost).toBe('800.0000'); // 80 وحدة خيط × 10 = 800

    const rawBalance = await getBalance(f.stack.companyId, f.stack.warehouseId, f.rawItemId);
    expect(Number(rawBalance.quantity_on_hand)).toBe(20); // 100 - 80
    const outputBalance = await getBalance(f.stack.companyId, f.stack.warehouseId, f.outputItemId);
    expect(Number(outputBalance.quantity_on_hand)).toBe(20);
    expect(Number(outputBalance.weighted_average_cost)).toBeCloseTo(40, 4); // 800 / 20 وحدة قماش

    const journalLines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [posted.journalEntryId]);
    const totalDebit = journalLines.rows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = journalLines.rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 4);
    // الحساب الوسيط (تحت التشغيل) يتصفَّر صافيًا: مدينه من الاستهلاك = دائنه من الإنتاج بالضبط.
    const wipLines = journalLines.rows.filter((r) => r.account_id === f.wipAccountId);
    const wipNet = wipLines.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
    expect(wipNet).toBeCloseTo(0, 4);
    // مخزون الخام يُدان 800 (خروج)، ومخزون القماش يُدين 800 (دخول) — كل منهما ظهر مرة واحدة بمبلغ 800.
    const rawInventoryLine = journalLines.rows.find((r) => r.account_id === f.rawInventoryAccountId);
    const outputInventoryLine = journalLines.rows.find((r) => r.account_id === f.outputInventoryAccountId);
    expect(Number(rawInventoryLine!.credit)).toBeCloseTo(800, 4);
    expect(Number(outputInventoryLine!.debit)).toBeCloseTo(800, 4);
  });

  it('يرفض ترحيل أمر تصنيع تتجاوز كميته المخطَّطة الرصيد المتاح من المكوّن', async () => {
    const f = await setupFixture('mfg-insufficient', '10', '5'); // 10 وحدات فقط
    const bom = await createBom(f.stack.ctx, {
      code: 'BOM-X', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
      lines: [{ componentItemId: f.rawItemId, quantity: '1' }],
    });
    const order = await createProductionOrder(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
      orderDate: '2026-04-05', plannedOutputQuantity: '100', // يحتاج 100 وحدة خام، المتاح فقط 10
    });
    await expect(postProductionOrder(f.stack.ctx, order.id)).rejects.toThrow();
  });

  it('عكس أمر مرحَّل: يستعيد رصيد الخام بالكامل، يصرف الناتج بالكامل، ويعكس القيد', async () => {
    const f = await setupFixture('mfg-reverse', '100', '10');
    const bom = await createBom(f.stack.ctx, {
      code: 'BOM-R', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
      lines: [{ componentItemId: f.rawItemId, quantity: '2' }],
    });
    const order = await createProductionOrder(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
      orderDate: '2026-04-05', plannedOutputQuantity: '10', // يستهلك 20
    });
    await postProductionOrder(f.stack.ctx, order.id);
    const reversed = await reverseProductionOrder(f.stack.ctx, order.id, 'خطأ في المدخلات');
    expect(reversed.status).toBe('reversed');

    const rawBalance = await getBalance(f.stack.companyId, f.stack.warehouseId, f.rawItemId);
    expect(Number(rawBalance.quantity_on_hand)).toBe(100); // عاد كما كان
    const outputBalance = await getBalance(f.stack.companyId, f.stack.warehouseId, f.outputItemId);
    expect(Number(outputBalance.quantity_on_hand)).toBe(0);

    const orderRow = await pool.query(`SELECT journal_entry_id FROM production_orders WHERE id=$1`, [order.id]);
    const journal = await pool.query(`SELECT status FROM journal_entries WHERE id=$1`, [orderRow.rows[0].journal_entry_id]);
    expect(journal.rows[0].status).toBe('reversed');
  });

  it('تسلسل مرحلتين (غزل ثم نسيج): مُخرَج الأمر الأول يصبح مُدخَل الأمر الثاني مباشرة', async () => {
    const f = await setupFixture('mfg-chain', '50', '8'); // مادة خام (قطن) لإنتاج خيط
    const spinningBom = await createBom(f.stack.ctx, {
      code: 'BOM-SPIN', nameAr: 'غزل خيط من قطن', nameEn: 'Spin Thread', outputItemId: f.outputItemId, // outputItemId هنا يمثِّل "الخيط"
      lines: [{ componentItemId: f.rawItemId, quantity: '1' }],
    });
    const spinOrder = await createProductionOrder(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: spinningBom.id, fiscalPeriodId: f.fiscalPeriodId,
      orderDate: '2026-04-05', plannedOutputQuantity: '50',
    });
    await postProductionOrder(f.stack.ctx, spinOrder.id);
    const threadBalance = await getBalance(f.stack.companyId, f.stack.warehouseId, f.outputItemId);
    expect(Number(threadBalance.quantity_on_hand)).toBe(50);

    // الآن "الخيط" (f.outputItemId) نفسه يصبح مكوِّنًا لوصفة نسيج تنتج صنفًا ثالثًا (قماش):
    const { itemId: fabricItemId } = await createBaseItem(f.stack.companyId);
    await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [f.outputCategoryId, fabricItemId]);
    await pool.query(`UPDATE items SET category_id=(SELECT category_id FROM items WHERE id=$1) WHERE id=$2`, [f.outputItemId, fabricItemId]);
    const weavingBom = await createBom(f.stack.ctx, {
      code: 'BOM-WEAVE', nameAr: 'نسيج قماش من خيط', nameEn: 'Weave Fabric', outputItemId: fabricItemId,
      lines: [{ componentItemId: f.outputItemId, quantity: '5' }],
    });
    const weaveOrder = await createProductionOrder(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: weavingBom.id, fiscalPeriodId: f.fiscalPeriodId,
      orderDate: '2026-04-06', plannedOutputQuantity: '10', // يستهلك 50 وحدة خيط بالضبط
    });
    const posted = await postProductionOrder(f.stack.ctx, weaveOrder.id);
    expect(posted.totalCost).toBeTruthy();

    const threadBalanceAfter = await getBalance(f.stack.companyId, f.stack.warehouseId, f.outputItemId);
    expect(Number(threadBalanceAfter.quantity_on_hand)).toBe(0); // استُهلِك بالكامل في مرحلة النسيج
  });

  it('يرفض إنشاء BOM بلا مكوّنات، وBOM يكون الصنف المُنتَج فيه أحد مكوّناته الخاصة', async () => {
    const f = await setupFixture('mfg-bom-validation', '10', '5');
    await expect(createBom(f.stack.ctx, {
      code: 'BOM-EMPTY', nameAr: 'وصفة فارغة', nameEn: 'Empty', outputItemId: f.outputItemId, lines: [],
    })).rejects.toThrow();
    await expect(createBom(f.stack.ctx, {
      code: 'BOM-SELF', nameAr: 'وصفة ذاتية', nameEn: 'Self', outputItemId: f.outputItemId,
      lines: [{ componentItemId: f.outputItemId, quantity: '1' }],
    })).rejects.toThrow();
  });

  it('RBAC: مستخدم بلا manufacturing.order.create يُرفض عند إنشاء أمر تصنيع', async () => {
    const f = await setupFixture('mfg-rbac', '10', '5');
    const bom = await createBom(f.stack.ctx, {
      code: 'BOM-RBAC', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
      lines: [{ componentItemId: f.rawItemId, quantity: '1' }],
    });
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, []);
    await expect(createProductionOrder(limited.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
      orderDate: '2026-04-05', plannedOutputQuantity: '1',
    })).rejects.toThrow();
  });

  it('عزل الشركات: أمر تصنيع شركة A غير مرئي لشركة B', async () => {
    const f1 = await setupFixture('mfg-iso-1', '10', '5');
    const f2 = await setupFixture('mfg-iso-2', '10', '5');
    const bom = await createBom(f1.stack.ctx, {
      code: 'BOM-ISO', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f1.outputItemId,
      lines: [{ componentItemId: f1.rawItemId, quantity: '1' }],
    });
    const order = await createProductionOrder(f1.stack.ctx, {
      branchId: f1.stack.branchId, warehouseId: f1.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f1.fiscalPeriodId,
      orderDate: '2026-04-05', plannedOutputQuantity: '1',
    });
    await expect(getProductionOrderById(f2.stack.ctx, order.id)).rejects.toThrow();
  });

  describe('مراحل التصنيع وتكاليف التحويل (عمالة/مصاريف تشغيل)', () => {
    async function withOperations(prefix: string) {
      const f = await setupFixture(prefix, '100', '10');
      const bom = await createBom(f.stack.ctx, {
        code: `BOM-${prefix}`, nameAr: 'وصفة بمراحل', nameEn: 'Routed', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '4' }],
        operations: [
          { name: 'غزل', costType: 'labor', costAmount: '30' },
          { name: 'نسيج', costType: 'overhead', costAmount: '20' },
        ],
      });
      return { f, bom };
    }

    it('BOM يحفظ مراحله بترتيبها، وأمر التصنيع ينسخها بتكلفة مخطَّطة مضروبة في نسبة الكمية', async () => {
      const { f, bom } = await withOperations('ops-copy');
      const detail = await getBomById(f.stack.ctx, bom.id);
      expect(detail.operations.map((o: { name: string }) => o.name)).toEqual(['غزل', 'نسيج']);

      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-04-05', plannedOutputQuantity: '10', // 10 أضعاف الوصفة (output_quantity=1)
      });
      const full = await getProductionOrderById(f.stack.ctx, order.id);
      expect(full.operations.map((o: { planned_cost: string }) => Number(o.planned_cost))).toEqual([300, 200]);
    });

    it('الترحيل: تكلفة الصنف = مواد + تحويل، والقيد متوازن، وحساب التحميل يُدان بمبلغ التحويل', async () => {
      const { f, bom } = await withOperations('ops-post');
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-04-05', plannedOutputQuantity: '10',
      });
      const posted = await postProductionOrder(f.stack.ctx, order.id);
      // مواد: 40 وحدة خام × 10 = 400 ؛ تحويل: 300 + 200 = 500 ؛ الإجمالي 900
      expect(posted.materialsCost).toBe('400.0000');
      expect(posted.conversionCost).toBe('500.0000');
      expect(posted.totalCost).toBe('900.0000');

      const out = await getBalance(f.stack.companyId, f.stack.warehouseId, f.outputItemId);
      expect(Number(out.quantity_on_hand)).toBe(10);
      expect(Number(out.weighted_average_cost)).toBeCloseTo(90, 4); // 900 / 10

      const lines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [posted.journalEntryId]);
      const debit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
      const credit = lines.rows.reduce((s, r) => s + Number(r.credit), 0);
      expect(debit).toBeCloseTo(credit, 4);
      const absorbed = lines.rows.filter((r) => r.account_id === f.absorptionAccountId).reduce((s, r) => s + Number(r.credit), 0);
      expect(absorbed).toBeCloseTo(500, 4);
      const outputInventoryDebit = lines.rows.filter((r) => r.account_id === f.outputInventoryAccountId).reduce((s, r) => s + Number(r.debit), 0);
      expect(outputInventoryDebit).toBeCloseTo(900, 4); // مخزون الناتج يُدان بالتكلفة الكاملة
      const wipNet = lines.rows.filter((r) => r.account_id === f.wipAccountId).reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
      expect(wipNet).toBeCloseTo(0, 4); // الحساب الوسيط يبقى متصفرًا
    });

    it('التكلفة الفعلية المُدخَلة في المسودة تحل محل المخطَّطة عند الترحيل', async () => {
      const { f, bom } = await withOperations('ops-actual');
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-04-05', plannedOutputQuantity: '10',
      });
      const ops = (await getProductionOrderById(f.stack.ctx, order.id)).operations;
      await updateOperationCosts(f.stack.ctx, order.id, [{ operationId: ops[0].id, actualCost: '450' }]); // بدل 300
      const posted = await postProductionOrder(f.stack.ctx, order.id);
      expect(posted.conversionCost).toBe('650.0000'); // 450 فعلي + 200 مخطَّط
    });

    it('لا تعديل لتكاليف المراحل بعد الترحيل، ولا تكلفة سالبة، ولا مرحلة من أمر آخر', async () => {
      const { f, bom } = await withOperations('ops-guards');
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-04-05', plannedOutputQuantity: '1',
      });
      const ops = (await getProductionOrderById(f.stack.ctx, order.id)).operations;
      await expect(updateOperationCosts(f.stack.ctx, order.id, [{ operationId: ops[0].id, actualCost: '-5' }])).rejects.toThrow();
      await expect(updateOperationCosts(f.stack.ctx, order.id, [{ operationId: '00000000-0000-4000-8000-000000000000', actualCost: '5' }])).rejects.toThrow();
      await postProductionOrder(f.stack.ctx, order.id);
      await expect(updateOperationCosts(f.stack.ctx, order.id, [{ operationId: ops[0].id, actualCost: '5' }])).rejects.toThrow();
    });

    it('RBAC: مستخدم بلا manufacturing.order.update لا يعدّل تكاليف المراحل', async () => {
      const { f, bom } = await withOperations('ops-rbac');
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-04-05', plannedOutputQuantity: '1',
      });
      const ops = (await getProductionOrderById(f.stack.ctx, order.id)).operations;
      const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, []);
      await expect(updateOperationCosts(limited.ctx, order.id, [{ operationId: ops[0].id, actualCost: '5' }])).rejects.toThrow();
    });

    it('عكس أمر بتكلفة تحويل: يستعيد الخام ويصرف الناتج ويعكس القيد كاملًا', async () => {
      const { f, bom } = await withOperations('ops-reverse');
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-04-05', plannedOutputQuantity: '10',
      });
      await postProductionOrder(f.stack.ctx, order.id);
      await reverseProductionOrder(f.stack.ctx, order.id, 'تصحيح');
      const raw = await getBalance(f.stack.companyId, f.stack.warehouseId, f.rawItemId);
      const out = await getBalance(f.stack.companyId, f.stack.warehouseId, f.outputItemId);
      expect(Number(raw.quantity_on_hand)).toBe(100);
      expect(Number(out.quantity_on_hand)).toBe(0);
    });
  });

  describe('نسبة الهالك في مكوّنات BOM', () => {
    it('الكمية المخطَّطة في أمر التصنيع = النظرية × (1 + نسبة الهالك/100)، والاستهلاك الفعلي يطابقها', async () => {
      const f = await setupFixture('waste-basic', '1000', '10');
      const bom = await createBom(f.stack.ctx, {
        code: 'BOM-WASTE', nameAr: 'وصفة بهالك', nameEn: 'Wasteful Recipe', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '4', wastePercent: '5' }], // 4 وحدة نظريًا + 5% هالك = 4.2
      });
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-05-01', plannedOutputQuantity: '100', // نظريًا 400 + هالك 5% = 420
      });
      const detail = await getProductionOrderById(f.stack.ctx, order.id);
      expect(Number(detail.lines[0].planned_quantity)).toBeCloseTo(420, 4);
      expect(Number(detail.lines[0].waste_percent)).toBe(5);

      const posted = await postProductionOrder(f.stack.ctx, order.id);
      expect(posted.materialsCost).toBe('4200.0000'); // 420 × 10

      const rawBalance = await getBalance(f.stack.companyId, f.stack.warehouseId, f.rawItemId);
      expect(Number(rawBalance.quantity_on_hand)).toBe(580); // 1000 - 420
    });

    it('نسبة هالك 0 (الافتراضي) لا تغيّر الكمية النظرية إطلاقًا', async () => {
      const f = await setupFixture('waste-zero', '100', '10');
      const bom = await createBom(f.stack.ctx, {
        code: 'BOM-NOWASTE', nameAr: 'وصفة بلا هالك', nameEn: 'No Waste', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '2' }], // بلا wastePercent
      });
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-05-01', plannedOutputQuantity: '10',
      });
      const detail = await getProductionOrderById(f.stack.ctx, order.id);
      expect(Number(detail.lines[0].planned_quantity)).toBe(20);
    });

    it('يرفض نسبة هالك سالبة أو 100 فأكثر', async () => {
      const f = await setupFixture('waste-validation', '100', '10');
      await expect(createBom(f.stack.ctx, {
        code: 'BOM-BADWASTE1', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '1', wastePercent: '-1' }],
      })).rejects.toThrow();
      await expect(createBom(f.stack.ctx, {
        code: 'BOM-BADWASTE2', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '1', wastePercent: '100' }],
      })).rejects.toThrow();
    });
  });

  describe('تشغيل/إيقاف وحدة التصنيع كاملة (فصلها عن البرنامج الأساسي)', () => {
    it('عند الإيقاف: كل دوال الوحدة (BOM وأوامر) تُرفض كأن الوحدة غير موجودة — النشاطات الأخرى لا تتأثر', async () => {
      const f = await setupFixture('toggle-off', '100', '10');
      const bom = await createBom(f.stack.ctx, {
        code: 'BOM-TOGGLE', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '1' }],
      });

      await updateManufacturingEnabled(f.stack.ctx, false);

      await expect(listBoms(f.stack.ctx)).rejects.toThrow();
      await expect(getBomById(f.stack.ctx, bom.id)).rejects.toThrow();
      await expect(createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-05-01', plannedOutputQuantity: '1',
      })).rejects.toThrow();

      // نشاط أساسي (خارج التصنيع تمامًا) يعمل بلا أي تأثر بإيقاف التصنيع:
      const { rows } = await pool.query(`SELECT quantity_on_hand FROM stock_balances WHERE company_id=$1 AND item_id=$2`, [f.stack.companyId, f.rawItemId]);
      expect(Number(rows[0].quantity_on_hand)).toBe(100);
    });

    it('إعادة التفعيل تستعيد العمل الطبيعي، والبيانات السابقة (BOM) تبقى محفوظة كما هي', async () => {
      const f = await setupFixture('toggle-on-again', '100', '10');
      const bom = await createBom(f.stack.ctx, {
        code: 'BOM-REENABLE', nameAr: 'وصفة', nameEn: 'Recipe', outputItemId: f.outputItemId,
        lines: [{ componentItemId: f.rawItemId, quantity: '1' }],
      });
      await updateManufacturingEnabled(f.stack.ctx, false);
      await updateManufacturingEnabled(f.stack.ctx, true);

      const boms = await listBoms(f.stack.ctx);
      expect(boms.some((b: { id: string }) => b.id === bom.id)).toBe(true);
      const order = await createProductionOrder(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, bomId: bom.id, fiscalPeriodId: f.fiscalPeriodId,
        orderDate: '2026-05-01', plannedOutputQuantity: '1',
      });
      expect(order.status).toBe('draft');
    });

    it('إيقاف/تفعيل التصنيع لشركة A لا يؤثر إطلاقًا على شركة B (كل شركة مستقلة)', async () => {
      const fa = await setupFixture('toggle-iso-a', '10', '5');
      const fb = await setupFixture('toggle-iso-b', '10', '5');
      await updateManufacturingEnabled(fa.stack.ctx, false);
      await expect(listBoms(fa.stack.ctx)).rejects.toThrow();
      await expect(listBoms(fb.stack.ctx)).resolves.toBeDefined();
    });

    it('PUT /company/settings/manufacturing-enabled عبر HTTP: يبدّل الإعداد فعليًا ويظهر أثره فورًا', async () => {
      const f = await setupFixture('toggle-http', '10', '5');
      const off = await request(app).put('/api/company/settings/manufacturing-enabled')
        .set('Authorization', `Bearer ${f.stack.token}`).send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.manufacturing_enabled).toBe(false);

      const listRes = await request(app).get('/api/manufacturing/boms').set('Authorization', `Bearer ${f.stack.token}`);
      expect(listRes.status).toBe(404);

      const on = await request(app).put('/api/company/settings/manufacturing-enabled')
        .set('Authorization', `Bearer ${f.stack.token}`).send({ enabled: true });
      expect(on.body.manufacturing_enabled).toBe(true);
      const listRes2 = await request(app).get('/api/manufacturing/boms').set('Authorization', `Bearer ${f.stack.token}`);
      expect(listRes2.status).toBe(200);
    });
  });
});
