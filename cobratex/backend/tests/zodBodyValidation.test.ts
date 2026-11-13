import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createFullTenantStack, createAccountAndFiscalPeriod } from './helpers';

const app = createApp();

describe('Zod على أجسام POST — تحقق حقيقي عبر HTTP (422 واضح، لا 500 ولا قبول صامت)', () => {
  it('POST /customers: يرفض حقلًا غير متوقع (مثل محاولة إرسال companyId في الجسم) بـ422', async () => {
    const stack = await createFullTenantStack('zod-extra-field');
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'ZX-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP', companyId: 'someone-elses-company-id' });
    expect(res.status).toBe(422);
  });

  it('POST /customers: يرفض حقلًا إلزاميًا مفقودًا (currencyCode) بـ422', async () => {
    const stack = await createFullTenantStack('zod-missing-field');
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'ZM-1', nameAr: 'ع', nameEn: 'C' });
    expect(res.status).toBe(422);
  });

  it('POST /customers: يرفض creditLimit سالبًا بـ422', async () => {
    const stack = await createFullTenantStack('zod-negative-credit');
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'ZN-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP', creditLimit: '-500' });
    expect(res.status).toBe(422);
  });

  it('POST /customers: طلب صالح تمامًا لا يزال ينجح (201) — التحقق لا يمنع الاستخدام السليم', async () => {
    const stack = await createFullTenantStack('zod-valid-customer');
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'ZV-1', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP', creditLimit: '1000', paymentTermDays: 30 });
    expect(res.status).toBe(201);
  });

  it('POST /sales/invoices: يرفض كمية سالبة في سطر الفاتورة بـ422 قبل الوصول لأي منطق أعمال', async () => {
    const stack = await createFullTenantStack('zod-negative-qty');
    const res = await request(app)
      .post('/api/sales/invoices')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, warehouseId: '00000000-0000-0000-0000-000000000000', customerId: '00000000-0000-0000-0000-000000000000',
        fiscalPeriodId: '00000000-0000-0000-0000-000000000000', currencyCode: 'EGP', invoiceDate: '2026-01-01',
        lines: [{ itemId: '00000000-0000-0000-0000-000000000000', uomId: '00000000-0000-0000-0000-000000000000', quantity: '-5', unitPrice: '10' }],
      });
    expect(res.status).toBe(422);
  });

  it('POST /sales/invoices: يرفض تاريخًا بصيغة غير صحيحة بـ422', async () => {
    const stack = await createFullTenantStack('zod-bad-date');
    const res = await request(app)
      .post('/api/sales/invoices')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, warehouseId: '00000000-0000-0000-0000-000000000000', customerId: '00000000-0000-0000-0000-000000000000',
        fiscalPeriodId: '00000000-0000-0000-0000-000000000000', currencyCode: 'EGP', invoiceDate: '01/01/2026',
        lines: [{ itemId: '00000000-0000-0000-0000-000000000000', uomId: '00000000-0000-0000-0000-000000000000', quantity: '5', unitPrice: '10' }],
      });
    expect(res.status).toBe(422);
  });

  it('POST /sales/invoices: يرفض فاتورة بلا أسطر إطلاقًا بـ422', async () => {
    const stack = await createFullTenantStack('zod-no-lines');
    const res = await request(app)
      .post('/api/sales/invoices')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, warehouseId: '00000000-0000-0000-0000-000000000000', customerId: '00000000-0000-0000-0000-000000000000',
        fiscalPeriodId: '00000000-0000-0000-0000-000000000000', currencyCode: 'EGP', invoiceDate: '2026-01-01', lines: [],
      });
    expect(res.status).toBe(422);
  });

  it('POST /purchasing/expense-invoices: يرفض إرسال supplierId وpaidFromAccountId معًا بـ422 (refine)', async () => {
    const stack = await createFullTenantStack('zod-expense-both');
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const res = await request(app)
      .post('/api/purchasing/expense-invoices')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, supplierId: '00000000-0000-0000-0000-000000000000', paidFromAccountId: '00000000-0000-0000-0000-000000000000',
        fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-01-01',
        lines: [{ expenseAccountId: '00000000-0000-0000-0000-000000000000', description: 'x', amount: '100' }],
      });
    expect(res.status).toBe(422);
  });

  it('POST /purchasing/expense-invoices: يرفض عدم إرسال أي منهما بـ422', async () => {
    const stack = await createFullTenantStack('zod-expense-neither');
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const res = await request(app)
      .post('/api/purchasing/expense-invoices')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-01-01',
        lines: [{ expenseAccountId: '00000000-0000-0000-0000-000000000000', description: 'x', amount: '100' }],
      });
    expect(res.status).toBe(422);
  });

  it('POST /sales/payments/:id/allocate: يرفض قائمة تخصيصات فارغة بـ422', async () => {
    const stack = await createFullTenantStack('zod-alloc-empty');
    const res = await request(app)
      .post(`/api/sales/payments/00000000-0000-0000-0000-000000000000/allocate`)
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ allocations: [] });
    expect(res.status).toBe(422);
  });

  it('POST /sales/invoices/:id/reverse: يرفض سبب عكس فارغ بـ422', async () => {
    const stack = await createFullTenantStack('zod-reverse-empty-reason');
    const res = await request(app)
      .post(`/api/sales/invoices/00000000-0000-0000-0000-000000000000/reverse`)
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ reason: '' });
    expect(res.status).toBe(422);
  });

  it('رسالة الخطأ 422 تذكر اسم الحقل المخالف — قابلة للفهم لا رمزًا غامضًا', async () => {
    const stack = await createFullTenantStack('zod-error-message');
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'ZE-1', nameAr: 'ع', nameEn: 'C' }); // بلا currencyCode
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/currencyCode/);
  });
});
