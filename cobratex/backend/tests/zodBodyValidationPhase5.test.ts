import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { createAccountAndFiscalPeriod } from './helpers';
import { createFullTenantStack } from './helpers';

const app = createApp();

describe('Zod على أجسام POST — المرحلة 5 (عروض أسعار، أوامر، استلامات، خزينة)', () => {
  it('POST /sales/quotations: يرفض عرض سعر بلا أسطر بـ422', async () => {
    const stack = await createFullTenantStack('zod5-quo-empty');
    const res = await request(app).post('/api/sales/quotations').set('Authorization', `Bearer ${stack.token}`)
      .send({ branchId: stack.branchId, customerId: '00000000-0000-0000-0000-000000000000', currencyCode: 'EGP', quotationDate: '2026-01-01', lines: [] });
    expect(res.status).toBe(422);
  });

  it('POST /sales/orders: يرفض حقلًا غير متوقع (extra field) بـ422', async () => {
    const stack = await createFullTenantStack('zod5-order-extra');
    const res = await request(app).post('/api/sales/orders').set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, customerId: '00000000-0000-0000-0000-000000000000', currencyCode: 'EGP', orderDate: '2026-01-01',
        lines: [{ itemId: '00000000-0000-0000-0000-000000000000', uomId: '00000000-0000-0000-0000-000000000000', quantity: '1', unitPrice: '10' }],
        tenantId: 'should-not-be-accepted',
      });
    expect(res.status).toBe(422);
  });

  it('POST /purchasing/orders: يرفض كمية غير رقمية بـ422', async () => {
    const stack = await createFullTenantStack('zod5-po-badqty');
    const res = await request(app).post('/api/purchasing/orders').set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, supplierId: '00000000-0000-0000-0000-000000000000', currencyCode: 'EGP', orderDate: '2026-01-01',
        lines: [{ itemId: '00000000-0000-0000-0000-000000000000', uomId: '00000000-0000-0000-0000-000000000000', quantity: 'abc', unitPrice: '10' }],
      });
    expect(res.status).toBe(422);
  });

  it('POST /purchasing/receipts: يرفض استلامًا بلا أسطر بـ422', async () => {
    const stack = await createFullTenantStack('zod5-receipt-empty');
    const res = await request(app).post('/api/purchasing/receipts').set('Authorization', `Bearer ${stack.token}`)
      .send({ branchId: stack.branchId, warehouseId: '00000000-0000-0000-0000-000000000000', supplierId: '00000000-0000-0000-0000-000000000000', receiptDate: '2026-01-01', lines: [] });
    expect(res.status).toBe(422);
  });

  it('POST /treasury/safes: يرفض kind غير مسموح (enum) بـ422', async () => {
    const stack = await createFullTenantStack('zod5-safe-badkind');
    const res = await request(app).post('/api/treasury/safes').set('Authorization', `Bearer ${stack.token}`)
      .send({ branchId: stack.branchId, code: 'SF-1', nameAr: 'خزينة', nameEn: 'Safe', kind: 'wallet', currencyCode: 'EGP' });
    expect(res.status).toBe(422);
  });

  it('POST /treasury/safes: طلب صالح ينجح (201)', async () => {
    const stack = await createFullTenantStack('zod5-safe-valid');
    const res = await request(app).post('/api/treasury/safes').set('Authorization', `Bearer ${stack.token}`)
      .send({ branchId: stack.branchId, code: 'SF-2', nameAr: 'خزينة', nameEn: 'Safe', kind: 'safe', currencyCode: 'EGP' });
    expect(res.status).toBe(201);
  });

  it('POST /treasury/transactions: يرفض counterpartyType خارج enum بـ422', async () => {
    const stack = await createFullTenantStack('zod5-tx-badcounterparty');
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const res = await request(app).post('/api/treasury/transactions').set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, safeOrBankId: '00000000-0000-0000-0000-000000000000', transactionType: 'receipt',
        counterpartyType: 'vendor', amount: '100', currencyCode: 'EGP', transactionDate: '2026-01-01', fiscalPeriodId,
      });
    expect(res.status).toBe(422);
  });

  it('POST /treasury/transfers: يرفض التحويل من وإلى نفس الخزينة بـ422 (refine)', async () => {
    const stack = await createFullTenantStack('zod5-transfer-same');
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const sameId = '00000000-0000-0000-0000-000000000001';
    const res = await request(app).post('/api/treasury/transfers').set('Authorization', `Bearer ${stack.token}`)
      .send({ branchId: stack.branchId, fromSafeOrBankId: sameId, toSafeOrBankId: sameId, amount: '100', currencyCode: 'EGP', transferDate: '2026-01-01', fiscalPeriodId });
    expect(res.status).toBe(422);
  });

  it('POST /treasury/checks: يرفض مبلغًا سالبًا بـ422', async () => {
    const stack = await createFullTenantStack('zod5-check-negative');
    const res = await request(app).post('/api/treasury/checks').set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, safeOrBankId: '00000000-0000-0000-0000-000000000000', checkType: 'incoming',
        checkNumber: 'CHK-1', checkDate: '2026-01-01', dueDate: '2026-02-01', amount: '-500', currencyCode: 'EGP',
      });
    expect(res.status).toBe(422);
  });

  it('POST /sales/quotations/:id/transition: يرفض جسمًا بلا target بـ422', async () => {
    const stack = await createFullTenantStack('zod5-transition-notarget');
    const res = await request(app)
      .post('/api/sales/quotations/00000000-0000-0000-0000-000000000000/transition')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({});
    expect(res.status).toBe(422);
  });
});
