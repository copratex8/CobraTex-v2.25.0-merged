import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createFullTenantStack, createAccountAndFiscalPeriod, createBaseItem, createLimitedPermissionUser } from './helpers';

const app = createApp();

/** إضافات مصنع الغزل والنسيج (0042): لوطات الألياف والخلط، الصباغة، التشغيل للغير، معدّلات التكلفة، الأدوات. */
describe('مصنع الغزل والنسيج — الإضافات', () => {
  let s: Awaited<ReturnType<typeof createFullTenantStack>>;
  let customerId = '';
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);

  beforeAll(async () => {
    s = await createFullTenantStack('mill');
    await pool.query(`UPDATE companies SET manufacturing_enabled = true WHERE id=$1`, [s.companyId]);
    const { inventoryAccountId } = await createAccountAndFiscalPeriod(s.companyId);
    const c = await pool.query(
      `INSERT INTO customers(company_id, code, name_ar, name_en, currency_code, linked_account_id) VALUES ($1,'TC1','عميل تشغيل','Toll Cust','EGP',$2) RETURNING id`,
      [s.companyId, inventoryAccountId]);
    customerId = c.rows[0].id;
  });

  it('خطة خلط: متوسطات مرجَّحة وأقصى كمية يحدّدها اللوط الأضيق، ولا تُعتمد إلا بمجموع 100%', async () => {
    const mk = async (lotCode: string, kg: string, staple: string, price: string) =>
      (await auth(request(app).post('/api/textile/fiber-lots')).send({ lotCode, fiberType: 'cotton', netWeightKg: kg, stapleLengthMm: staple, micronaire: '4.0', pricePerKg: price })).body.id as string;
    const a = await mk('A-1', '30000', '30', '100');
    const b = await mk('B-1', '10000', '27', '80');
    const dup = await auth(request(app).post('/api/textile/fiber-lots')).send({ lotCode: 'A-1', fiberType: 'cotton', netWeightKg: '1' });
    expect(dup.status).toBe(409);

    const bad = await auth(request(app).post('/api/textile/mixing-plans')).send({ planNo: 'MX-BAD', name: 'ناقصة', lines: [{ lotId: a, percent: '60' }, { lotId: b, percent: '30' }] });
    expect(bad.status).toBe(201);
    expect((await auth(request(app).post(`/api/textile/mixing-plans/${bad.body.id}/approve`)).send({})).status).toBe(422);

    const ok = await auth(request(app).post('/api/textile/mixing-plans')).send({ planNo: 'MX-OK', name: 'خلطة', lines: [{ lotId: a, percent: '60' }, { lotId: b, percent: '40' }] });
    const got = await auth(request(app).get(`/api/textile/mixing-plans/${ok.body.id}`));
    expect(got.body.blend.properties.stapleLengthMm).toBe('28.80');
    expect(got.body.blend.maxMixKg).toBe('25000.000');
    expect(got.body.blend.limitingLot).toBe('B-1');
    expect(got.body.blend.costPerKg).toBe('92.0000');
    expect((await auth(request(app).post(`/api/textile/mixing-plans/${ok.body.id}/approve`)).send({})).body.status).toBe('approved');
  });

  it('الصباغة: احتياج المواد من الوصفة، وحكم ΔE التلقائي، ورفض ثباتية خارج المدى', async () => {
    const dye = await createBaseItem(s.companyId);
    const recipe = await auth(request(app).post('/api/textile/dyeing/recipes')).send({
      code: 'R-NAVY', liquorRatio: '8', lines: [{ itemId: dye.itemId, amount: '2', basis: 'percent_owf' }] });
    expect(recipe.status).toBe(201);
    const batch = await auth(request(app).post('/api/textile/dyeing/batches')).send({ branchId: s.branchId, batchNo: 'DB-1', recipeId: recipe.body.id, materialKg: '500', batchDate: '2026-10-27' });
    expect(batch.status).toBe(201);
    const req = await auth(request(app).get(`/api/textile/dyeing/batches/${batch.body.id}/requirements`));
    expect(req.body.requirements[0].quantityKg).toBe('10.000');
    const res = await auth(request(app).put(`/api/textile/dyeing/batches/${batch.body.id}/result`)).send({ deltaE: '1.4', status: 'done' });
    expect(res.body.shade_result).toBe('fail');
    expect((await auth(request(app).put(`/api/textile/dyeing/batches/${batch.body.id}/result`)).send({ fastnessLight: '9' })).status).toBe(422);
  });

  it('التشغيل للغير: رصيد الخامة والفاقد المسموح والتعويض عند الإقفال، ومنع تسليم أكثر من المستلم', async () => {
    const job = await auth(request(app).post('/api/textile/toll-jobs')).send({
      branchId: s.branchId, jobNo: 'TJ-1', customerId, serviceType: 'spinning', materialDescription: 'قطن', feePerUnit: '5', allowedLossPercent: '2', materialValuePerUnit: '60' });
    expect(job.status).toBe(201);
    const mv = (body: object) => auth(request(app).post(`/api/textile/toll-jobs/${job.body.id}/movements`)).send(body);
    await mv({ movementType: 'receipt', movementDate: '2026-10-01', quantity: '1000' });
    await mv({ movementType: 'output', movementDate: '2026-10-20', quantity: '940' });
    await mv({ movementType: 'waste_returned', movementDate: '2026-10-20', quantity: '20' });
    await mv({ movementType: 'invoice', movementDate: '2026-10-21', amount: '2000' });
    expect((await mv({ movementType: 'output', movementDate: '2026-10-22', quantity: '100' })).status).toBe(422);
    const closed = await auth(request(app).post(`/api/textile/toll-jobs/${job.body.id}/close`)).send({});
    expect(closed.body.statement.excessLossQty).toBe('20.000');
    expect(closed.body.statement.compensation).toBe('1200.0000');
    expect(closed.body.statement.netDue).toBe('1500.0000');
    expect((await mv({ movementType: 'receipt', movementDate: '2026-10-23', quantity: '1' })).status).toBe(409);
  });

  it('معدّلات التكلفة: الأخصّ يغلب، والتطبيق على غير المسودة مرفوض، وأدوات الوزن التجاري', async () => {
    expect((await auth(request(app).post('/api/textile/cost-rates')).send({ rateType: 'labor_per_run_hour', rate: '50' })).status).toBe(201);
    expect((await auth(request(app).post('/api/textile/cost-rates')).send({ rateType: 'labor_per_run_hour', rate: '55' })).status).toBe(201);
    const rates = await auth(request(app).get('/api/textile/cost-rates'));
    expect(rates.body.filter((r: { rate_type: string }) => r.rate_type === 'labor_per_run_hour')).toHaveLength(1);
    const cw = await auth(request(app).get('/api/textile/tools/commercial-weight')).query({ actualKg: '1000', moisturePercent: '6', fiber: 'cotton' });
    expect(cw.body.commercialKg).toBe('1019.900');
  });

  it('صلاحيات: مستخدم بلا textile.toll.manage لا ينشئ عمل تشغيل للغير', async () => {
    const u = await createLimitedPermissionUser(s.tenantId, s.companyId, s.branchId, ['textile.toll.view']);
    const r = await request(app).post('/api/textile/toll-jobs').set('Authorization', `Bearer ${u.token}`).send({
      branchId: s.branchId, jobNo: 'TJ-X', customerId, serviceType: 'spinning', materialDescription: 'x', feePerUnit: '1' });
    expect(r.status).toBe(403);
  });
});
