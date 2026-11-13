import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createTaxType } from '@/modules/accounting/taxService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement, getStockBalance } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createSalesReturn, postSalesReturn, reverseSalesReturn } from '@/modules/sales/salesReturnService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser } from './helpers';

const app = createApp();

async function setupReturnFixture(prefix: string, currencyCode = 'EGP', exchangeRate = '1') {
  const stack = await createFullTenantStack(prefix);
  const { revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);

  const taxAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'2100','ضريبة مستحقة','Tax Payable','liability') RETURNING id`,
    [stack.companyId],
  );
  const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة', nameEn: 'VAT', initialRatePercent: '14', effectiveFrom: '2026-01-01' });

  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_revenue', debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_tax', debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: taxAccount.rows[0].id,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_cogs', debitAccountSourceType: 'ITEM_CATEGORY_COGS', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_return_revenue', debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: revenueAccountId,
    creditAccountSourceType: 'CUSTOMER_RECEIVABLE',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_return_tax', debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: taxAccount.rows[0].id,
    creditAccountSourceType: 'CUSTOMER_RECEIVABLE',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_return_cogs', debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', creditAccountSourceType: 'ITEM_CATEGORY_COGS',
  });

  const customer = await createCustomer(stack.ctx, { code: `CUST-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });

  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
    quantity: '1000', unitCost: '20', movementDate: '2026-01-05', sourceDocumentType: 'opening',
  });

  return { stack, itemId, uomId, categoryId, customerId: customer.id, taxId: tax.id, fiscalPeriodId, revenueAccountId, taxAccountId: taxAccount.rows[0].id, inventoryAccountId, cogsAccountId, currencyCode, exchangeRate };
}

async function createAndPostInvoice(f: Awaited<ReturnType<typeof setupReturnFixture>>, quantity: string, unitPrice: string, withTax = true) {
  const invoice = await createSalesInvoice(f.stack.ctx, {
    branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId,
    fiscalPeriodId: f.fiscalPeriodId, currencyCode: f.currencyCode, exchangeRate: f.exchangeRate, invoiceDate: '2026-02-01',
    lines: [{ itemId: f.itemId, uomId: f.uomId, quantity, unitPrice, taxTypeId: withTax ? f.taxId : undefined }],
  });
  await postSalesInvoice(f.stack.ctx, invoice.id);
  const line = await pool.query(`SELECT id FROM sales_invoice_lines WHERE sales_invoice_id=$1`, [invoice.id]);
  return { invoice, lineId: line.rows[0].id };
}

describe('مرتجع البيع الجزئي المستقل', () => {
  it('مرتجع جزئي بضريبة: يستعيد المخزون بتكلفة الفاتورة الأصلية، وقيد عكسي متوازن', async () => {
    const f = await setupReturnFixture('sret-partial');
    const { invoice, lineId } = await createAndPostInvoice(f, '10', '50');

    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '4' }],
    });
    const result = await postSalesReturn(f.stack.ctx, ret.id);
    expect(result.totalRevenue).toBe('200.0000');
    expect(result.totalTax).toBe('28.0000');

    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(308);

    const balance = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(balance.quantity_on_hand).toBe('994.0000');
  });

  it('مرتجع كامل يُغلق المتبقي القابل للإرجاع بالكامل', async () => {
    const f = await setupReturnFixture('sret-full');
    const { invoice, lineId } = await createAndPostInvoice(f, '5', '30', false);

    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '5' }],
    });
    await postSalesReturn(f.stack.ctx, ret.id);

    const lineRow = await pool.query(`SELECT returned_quantity FROM sales_invoice_lines WHERE id=$1`, [lineId]);
    expect(lineRow.rows[0].returned_quantity).toBe('5.0000');

    await expect(
      createSalesReturn(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-11',
        lines: [{ salesInvoiceLineId: lineId, quantity: '0.0001' }],
      }),
    ).rejects.toThrow(/تتجاوز الكمية القابلة للإرجاع/);
  });

  it('مرتجع متعدد الأسطر من فاتورة متعددة الأسطر', async () => {
    const f = await setupReturnFixture('sret-multiline');
    const invoice = await createSalesInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, customerId: f.customerId,
      fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      lines: [
        { itemId: f.itemId, uomId: f.uomId, quantity: '10', unitPrice: '10' },
        { itemId: f.itemId, uomId: f.uomId, quantity: '20', unitPrice: '15' },
      ],
    });
    await postSalesInvoice(f.stack.ctx, invoice.id);
    const lines = await pool.query(`SELECT id FROM sales_invoice_lines WHERE sales_invoice_id=$1 ORDER BY unit_price`, [invoice.id]);

    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [
        { salesInvoiceLineId: lines.rows[0].id, quantity: '3' },
        { salesInvoiceLineId: lines.rows[1].id, quantity: '5' },
      ],
    });
    const result = await postSalesReturn(f.stack.ctx, ret.id);
    expect(result.totalRevenue).toBe('105.0000');
  });

  it('يرفض كمية مرتجعة تتجاوز المباع أصلًا', async () => {
    const f = await setupReturnFixture('sret-over');
    const { invoice, lineId } = await createAndPostInvoice(f, '5', '10');
    await expect(
      createSalesReturn(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
        lines: [{ salesInvoiceLineId: lineId, quantity: '999' }],
      }),
    ).rejects.toThrow(/تتجاوز الكمية القابلة للإرجاع/);
  });

  it('تزامن: مرتجعان متزامنان يتجاوزان معًا المتبقي — أحدهما فقط ينجح', async () => {
    const f = await setupReturnFixture('sret-concurrent');
    const { invoice, lineId } = await createAndPostInvoice(f, '10', '10');

    const attempt = (qty: string) => createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: qty }],
    });

    const results = await Promise.allSettled([attempt('7'), attempt('7')]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const lineRow = await pool.query(`SELECT returned_quantity FROM sales_invoice_lines WHERE id=$1`, [lineId]);
    expect(lineRow.rows[0].returned_quantity).toBe('7.0000');
  });

  it('عملة أجنبية: المرتجع يرث عملة وسعر صرف الفاتورة الأصلية تلقائيًا', async () => {
    const f = await setupReturnFixture('sret-fx', 'USD', '50');
    const { invoice, lineId } = await createAndPostInvoice(f, '2', '100', false);

    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '1' }],
    });
    expect(ret.currency_code).toBe('USD');
    expect(ret.exchange_rate).toBe('50.000000');

    const posted = await postSalesReturn(f.stack.ctx, ret.id);
    const journal = await pool.query(`SELECT currency_code FROM journal_entries WHERE id=$1`, [posted.journalEntryId]);
    expect(journal.rows[0].currency_code).toBe('USD');
  });

  it('عكس المرتجع: يصرف المخزون المُستعاد فعليًا مجددًا، ويعكس القيد، ويُحرِّر الكمية للإرجاع مجددًا', async () => {
    const f = await setupReturnFixture('sret-reverse');
    const { invoice, lineId } = await createAndPostInvoice(f, '10', '20', false);

    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '6' }],
    });
    await postSalesReturn(f.stack.ctx, ret.id);
    const balanceAfterReturn = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);

    await reverseSalesReturn(f.stack.ctx, ret.id, 'خطأ في المرتجع');

    const balanceAfterReversal = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    const diff = Number(balanceAfterReturn.quantity_on_hand) - Number(balanceAfterReversal.quantity_on_hand);
    expect(diff).toBe(6);

    const lineRow = await pool.query(`SELECT returned_quantity FROM sales_invoice_lines WHERE id=$1`, [lineId]);
    expect(lineRow.rows[0].returned_quantity).toBe('0.0000');

    const retRow = await pool.query(`SELECT status FROM sales_returns WHERE id=$1`, [ret.id]);
    expect(retRow.rows[0].status).toBe('reversed');
  });

  it('لا يمكن تعديل قيد مرتجع مرحّل مباشرة (الحماية الموروثة تنطبق)', async () => {
    const f = await setupReturnFixture('sret-immutable');
    const { invoice, lineId } = await createAndPostInvoice(f, '3', '10', false);
    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '1' }],
    });
    const posted = await postSalesReturn(f.stack.ctx, ret.id);

    await expect(
      pool.query(`UPDATE journal_entries SET currency_code='USD' WHERE id=$1`, [posted.journalEntryId]),
    ).rejects.toThrow(/لا يمكن تعديل بيانات قيد مرحّل/);
  });

  it('Idempotent عبر HTTP: إعادة إرسال طلب ترحيل المرتجع بنفس المفتاح لا يكرر الأثر', async () => {
    const f = await setupReturnFixture('sret-idem');
    const { invoice, lineId } = await createAndPostInvoice(f, '5', '10', false);
    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '2' }],
    });

    const key = 'return-post-key-1';
    const first = await request(app).post(`/api/sales/returns/${ret.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    const second = await request(app).post(`/api/sales/returns/${ret.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const entries = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, ret.id]);
    expect(Number(entries.rows[0].count)).toBe(1);
  });

  it('RBAC: 403 لمستخدم بلا sales.return.create', async () => {
    const f = await setupReturnFixture('sret-rbac');
    const { invoice, lineId } = await createAndPostInvoice(f, '5', '10', false);
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, []);

    await expect(
      createSalesReturn(limited.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
        lines: [{ salesInvoiceLineId: lineId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('عزل الفرع: مستخدم يُمنع من إنشاء مرتجع على فرع لا يملك صلاحيته', async () => {
    const f = await setupReturnFixture('sret-branch-iso');
    const { invoice, lineId } = await createAndPostInvoice(f, '5', '10', false);
    const otherBranch = await pool.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,'فرع آخر','Other Branch') RETURNING id`,
      [f.stack.companyId],
    );
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['sales.return.create']);

    await expect(
      createSalesReturn(limited.ctx, {
        branchId: otherBranch.rows[0].id, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
        lines: [{ salesInvoiceLineId: lineId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('يسجّل إنشاء وترحيل وعكس المرتجع في سجل التدقيق', async () => {
    const f = await setupReturnFixture('sret-audit');
    const { invoice, lineId } = await createAndPostInvoice(f, '5', '10', false);
    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '2' }],
    });
    await postSalesReturn(f.stack.ctx, ret.id);
    await reverseSalesReturn(f.stack.ctx, ret.id, 'اختبار تدقيق');

    const logs = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_type='sales_return' AND entity_id=$1 ORDER BY created_at ASC`, [ret.id],
    );
    expect(logs.rows.map((r) => r.action)).toEqual(['create', 'post', 'reverse']);
  });

  it('الرصيد المستحق للفاتورة يتحدَّث بصورة صحيحة بعد مرتجع جزئي بعد دفعة جزئية', async () => {
    const f = await setupReturnFixture('sret-balance-after-payment');
    const { invoice, lineId } = await createAndPostInvoice(f, '10', '100', false);

    const payRes = await request(app).post('/api/sales/payments').set('Authorization', `Bearer ${f.stack.token}`).send({
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-02-05', amount: '400',
      receiptAccountId: f.revenueAccountId,
      allocations: [{ salesInvoiceId: invoice.id, amount: '400' }],
    });
    expect(payRes.status).toBe(201);

    const ret = await createSalesReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, salesInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-02-10',
      lines: [{ salesInvoiceLineId: lineId, quantity: '3' }],
    });
    await postSalesReturn(f.stack.ctx, ret.id);

    const balanceRes = await request(app).get(`/api/sales/invoices/${invoice.id}/remaining-balance`).set('Authorization', `Bearer ${f.stack.token}`);
    expect(balanceRes.body.total).toBe('700.0000');
    expect(balanceRes.body.remaining).toBe('300.0000');
  });
});
