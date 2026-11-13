import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createTaxType } from '@/modules/accounting/taxService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { getStockBalance } from '@/modules/inventory/stockService';
import { createGoodsReceipt, postGoodsReceipt } from '@/modules/purchasing/goodsReceiptService';
import { createSupplierInvoice, postSupplierInvoice } from '@/modules/purchasing/supplierInvoiceService';
import { createPurchaseReturn, postPurchaseReturn, reversePurchaseReturn } from '@/modules/purchasing/purchaseReturnService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem, createLimitedPermissionUser } from './helpers';

const app = createApp();

async function setupPurchaseReturnFixture(prefix: string, currencyCode = 'EGP', exchangeRate = '1') {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);

  const taxAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1300','ضريبة مشتريات قابلة للخصم','Input Tax','asset') RETURNING id`,
    [stack.companyId],
  );
  const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة', nameEn: 'VAT', initialRatePercent: '14', effectiveFrom: '2026-01-01' });

  await createPostingRule(stack.ctx, {
    operationType: 'purchase_invoice_inventory', debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', creditAccountSourceType: 'SUPPLIER_PAYABLE',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'purchase_invoice_tax', debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: taxAccount.rows[0].id,
    creditAccountSourceType: 'SUPPLIER_PAYABLE',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'purchase_return_inventory', debitAccountSourceType: 'SUPPLIER_PAYABLE', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });
  await createPostingRule(stack.ctx, {
    operationType: 'purchase_return_tax', debitAccountSourceType: 'SUPPLIER_PAYABLE', creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: taxAccount.rows[0].id,
  });

  const supplier = await createSupplier(stack.ctx, { code: `SUP-${prefix}`, nameAr: 'مورد', nameEn: 'Supplier', currencyCode: 'EGP' });

  return { stack, itemId, uomId, categoryId, supplierId: supplier.id, taxId: tax.id, fiscalPeriodId, inventoryAccountId, taxAccountId: taxAccount.rows[0].id, currencyCode, exchangeRate };
}

async function receiveAndInvoice(f: Awaited<ReturnType<typeof setupPurchaseReturnFixture>>, quantity: string, unitCost: string, withTax = true) {
  const receipt = await createGoodsReceipt(f.stack.ctx, {
    branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierId: f.supplierId,
    receiptDate: '2026-01-10', lines: [{ itemId: f.itemId, uomId: f.uomId, quantity, unitCost }],
  });
  await postGoodsReceipt(f.stack.ctx, receipt.id);
  const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);

  const invoice = await createSupplierInvoice(f.stack.ctx, {
    branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
    currencyCode: f.currencyCode, exchangeRate: f.exchangeRate, invoiceDate: '2026-01-15',
    lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity, unitCost, taxTypeId: withTax ? f.taxId : undefined }],
  });
  await postSupplierInvoice(f.stack.ctx, invoice.id);
  const invoiceLine = await pool.query(`SELECT id FROM supplier_invoice_lines WHERE supplier_invoice_id=$1`, [invoice.id]);
  return { invoice, lineId: invoiceLine.rows[0].id };
}

describe('مرتجع الشراء الجزئي المستقل', () => {
  it('مرتجع جزئي بضريبة: يصرف المخزون ويعكس الالتزام والضريبة بقيد متوازن', async () => {
    const f = await setupPurchaseReturnFixture('pret-partial');
    const { invoice, lineId } = await receiveAndInvoice(f, '20', '15'); // subtotal=300, tax=42

    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '8' }],
    });
    const result = await postPurchaseReturn(f.stack.ctx, ret.id);
    // subtotal=8*15=120, tax=16.80
    expect(result.totalTax).toBe('16.8000');

    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBeCloseTo(136.8, 4);

    const balance = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(balance.quantity_on_hand).toBe('12.0000'); // 20 - 8
  });

  it('مرتجع كامل يمنع أي إرجاع إضافي', async () => {
    const f = await setupPurchaseReturnFixture('pret-full');
    const { invoice, lineId } = await receiveAndInvoice(f, '5', '10', false);
    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '5' }],
    });
    await postPurchaseReturn(f.stack.ctx, ret.id);

    await expect(
      createPurchaseReturn(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-21',
        lines: [{ supplierInvoiceLineId: lineId, quantity: '0.0001' }],
      }),
    ).rejects.toThrow(/تتجاوز الكمية القابلة للإرجاع/);
  });

  it('يرفض كمية مرتجعة تتجاوز المشترى أصلًا، ولا ازدواج مع حركات الاستلام', async () => {
    const f = await setupPurchaseReturnFixture('pret-over');
    const { invoice, lineId } = await receiveAndInvoice(f, '5', '10', false);
    await expect(
      createPurchaseReturn(f.stack.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
        lines: [{ supplierInvoiceLineId: lineId, quantity: '999' }],
      }),
    ).rejects.toThrow(/تتجاوز الكمية القابلة للإرجاع/);
  });

  it('تزامن: مرتجعا شراء متزامنان يتجاوزان معًا المتبقي — أحدهما فقط ينجح', async () => {
    const f = await setupPurchaseReturnFixture('pret-concurrent');
    const { invoice, lineId } = await receiveAndInvoice(f, '10', '10', false);

    const attempt = (qty: string) => createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: qty }],
    });
    const results = await Promise.allSettled([attempt('6'), attempt('6')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('عملة أجنبية: المرتجع يرث عملة وسعر صرف فاتورة المورد الأصلية', async () => {
    const f = await setupPurchaseReturnFixture('pret-fx', 'USD', '50');
    const { invoice, lineId } = await receiveAndInvoice(f, '4', '25', false);
    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '2' }],
    });
    expect(ret.currency_code).toBe('USD');
    const posted = await postPurchaseReturn(f.stack.ctx, ret.id);
    const journal = await pool.query(`SELECT currency_code FROM journal_entries WHERE id=$1`, [posted.journalEntryId]);
    expect(journal.rows[0].currency_code).toBe('USD');
  });

  it('عكس مرتجع الشراء: يستعيد المخزون فعليًا (حركة وارد مقابلة)، ويحرِّر الكمية للإرجاع مجددًا', async () => {
    const f = await setupPurchaseReturnFixture('pret-reverse');
    const { invoice, lineId } = await receiveAndInvoice(f, '10', '10', false);
    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '4' }],
    });
    await postPurchaseReturn(f.stack.ctx, ret.id);
    const balanceAfterReturn = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);

    await reversePurchaseReturn(f.stack.ctx, ret.id, 'خطأ في المرتجع');
    const balanceAfterReversal = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(Number(balanceAfterReversal.quantity_on_hand) - Number(balanceAfterReturn.quantity_on_hand)).toBe(4);

    const lineRow = await pool.query(`SELECT returned_quantity FROM supplier_invoice_lines WHERE id=$1`, [lineId]);
    expect(lineRow.rows[0].returned_quantity).toBe('0.0000');
  });

  it('Idempotent عبر HTTP لترحيل مرتجع الشراء', async () => {
    const f = await setupPurchaseReturnFixture('pret-idem');
    const { invoice, lineId } = await receiveAndInvoice(f, '5', '10', false);
    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '2' }],
    });
    const key = 'purchase-return-post-key';
    const first = await request(app).post(`/api/purchasing/returns/${ret.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    const second = await request(app).post(`/api/purchasing/returns/${ret.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const entries = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, ret.id]);
    expect(Number(entries.rows[0].count)).toBe(1);
  });

  it('RBAC: 403 لمستخدم بلا purchasing.return.create', async () => {
    const f = await setupPurchaseReturnFixture('pret-rbac');
    const { invoice, lineId } = await receiveAndInvoice(f, '5', '10', false);
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, []);
    await expect(
      createPurchaseReturn(limited.ctx, {
        branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
        lines: [{ supplierInvoiceLineId: lineId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('عزل الفرع لمرتجع الشراء', async () => {
    const f = await setupPurchaseReturnFixture('pret-branch-iso');
    const { invoice, lineId } = await receiveAndInvoice(f, '5', '10', false);
    const otherBranch = await pool.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,'فرع آخر','Other Branch') RETURNING id`, [f.stack.companyId],
    );
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['purchasing.return.create']);
    await expect(
      createPurchaseReturn(limited.ctx, {
        branchId: otherBranch.rows[0].id, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
        fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
        lines: [{ supplierInvoiceLineId: lineId, quantity: '1' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('يسجّل إنشاء وترحيل وعكس مرتجع الشراء في سجل التدقيق', async () => {
    const f = await setupPurchaseReturnFixture('pret-audit');
    const { invoice, lineId } = await receiveAndInvoice(f, '5', '10', false);
    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '2' }],
    });
    await postPurchaseReturn(f.stack.ctx, ret.id);
    await reversePurchaseReturn(f.stack.ctx, ret.id, 'اختبار');
    const logs = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_type='purchase_return' AND entity_id=$1 ORDER BY created_at ASC`, [ret.id],
    );
    expect(logs.rows.map((r) => r.action)).toEqual(['create', 'post', 'reverse']);
  });

  it('الرصيد المستحق لفاتورة المورد يتحدَّث بصورة صحيحة بعد مرتجع جزئي', async () => {
    const f = await setupPurchaseReturnFixture('pret-balance');
    const { invoice, lineId } = await receiveAndInvoice(f, '10', '50', false); // إجمالي 500

    const ret = await createPurchaseReturn(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierInvoiceId: invoice.id,
      fiscalPeriodId: f.fiscalPeriodId, returnDate: '2026-01-20',
      lines: [{ supplierInvoiceLineId: lineId, quantity: '4' }], // 200
    });
    await postPurchaseReturn(f.stack.ctx, ret.id);

    const balanceRes = await request(app).get(`/api/purchasing/invoices/${invoice.id}/remaining-balance`).set('Authorization', `Bearer ${f.stack.token}`);
    expect(balanceRes.body.total).toBe('300.0000'); // 500 - 200
    expect(balanceRes.body.remaining).toBe('300.0000'); // لا دفعات بعد
  });
});
