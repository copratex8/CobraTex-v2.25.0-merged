import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createFullTenantStack, createLimitedPermissionUser, createBaseItem } from './helpers';

const app = createApp();

describe('عزل المؤسسات والفروع (Tenant/Branch Isolation)', () => {
  it('يمنع بنيويًا ربط مخزن بفرع تابع لشركة أخرى (قيد FK مركّب على مستوى قاعدة البيانات)', async () => {
    const companyA = await createFullTenantStack('iso-a');
    const companyB = await createFullTenantStack('iso-b');

    // محاولة إدراج مخزن بـ branch_id من الشركة A لكن company_id من الشركة B
    await expect(
      pool.query(
        `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,'خطأ','Wrong')`,
        [companyA.branchId, companyB.companyId],
      ),
    ).rejects.toThrow(); // يجب أن يفشل بخطأ قيد FK المركّب (branch_id, company_id) -> branches(id, company_id)
  });

  it('مستخدم شركة A لا يستطيع رؤية صنف تابع لشركة B عبر الـ API (عزل على مستوى طبقة التطبيق)', async () => {
    const companyA = await createFullTenantStack('iso-item-a');
    const companyB = await createFullTenantStack('iso-item-b');

    const uom = await pool.query(
      `INSERT INTO uoms(company_id, name_ar, name_en, symbol) VALUES ($1,'قطعة','Piece','pc') RETURNING id`,
      [companyB.companyId],
    );
    const itemB = await request(app)
      .post('/api/items')
      .set('Authorization', `Bearer ${companyB.token}`)
      .send({ code: 'ITM-B-1', nameAr: 'صنف ب', nameEn: 'Item B', itemKind: 'generic', baseUomId: uom.rows[0].id });
    expect(itemB.status).toBe(201);

    const attempt = await request(app)
      .get(`/api/items/${itemB.body.id}`)
      .set('Authorization', `Bearer ${companyA.token}`); // توكن شركة A يحاول الوصول لصنف شركة B

    expect(attempt.status).toBe(404); // لا تسرّب بيانات: يظهر كأنه غير موجود من منظور الشركة A
  });

  it('مستخدم بنطاق فرع واحد (وصلاحية own_branch فقط) لا يستطيع تسجيل حركة مخزون على فرع آخر داخل نفس الشركة', async () => {
    const stack = await createFullTenantStack('iso-branch');
    const secondBranch = await pool.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,'فرع 2','Branch 2') RETURNING id`,
      [stack.companyId],
    );
    const secondWarehouse = await pool.query(
      `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,'مخزن 2','WH 2') RETURNING id`,
      [secondBranch.rows[0].id, stack.companyId],
    );

    // مستخدم محدود: صلاحية inventory.movement.post بنطاق own_branch فقط، مربوط بالفرع الأول حصرًا
    const limited = await createLimitedPermissionUser(
      stack.tenantId, stack.companyId, stack.branchId, ['inventory.movement.post'],
    );

    const { itemId } = await createBaseItem(stack.companyId);

    const attempt = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${limited.token}`)
      .send({
        branchId: secondBranch.rows[0].id, // خارج نطاق المستخدم
        warehouseId: secondWarehouse.rows[0].id,
        itemId,
        quantity: '10',
        unitCost: '5',
        movementDate: '2026-01-10',
        sourceDocumentType: 'test',
      });

    expect(attempt.status).toBe(403);

    // لكنه ينجح على فرعه الخاص بنفس الصلاحية
    const okAttempt = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${limited.token}`)
      .send({
        branchId: stack.branchId,
        warehouseId: stack.warehouseId,
        itemId,
        quantity: '10',
        unitCost: '5',
        movementDate: '2026-01-10',
        sourceDocumentType: 'test',
      });
    expect(okAttempt.status).toBe(201);
  });
});
