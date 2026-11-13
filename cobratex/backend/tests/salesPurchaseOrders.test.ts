import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createQuotation, transitionQuotationStatus } from '@/modules/sales/quotationService';
import { createSalesOrder, transitionSalesOrderStatus } from '@/modules/sales/salesOrderService';
import { createPurchaseOrder, transitionPurchaseOrderStatus } from '@/modules/purchasing/purchaseOrderService';
import { createFullTenantStack, createBaseItem, createLimitedPermissionUser } from './helpers';

async function countFinancialSideEffects(companyId: string) {
  const movements = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1`, [companyId]);
  const entries = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1`, [companyId]);
  return { movements: Number(movements.rows[0].count), entries: Number(entries.rows[0].count) };
}

describe('عروض السعر — بلا أثر مالي أو مخزني', () => {
  it('ينشئ عرض سعر ويمر بدورة حياة صحيحة (draft→sent→accepted) دون أي حركة مخزون أو قيد', async () => {
    const stack = await createFullTenantStack('quo-happy');
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'QC-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });

    const before = await countFinancialSideEffects(stack.companyId);

    const quotation = await createQuotation(stack.ctx, {
      branchId: stack.branchId, customerId: customer.id, currencyCode: 'EGP', quotationDate: '2026-03-01',
      lines: [{ itemId, uomId, quantity: '10', unitPrice: '25' }],
    });
    expect(quotation.document_number).toMatch(/^QUO-/);

    await transitionQuotationStatus(stack.ctx, quotation.id, 'sent');
    const accepted = await transitionQuotationStatus(stack.ctx, quotation.id, 'accepted');
    expect(accepted.status).toBe('accepted');

    const after = await countFinancialSideEffects(stack.companyId);
    expect(after).toEqual(before);
  });

  it('يرفض القفز غير المسموح: draft مباشرة إلى accepted', async () => {
    const stack = await createFullTenantStack('quo-jump');
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'QC-2', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const quotation = await createQuotation(stack.ctx, {
      branchId: stack.branchId, customerId: customer.id, currencyCode: 'EGP', quotationDate: '2026-03-01',
      lines: [{ itemId, uomId, quantity: '5', unitPrice: '10' }],
    });

    await expect(transitionQuotationStatus(stack.ctx, quotation.id, 'accepted')).rejects.toThrow(/انتقال حالة غير مسموح/);
  });
});

describe('أوامر البيع — بلا أثر مالي أو مخزني', () => {
  it('ينشئ أمر بيع ويؤكَّد دون أي أثر مخزني/محاسبي', async () => {
    const stack = await createFullTenantStack('so-happy');
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'SOC-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });

    const before = await countFinancialSideEffects(stack.companyId);

    const order = await createSalesOrder(stack.ctx, {
      branchId: stack.branchId, customerId: customer.id, currencyCode: 'EGP', orderDate: '2026-03-02',
      lines: [{ itemId, uomId, quantity: '20', unitPrice: '30' }],
    });
    expect(order.document_number).toMatch(/^SO-/);

    const confirmed = await transitionSalesOrderStatus(stack.ctx, order.id, 'confirmed');
    expect(confirmed.status).toBe('confirmed');

    const after = await countFinancialSideEffects(stack.companyId);
    expect(after).toEqual(before);
  });

  it('يمنع الانتقال المباشر إلى invoiced عبر واجهة الانتقال العامة (محجوزة لخدمة الفاتورة فقط)', async () => {
    const stack = await createFullTenantStack('so-invoiced-guard');
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'SOC-2', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const order = await createSalesOrder(stack.ctx, {
      branchId: stack.branchId, customerId: customer.id, currencyCode: 'EGP', orderDate: '2026-03-02',
      lines: [{ itemId, uomId, quantity: '5', unitPrice: '10' }],
    });

    await expect(
      transitionSalesOrderStatus(stack.ctx, order.id, 'invoiced' as unknown as 'confirmed'),
    ).rejects.toThrow(/انتقال حالة غير مسموح/);
  });

  it('RBAC: 403 لمستخدم بلا sales.order.create', async () => {
    const stack = await createFullTenantStack('so-rbac');
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'SOC-3', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);

    await expect(
      createSalesOrder(limited.ctx, {
        branchId: stack.branchId, customerId: customer.id, currencyCode: 'EGP', orderDate: '2026-03-02',
        lines: [{ itemId, uomId, quantity: '1', unitPrice: '1' }],
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('أوامر الشراء — بلا أثر مالي أو مخزني', () => {
  it('ينشئ أمر شراء ويؤكَّد دون أي أثر مخزني/محاسبي؛ received محجوزة لخدمة الاستلام فقط', async () => {
    const stack = await createFullTenantStack('po-happy');
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    const supplier = await createSupplier(stack.ctx, { code: 'POS-1', nameAr: 'م', nameEn: 'S', currencyCode: 'EGP' });

    const before = await countFinancialSideEffects(stack.companyId);

    const order = await createPurchaseOrder(stack.ctx, {
      branchId: stack.branchId, supplierId: supplier.id, currencyCode: 'EGP', orderDate: '2026-03-03',
      lines: [{ itemId, uomId, quantity: '100', unitPrice: '5' }],
    });
    expect(order.document_number).toMatch(/^PO-/);
    await transitionPurchaseOrderStatus(stack.ctx, order.id, 'confirmed');

    const after = await countFinancialSideEffects(stack.companyId);
    expect(after).toEqual(before);

    await expect(
      transitionPurchaseOrderStatus(stack.ctx, order.id, 'received' as unknown as 'confirmed'),
    ).rejects.toThrow(/انتقال حالة غير مسموح/);
  });
});
