import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import {
  createCustomerPayment, postCustomerPayment, allocateAdvancePayment as allocateCustomerAdvance, getSalesInvoiceRemainingBalance,
} from '@/modules/sales/customerPaymentService';
import { createGoodsReceipt, postGoodsReceipt } from '@/modules/purchasing/goodsReceiptService';
import { createSupplierInvoice, postSupplierInvoice } from '@/modules/purchasing/supplierInvoiceService';
import {
  createSupplierPayment, postSupplierPayment, allocateAdvancePayment as allocateSupplierAdvance, getSupplierInvoiceRemainingBalance,
} from '@/modules/purchasing/supplierPaymentService';
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
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1010','الخزينة','Cash Box','asset') RETURNING id`,
    [stack.companyId],
  );
  const customer = await createCustomer(stack.ctx, { code: `ADV-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });
  await recordInMovement(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, itemId, quantity: '100', unitCost: '10',
    movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });

  async function makeInvoice(total: number) {
    const invoice = await createSalesInvoice(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id, fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-02-01',
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
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1011','البنك','Bank','asset') RETURNING id`,
    [stack.companyId],
  );
  const supplier = await createSupplier(stack.ctx, { code: `ADVS-${prefix}`, nameAr: 'مورد', nameEn: 'Supplier', currencyCode: 'EGP' });

  async function makeInvoice(total: number) {
    const receipt = await createGoodsReceipt(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, supplierId: supplier.id, receiptDate: '2026-02-01',
      lines: [{ itemId, uomId, quantity: String(total / 50), unitCost: '50' }],
    });
    await postGoodsReceipt(stack.ctx, receipt.id);
    const fullReceipt = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);
    const invoice = await createSupplierInvoice(stack.ctx, {
      branchId: stack.branchId, supplierId: supplier.id, fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-05',
      lines: [{ goodsReceiptLineId: fullReceipt.rows[0].id, quantity: String(total / 50), unitCost: '50' }],
    });
    await postSupplierInvoice(stack.ctx, invoice.id);
    return invoice.id;
  }

  return { stack, fiscalPeriodId, supplierId: supplier.id, paymentAccountId: bankAccount.rows[0].id, makeInvoice };
}

describe('تخصيص الدفعة المقدمة لاحقًا — العملاء', () => {
  it('دفعة مقدمة بلا تخصيص عند الإنشاء، ثم تُخصَّص لفاتورة لاحقة بالكامل', async () => {
    const f = await setupSalesFixture('adv-c-full');
    const invoiceId = await f.makeInvoice(1000);

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);

    const before = await getSalesInvoiceRemainingBalance(f.stack.ctx, invoiceId);
    expect(before.allocated).toBe('0.0000');

    await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '1000' }]);
    const after = await getSalesInvoiceRemainingBalance(f.stack.ctx, invoiceId);
    expect(after.allocated).toBe('1000.0000');
    expect(after.remaining).toBe('0.0000');
  });

  it('دفعة مقدمة تُخصَّص جزئيًا لأكثر من فاتورة عبر أكثر من نداء', async () => {
    const f = await setupSalesFixture('adv-c-multi');
    const invoice1 = await f.makeInvoice(600);
    const invoice2 = await f.makeInvoice(400);

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);

    await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoice1, amount: '600' }]);
    await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoice2, amount: '400' }]);

    const r1 = await getSalesInvoiceRemainingBalance(f.stack.ctx, invoice1);
    const r2 = await getSalesInvoiceRemainingBalance(f.stack.ctx, invoice2);
    expect(r1.remaining).toBe('0.0000');
    expect(r2.remaining).toBe('0.0000');
  });

  it('يرفض تخصيصًا يتجاوز المتبقي غير المخصَّص من الدفعة نفسها', async () => {
    const f = await setupSalesFixture('adv-c-overpay');
    const invoice1 = await f.makeInvoice(1000);
    const invoice2 = await f.makeInvoice(1000);

    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);

    await allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoice1, amount: '700' }]);
    await expect(allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoice2, amount: '400' }])).rejects.toThrow();
  });

  it('يرفض تخصيصًا يتجاوز المتبقي غير المُحصَّل من الفاتورة نفسها', async () => {
    const f = await setupSalesFixture('adv-c-overinvoice');
    const invoiceId = await f.makeInvoice(500);
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    await expect(allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '600' }])).rejects.toThrow();
  });

  it('يرفض التخصيص إن كانت الدفعة لا تزال draft (لم تُحصَّل بعد)', async () => {
    const f = await setupSalesFixture('adv-c-draft');
    const invoiceId = await f.makeInvoice(500);
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '500', receiptAccountId: f.receiptAccountId,
    });
    await expect(allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '500' }])).rejects.toThrow();
  });

  it('تخصيصان متزامنان على نفس الدفعة: واحد فقط ينجح إن تجاوز المجموع المتبقي', async () => {
    const f = await setupSalesFixture('adv-c-concurrent');
    const invoice1 = await f.makeInvoice(1000);
    const invoice2 = await f.makeInvoice(1000);
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '1000', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);

    const results = await Promise.allSettled([
      allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoice1, amount: '900' }]),
      allocateCustomerAdvance(f.stack.ctx, payment.id, [{ salesInvoiceId: invoice2, amount: '900' }]),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('RBAC: مستخدم بلا صلاحية sales.payment.allocate يُمنع من التخصيص', async () => {
    const f = await setupSalesFixture('adv-c-rbac');
    const invoiceId = await f.makeInvoice(500);
    const payment = await createCustomerPayment(f.stack.ctx, {
      branchId: f.stack.branchId, customerId: f.customerId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '500', receiptAccountId: f.receiptAccountId,
    });
    await postCustomerPayment(f.stack.ctx, payment.id);
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['sales.payment.view']);
    await expect(allocateCustomerAdvance(limited.ctx, payment.id, [{ salesInvoiceId: invoiceId, amount: '500' }])).rejects.toThrow();
  });
});

describe('تخصيص الدفعة المقدمة لاحقًا — الموردون', () => {
  it('دفعة مقدمة لمورد تُخصَّص لاحقًا لفاتورة مورد بالكامل', async () => {
    const f = await setupPurchaseFixture('adv-s-full');
    const invoiceId = await f.makeInvoice(500);

    const payment = await createSupplierPayment(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '500', paymentAccountId: f.paymentAccountId,
    });
    await postSupplierPayment(f.stack.ctx, payment.id);

    const before = await getSupplierInvoiceRemainingBalance(f.stack.ctx, invoiceId);
    expect(before.allocated).toBe('0.0000');

    await allocateSupplierAdvance(f.stack.ctx, payment.id, [{ supplierInvoiceId: invoiceId, amount: '500' }]);
    const after = await getSupplierInvoiceRemainingBalance(f.stack.ctx, invoiceId);
    expect(after.remaining).toBe('0.0000');
  });

  it('يرفض تخصيص مبلغ يتجاوز متبقي الدفعة غير المخصَّص للموردين أيضًا', async () => {
    const f = await setupPurchaseFixture('adv-s-overpay');
    const invoice1 = await f.makeInvoice(500);
    const invoice2 = await f.makeInvoice(500);
    const payment = await createSupplierPayment(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '500', paymentAccountId: f.paymentAccountId,
    });
    await postSupplierPayment(f.stack.ctx, payment.id);
    await allocateSupplierAdvance(f.stack.ctx, payment.id, [{ supplierInvoiceId: invoice1, amount: '400' }]);
    await expect(allocateSupplierAdvance(f.stack.ctx, payment.id, [{ supplierInvoiceId: invoice2, amount: '200' }])).rejects.toThrow();
  });

  it('عزل الفرع: مستخدم من فرع آخر بلا نطاق على فرع الدفعة يُمنع من التخصيص', async () => {
    const f = await setupPurchaseFixture('adv-s-branch');
    const invoiceId = await f.makeInvoice(300);
    const payment = await createSupplierPayment(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', paymentDate: '2026-01-15', amount: '300', paymentAccountId: f.paymentAccountId,
    });
    await postSupplierPayment(f.stack.ctx, payment.id);

    const otherBranch = await pool.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,'فرع آخر','Other Branch') RETURNING id`,
      [f.stack.companyId],
    );
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, otherBranch.rows[0].id, ['purchasing.payment.allocate']);
    await expect(allocateSupplierAdvance(limited.ctx, payment.id, [{ supplierInvoiceId: invoiceId, amount: '300' }])).rejects.toThrow();
  });
});
