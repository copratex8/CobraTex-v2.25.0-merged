import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem } from './helpers';

const app = createApp();

async function fixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);
  const c1 = await createCustomer(stack.ctx, { code: `A-${prefix}`, nameAr: 'عميل أ', nameEn: 'A', currencyCode: 'EGP' });
  const c2 = await createCustomer(stack.ctx, { code: `B-${prefix}`, nameAr: 'عميل ب', nameEn: 'B', currencyCode: 'EGP' });
  const mk = (customerId: string) => createSalesInvoice(stack.ctx, {
    branchId: stack.branchId, warehouseId: stack.warehouseId, customerId, fiscalPeriodId, currencyCode: 'EGP',
    invoiceDate: '2026-02-01', lines: [{ itemId, uomId, quantity: '1', unitPrice: '10' }],
  });
  return { stack, c1, c2, mk };
}

describe('فلترة قوائم الفواتير من الباك إند بالعميل/الحالة (بدل التصفية المحلية في الواجهة)', () => {
  it('customerId يُرجع فواتير ذلك العميل فقط، والعدّ الكلي total يعكس الفلتر (لا الجدول كله)', async () => {
    const { stack, c1, c2, mk } = await fixture('flt-cust');
    await mk(c1.id); await mk(c1.id); await mk(c2.id);
    const res = await request(app).get('/api/sales/invoices').query({ customerId: c1.id }).set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((i: { customer_id: string }) => i.customer_id === c1.id)).toBe(true);
  });

  it('بلا customerId تعود كل الفواتير (لا كسر للسلوك السابق)', async () => {
    const { stack, c1, c2, mk } = await fixture('flt-none');
    await mk(c1.id); await mk(c2.id);
    const res = await request(app).get('/api/sales/invoices').set('Authorization', `Bearer ${stack.token}`);
    expect(res.body.total).toBe(2);
  });

  it('الفلتر يجتمع مع status: عميل + حالة posted لا يُرجع مسودات', async () => {
    const { stack, c1, mk } = await fixture('flt-status');
    await mk(c1.id);
    const res = await request(app).get('/api/sales/invoices').query({ customerId: c1.id, status: 'posted' }).set('Authorization', `Bearer ${stack.token}`);
    expect(res.body.total).toBe(0);
  });

  it('عزل الشركات: customerId لشركة أخرى لا يكشف شيئًا (نتيجة فارغة)', async () => {
    const a = await fixture('flt-iso-a');
    const b = await fixture('flt-iso-b');
    await a.mk(a.c1.id);
    const res = await request(app).get('/api/sales/invoices').query({ customerId: a.c1.id }).set('Authorization', `Bearer ${b.stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('customerId غير صالح (ليس UUID) يُرفض بـ422', async () => {
    const { stack } = await fixture('flt-bad');
    const res = await request(app).get('/api/sales/invoices').query({ customerId: 'not-a-uuid' }).set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(422);
  });

  it('فواتير الشراء: supplierId يُقبَل ويُطبَّق (قائمة فارغة لمورد بلا فواتير)', async () => {
    const { stack } = await fixture('flt-sup');
    const res = await request(app).get('/api/purchasing/invoices').query({ supplierId: '00000000-0000-4000-8000-000000000000' }).set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});
