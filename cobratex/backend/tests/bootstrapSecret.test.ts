import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { config } from '@/config';

const app = createApp();

/**
 * لا BOOTSTRAP_SECRET مضبوطًا في .env.test عمدًا (كل بقية الاختبارات تعتمد على /bootstrap مفتوحًا
 * بلا ترويسة). هنا فقط نُفعِّله مؤقتًا بتعديل كائن config مباشرة (config.ts يُصدِّر كائنًا عاديًا لا
 * مجمَّدًا، لا يُعاد تحميله بين الاختبارات) ثم نُعيده undefined حتى لا يُفسِد أي اختبار لاحق.
 */
describe('حماية /bootstrap عبر BOOTSTRAP_SECRET — يمنع إنشاء مستأجرين بلا حد من أي زائر عند ضبطه', () => {
  afterEach(() => { config.bootstrapSecret = undefined; });

  it('بلا BOOTSTRAP_SECRET مضبوطًا: المسار يبقى مفتوحًا كسلوكه الحالي (لا كسر للتطوير المحلي)', async () => {
    const res = await request(app).post('/api/bootstrap').send({
      tenantName: 'ت', companyLegalName: 'ش', ownerEmail: `open-${Date.now()}@test.local`, ownerPassword: 'Seed@12345',
    });
    expect(res.status).toBe(201);
  });

  it('بضبطه: طلب بلا الترويسة أو بقيمة خاطئة يُرفض بـ401، ولا يُنشئ أي مستأجر', async () => {
    config.bootstrapSecret = 'super-secret-value';
    const noHeader = await request(app).post('/api/bootstrap').send({
      tenantName: 'ت', companyLegalName: 'ش', ownerEmail: `guarded-${Date.now()}@test.local`, ownerPassword: 'Seed@12345',
    });
    expect(noHeader.status).toBe(401);

    const wrongHeader = await request(app).post('/api/bootstrap')
      .set('x-bootstrap-secret', 'wrong-value')
      .send({ tenantName: 'ت', companyLegalName: 'ش', ownerEmail: `guarded2-${Date.now()}@test.local`, ownerPassword: 'Seed@12345' });
    expect(wrongHeader.status).toBe(401);
  });

  it('بالترويسة الصحيحة: يُنشئ المستأجر بنجاح كالمعتاد', async () => {
    config.bootstrapSecret = 'super-secret-value';
    const res = await request(app).post('/api/bootstrap')
      .set('x-bootstrap-secret', 'super-secret-value')
      .send({ tenantName: 'ت', companyLegalName: 'ش', ownerEmail: `guarded3-${Date.now()}@test.local`, ownerPassword: 'Seed@12345' });
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBeDefined();
  });
});
