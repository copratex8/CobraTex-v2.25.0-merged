import crypto from 'crypto';
import { pool, withTransaction } from '@/db/pool';
import { NotFoundError, ValidationError, ConflictError } from '@/shared/errors';
import { isUuid } from '@/modules/platform/platformService';
import { hashPassword } from '@/shared/auth';

/**
 * هوية كل عميل (2.23.0): تُخزَّن في القاعدة وتُدار من لوحة المطور. قائمة مفاتيح مسموحة فقط —
 * بلا `developer` عمدًا، فحقوق المطوّر وسطر الدعم لا يستطيع عميل (ولا خطأ إدخال) إزالتهما.
 */
const STR_KEYS = ['appName', 'appNameEn', 'tagline', 'companyName', 'website', 'supportPhone', 'supportEmail'] as const;
const URL_KEYS = ['logoUrl', 'logoFullUrl', 'faviconUrl'] as const;
const THEME_KEYS = ['navy', 'navy2', 'gold', 'gold2'] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function sanitizeBrand(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('الهوية يجب أن تكون كائنًا');
  const src = input as Record<string, unknown>; const out: Record<string, unknown> = {};
  for (const k of STR_KEYS) if (src[k] !== undefined && src[k] !== null && src[k] !== '') {
    if (typeof src[k] !== 'string') throw new ValidationError(`${k} يجب أن يكون نصًا`);
    out[k] = (src[k] as string).trim().slice(0, 200);
  }
  for (const k of URL_KEYS) if (src[k] !== undefined && src[k] !== null && src[k] !== '') {
    const v = String(src[k]).trim();
    // مسار نسبي من نفس الموقع أو https فقط (لا javascript: ولا data: ولا http غير آمن)
    if (!(/^\/(?!\/)[^\s]*$/.test(v) || /^https:\/\/[^\s]+$/.test(v)) || v.length > 500) throw new ValidationError(`${k}: رابط https أو مسار يبدأ بـ / فقط`);
    out[k] = v;
  }
  if (src.theme !== undefined && src.theme !== null) {
    if (typeof src.theme !== 'object') throw new ValidationError('theme يجب أن يكون كائنًا');
    const th: Record<string, string> = {};
    for (const k of THEME_KEYS) { const v = (src.theme as any)[k]; if (v !== undefined && v !== '') { if (typeof v !== 'string' || !HEX.test(v)) throw new ValidationError(`لون ${k} يجب أن يكون #RRGGBB`); th[k] = v; } }
    if (Object.keys(th).length) out.theme = th;
  }
  return out;
}

export function normHost(h: string): string {
  const v = h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v) || !v.includes('.') && v !== 'localhost') throw new ValidationError(`نطاق غير صالح: ${h}`);
  return v;
}

export async function getBranding(tenantId: string) {
  const [b, d] = await Promise.all([
    pool.query(`SELECT slug, brand FROM tenant_branding WHERE tenant_id = $1`, [tenantId]),
    pool.query(`SELECT host FROM tenant_domains WHERE tenant_id = $1 ORDER BY host`, [tenantId]),
  ]);
  return { slug: b.rows[0]?.slug ?? null, brand: b.rows[0]?.brand ?? {}, domains: d.rows.map((r) => r.host as string) };
}

export async function setBranding(tenantId: string, input: { slug?: unknown; brand?: unknown; domains?: unknown }) {
  if (!isUuid(tenantId)) throw new ValidationError('معرّف العميل غير صالح');
  const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
  if (t.rows.length === 0) throw new NotFoundError('العميل غير موجود');
  const brand = sanitizeBrand(input.brand);
  let slug: string | null = null;
  if (input.slug !== undefined && input.slug !== null && input.slug !== '') {
    slug = String(input.slug).trim().toLowerCase();
    if (!SLUG.test(slug)) throw new ValidationError('الرمز القصير: 3–40 حرفًا إنجليزيًا صغيرًا/أرقامًا/شرطة');
  }
  const domains = Array.isArray(input.domains) ? [...new Set((input.domains as unknown[]).map((x) => normHost(String(x))))] : [];
  try {
    // ذري: أي تعارض (رمز/نطاق مستخدم) يُلغي كل التغيير فلا يبقى العميل بهوية نصف محدَّثة.
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO tenant_branding(tenant_id, slug, brand, updated_at) VALUES ($1,$2,$3::jsonb, now())
         ON CONFLICT (tenant_id) DO UPDATE SET slug = EXCLUDED.slug, brand = EXCLUDED.brand, updated_at = now()`,
        [tenantId, slug, JSON.stringify(brand)]);
      await client.query(`DELETE FROM tenant_domains WHERE tenant_id = $1`, [tenantId]);
      for (const h of domains) await client.query(`INSERT INTO tenant_domains(host, tenant_id) VALUES ($1,$2)`, [h, tenantId]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError('الرمز القصير أو أحد النطاقات مستخدم لعميل آخر');
    throw e;
  }
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('brand.set', $1)`, [JSON.stringify({ tenantId, slug, domains })]);
  return getBranding(tenantId);
}

/** عام (بلا مصادقة): ما تحتاجه شاشة الدخول لتعرف العميل من رابطه. الأولوية: النطاق ثم الرمز القصير ثم المعرّف. لا يُرجع إلا الهوية. */
export async function resolveBrand(opts: { host?: string | null; slug?: string | null; tenantId?: string | null }) {
  let tenantId: string | null = null;
  if (opts.host) {
    try { const h = normHost(opts.host); const r = await pool.query(`SELECT tenant_id FROM tenant_domains WHERE host = $1`, [h]); tenantId = r.rows[0]?.tenant_id ?? null; } catch { /* نطاق غير صالح */ }
  }
  if (!tenantId && opts.slug && SLUG.test(opts.slug)) { const r = await pool.query(`SELECT tenant_id FROM tenant_branding WHERE slug = $1`, [opts.slug]); tenantId = r.rows[0]?.tenant_id ?? null; }
  if (!tenantId && isUuid(opts.tenantId)) { const r = await pool.query(`SELECT id FROM tenants WHERE id = $1`, [opts.tenantId]); tenantId = r.rows[0]?.id ?? null; }
  if (!tenantId) return null;
  const b = await pool.query(`SELECT brand FROM tenant_branding WHERE tenant_id = $1`, [tenantId]);
  return { tenantId, brand: b.rows[0]?.brand ?? {} };
}

/* ───────────── مستخدمو العميل (لوحة المطور) ───────────── */
export async function listTenantUsers(tenantId: string) {
  const { rows } = await pool.query(`SELECT id, full_name, email, is_active, last_login_at FROM users WHERE tenant_id = $1 ORDER BY created_at`, [tenantId]);
  return rows;
}
export function generatePassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len), (b) => chars[b % chars.length]).join('');
}
/** يعيد ضبط كلمة المرور ويُبطل كل جلساته. إن لم تُمرَّر كلمة تُولَّد عشوائية وتُعاد مرة واحدة. */
export async function resetUserPassword(tenantId: string, userId: string, password?: unknown) {
  if (!isUuid(tenantId) || !isUuid(userId)) throw new ValidationError('معرّف غير صالح');
  const pw = typeof password === 'string' && password ? password : generatePassword();
  if (pw.length < 8) throw new ValidationError('كلمة المرور 8 أحرف على الأقل');
  const u = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId]);
  if (u.rows.length === 0) throw new NotFoundError('المستخدم غير موجود لدى هذا العميل');
  await pool.query(`UPDATE users SET password_hash = $3 WHERE id = $1 AND tenant_id = $2`, [userId, tenantId, await hashPassword(pw)]);
  await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('user.reset_password', $1)`, [JSON.stringify({ tenantId, userId })]);
  return { password: pw };
}
export async function setUserActive(tenantId: string, userId: string, active: boolean) {
  const r = await pool.query(`UPDATE users SET is_active = $3 WHERE id = $1 AND tenant_id = $2`, [userId, tenantId, active]);
  if (r.rowCount === 0) throw new NotFoundError('المستخدم غير موجود لدى هذا العميل');
  if (!active) await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  (await import('@/shared/activeUsers')).invalidateActiveUser(userId);
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('user.set_active', $1)`, [JSON.stringify({ tenantId, userId, active })]);
}
