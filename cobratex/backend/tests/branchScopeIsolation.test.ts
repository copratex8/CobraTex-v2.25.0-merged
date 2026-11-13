import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem } from './helpers';
import { grantBranchScope, grantPermissionsToRole, createRole, assignRoleToUser, createUser } from '@/modules/identity/identityService';
import { signAccessToken } from '@/shared/auth';
import { RequestContext, GrantedPermission } from '@/shared/requestContext';

const app = createApp();

interface Fixture {
  companyId: string;
  tenantId: string;
  branchId: string;
  warehouseId: string;
  itemId: string;
  uomId: string;
  categoryId: string;
  fiscalPeriodId: string;
  ctx: RequestContext;
  token: string;
}

/** يهيّئ شركة كاملة بحسابات/فئة صنف/قواعد ترحيل، جاهزة لإنشاء فواتير مرحّلة حقيقية على أي فرع. */
async function setupCompany(prefix: string): Promise<Fixture> {
  const stack = await createFullTenantStack(prefix);
  const { revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
  const { itemId, uomId } = await createBaseItem(stack.companyId);
  await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_revenue', debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
    creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
  });
  await createPostingRule(stack.ctx, {
    operationType: 'sales_invoice_cogs', debitAccountSourceType: 'ITEM_CATEGORY_COGS', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
  });
  return {
    companyId: stack.companyId, tenantId: stack.tenantId, branchId: stack.branchId, warehouseId: stack.warehouseId,
    itemId, uomId, categoryId, fiscalPeriodId, ctx: stack.ctx, token: stack.token,
  };
}

async function createBranch(companyId: string, name: string) {
  const branch = await pool.query(`INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,$2,$2) RETURNING id`, [companyId, name]);
  const warehouse = await pool.query(
    `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,$3,$3) RETURNING id`,
    [branch.rows[0].id, companyId, `مخزن ${name}`],
  );
  return { branchId: branch.rows[0].id, warehouseId: warehouse.rows[0].id };
}

/** ينشئ فاتورة بيع مرحّلة حقيقية على فرع/مخزن مُحدَّدين ضمن نفس الشركة. */
async function postInvoiceOn(f: Fixture, branchId: string, warehouseId: string) {
  await recordInMovement(f.ctx, {
    branchId, warehouseId, itemId: f.itemId, quantity: '50', unitCost: '10',
    movementDate: '2026-01-01', sourceDocumentType: 'opening',
  });
  const customer = await createCustomer(f.ctx, { code: `C-${branchId.slice(0, 6)}`, nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
  const invoice = await createSalesInvoice(f.ctx, {
    branchId, warehouseId, customerId: customer.id, fiscalPeriodId: f.fiscalPeriodId,
    currencyCode: 'EGP', invoiceDate: '2026-02-01',
    lines: [{ itemId: f.itemId, uomId: f.uomId, quantity: '5', unitPrice: '20' }],
  });
  await postSalesInvoice(f.ctx, invoice.id);
  return invoice.id;
}

async function createScopedUser(
  f: Fixture, branchIds: string[], scopeType: 'single' | 'multi' | 'all', permissionCodes: string[],
) {
  const user = await createUser({
    tenantId: f.tenantId, companyId: f.companyId, fullName: 'Scoped User',
    email: `scoped-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: 'Passw0rd!123',
  });
  for (const b of branchIds) await grantBranchScope(user.id, b, f.companyId, scopeType);
  const role = await createRole(f.companyId, `Role-${user.id.slice(0, 8)}`);
  await grantPermissionsToRole(role.id, permissionCodes, scopeType === 'all' ? 'all_branches' : 'own_branch');
  await assignRoleToUser(user.id, role.id, f.companyId);

  const rows = await pool.query(`SELECT code FROM permissions WHERE code = ANY($1::text[])`, [permissionCodes]);
  const permissions: GrantedPermission[] = rows.rows.map((r: { code: string }) => ({
    code: r.code, scope: scopeType === 'all' ? 'all_branches' : 'own_branch',
  }));
  const claims = { userId: user.id, tenantId: f.tenantId, companyId: f.companyId, branchIds, scopeType, permissions };
  return { userId: user.id, token: signAccessToken(claims), ctx: new RequestContext(claims) };
}

describe('عزل نطاق الفرع على مسارات القراءة (مركزي: fetchScopedById / assertBranchScope / assertWarehouseScope)', () => {
  it('مستخدم بفرع واحد: 200 على فاتورة فرعه، 403 على فاتورة فرع آخر لنفس الشركة', async () => {
    const f = await setupCompany('bs-single');
    const branch2 = await createBranch(f.companyId, 'فرع 2');
    const invoiceOnBranch1 = await postInvoiceOn(f, f.branchId, f.warehouseId);
    const invoiceOnBranch2 = await postInvoiceOn(f, branch2.branchId, branch2.warehouseId);

    const user = await createScopedUser(f, [f.branchId], 'single', ['sales.invoice.view']);

    const ownBranchRes = await request(app).get(`/api/sales/invoices/${invoiceOnBranch1}`).set('Authorization', `Bearer ${user.token}`);
    expect(ownBranchRes.status).toBe(200);

    const otherBranchRes = await request(app).get(`/api/sales/invoices/${invoiceOnBranch2}`).set('Authorization', `Bearer ${user.token}`);
    expect(otherBranchRes.status).toBe(403);
  });

  it('مستخدم بعدة فروع (multi): 200 على كلا الفرعين المسموحين، 403 على فرع ثالث خارج القائمة', async () => {
    const f = await setupCompany('bs-multi');
    const branch2 = await createBranch(f.companyId, 'فرع 2');
    const branch3 = await createBranch(f.companyId, 'فرع 3');
    const inv1 = await postInvoiceOn(f, f.branchId, f.warehouseId);
    const inv2 = await postInvoiceOn(f, branch2.branchId, branch2.warehouseId);
    const inv3 = await postInvoiceOn(f, branch3.branchId, branch3.warehouseId);

    const user = await createScopedUser(f, [f.branchId, branch2.branchId], 'multi', ['sales.invoice.view']);

    expect((await request(app).get(`/api/sales/invoices/${inv1}`).set('Authorization', `Bearer ${user.token}`)).status).toBe(200);
    expect((await request(app).get(`/api/sales/invoices/${inv2}`).set('Authorization', `Bearer ${user.token}`)).status).toBe(200);
    expect((await request(app).get(`/api/sales/invoices/${inv3}`).set('Authorization', `Bearer ${user.token}`)).status).toBe(403);
  });

  it('مدير بنطاق كل الفروع (all): 200 على كل الفروع الثلاثة بلا استثناء', async () => {
    const f = await setupCompany('bs-all');
    const branch2 = await createBranch(f.companyId, 'فرع 2');
    const branch3 = await createBranch(f.companyId, 'فرع 3');
    const inv1 = await postInvoiceOn(f, f.branchId, f.warehouseId);
    const inv2 = await postInvoiceOn(f, branch2.branchId, branch2.warehouseId);
    const inv3 = await postInvoiceOn(f, branch3.branchId, branch3.warehouseId);

    const manager = await createScopedUser(f, [f.branchId], 'all', ['sales.invoice.view']);

    for (const id of [inv1, inv2, inv3]) {
      expect((await request(app).get(`/api/sales/invoices/${id}`).set('Authorization', `Bearer ${manager.token}`)).status).toBe(200);
    }
  });

  it('معرّف من شركة أخرى بالكامل → 404 (سياسة عدم الإفصاح، لا 403)', async () => {
    const companyA = await setupCompany('bs-cross-company-a');
    const invoiceA = await postInvoiceOn(companyA, companyA.branchId, companyA.warehouseId);
    const companyB = await setupCompany('bs-cross-company-b');

    const res = await request(app).get(`/api/sales/invoices/${invoiceA}`).set('Authorization', `Bearer ${companyB.token}`);
    expect(res.status).toBe(404);
  });

  it('رصيد المخزون (assertWarehouseScope): 403 لمخزن خارج نطاق فرع المستخدم، 200 لمخزن فرعه', async () => {
    const f = await setupCompany('bs-warehouse');
    const branch2 = await createBranch(f.companyId, 'فرع 2');
    await postInvoiceOn(f, f.branchId, f.warehouseId);

    const user = await createScopedUser(f, [f.branchId], 'single', ['inventory.balance.view']);

    const ownWarehouse = await request(app)
      .get(`/api/inventory/balance?warehouseId=${f.warehouseId}&itemId=${f.itemId}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(ownWarehouse.status).toBe(200);

    const otherWarehouse = await request(app)
      .get(`/api/inventory/balance?warehouseId=${branch2.warehouseId}&itemId=${f.itemId}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(otherWarehouse.status).toBe(403);
  });

  it('رصيد المخزون بمخزن من شركة أخرى تمامًا → 404', async () => {
    const companyA = await setupCompany('bs-wh-company-a');
    const companyB = await setupCompany('bs-wh-company-b');
    const res = await request(app)
      .get(`/api/inventory/balance?warehouseId=${companyA.warehouseId}&itemId=${companyA.itemId}`)
      .set('Authorization', `Bearer ${companyB.token}`);
    expect(res.status).toBe(404);
  });

  it('كيانات مستوى الشركة (العملاء): تُعزل بمستوى الشركة فقط، بلا فحص فرع، والقائمة والتفاصيل كلاهما محميان', async () => {
    const f = await setupCompany('bs-company-level');
    await createCustomer(f.ctx, { code: 'CL-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const list = await request(app).get('/api/customers').set('Authorization', `Bearer ${f.token}`);
    expect(list.status).toBe(200);
    const customerId = list.body.data[0].id;

    const otherCompany = await setupCompany('bs-company-level-b');
    const crossCompany = await request(app).get(`/api/customers/${customerId}`).set('Authorization', `Bearer ${otherCompany.token}`);
    expect(crossCompany.status).toBe(404);

    // لكن مستخدم بفرع مختلف داخل *نفس* الشركة يرى العميل بلا مشكلة (لا عزل فرعي على كيان شركة)
    const branch2 = await createBranch(f.companyId, 'فرع آخر');
    const sameCompanyOtherBranchUser = await createScopedUser(f, [branch2.branchId], 'single', ['sales.customer.view']);
    const sameCompanyRead = await request(app).get(`/api/customers/${customerId}`).set('Authorization', `Bearer ${sameCompanyOtherBranchUser.token}`);
    expect(sameCompanyRead.status).toBe(200);
  });

  it('401 لغياب التوكن على مسار قراءة محمي', async () => {
    const f = await setupCompany('bs-401');
    const invoiceId = await postInvoiceOn(f, f.branchId, f.warehouseId);
    const res = await request(app).get(`/api/sales/invoices/${invoiceId}`);
    expect(res.status).toBe(401);
  });
});

describe('تحقق Zod المركزي على مسارات القراءة المُراجَعة', () => {
  it('يرفض معرّف غير صالح (ليس UUID) بـ 422 قبل الوصول لقاعدة البيانات', async () => {
    const f = await setupCompany('zod-invalid-id');
    const res = await request(app).get('/api/sales/invoices/not-a-uuid').set('Authorization', `Bearer ${f.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/تحقق من المدخلات فشل/);
  });

  it('يرفض استعلام رصيد المخزون بحقل إضافي غير متوقع (مثال: companyId في query) بـ 422', async () => {
    const f = await setupCompany('zod-extra-field');
    const res = await request(app)
      .get(`/api/inventory/balance?warehouseId=${f.warehouseId}&itemId=${f.itemId}&companyId=malicious-id`)
      .set('Authorization', `Bearer ${f.token}`);
    expect(res.status).toBe(422);
  });

  it('يرفض استعلام رصيد المخزون بلا warehouseId أو itemId', async () => {
    const f = await setupCompany('zod-missing-fields');
    const res = await request(app).get('/api/inventory/balance').set('Authorization', `Bearer ${f.token}`);
    expect(res.status).toBe(422);
  });

  it('استعلام صالح بمعرّفات UUID سليمة ينجح كالمعتاد', async () => {
    const f = await setupCompany('zod-valid');
    await postInvoiceOn(f, f.branchId, f.warehouseId);
    const res = await request(app)
      .get(`/api/inventory/balance?warehouseId=${f.warehouseId}&itemId=${f.itemId}`)
      .set('Authorization', `Bearer ${f.token}`);
    expect(res.status).toBe(200);
  });
});
