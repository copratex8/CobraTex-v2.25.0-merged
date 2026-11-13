import { assertSeat } from '@/modules/platform/licenseService';
import { PoolClient } from 'pg';
import { pool } from '@/db/pool';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken, hashToken, generateJti } from '@/shared/auth';
import { UnauthorizedError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { config } from '@/config';
import { GrantedPermission, PermissionScope, AuthenticatedUserClaims } from '@/shared/requestContext';

export async function createUser(params: {
  tenantId: string;
  companyId: string;
  fullName: string;
  email: string;
  password: string;
}) {
  await assertSeat(params.tenantId, 'users');
  const passwordHash = await hashPassword(params.password);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users(tenant_id, company_id, full_name, email, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, tenant_id, company_id, full_name, email`,
      [params.tenantId, params.companyId, params.fullName, params.email, passwordHash],
    );
    await writeAuditLog(pool, {
      tenantId: params.tenantId, companyId: params.companyId, userId: rows[0].id,
      entityType: 'user', entityId: rows[0].id, action: 'create',
      afterJson: { email: params.email, fullName: params.fullName },
    });
    return rows[0];
  } catch (e) {
    const pgErr = e as { code?: string };
    if (pgErr.code === '23505') throw new ConflictError('البريد الإلكتروني مستخدم بالفعل داخل هذا المستأجر');
    throw e;
  }
}

export async function grantBranchScope(
  userId: string,
  branchId: string,
  companyId: string,
  scopeType: 'single' | 'multi' | 'all' = 'single',
) {
  await pool.query(
    `INSERT INTO user_branch_scopes(user_id, branch_id, company_id, scope_type)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, branch_id) DO UPDATE SET scope_type = EXCLUDED.scope_type`,
    [userId, branchId, companyId, scopeType],
  );
}

/** ------------------------- RBAC: أدوار وصلاحيات ------------------------- */

export async function createRole(companyId: string, name: string, isSystemRole = false, client?: PoolClient) {
  const runner = client ?? pool;
  const { rows } = await runner.query(
    `INSERT INTO roles(company_id, name, is_system_role) VALUES ($1,$2,$3) RETURNING id, company_id, name`,
    [companyId, name, isSystemRole],
  );
  return rows[0];
}

/** يمنح دورًا مجموعة أكواد صلاحيات بنطاق موحّد. يتجاهل الأكواد غير الموجودة بصمت (لا يوقف الإعداد). */
export async function grantPermissionsToRole(
  roleId: string,
  codes: string[],
  scope: PermissionScope,
  client?: PoolClient,
) {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO role_permissions(role_id, permission_id, scope)
     SELECT $1, p.id, $3 FROM permissions p WHERE p.code = ANY($2::text[])
     ON CONFLICT (role_id, permission_id) DO UPDATE SET scope = EXCLUDED.scope`,
    [roleId, codes, scope],
  );
}

export async function assignRoleToUser(userId: string, roleId: string, companyId: string, client?: PoolClient) {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO user_roles(user_id, role_id, company_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, roleId, companyId],
  );
}

/** يمنح المستخدم دور مالك كامل الصلاحيات (كل الأكواد المُسجَّلة في جدول permissions) بنطاق all_branches. */
export async function grantOwnerRole(userId: string, companyId: string, client?: PoolClient) {
  const runner = client ?? pool;
  const role = await createRole(companyId, 'Owner', true, runner as PoolClient);
  const allCodes = await runner.query(`SELECT code FROM permissions`);
  await grantPermissionsToRole(role.id, allCodes.rows.map((r: { code: string }) => r.code), 'all_branches', runner as PoolClient);
  await assignRoleToUser(userId, role.id, companyId, runner as PoolClient);
  return role;
}

async function resolvePermissions(userId: string, companyId: string): Promise<GrantedPermission[]> {
  const { rows } = await pool.query(
    `SELECT p.code AS code,
            MAX(CASE rp.scope WHEN 'all_branches' THEN 3 WHEN 'multi_branch' THEN 2 ELSE 1 END) AS rank
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1 AND ur.company_id = $2
     GROUP BY p.code`,
    [userId, companyId],
  );
  const rankToScope: Record<number, PermissionScope> = { 3: 'all_branches', 2: 'multi_branch', 1: 'own_branch' };
  return rows.map((r) => ({ code: r.code, scope: rankToScope[Number(r.rank)] }));
}

/** يُعيد بناء ادّعاءات access token كاملة من الصلاحيات الحالية في قاعدة البيانات (لا من توكن قديم)،
 * حتى تنعكس أي تغييرات أدوار/صلاحيات حدثت أثناء الجلسة فور أول تجديد — يُستخدَم من login وrefreshSession معًا. */
async function buildAccessClaims(userId: string, tenantId: string, companyId: string): Promise<AuthenticatedUserClaims> {
  const scopes = await pool.query(
    `SELECT branch_id, scope_type FROM user_branch_scopes WHERE user_id = $1`,
    [userId],
  );
  const scopeType = scopes.rows.some((r) => r.scope_type === 'all') ? 'all' : 'multi';
  const branchIds: string[] = scopes.rows.map((r) => r.branch_id);
  const finalScopeType = branchIds.length <= 1 && scopeType !== 'all' ? 'single' : scopeType;
  const permissions = await resolvePermissions(userId, companyId);
  return { userId, tenantId, companyId, branchIds, scopeType: finalScopeType, permissions };
}

/** يحوّل صيغة TTL المستخدَمة في jsonwebtoken ('7d' | '15m' | ...) لمللي ثانية، لحساب expires_at في
 * قاعدة البيانات (jwt.sign لا يُعيد هذا التاريخ، فنحسبه بأنفسنا لتخزينه). */
function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 0;
  const value = Number(match[1]);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * unitMs[match[2]];
}

/** يُصدر refresh token جديدًا، ويخزّن هاشه فقط (راجع hashToken) في refresh_tokens. */
async function issueRefreshToken(userId: string, tenantId: string, client?: PoolClient) {
  const runner = client ?? pool;
  const jti = generateJti();
  const raw = signRefreshToken({ userId, tenantId, jti });
  const expiresAt = new Date(Date.now() + ttlToMs(config.refreshTokenTtl));
  await runner.query(
    `INSERT INTO refresh_tokens(id, user_id, tenant_id, token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [jti, userId, tenantId, hashToken(raw), expiresAt],
  );
  return { raw, jti };
}

/** هاش وهمي لمقارنة كلمة المرور عند غياب المستخدم: يمنع كشف وجود البريد من فرق زمن الاستجابة. */
let dummyHash: Promise<string> | null = null;

export async function login(email: string, password: string, tenantId: string) {
  if (typeof email !== 'string' || typeof password !== 'string' || typeof tenantId !== 'string' || email.length > 200 || password.length > 200) {
    throw new UnauthorizedError('بيانات الدخول غير صحيحة');
  }
  const { rows } = await pool.query(
    `SELECT id, tenant_id, company_id, password_hash, is_active FROM users
     WHERE lower(email) = lower($1) AND tenant_id = $2 ORDER BY (email = $1) DESC LIMIT 1`,
    [email.trim(), tenantId],
  );
  if (rows.length === 0) {
    dummyHash ??= hashPassword('not-a-real-password-' + Math.random());
    await verifyPassword(password, await dummyHash);
    throw new UnauthorizedError('بيانات الدخول غير صحيحة');
  }
  const user = rows[0];

  // كلمة المرور أولًا: لا نكشف حالة «معطَّل» لمن لا يعرفها.
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await writeAuditLog(pool, { tenantId, companyId: user.company_id, userId: user.id, entityType: 'user', entityId: user.id, action: 'login_failed' });
    throw new UnauthorizedError('بيانات الدخول غير صحيحة');
  }
  if (!user.is_active) {
    await writeAuditLog(pool, { tenantId, companyId: user.company_id, userId: user.id, entityType: 'user', entityId: user.id, action: 'login_failed' });
    throw new UnauthorizedError('الحساب معطَّل');
  }

  const claims = await buildAccessClaims(user.id, user.tenant_id, user.company_id);

  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await writeAuditLog(pool, { tenantId: user.tenant_id, companyId: user.company_id, userId: user.id, entityType: 'user', entityId: user.id, action: 'login' });

  const accessToken = signAccessToken(claims);
  const { raw: refreshToken } = await issueRefreshToken(user.id, user.tenant_id);

  return { accessToken, refreshToken, userId: user.id };
}

/**
 * تجديد الجلسة عبر refresh token: يتحقق التوقيع أولًا (يرفض توكن منتهٍ/مزوَّر فورًا)، ثم يطابق
 * هاشه مع الصف المخزَّن. Rotation: كل تجديد يُبطل التوكن القديم فورًا ويصدر واحدًا جديدًا محله؛
 * محاولة استخدام توكن سبق تدويره (revoked_at IS NOT NULL) تُعامَل كإشارة سرقة/تسرُّب محتملة —
 * فتُبطَل كل جلسات المستخدم النشطة دفعة واحدة كإجراء احترازي (نمط شائع في OAuth refresh rotation).
 */
export async function refreshSession(rawToken: string) {
  let claims: { userId: string; tenantId: string; jti: string };
  try {
    claims = verifyRefreshToken(rawToken);
  } catch {
    throw new UnauthorizedError('جلسة غير صالحة، الرجاء تسجيل الدخول مجددًا');
  }

  const { rows } = await pool.query(
    `SELECT id, user_id, tenant_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1`,
    [hashToken(rawToken)],
  );
  const stored = rows[0];
  if (!stored || stored.expires_at < new Date()) {
    throw new UnauthorizedError('جلسة غير صالحة، الرجاء تسجيل الدخول مجددًا');
  }
  if (stored.revoked_at) {
    // إعادة استخدام توكن مُدوَّر بالفعل — يُحتمَل تسرُّبًا. أبطل كل جلسات المستخدم فورًا.
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [stored.user_id]);
    throw new UnauthorizedError('تم اكتشاف استخدام غير طبيعي للجلسة، الرجاء تسجيل الدخول مجددًا');
  }

  const { rows: userRows } = await pool.query(`SELECT id, tenant_id, company_id, is_active FROM users WHERE id = $1`, [stored.user_id]);
  const user = userRows[0];
  if (!user || !user.is_active) throw new UnauthorizedError('الحساب غير متاح');

  const newRefreshToken = await issueRefreshToken(user.id, user.tenant_id);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = $2 WHERE id = $1`,
    [stored.id, newRefreshToken.jti],
  );

  const accessClaims = await buildAccessClaims(user.id, user.tenant_id, user.company_id);
  const accessToken = signAccessToken(accessClaims);

  return { accessToken, refreshToken: newRefreshToken.raw, userId: user.id };
}

/** تسجيل خروج: إبطال صف الـ refresh token فقط (لا يمسّ access token الحالي، الذي ينتهي تلقائيًا
 * خلال 15 دقيقة على أي حال). عملية آمنة للتكرار (idempotent) — توكن غير موجود/غير صالح لا يُخرج خطأ. */
export async function logoutSession(rawToken: string) {
  try {
    verifyRefreshToken(rawToken);
  } catch {
    return;
  }
  await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(rawToken)]);
}
