import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { createFullTenantStack, createLimitedPermissionUser } from './helpers';
import { pool } from '@/db/pool';

const app = createApp();

/** عمالة وحوافز الإنتاج + ملصقات + أرصدة الهوالك (هجرة 0044). الجدولة مغطّاة باختبار SQL مباشر (راجع docs/TEXTILE.md). */
describe('مصنع الغزل والنسيج — العمالة والحوافز والملصقات', () => {
  let s: Awaited<ReturnType<typeof createFullTenantStack>>;
  let stageId = '';
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);

  beforeAll(async () => {
    s = await createFullTenantStack('ops');
    await pool.query(`UPDATE companies SET manufacturing_enabled = true WHERE id=$1`, [s.companyId]);
    const st = await pool.query(
      `INSERT INTO textile_stages(company_id, code, name_ar, name_en, stage_type) VALUES ($1,'SP','غزل','Spinning','ring_spinning') RETURNING id`, [s.companyId]);
    stageId = st.rows[0].id;
  });

  it('حافز العامل: المعدّل الأساسي وحدّ الزيادة وخصم المعيب، والسجل المكرر يُرفض', async () => {
    const w = await auth(request(app).post('/api/textile/workers')).send({ code: 'W1', nameAr: 'أحمد', stageId });
    expect(w.status).toBe(201);
    expect((await auth(request(app).post('/api/textile/workers')).send({ code: 'W1', nameAr: 'مكرر' })).status).toBe(409);
    const rate = await auth(request(app).post('/api/textile/incentive-rates')).send({ stageId, ratePerUnit: '1', bonusThreshold: '100', bonusRatePerUnit: '2', effectiveFrom: '2026-01-01' });
    expect(rate.status).toBe(201);
    expect((await auth(request(app).post('/api/textile/incentive-rates')).send({ ratePerUnit: '1', bonusRatePerUnit: '2', effectiveFrom: '2026-01-01' })).status).toBe(422);

    const log = (b: object) => auth(request(app).post('/api/textile/worker-logs')).send({ branchId: s.branchId, workerId: w.body.id, shift: 'morning', ...b });
    expect((await log({ logDate: '2026-11-02', quantity: '150', defectiveQuantity: '10' })).status).toBe(201);
    expect((await log({ logDate: '2026-11-02', quantity: '5' })).status).toBe(409);
    expect((await log({ logDate: '2026-11-03', quantity: '5', defectiveQuantity: '9' })).status).toBe(422);

    const rep = await auth(request(app).get('/api/textile/reports/incentives?from=2026-11-01&to=2026-11-30'));
    expect(rep.status).toBe(200);
    // الصافي 140: 100×1 + 40×2 = 180
    expect(Number(rep.body.workers[0].incentive)).toBe(180);
    expect(rep.body.unratedLogs).toBe(0);
  });

  it('الجدولة: تاريخ ناقص/معكوس يُرفض، وأمر غير موجود 404', async () => {
    expect((await auth(request(app).put('/api/textile/orders/00000000-0000-0000-0000-000000000001/schedule')).send({ plannedStart: '2026-11-05' })).status).toBe(422);
    expect((await auth(request(app).put('/api/textile/orders/00000000-0000-0000-0000-000000000001/schedule')).send({ plannedStart: '2026-11-05', plannedEnd: '2026-11-01' })).status).toBe(422);
    expect((await auth(request(app).put('/api/textile/orders/00000000-0000-0000-0000-000000000001/schedule')).send({ plannedStart: '2026-11-01', plannedEnd: '2026-11-05' })).status).toBe(404);
  });

  it('الملصقات والهوالك: معرّفات غير صالحة 422، غير موجودة 404، والصلاحية مطلوبة', async () => {
    expect((await auth(request(app).get('/api/textile/labels?kind=roll&ids=abc')).send()).status).toBe(422);
    expect((await auth(request(app).get('/api/textile/labels?kind=roll&ids=00000000-0000-0000-0000-00000000dead'))).status).toBe(404);
    expect((await auth(request(app).get('/api/textile/reports/waste-stock'))).status).toBe(200);
    const limited = await createLimitedPermissionUser(s.tenantId, s.companyId, s.branchId, ['textile.master.view']);
    const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${limited.token}`);
    expect((await bearer(request(app).get('/api/textile/workers'))).status).toBe(403);
    expect((await bearer(request(app).get('/api/textile/schedule'))).status).toBe(403);
    expect((await bearer(request(app).get('/api/textile/reports/waste-stock'))).status).toBe(403);
  });
});
