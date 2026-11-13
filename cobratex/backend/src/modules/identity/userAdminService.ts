import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import type { PoolClient } from 'pg';
import { RequestContext, ForbiddenScopeError, type PermissionScope } from '@/shared/requestContext';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors';
import { hashPassword, verifyPassword } from '@/shared/auth';
import { writeAuditLog } from '@/shared/audit';
import { createUser as coreCreateUser } from '@/modules/identity/identityService';
import { invalidateActiveUser } from '@/shared/activeUsers';
import { generatePassword } from '@/modules/platform/brandingService';

/**
 * إدارة المستخدمين والأدوار (2.24.0). كل مستخدم بكلمة مرور خاصة وأدوار بصلاحيات حسب الشركة.
 * حمايات: لا تصعيد صلاحيات (لا تمنح ما لا تملكه)، الدور النظامي (Owner) غير قابل للتعديل،
 * ولا يمكن ترك الشركة بلا مدير نشط يملك admin.users.manage، ولا يعطّل المستخدم نفسه.
 */
const RANK: Record<PermissionScope, number> = { own_branch: 1, multi_branch: 2, all_branches: 3 };
export const PASSWORD_HELP = 'كلمة المرور 8 أحرف على الأقل (72 بايت كحد أقصى) وتحوي حروفًا وأرقامًا';

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8 || Buffer.byteLength(pw, 'utf8') > 72 || !/[A-Za-z؀-ۿ]/.test(pw) || !/\d/.test(pw)) throw new ValidationError(PASSWORD_HELP);
  return pw;
}

/** قوالب أدوار جاهزة: تُحسب من قائمة الصلاحيات الفعلية، ولا تشمل إدارة المستخدمين/النظام/إعدادات الشركة أبدًا. */
export const ROLE_TEMPLATES: { id: string; name: string; desc: string; match: (code: string) => boolean }[] = (() => {
  const view = (c: string) => /\.view$/.test(c);
  const starts = (...p: string[]) => (c: string) => p.some((x) => c.startsWith(x));
  const forbidden = (c: string) => c.startsWith('admin.') || c.startsWith('system.') || c === 'company.settings.update';
  const t = (id: string, name: string, desc: string, m: (c: string) => boolean) => ({ id, name, desc, match: (c: string) => !forbidden(c) && m(c) });
  return [
    t('viewer', 'مشاهد فقط', 'يرى كل البيانات ولا يُدخل أو يعدّل شيئًا', view),
    t('accountant', 'محاسب', 'الحسابات والخزينة والضرائب والأصول + عرض بقية الأنظمة', (c) => view(c) || starts('accounting.', 'treasury.', 'wht.', 'fx.', 'assets.', 'carryforward.', 'landed.', 'attachments.')(c)),
    t('storekeeper', 'أمين مخزن', 'المخزون والأصناف والاستلامات والجرد وسجل الخيوط', (c) => view(c) || starts('inventory.', 'items.', 'purchasing.receipt.', 'textile.lots.', 'yarnlot.', 'attachments.')(c)),
    t('sales', 'مبيعات', 'العملاء والعروض والطلبات والفواتير والمرتجعات والتحصيل', (c) => view(c) || starts('sales.', 'attachments.')(c)),
    t('purchasing', 'مشتريات', 'الموردون وأوامر وفواتير الشراء والاستلام والسداد', (c) => view(c) || starts('purchasing.', 'attachments.')(c)),
    t('production', 'مدير إنتاج', 'التصنيع والغزل والنسيج والصباغة والجودة والصيانة', (c) => view(c) || starts('manufacturing.', 'textile.', 'yarnlot.', 'inventory.movement', 'attachments.')(c)),
  ];
})();

function assertCanGrant(ctx: RequestContext, codes: string[], scope: PermissionScope) {
  const mine = new Map(ctx.permissions.map((p) => [p.code, p.scope]));
  for (const c of codes) {
    const have = mine.get(c);
    if (!have) throw new ForbiddenScopeError(`لا يمكنك منح صلاحية لا تملكها: ${c}`);
    if (RANK[have] < RANK[scope]) throw new ForbiddenScopeError(`لا يمكنك منح نطاق أوسع من نطاقك في: ${c}`);
  }
}

async function assertAdminRemains(client: PoolClient, companyId: string) {
  const { rows } = await client.query(
    `SELECT count(DISTINCT u.id)::int AS n FROM users u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.company_id = $1
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id AND p.code = 'admin.users.manage'
      WHERE u.company_id = $1 AND u.is_active`, [companyId]);
  if (rows[0].n < 1) throw new ValidationError('لا يمكن تنفيذ ذلك: يجب أن يبقى مستخدم نشط واحد على الأقل يملك إدارة المستخدمين');
}

/* ───────────── القراءة ───────────── */
export async function listPermissions(ctx: RequestContext) {
  ctx.assertPermission('admin.roles.manage');
  const { rows } = await pool.query(`SELECT code FROM permissions ORDER BY code`);
  const codes = rows.map((r) => r.code as string);
  const mine = new Set(ctx.permissions.map((p) => p.code));
  return {
    codes, grantable: codes.filter((c) => mine.has(c)),
    templates: ROLE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, codes: codes.filter(t.match) })),
  };
}

export async function listRoles(ctx: RequestContext) {
  ctx.assertPermission('admin.roles.manage');
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.is_system_role,
            COALESCE((SELECT json_agg(json_build_object('code', p.code, 'scope', rp.scope) ORDER BY p.code) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id), '[]') AS permissions,
            (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
       FROM roles r WHERE r.company_id = $1 ORDER BY r.is_system_role DESC, r.name`, [ctx.companyId]);
  return rows.map((r) => ({ id: r.id, name: r.name, isSystem: r.is_system_role, userCount: r.user_count, permissions: r.permissions }));
}

export async function listUsers(ctx: RequestContext) {
  ctx.assertPermission('admin.users.manage');
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.last_login_at,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '[]') AS roles,
            COALESCE((SELECT json_agg(s.branch_id) FROM user_branch_scopes s WHERE s.user_id = u.id), '[]') AS branch_ids,
            EXISTS (SELECT 1 FROM user_branch_scopes s WHERE s.user_id = u.id AND s.scope_type = 'all') AS all_branches
       FROM users u WHERE u.tenant_id = $1 AND u.company_id = $2 ORDER BY u.created_at`, [ctx.tenantId, ctx.companyId]);
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, phone: r.phone, isActive: r.is_active, lastLoginAt: r.last_login_at, roles: r.roles, branchIds: r.branch_ids, allBranches: r.all_branches, isSelf: r.id === ctx.userId }));
}

/* ───────────── الأدوار ───────────── */
export const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  scope: z.enum(['own_branch', 'multi_branch', 'all_branches']).default('own_branch'),
  permissionCodes: z.array(z.string().min(3).max(80)).min(1).max(400),
});
type RoleInput = z.infer<typeof roleSchema>;

async function validCodes(client: PoolClient | typeof pool, codes: string[]): Promise<string[]> {
  const uniq = [...new Set(codes)];
  const { rows } = await client.query(`SELECT code FROM permissions WHERE code = ANY($1::text[])`, [uniq]);
  const ok = new Set(rows.map((r: { code: string }) => r.code));
  const bad = uniq.filter((c) => !ok.has(c));
  if (bad.length) throw new ValidationError(`صلاحيات غير معروفة: ${bad.slice(0, 5).join('، ')}`);
  return uniq;
}

export async function createRole(ctx: RequestContext, input: RoleInput) {
  ctx.assertPermission('admin.roles.manage');
  const codes = await validCodes(pool, input.permissionCodes);
  assertCanGrant(ctx, codes, input.scope);
  return withTransaction(async (client) => {
    let role;
    try {
      role = (await client.query(`INSERT INTO roles(company_id, name, is_system_role) VALUES ($1,$2,false) RETURNING id, name`, [ctx.companyId, input.name])).rows[0];
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError('يوجد دور بهذا الاسم'); throw e; }
    await client.query(`INSERT INTO role_permissions(role_id, permission_id, scope) SELECT $1, p.id, $3 FROM permissions p WHERE p.code = ANY($2::text[])`, [role.id, codes, input.scope]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'role', entityId: role.id, action: 'create', afterJson: { name: input.name, scope: input.scope, count: codes.length } });
    return { id: role.id as string, name: role.name as string };
  });
}

export async function updateRole(ctx: RequestContext, roleId: string, input: RoleInput) {
  ctx.assertPermission('admin.roles.manage');
  const codes = await validCodes(pool, input.permissionCodes);
  assertCanGrant(ctx, codes, input.scope);
  return withTransaction(async (client) => {
    const r = await client.query(`SELECT id, is_system_role FROM roles WHERE id = $1 AND company_id = $2 FOR UPDATE`, [roleId, ctx.companyId]);
    if (!r.rows[0]) throw new NotFoundError('الدور غير موجود');
    if (r.rows[0].is_system_role) throw new ValidationError('الدور النظامي لا يُعدَّل');
    try { await client.query(`UPDATE roles SET name = $2 WHERE id = $1`, [roleId, input.name]); }
    catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError('يوجد دور بهذا الاسم'); throw e; }
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    await client.query(`INSERT INTO role_permissions(role_id, permission_id, scope) SELECT $1, p.id, $3 FROM permissions p WHERE p.code = ANY($2::text[])`, [roleId, codes, input.scope]);
    await assertAdminRemains(client, ctx.companyId);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'role', entityId: roleId, action: 'update', afterJson: { name: input.name, scope: input.scope, count: codes.length } });
    return { id: roleId, name: input.name };
  });
}

export async function deleteRole(ctx: RequestContext, roleId: string) {
  ctx.assertPermission('admin.roles.manage');
  await withTransaction(async (client) => {
    const r = await client.query(`SELECT is_system_role, name FROM roles WHERE id = $1 AND company_id = $2 FOR UPDATE`, [roleId, ctx.companyId]);
    if (!r.rows[0]) throw new NotFoundError('الدور غير موجود');
    if (r.rows[0].is_system_role) throw new ValidationError('الدور النظامي لا يُحذف');
    const n = await client.query(`SELECT count(*)::int AS n FROM user_roles WHERE role_id = $1`, [roleId]);
    if (n.rows[0].n > 0) throw new ConflictError(`الدور مُسنَد إلى ${n.rows[0].n} مستخدم — انقلهم لدور آخر أولًا`);
    await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    await client.query(`DELETE FROM roles WHERE id = $1`, [roleId]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'role', entityId: roleId, action: 'delete', beforeJson: { name: r.rows[0].name } });
  });
}

/* ───────────── المستخدمون ───────────── */
export const userCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  phone: z.string().trim().max(30).optional(),
  password: z.string().max(128).optional(),
  roleIds: z.array(z.string().uuid()).min(1, 'اختر دورًا واحدًا على الأقل').max(20),
  branchIds: z.array(z.string().uuid()).max(200).default([]),
  allBranches: z.boolean().default(false),
});
export const userUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  isActive: z.boolean().optional(),
  roleIds: z.array(z.string().uuid()).min(1).max(20).optional(),
  branchIds: z.array(z.string().uuid()).max(200).optional(),
  allBranches: z.boolean().optional(),
});

async function loadGrantableRoles(client: PoolClient | typeof pool, ctx: RequestContext, roleIds: string[]) {
  const { rows } = await client.query(
    `SELECT r.id, r.name,
            COALESCE(json_agg(json_build_object('code', p.code, 'scope', rp.scope)) FILTER (WHERE p.code IS NOT NULL), '[]') AS perms
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id = $1 AND r.id = ANY($2::uuid[]) GROUP BY r.id`, [ctx.companyId, roleIds]);
  if (rows.length !== new Set(roleIds).size) throw new ValidationError('دور غير موجود في هذه الشركة');
  const mine = new Map(ctx.permissions.map((p) => [p.code, p.scope]));
  for (const r of rows) for (const p of r.perms as { code: string; scope: PermissionScope }[]) {
    const have = mine.get(p.code);
    if (!have || RANK[have] < RANK[p.scope]) throw new ForbiddenScopeError(`لا يمكنك إسناد الدور «${r.name}»: يتضمن صلاحيات تفوق صلاحياتك`);
  }
}
async function setBranches(client: PoolClient, ctx: RequestContext, userId: string, branchIds: string[], all: boolean) {
  const { rows } = await client.query(`SELECT id FROM branches WHERE company_id = $1 AND is_active`, [ctx.companyId]);
  const valid = new Set(rows.map((r: { id: string }) => r.id));
  const target = all ? [...valid] : [...new Set(branchIds)];
  if (target.length === 0) throw new ValidationError('حدّد فرعًا واحدًا على الأقل أو «كل الفروع»');
  if (target.some((b) => !valid.has(b))) throw new ValidationError('فرع غير صالح');
  await client.query(`DELETE FROM user_branch_scopes WHERE user_id = $1`, [userId]);
  for (const b of target) await client.query(`INSERT INTO user_branch_scopes(user_id, branch_id, company_id, scope_type) VALUES ($1,$2,$3,$4)`, [userId, b, ctx.companyId, all ? 'all' : target.length > 1 ? 'multi' : 'single']);
}

export async function createUser(ctx: RequestContext, input: z.infer<typeof userCreateSchema>) {
  ctx.assertPermission('admin.users.manage');
  const password = input.password ? validatePassword(input.password) : generatePassword();
  await loadGrantableRoles(pool, ctx, input.roleIds);
  const u = await coreCreateUser({ tenantId: ctx.tenantId, companyId: ctx.companyId, fullName: input.fullName, email: input.email.trim().toLowerCase(), password }); // يطبّق حد التراخيص والتكرار
  try {
    await withTransaction(async (client) => {
      if (input.phone) await client.query(`UPDATE users SET phone = $2 WHERE id = $1`, [u.id, input.phone]);
      for (const rid of input.roleIds) await client.query(`INSERT INTO user_roles(user_id, role_id, company_id) VALUES ($1,$2,$3)`, [u.id, rid, ctx.companyId]);
      await setBranches(client, ctx, u.id, input.branchIds, input.allBranches);
    });
  } catch (e) { await pool.query(`DELETE FROM users WHERE id = $1`, [u.id]).catch(() => undefined); throw e; }
  return { id: u.id as string, email: input.email.trim().toLowerCase(), ...(input.password ? {} : { generatedPassword: password }) };
}

export async function updateUser(ctx: RequestContext, userId: string, input: z.infer<typeof userUpdateSchema>) {
  ctx.assertPermission('admin.users.manage');
  if (userId === ctx.userId && (input.isActive === false || input.roleIds !== undefined)) throw new ValidationError('لا يمكنك تعطيل نفسك أو تغيير أدوارك — اطلب ذلك من مدير آخر');
  return withTransaction(async (client) => {
    const cur = await client.query(`SELECT id, is_active FROM users WHERE id = $1 AND tenant_id = $2 AND company_id = $3 FOR UPDATE`, [userId, ctx.tenantId, ctx.companyId]);
    if (!cur.rows[0]) throw new NotFoundError('المستخدم غير موجود');
    if (input.fullName !== undefined) await client.query(`UPDATE users SET full_name = $2 WHERE id = $1`, [userId, input.fullName]);
    if (input.phone !== undefined) await client.query(`UPDATE users SET phone = $2 WHERE id = $1`, [userId, input.phone]);
    if (input.isActive !== undefined) {
      await client.query(`UPDATE users SET is_active = $2 WHERE id = $1`, [userId, input.isActive]);
      if (!input.isActive) await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      invalidateActiveUser(userId);
    }
    if (input.roleIds) {
      await loadGrantableRoles(client, ctx, input.roleIds);
      await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
      for (const rid of input.roleIds) await client.query(`INSERT INTO user_roles(user_id, role_id, company_id) VALUES ($1,$2,$3)`, [userId, rid, ctx.companyId]);
    }
    if (input.branchIds !== undefined || input.allBranches !== undefined) {
      const ex = await client.query(`SELECT branch_id, scope_type FROM user_branch_scopes WHERE user_id = $1`, [userId]);
      const all = input.allBranches ?? ex.rows.some((r: { scope_type: string }) => r.scope_type === 'all');
      await setBranches(client, ctx, userId, input.branchIds ?? ex.rows.map((r: { branch_id: string }) => r.branch_id), all);
    }
    await assertAdminRemains(client, ctx.companyId);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'user', entityId: userId, action: 'update', afterJson: { ...input } });
    return { id: userId };
  });
}

/** إعادة ضبط كلمة مرور مستخدم (مدير): تُنهي كل جلساته. بلا كلمة ⇒ تُولَّد وتُعاد مرة واحدة. */
export async function resetPassword(ctx: RequestContext, userId: string, password?: string) {
  ctx.assertPermission('admin.users.manage');
  const pw = password ? validatePassword(password) : generatePassword();
  const r = await pool.query(`UPDATE users SET password_hash = $4 WHERE id = $1 AND tenant_id = $2 AND company_id = $3`, [userId, ctx.tenantId, ctx.companyId, await hashPassword(pw)]);
  if (r.rowCount === 0) throw new NotFoundError('المستخدم غير موجود');
  await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'user', entityId: userId, action: 'update', afterJson: { event: 'password_reset' } });
  return password ? { ok: true } : { ok: true, generatedPassword: pw };
}

/** تغيير المستخدم لكلمة مروره بنفسه (يتطلب الحالية). يُنهي كل جلساته ليدخل من جديد. */
export async function changeOwnPassword(ctx: RequestContext, current: unknown, next: unknown) {
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [ctx.userId]);
  if (!rows[0] || typeof current !== 'string' || !(await verifyPassword(current, rows[0].password_hash))) throw new ValidationError('كلمة المرور الحالية غير صحيحة');
  const pw = validatePassword(next);
  if (pw === current) throw new ValidationError('كلمة المرور الجديدة مطابقة للحالية');
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [ctx.userId, await hashPassword(pw)]);
  await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [ctx.userId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'user', entityId: ctx.userId, action: 'update', afterJson: { event: 'password_change' } });
  return { ok: true };
}


/** المستخدم الحالي + أكواد صلاحياته ونطاقاتها. */
export async function me(ctx: RequestContext) {
  const { rows } = await pool.query(`SELECT id, full_name, email, phone FROM users WHERE id = $1`, [ctx.userId]);
  return { ...rows[0], tenantId: ctx.tenantId, companyId: ctx.companyId, permissions: [...ctx.permissions] };
}
