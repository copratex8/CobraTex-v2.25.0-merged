import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createFullTenantStack } from './helpers';

const app = createApp();

/**
 * لوحة المطور الخارجية (Remote Control Plane).
 * ملاحظة: لا نُجرِّب الإيقاف العام (global) هنا لأن ملفات الاختبار الأخرى تعمل بالتوازي على نفس
 * قاعدة البيانات — الإيقاف على مستوى عميل (tenant) فقط يغطي نفس مسار الحارس بلا أي تأثير على غيره.
 */
describe('لوحة المطور: إيقاف/تشغيل عميل + إشعارات شاشة الدخول', () => {
  let stack: Awaited<ReturnType<typeof createFullTenantStack>>;
  let devToken = '';

  beforeAll(async () => {
    process.env.DEVELOPER_SECRET = 'test-developer-secret';
    stack = await createFullTenantStack('platform');
    const res = await request(app).post('/api/developer/login').send({ secret: 'test-developer-secret' });
    devToken = res.body.token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM platform_announcements WHERE title LIKE 'اختبار-%'`);
    delete process.env.DEVELOPER_SECRET;
  });

  const dev = (r: request.Test) => r.set('Authorization', `Bearer ${devToken}`);

  it('دخول المطوّر: كلمة خاطئة 401، صحيحة تُعيد توكن، ومسارات المطوّر ترفض بلا توكن أو بتوكن مستخدم عميل', async () => {
    expect((await request(app).post('/api/developer/login').send({ secret: 'wrong' })).status).toBe(401);
    expect(devToken.length).toBeGreaterThan(20);
    expect((await request(app).get('/api/developer/overview')).status).toBe(401);
    const asCustomer = await request(app).get('/api/developer/overview').set('Authorization', `Bearer ${stack.token}`);
    expect(asCustomer.status).toBe(401);
  });

  it('إيقاف عميل: تسجيل الدخول والطلبات المصادَق عليها تُرفض بـ503 SERVICE_SUSPENDED برسالة المطوّر، وغيره لا يتأثر', async () => {
    const other = await createFullTenantStack('platform-other');
    const off = await dev(request(app).put(`/api/developer/tenants/${stack.tenantId}/service`)).send({ status: 'suspended', message: 'متأخر السداد' });
    expect(off.status).toBe(200);

    const authed = await request(app).get('/api/company').set('Authorization', `Bearer ${stack.token}`);
    expect(authed.status).toBe(503);
    expect(authed.body.code).toBe('SERVICE_SUSPENDED');
    expect(authed.body.error).toBe('متأخر السداد');

    const login = await request(app).post('/api/auth/login').send({ tenantId: stack.tenantId, email: 'x@y.z', password: 'p' });
    expect(login.status).toBe(503);

    const unaffected = await request(app).get('/api/company').set('Authorization', `Bearer ${other.token}`);
    expect(unaffected.status).toBe(200);

    const status = await request(app).get(`/api/public/status?tenantId=${stack.tenantId}`);
    expect(status.body.status).toBe('suspended');
    expect(status.body.message).toBe('متأخر السداد');

    const on = await dev(request(app).put(`/api/developer/tenants/${stack.tenantId}/service`)).send({ status: 'active' });
    expect(on.status).toBe(200);
    const back = await request(app).get('/api/company').set('Authorization', `Bearer ${stack.token}`);
    expect(back.status).toBe(200);
  });

  it('إشعارات شاشة الدخول: عامة لكل العملاء أو موجَّهة لعميل، وتختفي عند الإخفاء أو انتهاء الفترة', async () => {
    const all = await dev(request(app).post('/api/developer/announcements')).send({ title: 'اختبار-عام', body: 'للجميع', severity: 'warning' });
    expect(all.status).toBe(201);
    const mine = await dev(request(app).post('/api/developer/announcements')).send({ title: 'اختبار-خاص', tenantId: stack.tenantId });
    const expired = await dev(request(app).post('/api/developer/announcements')).send({ title: 'اختبار-منتهي', endsAt: '2020-01-01T00:00:00Z' });
    expect([mine.status, expired.status]).toEqual([201, 201]);

    const anon = await request(app).get('/api/public/status');
    const titlesAnon = anon.body.announcements.map((a: { title: string }) => a.title);
    expect(titlesAnon).toContain('اختبار-عام');
    expect(titlesAnon).not.toContain('اختبار-خاص');
    expect(titlesAnon).not.toContain('اختبار-منتهي');

    const forTenant = await request(app).get(`/api/public/status?tenantId=${stack.tenantId}`);
    expect(forTenant.body.announcements.map((a: { title: string }) => a.title)).toContain('اختبار-خاص');

    await dev(request(app).patch(`/api/developer/announcements/${all.body.id}`)).send({ isActive: false });
    const after = await request(app).get('/api/public/status');
    expect(after.body.announcements.map((a: { title: string }) => a.title)).not.toContain('اختبار-عام');
  });

  it('تحقق المدخلات: حالة غير صالحة 422، عنوان إشعار فارغ 422، عميل غير موجود 404', async () => {
    expect((await dev(request(app).put(`/api/developer/tenants/${stack.tenantId}/service`)).send({ status: 'paused' })).status).toBe(422);
    expect((await dev(request(app).post('/api/developer/announcements')).send({ title: ' ' })).status).toBe(422);
    expect((await dev(request(app).put('/api/developer/tenants/00000000-0000-4000-8000-000000000000/service')).send({ status: 'suspended' })).status).toBe(404);
  });
});
