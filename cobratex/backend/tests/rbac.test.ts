import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { createFullTenantStack, createLimitedPermissionUser, createBaseItem } from './helpers';

const app = createApp();

describe('RBAC — الصلاحية × الفعل × النطاق', () => {
  it('401: طلب بلا توكن على مسار محمي', async () => {
    const res = await request(app).post('/api/items').send({ code: 'X' });
    expect(res.status).toBe(401);
  });

  it('401: توكن غير صالح', async () => {
    const res = await request(app)
      .post('/api/items')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ code: 'X' });
    expect(res.status).toBe(401);
  });

  it('403: مستخدم بلا صلاحية items.item.create يُمنع من إنشاء صنف', async () => {
    const stack = await createFullTenantStack('rbac-403-item');
    const limited = await createLimitedPermissionUser(
      stack.tenantId, stack.companyId, stack.branchId, ['inventory.movement.post'], // لا items.item.create
    );
    const uomRes = await request(app)
      .post('/api/uoms')
      .set('Authorization', `Bearer ${stack.token}`) // owner ينشئ الوحدة
      .send({ nameAr: 'قطعة', nameEn: 'Piece', symbol: 'pc' });

    const res = await request(app)
      .post('/api/items')
      .set('Authorization', `Bearer ${limited.token}`)
      .send({ code: 'RBAC-1', nameAr: 'صنف', nameEn: 'Item', itemKind: 'generic', baseUomId: uomRes.body.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/items\.item\.create/);
  });

  it('403: مستخدم بصلاحية accounting.journal.create فقط (بلا submit/approve/post) يُمنع من المسار المختصر postJournalEntry', async () => {
    const stack = await createFullTenantStack('rbac-403-journal');
    const limited = await createLimitedPermissionUser(
      stack.tenantId, stack.companyId, stack.branchId, ['accounting.journal.create'], // بلا submit/approve/post
    );

    const cash = await request(app).post('/api/accounting/accounts').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: '1000', nameAr: 'نقدية', nameEn: 'Cash', accountType: 'asset' });
    const revenue = await request(app).post('/api/accounting/accounts').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: '4000', nameAr: 'إيراد', nameEn: 'Revenue', accountType: 'revenue' });
    const period = await request(app).post('/api/accounting/fiscal-periods').set('Authorization', `Bearer ${stack.token}`)
      .send({ startDate: '2026-01-01', endDate: '2026-12-31' });

    const res = await request(app)
      .post('/api/accounting/journal-entries')
      .set('Authorization', `Bearer ${limited.token}`)
      .send({
        branchId: stack.branchId, fiscalPeriodId: period.body.id, entryDate: '2026-01-05', currencyCode: 'EGP',
        sourceDocumentType: 'test',
        lines: [
          { accountId: cash.body.id, debit: '10', credit: '0' },
          { accountId: revenue.body.id, debit: '0', credit: '10' },
        ],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/accounting\.journal\.submit/); // أول صلاحية ناقصة يصطدم بها المسار المختصر
  });

  it('نجاح: مستخدم مخوَّل بكل الصلاحيات (Owner) ينشئ صنفًا ويسجّل حركة وارد بنجاح', async () => {
    const stack = await createFullTenantStack('rbac-success');
    const uom = await request(app).post('/api/uoms').set('Authorization', `Bearer ${stack.token}`)
      .send({ nameAr: 'متر', nameEn: 'Meter', symbol: 'm' });
    const item = await request(app).post('/api/items').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'RBAC-OK-1', nameAr: 'صنف', nameEn: 'Item', itemKind: 'generic', baseUomId: uom.body.id });
    expect(item.status).toBe(201);

    const movement = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, warehouseId: stack.warehouseId, itemId: item.body.id,
        quantity: '5', unitCost: '2', movementDate: '2026-01-01', sourceDocumentType: 'test',
      });
    expect(movement.status).toBe(201);
  });

  it('نجاح جزئي متسق: مستخدم بصلاحية inventory.movement.post فقط ينجح في تسجيل حركة، ويُمنع من إنشاء صنف بنفس التوكن', async () => {
    const stack = await createFullTenantStack('rbac-partial');
    const { itemId } = await createBaseItem(stack.companyId); // يُنشأ مباشرة عبر SQL (تجاوز RBAC، تجهيز بيانات فقط)
    const limited = await createLimitedPermissionUser(
      stack.tenantId, stack.companyId, stack.branchId, ['inventory.movement.post'],
    );

    const movement = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${limited.token}`)
      .send({
        branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
        quantity: '5', unitCost: '2', movementDate: '2026-01-01', sourceDocumentType: 'test',
      });
    expect(movement.status).toBe(201);

    const itemCreation = await request(app)
      .post('/api/items')
      .set('Authorization', `Bearer ${limited.token}`)
      .send({ code: 'SHOULD-FAIL', nameAr: 'x', nameEn: 'x', itemKind: 'generic', baseUomId: 'irrelevant' });
    expect(itemCreation.status).toBe(403);
  });
});
