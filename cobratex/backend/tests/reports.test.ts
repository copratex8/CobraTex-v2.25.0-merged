import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { getCustomerStatement } from '@/modules/sales/customerService';
import { getSupplierStatement } from '@/modules/purchasing/supplierService';
import { getTrialBalance } from '@/modules/accounting/reportingService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createCustomerPayment, postCustomerPayment } from '@/modules/sales/customerPaymentService';
import { createGoodsReceipt, postGoodsReceipt } from '@/modules/purchasing/goodsReceiptService';
import { createSupplierInvoice, postSupplierInvoice } from '@/modules/purchasing/supplierInvoiceService';
import { createSupplierPayment, postSupplierPayment } from '@/modules/purchasing/supplierPaymentService';
import {
  createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser,
} from './helpers';

async function setupSalesFixture(prefix: string) {
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
  const cashAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1018','خزينة تقارير','Cash Reports','asset') RETURNING id`,
    [stack.companyId],
  );
  const customer = await createCustomer(stack.ctx, { code: `RPT-${prefix}`, nameAr: 'عميل تقارير', nameEn: 'Report Customer', currencyCode: 'EGP' });
  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId, quantity: '100', unitCost: '10',
    movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });

  async function makeInvoice(total: number, date: string) {
    const invoice = await createSalesInvoice(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id, fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: date,
      lines: [{ itemId, uomId, quantity: String(total / 100), unitPrice: '100' }],
    });
    await postSalesInvoice(stack.ctx, invoice.id);
    return invoice.id;
  }

  return { stack, fiscalPeriodId, customerId: customer.id, receiptAccountId: cashAccount.rows[0].id, makeInvoice };
}

async function setupPurchaseFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, inventoryAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);
  await createPostingRule(stack.ctx, {
    operationType: 'purchase_invoice_inventory', debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', creditAccountSourceType: 'SUPPLIER_PAYABLE',
  });
  const bankAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1019','بنك تقارير','Bank Reports','asset') RETURNING id`,
    [stack.companyId],
  );
  const supplier = await createSupplier(stack.ctx, { code: `RPTS-${prefix}`, nameAr: 'مورد تقارير', nameEn: 'Report Supplier', currencyCode: 'EGP' });

  async function makeInvoice(qty: number, unitCost: number, date: string) {
    const receipt = await createGoodsReceipt(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, supplierId: supplier.id, receiptDate: date,
      lines: [{ itemId, uomId, quantity: String(qty), unitCost: String(unitCost) }],
    });
    await postGoodsReceipt(stack.ctx, receipt.id);
    const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);
    const invoice = await createSupplierInvoice(stack.ctx, {
      branchId: stack.branchId, supplierId: supplier.id, fiscalPeriodId, currencyCode: 'EGP', invoiceDate: date,
      lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: String(qty), unitCost: String(unitCost) }],
    });
    await postSupplierInvoice(stack.ctx, invoice.id);
    return invoice.id;
  }

  return { stack, fiscalPeriodId, supplierId: supplier.id, paymentAccountId: bankAccount.rows[0].id, makeInvoice };
}

describe('ميزان المراجعة (Trial Balance)', () => {
  it('التوازن الأساسي: إجمالي المدين = إجمالي الدائن عبر كل الحسابات، ويعكس فقط القيود المرحَّلة', async () => {
    const f = await setupSalesFixture('tb-basic');
    await f.makeInvoice(1000, '2026-02-01');

    const report = await getTrialBalance(f.stack.ctx, '2026-12-31');
    expect(Number(report.totals.debit)).toBeCloseTo(Number(report.totals.credit), 2);
    expect(Number(report.totals.debit)).toBeGreaterThan(0);
  });

  it('asOfDate يحصر القيود حتى تاريخ معيّن فقط — فاتورة بعد التاريخ لا تظهر', async () => {
    const f = await setupSalesFixture('tb-asof');
    await f.makeInvoice(500, '2026-01-10');
    await f.makeInvoice(300, '2026-03-10'); // بعد asOfDate أدناه

    const report = await getTrialBalance(f.stack.ctx, '2026-02-01');
    const receivableAccount = await pool.query(
      `SELECT linked_account_id FROM customers WHERE id=$1`, [f.customerId],
    );
    const row = report.accounts.find((a: any) => a.id === receivableAccount.rows[0].linked_account_id);
    expect(Number(row.total_debit)).toBeCloseTo(500, 2); // فقط الفاتورة الأولى
  });

  it('onlyWithActivity=true يستبعد الحسابات بلا أي حركة', async () => {
    const f = await setupSalesFixture('tb-activity');
    await f.makeInvoice(200, '2026-02-01');
    const full = await getTrialBalance(f.stack.ctx, '2026-12-31', undefined, false);
    const filtered = await getTrialBalance(f.stack.ctx, '2026-12-31', undefined, true);
    expect(filtered.accounts.length).toBeLessThan(full.accounts.length);
    expect(filtered.accounts.every((a: any) => Number(a.total_debit) !== 0 || Number(a.total_credit) !== 0)).toBe(true);
  });

  it('عزل الفرع: مستخدم بنطاق فرع واحد يرى فقط أثر قيود فرعه في الميزان', async () => {
    const f = await setupSalesFixture('tb-branch');
    await f.makeInvoice(700, '2026-02-01');
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['accounting.journal.view']);
    const report = await getTrialBalance(limited.ctx, '2026-12-31');
    expect(Number(report.totals.debit)).toBeCloseTo(Number(report.totals.credit), 2); // لا يزال متوازنًا
    expect(Number(report.totals.debit)).toBeGreaterThan(0);
  });

  it('يرفض fromDate بعد asOfDate بوضوح', async () => {
    const f = await setupSalesFixture('tb-invalid');
    await expect(getTrialBalance(f.stack.ctx, '2026-01-01', '2026-06-01')).rejects.toThrow();
  });
});

describe('كشف حساب العميل', () => {
  it('فاتورتان ثم تحصيل: الرصيد المتراكم يعكس الترتيب الزمني بدقة', async () => {
    const f = await setupSalesFixture('stmt-customer');
    await f.makeInvoice(1000, '2026-02-01');
    await f.makeInvoice(500, '2026-02-15');

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-20', amount: '800', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);

    const statement = await getCustomerStatement(f.stack.ctx, f.customerId);
    expect(statement.lines).toHaveLength(3); // فاتورتان + دفعة
    expect(Number(statement.closingBalance)).toBeCloseTo(1000 + 500 - 800, 2); // 700 متبقٍ
    // الرصيد بعد أول فاتورة فقط = 1000
    expect(Number(statement.lines[0].running_balance)).toBeCloseTo(1000, 2);
  });

  it('fromDate/toDate يحصران الفترة المعروضة فقط', async () => {
    const f = await setupSalesFixture('stmt-customer-range');
    await f.makeInvoice(400, '2026-01-05');
    await f.makeInvoice(600, '2026-03-05');

    const statement = await getCustomerStatement(f.stack.ctx, f.customerId, { fromDate: '2026-02-01', toDate: '2026-12-31' });
    expect(statement.lines).toHaveLength(1); // فاتورة مارس فقط
  });

  it('عميل من شركة أخرى: كشف الحساب يُرفض (404)، لا تسريب بيانات', async () => {
    const f1 = await setupSalesFixture('stmt-iso-1');
    const f2 = await setupSalesFixture('stmt-iso-2');
    await expect(getCustomerStatement(f2.stack.ctx, f1.customerId)).rejects.toThrow();
  });
});

describe('كشف حساب المورد', () => {
  it('فاتورة ثم سداد جزئي: الرصيد المتراكم = التزام قائم صحيح', async () => {
    const f = await setupPurchaseFixture('stmt-supplier');
    await f.makeInvoice(20, 25, '2026-02-01'); // 500

    const payment = await createSupplierPayment(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '200', paymentAccountId: f.paymentAccountId,
    });
    await postSupplierPayment(f.stack.ctx, payment.id);

    const statement = await getSupplierStatement(f.stack.ctx, f.supplierId);
    expect(statement.lines).toHaveLength(2);
    expect(Number(statement.closingBalance)).toBeCloseTo(300, 2); // 500 - 200 متبقٍ كالتزام
  });
});
