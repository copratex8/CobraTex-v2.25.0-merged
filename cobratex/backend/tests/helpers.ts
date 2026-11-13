import { randomUUID } from 'crypto';
import { pool } from '@/db/pool';
import { signAccessToken } from '@/shared/auth';
import { hashPassword } from '@/shared/auth';
import { RequestContext, GrantedPermission } from '@/shared/requestContext';
import { grantOwnerRole, createRole, grantPermissionsToRole, assignRoleToUser } from '@/modules/identity/identityService';

export async function createFullTenantStack(prefix = 'test') {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await pool.query(`INSERT INTO tenants(name) VALUES ($1) RETURNING id`, [`${prefix}-tenant-${suffix}`]);
  const company = await pool.query(
    `INSERT INTO companies(tenant_id, legal_name, display_name) VALUES ($1,$2,$2) RETURNING id`,
    [tenant.rows[0].id, `${prefix}-company-${suffix}`],
  );
  const branch = await pool.query(
    `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,$2,$2) RETURNING id`,
    [company.rows[0].id, `${prefix}-branch-${suffix}`],
  );
  const warehouse = await pool.query(
    `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,$3,$3) RETURNING id`,
    [branch.rows[0].id, company.rows[0].id, `${prefix}-wh-${suffix}`],
  );
  const passwordHash = await hashPassword('Passw0rd!123');
  const user = await pool.query(
    `INSERT INTO users(tenant_id, company_id, full_name, email, password_hash)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenant.rows[0].id, company.rows[0].id, 'Owner', `owner-${suffix}@example.com`, passwordHash],
  );
  await pool.query(
    `INSERT INTO user_branch_scopes(user_id, branch_id, company_id, scope_type) VALUES ($1,$2,$3,'all')`,
    [user.rows[0].id, branch.rows[0].id, company.rows[0].id],
  );
  await grantOwnerRole(user.rows[0].id, company.rows[0].id); // كل الصلاحيات المُسجَّلة، بنطاق all_branches

  const allPermissions = await pool.query(`SELECT code FROM permissions`);
  const permissions: GrantedPermission[] = allPermissions.rows.map((r: { code: string }) => ({
    code: r.code, scope: 'all_branches',
  }));

  const claims = {
    userId: user.rows[0].id,
    tenantId: tenant.rows[0].id,
    companyId: company.rows[0].id,
    branchIds: [branch.rows[0].id],
    scopeType: 'all' as const,
    permissions,
  };

  return {
    tenantId: tenant.rows[0].id,
    companyId: company.rows[0].id,
    branchId: branch.rows[0].id,
    warehouseId: warehouse.rows[0].id,
    userId: user.rows[0].id,
    token: signAccessToken(claims),
    ctx: new RequestContext(claims),
  };
}

/** يُنشئ مستخدمًا محدود الصلاحيات (فقط الأكواد المُمرَّرة) لاختبارات RBAC السلبية. */
export async function createLimitedPermissionUser(
  tenantId: string,
  companyId: string,
  branchId: string,
  permissionCodes: string[],
) {
  const suffix = randomUUID().slice(0, 8);
  const passwordHash = await hashPassword('Passw0rd!123');
  const user = await pool.query(
    `INSERT INTO users(tenant_id, company_id, full_name, email, password_hash)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, companyId, 'Limited User', `limited-${suffix}@example.com`, passwordHash],
  );
  await pool.query(
    `INSERT INTO user_branch_scopes(user_id, branch_id, company_id, scope_type) VALUES ($1,$2,$3,'single')`,
    [user.rows[0].id, branchId, companyId],
  );
  if (permissionCodes.length > 0) {
    const role = await createRole(companyId, `Limited-${suffix}`);
    await grantPermissionsToRole(role.id, permissionCodes, 'own_branch');
    await assignRoleToUser(user.rows[0].id, role.id, companyId);
  }

  const grantedRows = await pool.query(
    `SELECT p.code FROM permissions p WHERE p.code = ANY($1::text[])`,
    [permissionCodes],
  );
  const permissions: GrantedPermission[] = grantedRows.rows.map((r: { code: string }) => ({
    code: r.code, scope: 'own_branch' as const,
  }));

  const claims = {
    userId: user.rows[0].id,
    tenantId,
    companyId,
    branchIds: [branchId],
    scopeType: 'single' as const,
    permissions,
  };

  return { userId: user.rows[0].id, token: signAccessToken(claims), ctx: new RequestContext(claims) };
}

export async function createAccountAndFiscalPeriod(companyId: string) {
  const cash = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1000','النقدية','Cash','asset') RETURNING id`,
    [companyId],
  );
  const revenue = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'4000','الإيرادات','Revenue','revenue') RETURNING id`,
    [companyId],
  );
  const inventory = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1200','المخزون','Inventory','asset') RETURNING id`,
    [companyId],
  );
  const cogs = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5000','تكلفة المبيعات','COGS','expense') RETURNING id`,
    [companyId],
  );
  const payable = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'2000','الموردون (تجريبي)','Suppliers (test)','liability') RETURNING id`,
    [companyId],
  );
  const period = await pool.query(
    `INSERT INTO fiscal_periods(company_id, start_date, end_date) VALUES ($1,'2026-01-01','2026-12-31') RETURNING id`,
    [companyId],
  );
  return {
    cashAccountId: cash.rows[0].id,
    revenueAccountId: revenue.rows[0].id,
    inventoryAccountId: inventory.rows[0].id,
    cogsAccountId: cogs.rows[0].id,
    payableAccountId: payable.rows[0].id,
    fiscalPeriodId: period.rows[0].id,
  };
}

export async function createBaseItem(companyId: string) {
  const uom = await pool.query(
    `INSERT INTO uoms(company_id, name_ar, name_en, symbol) VALUES ($1,'متر','Meter',$2) RETURNING id`,
    [companyId, `m-${randomUUID().slice(0, 8)}`],
  );
  const item = await pool.query(
    `INSERT INTO items(company_id, item_kind, code, name_ar, name_en, base_uom_id)
     VALUES ($1,'fabric',$2,'قماش تجريبي','Test Fabric',$3) RETURNING id`,
    [companyId, `SKU-${randomUUID().slice(0, 8)}`, uom.rows[0].id],
  );
  return { itemId: item.rows[0].id, uomId: uom.rows[0].id };
}

/** فئة صنف بحسابي مخزون/تكلفة مبيعات افتراضيين — مطلوبة لاختبار ITEM_CATEGORY_INVENTORY/COGS في PostingRule. */
export async function createItemCategoryWithAccounts(companyId: string, inventoryAccountId: string, cogsAccountId: string) {
  const category = await pool.query(
    `INSERT INTO item_categories(company_id, name_ar, name_en, item_kind, default_inventory_account_id, default_cogs_account_id)
     VALUES ($1,'فئة تجريبية','Test Category','fabric',$2,$3) RETURNING id`,
    [companyId, inventoryAccountId, cogsAccountId],
  );
  return { categoryId: category.rows[0].id };
}
