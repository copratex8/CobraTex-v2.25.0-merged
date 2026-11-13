import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createCustomerPayment, postCustomerPayment, allocateAdvancePayment as allocateCustomerAdvance } from '@/modules/sales/customerPaymentService';
import { createGoodsReceipt, postGoodsReceipt } from '@/modules/purchasing/goodsReceiptService';
import { createSupplierInvoice, postSupplierInvoice } from '@/modules/purchasing/supplierInvoiceService';
import { createSupplierPayment, postSupplierPayment, allocateAdvancePayment as allocateSupplierAdvance } from '@/modules/purchasing/supplierPaymentService';
import { updateFxGainLossAccount } from '@/modules/tenancy/tenancyService';
import {
  createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem,
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
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1010','الخزينة','Cash Box','asset') RETURNING id`,
    [stack.companyId],
  );
  const fxAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'7900','فروق عملة','FX Gain/Loss','revenue') RETURNING id`,
    [stack.companyId],
  );
  const customer = await createCustomer(stack.ctx, { code: `FX-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'USD' });
  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId, quantity: '1000', unitCost: '5',
    movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });

  async function makeInvoice(qty: number, unitPrice: number, exchangeRate: string) {
    const invoice = await createSalesInvoice(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id, fiscalPeriodId,
      currencyCode: 'USD', exchangeRate, invoiceDate: '2026-02-01',
      lines: [{ itemId, uomId, quantity: String(qty), unitPrice: String(unitPrice) }],
    });
    const result = await postSalesInvoice(stack.ctx, invoice.id);
    return { invoiceId: invoice.id, journalEntryId: result.journalEntryId };
  }

  return { stack, fiscalPeriodId, customerId: customer.id, receiptAccountId: cashAccount.rows[0].id, fxAccountId: fxAccount.rows[0].id, makeInvoice };
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
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1011','البنك','Bank','asset') RETURNING id`,
    [stack.companyId],
  );
  const fxAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'7900','فروق عملة','FX Gain/Loss','revenue') RETURNING id`,
    [stack.companyId],
  );
  const supplier = await createSupplier(stack.ctx, { code: `FXS-${prefix}`, nameAr: 'مورد', nameEn: 'Supplier', currencyCode: 'USD' });

  async function makeInvoice(qty: number, unitCost: number, exchangeRate: string) {
    const receipt = await createGoodsReceipt(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, supplierId: supplier.id, receiptDate: '2026-02-01',
      lines: [{ itemId, uomId, quantity: String(qty), unitCost: String(unitCost) }],
    });
    await postGoodsReceipt(stack.ctx, receipt.id);
    const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);
    const invoice = await createSupplierInvoice(stack.ctx, {
      branchId: stack.branchId, supplierId: supplier.id, fiscalPeriodId, currencyCode: 'USD', exchangeRate, invoiceDate: '2026-02-05',
      lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: String(qty), unitCost: String(unitCost) }],
    });
    const result = await postSupplierInvoice(stack.ctx, invoice.id);
    return { invoiceId: invoice.id, journalEntryId: result.journalEntryId };
  }

  return { stack, fiscalPeriodId, supplierId: supplier.id, paymentAccountId: bankAccount.rows[0].id, fxAccountId: fxAccount.rows[0].id, makeInvoice };
}

describe('توحيد تحويل العملة عبر كل الوحدات (createDraftJournalEntry)', () => {
  it('فاتورة بيع بعملة أجنبية: أسطر القيد تُخزَّن بعملة الأساس (face × exchange_rate)، لا بالقيمة الاسمية', async () => {
    const f = await setupSalesFixture('conv-sales');
    const { journalEntryId } = await f.makeInvoice(10, 100, '50'); // 10*100=1000 دولار إيراد، بسعر 50 = 50000 جنيه
    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1 ORDER BY debit DESC`, [journalEntryId]);
    // أعلى سطر مدين هو الذمة (الإيراد الكامل) = 50000؛ الأصغر هو تكلفة البضاعة المباعة (10*5=50 دولار×50=2500)
    expect(Number(lines.rows[0].debit)).toBeCloseTo(50000, 2); // لا 1000 (القيمة الاسمية) بل 50000 بعد التحويل
    expect(Number(lines.rows[1].debit)).toBeCloseTo(2500, 2); // تكلفة البضاعة المباعة محوَّلة أيضًا لنفس السعر
  });

  it('فاتورة شراء بعملة أجنبية: نفس التحويل المركزي يعمل من نفس نقطة الشيفرة', async () => {
    const f = await setupPurchaseFixture('conv-purchase');
    const { journalEntryId } = await f.makeInvoice(20, 10, '48'); // 20*10=200 دولار × 48 = 9600 جنيه
    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [journalEntryId]);
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    expect(totalDebit).toBeCloseTo(9600, 2);
  });

  it('لا تغيير في السلوك لقيود بعملة الأساس (exchange_rate=1) — كل الاختبارات القديمة لم تنكسر (تأكيد إضافي هنا)', async () => {
    const f = await setupPurchaseFixture('conv-noop');
    const { journalEntryId } = await f.makeInvoice(5, 10, '1');
    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [journalEntryId]);
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    expect(totalDebit).toBeCloseTo(50, 2);
  });
});

describe('فروق العملة الفعلية عند تخصيص دفعة لفاتورة بسعر صرف مختلف — العملاء', () => {
  it('سعر الدفعة أعلى من سعر الفاتورة → ربح: مدين الذمة، دائن حساب فرق العملة', async () => {
    const f = await setupSalesFixture('fx-c-gain');
    await updateFxGainLossAccount(f.stack.ctx, f.fxAccountId);
    const { invoiceId } = await f.makeInvoice(10, 100, '50'); // 1000 USD @ 50 = 50000 EGP

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'USD', exchangeRate: '52', paymentDate: '2026-03-01', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    const result = await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '1000' }]);
    expect(result.fxJournalEntryId).toBeDefined();

    const fxLines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.fxJournalEntryId]);
    expect(fxLines.rows).toHaveLength(2);
    const totalDebit = fxLines.rows.reduce((s, r) => s + Number(r.debit), 0);
    expect(totalDebit).toBeCloseTo(2000, 2); // 1000 * (52-50) = 2000 EGP ربح
    const fxLine = fxLines.rows.find((r) => r.account_id === f.fxAccountId);
    expect(Number(fxLine.credit)).toBeCloseTo(2000, 2); // حساب الفرق يُدان بالربح

    const allocationRow = await pool.query(`SELECT fx_difference_amount FROM customer_payment_allocations WHERE customer_payment_id=$1`, [payment.id]);
    expect(Number(allocationRow.rows[0].fx_difference_amount)).toBeCloseTo(2000, 2);
  });

  it('سعر الدفعة أقل من سعر الفاتورة → خسارة: مدين حساب فرق العملة، دائن الذمة', async () => {
    const f = await setupSalesFixture('fx-c-loss');
    await updateFxGainLossAccount(f.stack.ctx, f.fxAccountId);
    const { invoiceId } = await f.makeInvoice(10, 100, '50');

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'USD', exchangeRate: '47', paymentDate: '2026-03-01', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    const result = await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '1000' }]);

    const fxLines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.fxJournalEntryId]);
    const fxLine = fxLines.rows.find((r) => r.account_id === f.fxAccountId);
    expect(Number(fxLine.debit)).toBeCloseTo(3000, 2); // 1000 * (50-47) = 3000 EGP خسارة، حساب الفرق يُدان بالخسارة (مدين)

    const allocationRow = await pool.query(`SELECT fx_difference_amount FROM customer_payment_allocations WHERE customer_payment_id=$1`, [payment.id]);
    expect(Number(allocationRow.rows[0].fx_difference_amount)).toBeCloseTo(-3000, 2);
  });

  it('نفس سعر الصرف بين الفاتورة والدفعة → لا فرق عملة، ولا قيد إضافي يُنشأ', async () => {
    const f = await setupSalesFixture('fx-c-none');
    await updateFxGainLossAccount(f.stack.ctx, f.fxAccountId);
    const { invoiceId } = await f.makeInvoice(10, 100, '50');
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'USD', exchangeRate: '50', paymentDate: '2026-03-01', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    const result = await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '1000' }]);
    expect(result.fxJournalEntryId).toBeUndefined();
  });

  it('يرفض التخصيص بوضوح إن وُجد فرق عملة ولم يُحدَّد حساب فرق العملة للشركة بعد', async () => {
    const f = await setupSalesFixture('fx-c-noaccount');
    // لا نستدعي updateFxGainLossAccount هنا عمدًا
    const { invoiceId } = await f.makeInvoice(10, 100, '50');
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'USD', exchangeRate: '55', paymentDate: '2026-03-01', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    await expect(allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '1000' }])).rejects.toThrow(/حساب فرق العملة/);
  });
});

describe('فروق العملة الفعلية عند تخصيص دفعة لفاتورة بسعر صرف مختلف — الموردون', () => {
  it('سعر الدفعة أعلى من سعر الفاتورة → خسارة (دُفع أكثر): مدين حساب الفرق، دائن الالتزام', async () => {
    const f = await setupPurchaseFixture('fx-s-loss');
    await updateFxGainLossAccount(f.stack.ctx, f.fxAccountId);
    const { invoiceId } = await f.makeInvoice(20, 10, '48'); // 200 USD @48 = 9600 EGP

    const payment = await createSupplierPayment(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'USD', exchangeRate: '50', paymentDate: '2026-03-01', amount: '200', paymentAccountId: f.paymentAccountId,
    });
    await postSupplierPayment(f.stack.ctx, payment.id);
    const result = await allocateSupplierAdvance(f.stack.ctx, payment.id, [{ supplierInvoiceId: invoiceId, amount: '200' }]);

    const fxLines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.fxJournalEntryId]);
    const fxLine = fxLines.rows.find((r) => r.account_id === f.fxAccountId);
    expect(Number(fxLine.debit)).toBeCloseTo(400, 2); // 200 * (50-48) = 400 EGP خسارة

    const allocationRow = await pool.query(`SELECT fx_difference_amount FROM supplier_payment_allocations WHERE supplier_payment_id=$1`, [payment.id]);
    expect(Number(allocationRow.rows[0].fx_difference_amount)).toBeCloseTo(400, 2);
  });

  it('سعر الدفعة أقل من سعر الفاتورة → ربح (دُفع أقل): مدين الالتزام، دائن حساب الفرق', async () => {
    const f = await setupPurchaseFixture('fx-s-gain');
    await updateFxGainLossAccount(f.stack.ctx, f.fxAccountId);
    const { invoiceId } = await f.makeInvoice(20, 10, '48');

    const payment = await createSupplierPayment(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'USD', exchangeRate: '45', paymentDate: '2026-03-01', amount: '200', paymentAccountId: f.paymentAccountId,
    });
    await postSupplierPayment(f.stack.ctx, payment.id);
    const result = await allocateSupplierAdvance(f.stack.ctx, payment.id, [{ supplierInvoiceId: invoiceId, amount: '200' }]);

    const fxLines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.fxJournalEntryId]);
    const fxLine = fxLines.rows.find((r) => r.account_id === f.fxAccountId);
    expect(Number(fxLine.credit)).toBeCloseTo(600, 2); // 200 * (48-45) = 600 EGP ربح
  });
});
