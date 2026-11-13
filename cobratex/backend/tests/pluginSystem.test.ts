import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { createFullTenantStack } from './helpers';

const app = createApp();

describe('نظام الإضافات (Plugins) ومسارات النظام (version/update-check)', () => {
  it('GET /system/version يعمل بلا مصادقة ويُرجع نصًا', async () => {
    const res = await request(app).get('/api/system/version');
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version.length).toBeGreaterThan(0);
  });

  it('GET /system/plugins يُظهر إضافة hello-activity المُحمَّلة فعليًا من مجلد plugins/', async () => {
    const res = await request(app).get('/api/system/plugins');
    expect(res.status).toBe(200);
    const names = res.body.plugins.map((p: { name: string }) => p.name);
    expect(names).toContain('hello-activity');
  });

  it('GET /system/update-check بلا UPDATE_FEED_URL يُرجع حالة صريحة بلا ادّعاء تحديث', async () => {
    const res = await request(app).get('/api/system/update-check');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
    expect(res.body.note).toMatch(/UPDATE_FEED_URL/);
  });

  it('مسار الإضافة الفعلي (/plugins/hello-activity/ping) يعمل خلف المصادقة ويُرجع req.ctx.userId', async () => {
    const stack = await createFullTenantStack('plugin-auth');
    const res = await request(app).get('/api/plugins/hello-activity/ping').set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/نشاط خارجي/);
    expect(res.body.calledBy).toBeTruthy();
  });

  it('مسار الإضافة بلا توكن يُرفَض بـ401 — نفس حماية أي مسار أساسي آخر', async () => {
    const res = await request(app).get('/api/plugins/hello-activity/ping');
    expect(res.status).toBe(401);
  });

  it('الإضافة تصل فعليًا لقاعدة البيانات المشتركة عبر sdk.pool وتُرجع بيانات الشركة الصحيحة', async () => {
    const stack = await createFullTenantStack('plugin-db');
    const res = await request(app).get('/api/plugins/hello-activity/company-info').set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.company).toBeTruthy();
    expect(res.body.company.base_currency_code).toBe('EGP');
  });
});
