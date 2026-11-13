import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import {
  createCustomerPayment, postCustomerPayment, reverseCustomerPayment, getSalesInvoiceRemainingBalance,
} from '@/modules/sales/customerPaymentService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem } from './helpers';

async function setupInvoiceFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);

  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_revenue',
    debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_cogs',
    debitAccountSourceType: 'ITEM_CATEGORY_COGS', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });

  const cashAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1010','الخزينة','Cash Box','asset') RETURNING id`,
    [stack.companyId],
  );
  const customer = await createCustomer(stack.ctx, { code: `PAYC-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });

  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
    quantity: '100', unitCost: '10', movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });

  const invoice = await createSalesInvoice(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id, fiscalPeriodId,
    currencyCode: 'EGP', invoiceDate: '2026-02-01',
    lines: [{ itemId, uomId, quantity: '10', unitPrice: '100' }], // subtotal = 1000
  });
  await postSalesInvoice(stack.ctx, invoice.id);

  return { stack, invoiceId: invoice.id, customerId: customer.id, fiscalPeriodId, receiptAccountId: cashAccount.rows[0].id };
}

describe('تحصيل العملاء — PaymentAllocation لكل فاتورة', () => {
  it('دفعة جزئية تُحصِّص المبلغ الصحيح، والمتبقي من الفاتورة يُحدَّث بدقة', async () => {
    const f = await setupInvoiceFixture('pay-partial');

    const before = await getSalesInvoiceRemainingBalance(f.stack.ctx, f.invoiceId);
    expect(before.total).toBe('1000.0000');
    expect(before.remaining).toBe('1000.0000');

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '400', receiptAccountId: f.receiptAccountId,
      allocations: [{ salesInvoiceId: f.invoiceId, amount: '400' }],
    });
    const result = await postCustomerPayment(f.stack.ctx, payment.id);

    const after = await getSalesInvoiceRemainingBalance(f.stack.ctx, f.invoiceId);
    expect(after.allocated).toBe('400.0000');
    expect(after.remaining).toBe('600.0000');

    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    expect(lines.rows).toHaveLength(2);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    expect(totalDebit).toBe(400); // مبلغ الدفعة كاملًا، لا مبلغ التخصيص فقط (قد يختلفان في حالة الدفعة المقدمة)
  });

  it('دفعتان جزئيتان متتاليتان تُسدِّدان الفاتورة بالكامل، والثالثة تُرفض لتجاوز المتبقي', async () => {
    const f = await setupInvoiceFixture('pay-multi');

    const p1 = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '600', receiptAccountId: f.receiptAccountId,
      allocations: [{ salesInvoiceId: f.invoiceId, amount: '600' }],
    });
    await postCustomerPayment(f.stack.ctx, p1.id);

    const p2 = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-15', amount: '400', receiptAccountId: f.receiptAccountId,
      allocations: [{ salesInvoiceId: f.invoiceId, amount: '400' }],
    });
    await postCustomerPayment(f.stack.ctx, p2.id);

    const afterBoth = await getSalesInvoiceRemainingBalance(f.stack.ctx, f.invoiceId);
    expect(afterBoth.remaining).toBe('0.0000');

    await expect(
      createCustomerPayment(f.stack.ctx, {
        branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', paymentDate: '2026-02-20', amount: '1', receiptAccountId: f.receiptAccountId,
        allocations: [{ salesInvoiceId: f.invoiceId, amount: '1' }],
      }),
    ).rejects.toThrow(/يتجاوز المتبقي غير المُحصَّل/);
  });

  it('دفعة مقدمة بلا تخصيص (advance) تُرحَّل بنجاح دون أي فاتورة مرتبطة', async () => {
    const f = await setupInvoiceFixture('pay-advance');
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '500', receiptAccountId: f.receiptAccountId,
      // بلا allocations إطلاقًا
    });
    const result = await postCustomerPayment(f.stack.ctx, payment.id);
    expect(result.journalEntryId).toBeTruthy();

    const allocations = await pool.query(`SELECT count(*) FROM customer_payment_allocations WHERE customer_payment_id=$1`, [payment.id]);
    expect(Number(allocations.rows[0].count)).toBe(0);
  });

  it('يرفض تخصيصًا يتجاوز مبلغ الدفعة نفسها', async () => {
    const f = await setupInvoiceFixture('pay-over-amount');
    await expect(
      createCustomerPayment(f.stack.ctx, {
        branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '100', receiptAccountId: f.receiptAccountId,
        allocations: [{ salesInvoiceId: f.invoiceId, amount: '200' }],
      }),
    ).rejects.toThrow(/يتجاوز مبلغ الدفعة/);
  });

  it('عكس الدفعة يحرِّر التخصيص فيعود المتبقي على الفاتورة كما كان', async () => {
    const f = await setupInvoiceFixture('pay-reverse');
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '400', receiptAccountId: f.receiptAccountId,
      allocations: [{ salesInvoiceId: f.invoiceId, amount: '400' }],
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    expect((await getSalesInvoiceRemainingBalance(f.stack.ctx, f.invoiceId)).remaining).toBe('600.0000');

    await reverseCustomerPayment(f.stack.ctx, payment.id, 'دفعة خاطئة');
    expect((await getSalesInvoiceRemainingBalance(f.stack.ctx, f.invoiceId)).remaining).toBe('1000.0000');
  });

  it('لا يمكن التحصيل مقابل فاتورة غير مرحّلة (draft)', async () => {
    const f = await setupInvoiceFixture('pay-draft-invoice');
    const draftInvoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId: (await createBaseItem(f.stack.companyId)).itemId, uomId: (await createBaseItem(f.stack.companyId)).uomId, quantity: '1', unitPrice: '10' }],
    });

    await expect(
      createCustomerPayment(f.stack.ctx, {
        branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '10', receiptAccountId: f.receiptAccountId,
        allocations: [{ salesInvoiceId: draftInvoice.id, amount: '10' }],
      }),
    ).rejects.toThrow(/غير موجودة أو غير مرحّلة/);
  });

  it('تزامن: طلبا تخصيص متزامنان معًا يتجاوزان المتبقي — أحدهما فقط ينجح (قفل صف الفاتورة يمنع التجاوز)', async () => {
    const f = await setupInvoiceFixture('pay-concurrency');
    // المتبقي = 1000؛ طلبان بـ 700 لكل منهما بالتزامن (المجموع 1400 > 1000)
    const attempts = await Promise.allSettled([
      createCustomerPayment(f.stack.ctx, {
        branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '700', receiptAccountId: f.receiptAccountId,
        allocations: [{ salesInvoiceId: f.invoiceId, amount: '700' }],
      }),
      createCustomerPayment(f.stack.ctx, {
        branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', paymentDate: '2026-02-10', amount: '700', receiptAccountId: f.receiptAccountId,
        allocations: [{ salesInvoiceId: f.invoiceId, amount: '700' }],
      }),
    ]);
    const succeeded = attempts.filter((a) => a.status === 'fulfilled');
    const failed = attempts.filter((a) => a.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const finalAllocated = await getSalesInvoiceRemainingBalance(f.stack.ctx, f.invoiceId);
    expect(finalAllocated.allocated).toBe('700.0000'); // وليس 1400 (لا تجاوز)
  });
});
