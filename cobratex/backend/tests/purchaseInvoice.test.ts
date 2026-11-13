import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { getStockBalance } from '@/modules/inventory/stockService';
import { createPurchaseOrder, transitionPurchaseOrderStatus } from '@/modules/purchasing/purchaseOrderService';
import { createGoodsReceipt, postGoodsReceipt } from '@/modules/purchasing/goodsReceiptService';
import { createSupplierInvoice, postSupplierInvoice, reverseSupplierInvoice } from '@/modules/purchasing/supplierInvoiceService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem } from './helpers';

async function setupPurchaseFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);

  await createPostingRule(stack.ctx, {
    operationType: 'purchase_invoice_inventory',
    debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    creditAccountSourceType: 'SUPPLIER_PAYABLE',
  });

  const supplier = await createSupplier(stack.ctx, { code: `SUP-${prefix}`, nameAr: 'مورد', nameEn: 'Supplier', currencyCode: 'EGP' });

  return { stack, itemId, uomId, categoryId, supplierId: supplier.id, fiscalPeriodId, inventoryAccountId };
}

describe('الفصل بين الاستلام (مخزون فقط) وفاتورة المورد (التزام فقط)', () => {
  it('الاستلام يزيد المخزون فقط بلا أي قيد محاسبي', async () => {
    const f = await setupPurchaseFixture('recv-only');
    const order = await createPurchaseOrder(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, currencyCode: 'EGP', orderDate: '2026-01-01',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '50', unitPrice: '8' }],
    });
    await transitionPurchaseOrderStatus(f.stack.ctx, order.id, 'confirmed');
    const poLine = await pool.query(`SELECT id FROM purchase_order_lines WHERE purchase_order_id=$1`, [order.id]);

    const entriesBefore = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1`, [f.stack.companyId]);

    const receipt = await createGoodsReceipt(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierId: f.supplierId, purchaseOrderId: order.id,
      receiptDate: '2026-01-05',
      lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '50', unitCost: '8', purchaseOrderLineId: poLine.rows[0].id }],
    });
    await postGoodsReceipt(f.stack.ctx, receipt.id);

    const balance = await getStockBalance(f.stack.ctx, f.stack.warehouseId, f.itemId);
    expect(balance.quantity_on_hand).toBe('50.0000');

    const entriesAfter = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1`, [f.stack.companyId]);
    expect(entriesAfter.rows[0].count).toBe(entriesBefore.rows[0].count);

    const orderRow = await pool.query(`SELECT status FROM purchase_orders WHERE id=$1`, [order.id]);
    expect(orderRow.rows[0].status).toBe('received');
  });

  it('فاتورة المورد تُنشئ القيد فقط، ولا تُنشئ أي حركة مخزون جديدة (لا ازدواج)', async () => {
    const f = await setupPurchaseFixture('inv-only');
    const receipt = await createGoodsReceipt(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierId: f.supplierId,
      receiptDate: '2026-01-05', lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '20', unitCost: '10' }],
    });
    await postGoodsReceipt(f.stack.ctx, receipt.id);
    const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);

    const movementsBefore = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1`, [f.stack.companyId]);

    const invoice = await createSupplierInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-01-10',
      lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: '20', unitCost: '10' }],
    });
    const result = await postSupplierInvoice(f.stack.ctx, invoice.id);

    const movementsAfter = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1`, [f.stack.companyId]);
    expect(movementsAfter.rows[0].count).toBe(movementsBefore.rows[0].count);

    const lines = await pool.query(`SELECT debit, credit, account_id FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    expect(lines.rows).toHaveLength(2);
    const inventoryLine = lines.rows.find((l) => l.account_id === f.inventoryAccountId);
    expect(inventoryLine.debit).toBe('200.0000');
  });

  it('يرفض فوترة كمية أكبر من المستلمة (منع الفوترة الزائدة)', async () => {
    const f = await setupPurchaseFixture('over-invoice');
    const receipt = await createGoodsReceipt(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierId: f.supplierId,
      receiptDate: '2026-01-05', lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '10', unitCost: '5' }],
    });
    await postGoodsReceipt(f.stack.ctx, receipt.id);
    const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);

    await expect(
      createSupplierInvoice(f.stack.ctx, {
        branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', invoiceDate: '2026-01-10',
        lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: '999', unitCost: '5' }],
      }),
    ).rejects.toThrow(/تتجاوز الكمية المستلمة غير المفوترة/);
  });

  it('يرفض فوترة نفس الكمية مرتين عبر فاتورتين منفصلتين (منع الازدواج التراكمي)', async () => {
    const f = await setupPurchaseFixture('double-invoice');
    const receipt = await createGoodsReceipt(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierId: f.supplierId,
      receiptDate: '2026-01-05', lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '10', unitCost: '5' }],
    });
    await postGoodsReceipt(f.stack.ctx, receipt.id);
    const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);

    await createSupplierInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-01-10',
      lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: '10', unitCost: '5' }],
    });

    await expect(
      createSupplierInvoice(f.stack.ctx, {
        branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', invoiceDate: '2026-01-11',
        lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: '1', unitCost: '5' }],
      }),
    ).rejects.toThrow(/تتجاوز الكمية المستلمة غير المفوترة/);
  });

  it('عكس فاتورة المورد يحرِّر الكمية المحجوزة فتصبح قابلة للفوترة مجددًا', async () => {
    const f = await setupPurchaseFixture('reverse-frees');
    const receipt = await createGoodsReceipt(f.stack.ctx, {
      branchId: f.stack.branchId, warehouseId: f.stack.warehouseId, supplierId: f.supplierId,
      receiptDate: '2026-01-05', lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '10', unitCost: '5' }],
    });
    await postGoodsReceipt(f.stack.ctx, receipt.id);
    const receiptLine = await pool.query(`SELECT id FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receipt.id]);

    const invoice = await createSupplierInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-01-10',
      lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: '10', unitCost: '5' }],
    });
    await postSupplierInvoice(f.stack.ctx, invoice.id);
    await reverseSupplierInvoice(f.stack.ctx, invoice.id, 'خطأ في الفاتورة');

    const newInvoice = await createSupplierInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-01-12',
      lines: [{ goodsReceiptLineId: receiptLine.rows[0].id, quantity: '10', unitCost: '5' }],
    });
    expect(newInvoice.id).toBeTruthy();
  });
});
