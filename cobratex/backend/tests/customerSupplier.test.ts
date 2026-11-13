import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createFullTenantStack, createLimitedPermissionUser } from './helpers';

const app = createApp();

describe('العملاء والموردون — حساب فرعي يُنشأ مرة واحدة فقط (Atomic)', () => {
  it('إنشاء عميل ينشئ حسابًا فرعيًا (AR-<code>) مرتبطًا فعليًا في نفس المعاملة', async () => {
    const stack = await createFullTenantStack('cust-atomic');
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'C-001', nameAr: 'عميل تجريبي', nameEn: 'Test Customer', currencyCode: 'EGP' });

    expect(res.status).toBe(201);
    expect(res.body.linked_account_id).toBeTruthy();

    const account = await pool.query(`SELECT code, account_type FROM accounts WHERE id=$1`, [res.body.linked_account_id]);
    expect(account.rows[0].code).toBe('AR-C-001');
    expect(account.rows[0].account_type).toBe('asset');
  });

  it('إنشاء مورد ينشئ حسابًا فرعيًا (AP-<code>) بنوع liability', async () => {
    const stack = await createFullTenantStack('supp-atomic');
    const res = await request(app)
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'S-001', nameAr: 'مورد تجريبي', nameEn: 'Test Supplier', currencyCode: 'EGP' });

    expect(res.status).toBe(201);
    const account = await pool.query(`SELECT code, account_type FROM accounts WHERE id=$1`, [res.body.linked_account_id]);
    expect(account.rows[0].code).toBe('AP-S-001');
    expect(account.rows[0].account_type).toBe('liability');
  });

  it('كود عميل مكرر يُرفض (409) ولا يُترك أي حساب يتيم في قاعدة البيانات', async () => {
    const stack = await createFullTenantStack('cust-dup');
    await request(app).post('/api/customers').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'C-DUP', nameAr: 'أ', nameEn: 'A', currencyCode: 'EGP' });

    const before = await pool.query(`SELECT count(*) FROM accounts WHERE company_id=$1`, [stack.companyId]);

    const dup = await request(app).post('/api/customers').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'C-DUP', nameAr: 'ب', nameEn: 'B', currencyCode: 'EGP' });
    expect(dup.status).toBe(409);

    const after = await pool.query(`SELECT count(*) FROM accounts WHERE company_id=$1`, [stack.companyId]);
    expect(after.rows[0].count).toBe(before.rows[0].count); // لم يُضَف أي حساب جديد رغم محاولة الإدراج الفاشلة

    const accountsWithDupCode = await pool.query(
      `SELECT count(*) FROM accounts WHERE company_id=$1 AND code='AR-C-DUP'`, [stack.companyId],
    );
    expect(accountsWithDupCode.rows[0].count).toBe('1'); // حساب واحد فقط، لا يتيم إضافي
  });

  it('Idempotency-Key: إعادة إرسال نفس طلب إنشاء العميل لا يُنشئ عميلًا أو حسابًا مكررًا', async () => {
    const stack = await createFullTenantStack('cust-idem');
    const payload = { code: 'C-IDEM', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' };
    const key = 'customer-create-key-1';

    const first = await request(app).post('/api/customers').set('Authorization', `Bearer ${stack.token}`)
      .set('Idempotency-Key', key).send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/customers').set('Authorization', `Bearer ${stack.token}`)
      .set('Idempotency-Key', key).send(payload);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    const customerCount = await pool.query(`SELECT count(*) FROM customers WHERE company_id=$1 AND code='C-IDEM'`, [stack.companyId]);
    expect(customerCount.rows[0].count).toBe('1');
    const accountCount = await pool.query(`SELECT count(*) FROM accounts WHERE company_id=$1 AND code='AR-C-IDEM'`, [stack.companyId]);
    expect(accountCount.rows[0].count).toBe('1');
  });

  it('RBAC: 403 لمستخدم بلا sales.customer.create، و403 لعرض قائمة العملاء بلا sales.customer.view', async () => {
    const stack = await createFullTenantStack('cust-rbac');
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);

    const createAttempt = await request(app).post('/api/customers').set('Authorization', `Bearer ${limited.token}`)
      .send({ code: 'C-RBAC', nameAr: 'x', nameEn: 'x', currencyCode: 'EGP' });
    expect(createAttempt.status).toBe(403);

    const listAttempt = await request(app).get('/api/customers').set('Authorization', `Bearer ${limited.token}`);
    expect(listAttempt.status).toBe(403);
  });

  it('RBAC: مستخدم بصلاحية sales.customer.view فقط يمكنه القراءة لكن لا الإنشاء', async () => {
    const stack = await createFullTenantStack('cust-rbac-view');
    await request(app).post('/api/customers').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'C-VIEW', nameAr: 'x', nameEn: 'x', currencyCode: 'EGP' });

    const viewer = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, ['sales.customer.view']);
    const list = await request(app).get('/api/customers').set('Authorization', `Bearer ${viewer.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);

    const createAttempt = await request(app).post('/api/customers').set('Authorization', `Bearer ${viewer.token}`)
      .send({ code: 'C-VIEW-2', nameAr: 'y', nameEn: 'y', currencyCode: 'EGP' });
    expect(createAttempt.status).toBe(403);
  });

  it('عزل المؤسسات: شركة أخرى لا ترى عميل شركة A (404)', async () => {
    const companyA = await createFullTenantStack('cust-iso-a');
    const companyB = await createFullTenantStack('cust-iso-b');

    const created = await request(app).post('/api/customers').set('Authorization', `Bearer ${companyA.token}`)
      .send({ code: 'C-ISO', nameAr: 'x', nameEn: 'x', currencyCode: 'EGP' });

    const attempt = await request(app).get(`/api/customers/${created.body.id}`).set('Authorization', `Bearer ${companyB.token}`);
    expect(attempt.status).toBe(404);
  });

  it('يسجّل إنشاء العميل في سجل التدقيق مع معرّف الحساب المرتبط', async () => {
    const stack = await createFullTenantStack('cust-audit');
    const created = await request(app).post('/api/customers').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'C-AUD', nameAr: 'x', nameEn: 'x', currencyCode: 'EGP' });

    const log = await pool.query(
      `SELECT action, after_json FROM audit_logs WHERE entity_type='customer' AND entity_id=$1`,
      [created.body.id],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].action).toBe('create');
    expect(log.rows[0].after_json.linkedAccountId).toBe(created.body.linked_account_id);
  });
});
