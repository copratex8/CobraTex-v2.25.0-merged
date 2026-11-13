import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { getInventoryValuationReport, getSalesSummaryReport } from '@/modules/accounting/reportingService';
import {
  createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser,
} from './helpers';

async function setupFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_revenue', debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_cogs', debitAccountSourceType: 'ITEM_CATEGORY_COGS', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });
  const customer = await createCustomer(stack.ctx, { code: `RPT2-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });
  return { stack, fiscalPeriodId, itemId, uomId, customerId: customer.id };
}

describe('تقرير تقييم المخزون (Inventory Valuation)', () => {
  it('يعكس الكمية والقيمة بمتوسط التكلفة المرجَّح بدقة بعد إدخال بضاعة', async () => {
    const f = await setupFixture('inv-basic');
    await recordInMovement(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, itemId: f.itemId, quantity: '50', unitCost: '20',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const report = await getInventoryValuationReport(f.stack.ctx);
    const line = report.lines.find((l: any) => l.item_id === f.itemId);
    expect(Number(line.quantity_on_hand)).toBeCloseTo(50, 2);
    expect(Number(line.weighted_average_cost)).toBeCloseTo(20, 2);
    expect(Number(line.stock_value)).toBeCloseTo(1000, 2);
    expect(Number(report.totalValue)).toBeCloseTo(1000, 2);
  });

  it('البيع يخفض الكمية والقيمة في التقرير بعد الترحيل', async () => {
    const f = await setupFixture('inv-sale');
    await recordInMovement(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, itemId: f.itemId, quantity: '100', unitCost: '10',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '30', unitPrice: '15' }],
    });
    await postSalesInvoice(f.stack.ctx, invoice.id);

    const report = await getInventoryValuationReport(f.stack.ctx);
    const line = report.lines.find((l: any) => l.item_id === f.itemId);
    expect(Number(line.quantity_on_hand)).toBeCloseTo(70, 2); // 100 - 30
  });

  it('onlyWithStock=true (الافتراضي) يستبعد أصنافًا برصيد صفري', async () => {
    const f = await setupFixture('inv-zero');
    const withStock = await getInventoryValuationReport(f.stack.ctx);
    expect(withStock.lines.find((l: any) => l.item_id === f.itemId)).toBeUndefined(); // لا حركة بعد = لا صف إطلاقًا في stock_balances
  });

  it('عزل الفرع: مستخدم بنطاق فرع واحد لا يرى مخزون فرع آخر', async () => {
    const f = await setupFixture('inv-branch');
    await recordInMovement(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, itemId: f.itemId, quantity: '40', unitCost: '5',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['inventory.balance.view']);
    const report = await getInventoryValuationReport(limited.ctx);
    expect(report.lines.some((l: any) => l.item_id === f.itemId)).toBe(true); // نفس فرعه، يظهر
  });
});

describe('تقرير المبيعات المُلخَّص (Sales Summary)', () => {
  it('التجميع حسب الصنف: يُظهر الكمية والإجمالي الصحيحين لفترة محددة', async () => {
    const f = await setupFixture('sales-item');
    await recordInMovement(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, itemId: f.itemId, quantity: '100', unitCost: '5',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-02-15',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '10', unitPrice: '20' }],
    });
    await postSalesInvoice(f.stack.ctx, invoice.id);

    const report = await getSalesSummaryReport(f.stack.ctx, '2026-02-01', '2026-02-28', 'item');
    expect(report.lines).toHaveLength(1);
    expect(Number(report.lines[0].total_quantity)).toBeCloseTo(10, 2);
    expect(Number(report.lines[0].total_sales)).toBeCloseTo(200, 2);
    expect(Number(report.grandTotal)).toBeCloseTo(200, 2);
  });

  it('التجميع حسب العميل يعمل بشكل صحيح', async () => {
    const f = await setupFixture('sales-customer');
    await recordInMovement(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, itemId: f.itemId, quantity: '100', unitCost: '5',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-02-15',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '5', unitPrice: '20' }],
    });
    await postSalesInvoice(f.stack.ctx, invoice.id);

    const report = await getSalesSummaryReport(f.stack.ctx, '2026-02-01', '2026-02-28', 'customer');
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0].customer_id).toBe(f.customerId);
  });

  it('فاتورة خارج الفترة المطلوبة لا تظهر في التقرير', async () => {
    const f = await setupFixture('sales-outside-range');
    await recordInMovement(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, itemId: f.itemId, quantity: '100', unitCost: '5',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-05-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '5', unitPrice: '20' }],
    });
    await postSalesInvoice(f.stack.ctx, invoice.id);

    const report = await getSalesSummaryReport(f.stack.ctx, '2026-02-01', '2026-02-28', 'item');
    expect(report.lines).toHaveLength(0);
    expect(Number(report.grandTotal)).toBe(0);
  });

  it('يرفض fromDate بعد toDate بوضوح', async () => {
    const f = await setupFixture('sales-invalid-range');
    await expect(getSalesSummaryReport(f.stack.ctx, '2026-03-01', '2026-01-01')).rejects.toThrow();
  });
});
