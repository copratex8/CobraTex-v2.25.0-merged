import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createTaxType } from '@/modules/accounting/taxService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement, getStockBalance } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice, reverseSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem } from './helpers';

const app = createApp();

async function setupSalesFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { cashAccountId, revenueAccountId, inventoryAccountId, cogsAccountId, payableAccountId, fiscalPeriodId } =
    await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);

  const taxAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'2100','ضريبة المبيعات المستحقة','Sales Tax Payable','liability') RETURNING id`,
    [stack.companyId],
  );
  const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة القيمة المضافة', nameEn: 'VAT', initialRatePercent: '14', effectiveFrom: '2026-01-01' });

  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_revenue',
    debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_tax',
    debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: taxAccount.rows[0].id,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_cogs',
    debitAccountSourceType: 'ITEM_CATEGORY_COGS',
    creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });

  const customer = await createCustomer(stack.ctx, { code: `CUST-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });

  // رصيد افتتاحي: 100 وحدة بتكلفة 20 (متوسط مرجح = 20)
  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
    quantity: '100', unitCost: '20', movementDate: '2026-01-05', sourceDocumentType: 'opening', movementType: 'opening',
  });

  return { stack, itemId, uomId, categoryId, customerId: customer.id, taxId: tax.id, fiscalPeriodId, cashAccountId, revenueAccountId, taxAccountId: taxAccount.rows[0].id, inventoryAccountId, cogsAccountId, payableAccountId };
}

describe('فاتورة البيع — القيد الرباعي الكامل (عملاء/إيراد/ضريبة/تكلفة مبيعات/مخزون)', () => {
  it('ترحيل فاتورة ببند واحد خاضع للضريبة ينتج قيدًا متوازنًا بالمبالغ الصحيحة، ويصرف المخزون بالمتوسط المرجح', async () => {
    const f = await setupSalesFixture('sinv-happy');

    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId,
      fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '10', unitPrice: '50', taxTypeId: f.taxId }],
    });
    // subtotal = 10*50 = 500, ضريبة 14% = 70, الإجمالي = 570
    expect(invoice.status).toBe('draft');

    const result = await postSalesInvoice(f.stack.ctx, invoice.id);
    expect(result.totalRevenue).toBe('500.0000');
    expect(result.totalTax).toBe('70.0000');

    const lines = await pool.query(`SELECT * FROM journal_lines WHERE journal_entry_id=$1 ORDER BY debit DESC, credit DESC`, [result.journalEntryId]);
    // 4 أسطر: مدين عميل (500)، مدين عميل (70)، مدين تكلفة مبيعات (200)، دائن إيراد (500)، دائن ضريبة (70)، دائن مخزون (200)
    expect(lines.rows).toHaveLength(6);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit); // متوازن تمامًا
    expect(totalDebit).toBe(770); // 500+70+200 = 770 (تكلفة المبيعات 10 وحدات × 20 = 200)

    const revenueLine = lines.rows.find((l) => l.account_id === f.revenueAccountId);
    expect(revenueLine.credit).toBe('500.0000');
    const taxLine = lines.rows.find((l) => l.account_id === f.taxAccountId);
    expect(taxLine.credit).toBe('70.0000');
    const cogsLine = lines.rows.find((l) => l.account_id === f.cogsAccountId);
    expect(cogsLine.debit).toBe('200.0000');
    const inventoryLine = lines.rows.find((l) => l.account_id === f.inventoryAccountId);
    expect(inventoryLine.credit).toBe('200.0000');

    const balance = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(balance.quantity_on_hand).toBe('90.0000'); // 100 - 10

    const invoiceRow = await pool.query(`SELECT status, journal_entry_id FROM sales_invoices WHERE id=$1`, [invoice.id]);
    expect(invoiceRow.rows[0].status).toBe('posted');
    expect(invoiceRow.rows[0].journal_entry_id).toBe(result.journalEntryId);
  });

  it('يرفض ترحيل فاتورة بكمية تفوق الرصيد المتاح، ولا يترك أي أثر جزئي (لا حركة مخزون ولا قيد)', async () => {
    const f = await setupSalesFixture('sinv-insufficient');
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId,
      fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '9999', unitPrice: '50' }],
    });

    await expect(postSalesInvoice(f.stack.ctx, invoice.id)).rejects.toThrow(/الكمية المتاحة غير كافية/);

    const invoiceRow = await pool.query(`SELECT status FROM sales_invoices WHERE id=$1`, [invoice.id]);
    expect(invoiceRow.rows[0].status).toBe('draft'); // لم يتغير
    const movements = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, invoice.id]);
    expect(Number(movements.rows[0].count)).toBe(0);
    const entries = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, invoice.id]);
    expect(Number(entries.rows[0].count)).toBe(0);
  });

  it('عكس فاتورة مرحّلة يعيد المخزون بنفس التكلفة ويعكس القيد، دون حذف أي سجل', async () => {
    const f = await setupSalesFixture('sinv-reverse');
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId,
      fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '10', unitPrice: '50' }],
    });
    await postSalesInvoice(f.stack.ctx, invoice.id);

    const balanceAfterSale = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(balanceAfterSale.quantity_on_hand).toBe('90.0000');

    const reversed = await reverseSalesInvoice(f.stack.ctx, invoice.id, 'خطأ في الفاتورة');
    expect(reversed.status).toBe('reversed');

    const balanceAfterReversal = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(balanceAfterReversal.quantity_on_hand).toBe('100.0000'); // عاد الرصيد كاملًا

    const invoiceRow = await pool.query(`SELECT status FROM sales_invoices WHERE id=$1`, [invoice.id]);
    expect(invoiceRow.rows[0].status).toBe('reversed');
  });

  it('Idempotent: إعادة إرسال طلب الترحيل بنفس Idempotency-Key عبر HTTP لا يُنشئ قيدًا أو حركة مخزون مكررة', async () => {
    const f = await setupSalesFixture('sinv-idem');
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId,
      fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '5', unitPrice: '50' }],
    });

    const key = 'post-invoice-key-1';
    const first = await request(app).post(`/api/sales/invoices/${invoice.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    expect(first.status).toBe(200);

    const second = await request(app).post(`/api/sales/invoices/${invoice.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const entries = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, invoice.id]);
    expect(Number(entries.rows[0].count)).toBe(1);
    const movements = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, invoice.id]);
    expect(Number(movements.rows[0].count)).toBe(1);
  });

  it('يمنع الترحيل إذا كانت مجموعة الصنف بلا حساب مخزون/تكلفة معرَّف (رسالة واضحة بدل فشل غامض)', async () => {
    const stack = await createFullTenantStack('sinv-missing-accounts');
    const { itemId, uomId } = await createBaseItem(stack.companyId); // بلا category_id
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'C-NOACC', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '10', unitCost: '5', movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });

    const invoice = await createSalesInvoice(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id,
      fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [{ itemId, uomId, quantity: '1', unitPrice: '10' }],
    });

    await expect(postSalesInvoice(stack.ctx, invoice.id)).rejects.toThrow(/بلا مجموعة صنف/);
  });
});
