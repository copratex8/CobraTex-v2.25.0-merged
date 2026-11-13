import { pool, withTransaction } from '@/db/pool';
import { NotFoundError, ValidationError, AppError } from '@/shared/errors';
import { isUuid, invalidateControlCache } from '@/modules/platform/platformService';

/**
 * التراخيص (2.22.0) — تُدار كلها من لوحة المطور وتُنفَّذ من الخادم.
 * تنبيه صريح: الإنفاذ يحمي من النسخ العارض والعميل غير الأمين الذي لا يملك الكود. من يملك الكود المصدري
 * ويستضيفه بنفسه يستطيع إزالة الفحص — الحماية القانونية (العقد) هي الأساس، وهذا الفحص طبقة تشغيلية.
 */

export type PlanType = 'trial' | 'monthly' | 'annual' | 'perpetual' | 'custom';
export type ExpiredMode = 'readonly' | 'block';
export type BindingMode = 'none' | 'domain' | 'device' | 'domain_device';
export const PLAN_TYPES: PlanType[] = ['trial', 'monthly', 'annual', 'perpetual', 'custom'];

export interface License {
  tenantId: string; planType: PlanType; startsAt: Date; expiresAt: Date | null; graceDays: number;
  expiredMode: ExpiredMode; bindingMode: BindingMode; allowedDomains: string[];
  maxDevices: number | null; maxUsers: number | null; maxBranches: number | null; notes: string;
}
export type LicenseState = 'not_started' | 'active' | 'grace' | 'expired';
export interface Evaluation { state: LicenseState; daysLeft: number | null; graceEndsAt: Date | null }

const DAY = 86_400_000;

export function evaluateLicense(lic: License, now = new Date()): Evaluation {
  if (now < lic.startsAt) return { state: 'not_started', daysLeft: null, graceEndsAt: null };
  if (!lic.expiresAt) return { state: 'active', daysLeft: null, graceEndsAt: null };
  const daysLeft = Math.ceil((lic.expiresAt.getTime() - now.getTime()) / DAY);
  if (now <= lic.expiresAt) return { state: 'active', daysLeft, graceEndsAt: null };
  const graceEndsAt = new Date(lic.expiresAt.getTime() + lic.graceDays * DAY);
  return { state: now <= graceEndsAt ? 'grace' : 'expired', daysLeft, graceEndsAt };
}

export interface RequestMeta { method: string; path: string; origin: string | null; deviceId: string | null }
export type Decision =
  | { allow: true; needsDevice: boolean }
  | { allow: false; status: number; code: string; message: string };

const AUTH_PATH = /^\/auth(\/|$)/;

export function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p));
}

export function hostFromOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try { return new URL(origin).hostname.toLowerCase(); } catch { return null; }
}

/** قرار نقي (بلا قاعدة بيانات) — مُختبَر مباشرة. تسجيل الجهاز يحدث بعده في الحارس إن لزم. */
export function decide(lic: License | null, meta: RequestMeta, now = new Date(), required = false): Decision {
  if (!lic) return required
    ? { allow: false, status: 402, code: 'LICENSE_REQUIRED', message: 'لا يوجد ترخيص مفعَّل لهذا العميل. تواصل مع مزوّد الخدمة.' }
    : { allow: true, needsDevice: false };
  const ev = evaluateLicense(lic, now);
  if (ev.state === 'not_started') return { allow: false, status: 402, code: 'LICENSE_NOT_STARTED', message: 'الترخيص لم يبدأ بعد.' };
  if (ev.state === 'expired') {
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(meta.method.toUpperCase());
    if (lic.expiredMode === 'block' || !(isRead || AUTH_PATH.test(meta.path))) {
      return { allow: false, status: 402, code: 'LICENSE_EXPIRED', message: lic.expiredMode === 'block'
        ? 'انتهى الترخيص. تواصل مع مزوّد الخدمة للتجديد.'
        : 'انتهى الترخيص: النظام في وضع القراءة فقط. جدّد الترخيص لاستعادة الإدخال.' };
    }
  }
  if (lic.bindingMode === 'domain' || lic.bindingMode === 'domain_device') {
    const host = hostFromOrigin(meta.origin);
    if (host && !hostMatches(host, lic.allowedDomains)) {
      return { allow: false, status: 403, code: 'LICENSE_DOMAIN', message: 'هذا النطاق غير مرخَّص لتشغيل النظام.' };
    }
  }
  const needsDevice = lic.bindingMode === 'device' || lic.bindingMode === 'domain_device';
  if (needsDevice && !meta.deviceId) {
    return { allow: false, status: 403, code: 'LICENSE_DEVICE_REQUIRED', message: 'تعذّر تعريف الجهاز. حدّث الصفحة وأعد المحاولة.' };
  }
  return { allow: true, needsDevice };
}

/* ───────────── قاعدة البيانات ───────────── */
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; lic: License | null }>();
export function invalidateLicenseCache(tenantId?: string) { if (tenantId) cache.delete(tenantId); else cache.clear(); }

function rowToLicense(r: any): License {
  return {
    tenantId: r.tenant_id, planType: r.plan_type, startsAt: new Date(r.starts_at), expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    graceDays: r.grace_days, expiredMode: r.expired_mode, bindingMode: r.binding_mode, allowedDomains: r.allowed_domains ?? [],
    maxDevices: r.max_devices, maxUsers: r.max_users, maxBranches: r.max_branches, notes: r.notes ?? '',
  };
}

export async function getLicense(tenantId: string): Promise<License | null> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.lic;
  const { rows } = await pool.query(`SELECT * FROM tenant_licenses WHERE tenant_id = $1`, [tenantId]);
  const lic = rows[0] ? rowToLicense(rows[0]) : null;
  cache.set(tenantId, { at: Date.now(), lic });
  return lic;
}

export function addMonths(d: Date, n: number): Date { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; }
export function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * DAY); }

function normDomain(s: string): string {
  let v = s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '');
  if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v)) throw new ValidationError(`نطاق غير صالح: ${s}`);
  return v;
}
const optInt = (v: unknown, name: string): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${name} يجب أن يكون عددًا صحيحًا موجبًا`); return n;
};

export interface LicenseInput {
  planType?: unknown; startsAt?: unknown; expiresAt?: unknown; graceDays?: unknown; expiredMode?: unknown; bindingMode?: unknown;
  allowedDomains?: unknown; maxDevices?: unknown; maxUsers?: unknown; maxBranches?: unknown; notes?: unknown;
}
const parseDate = (v: unknown, name: string): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new ValidationError(`${name} تاريخ غير صالح`); return d;
};

export async function upsertLicense(tenantId: string, input: LicenseInput, now = new Date()): Promise<License> {
  if (!isUuid(tenantId)) throw new ValidationError('معرّف العميل غير صالح');
  const t = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
  if (t.rows.length === 0) throw new NotFoundError('العميل غير موجود');
  const planType = input.planType as PlanType;
  if (!PLAN_TYPES.includes(planType)) throw new ValidationError('نوع الترخيص: trial | monthly | annual | perpetual | custom');
  const startsAt = parseDate(input.startsAt, 'تاريخ البدء') ?? now;
  let expiresAt = parseDate(input.expiresAt, 'تاريخ الانتهاء');
  if (planType === 'perpetual') expiresAt = null;
  else if (!expiresAt) {
    if (planType === 'trial') expiresAt = addDays(startsAt, 14);
    else if (planType === 'monthly') expiresAt = addMonths(startsAt, 1);
    else if (planType === 'annual') expiresAt = addMonths(startsAt, 12);
    else throw new ValidationError('الترخيص المخصص يتطلب تاريخ انتهاء');
  }
  if (expiresAt && expiresAt <= startsAt) throw new ValidationError('تاريخ الانتهاء يجب أن يلي تاريخ البدء');
  const graceDays = input.graceDays === undefined || input.graceDays === null || input.graceDays === '' ? 7 : Number(input.graceDays);
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 365) throw new ValidationError('مهلة السماح بين 0 و365 يومًا');
  const expiredMode = (input.expiredMode ?? 'readonly') as ExpiredMode;
  if (expiredMode !== 'readonly' && expiredMode !== 'block') throw new ValidationError('وضع الانتهاء: readonly | block');
  const bindingMode = (input.bindingMode ?? 'none') as BindingMode;
  if (!['none', 'domain', 'device', 'domain_device'].includes(bindingMode)) throw new ValidationError('نوع الربط: none | domain | device | domain_device');
  const domains = Array.isArray(input.allowedDomains) ? [...new Set((input.allowedDomains as unknown[]).map((d) => normDomain(String(d))))] : [];
  if ((bindingMode === 'domain' || bindingMode === 'domain_device') && domains.length === 0) throw new ValidationError('الربط بالنطاق يتطلب نطاقًا واحدًا على الأقل');
  let maxDevices = optInt(input.maxDevices, 'أقصى عدد أجهزة');
  if ((bindingMode === 'device' || bindingMode === 'domain_device') && maxDevices === null) maxDevices = 3;
  const notes = typeof input.notes === 'string' ? input.notes.slice(0, 1000) : '';
  await pool.query(
    `INSERT INTO tenant_licenses(tenant_id, plan_type, starts_at, expires_at, grace_days, expired_mode, binding_mode, allowed_domains, max_devices, max_users, max_branches, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12, now())
     ON CONFLICT (tenant_id) DO UPDATE SET plan_type=EXCLUDED.plan_type, starts_at=EXCLUDED.starts_at, expires_at=EXCLUDED.expires_at,
       grace_days=EXCLUDED.grace_days, expired_mode=EXCLUDED.expired_mode, binding_mode=EXCLUDED.binding_mode, allowed_domains=EXCLUDED.allowed_domains,
       max_devices=EXCLUDED.max_devices, max_users=EXCLUDED.max_users, max_branches=EXCLUDED.max_branches, notes=EXCLUDED.notes, updated_at=now()`,
    [tenantId, planType, startsAt, expiresAt, graceDays, expiredMode, bindingMode, domains, maxDevices, optInt(input.maxUsers, 'أقصى عدد مستخدمين'), optInt(input.maxBranches, 'أقصى عدد فروع'), notes],
  );
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('license.set', $1)`, [JSON.stringify({ tenantId, planType, expiresAt, bindingMode })]);
  invalidateLicenseCache(tenantId); invalidateControlCache();
  return (await getLicense(tenantId))!;
}

/** تمديد: من تاريخ الانتهاء الحالي إن كان في المستقبل، وإلا من الآن. لا يُطبَّق على الدائم. */
export async function extendLicense(tenantId: string, unit: unknown, amount: unknown, now = new Date()): Promise<License> {
  const lic = await getLicense(tenantId);
  if (!lic) throw new NotFoundError('لا يوجد ترخيص لهذا العميل');
  if (!lic.expiresAt) throw new ValidationError('الترخيص الدائم لا يحتاج تمديدًا');
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1 || n > 1200) throw new ValidationError('المقدار عدد صحيح موجب');
  if (unit !== 'days' && unit !== 'months' && unit !== 'years') throw new ValidationError('الوحدة: days | months | years');
  const base = lic.expiresAt > now ? lic.expiresAt : now;
  const next = unit === 'days' ? addDays(base, n) : addMonths(base, unit === 'months' ? n : n * 12);
  await pool.query(`UPDATE tenant_licenses SET expires_at = $2, updated_at = now() WHERE tenant_id = $1`, [tenantId, next]);
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('license.extend', $1)`, [JSON.stringify({ tenantId, unit, amount: n, expiresAt: next })]);
  invalidateLicenseCache(tenantId);
  return (await getLicense(tenantId))!;
}

export async function deleteLicense(tenantId: string) {
  await pool.query(`DELETE FROM tenant_licenses WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('license.delete', $1)`, [JSON.stringify({ tenantId })]);
  invalidateLicenseCache(tenantId);
}

/* ───────────── الأجهزة ───────────── */
export const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** يسجّل الجهاز أو يحدّث آخر ظهور؛ يرفض المحظور أو عند بلوغ الحد. يُرجع null عند السماح أو رسالة الرفض. */
export async function registerDevice(tenantId: string, deviceId: string, userAgent: string, maxDevices: number | null): Promise<{ code: string; message: string } | null> {
  if (!DEVICE_RE.test(deviceId)) return { code: 'LICENSE_DEVICE_REQUIRED', message: 'معرّف الجهاز غير صالح.' };
  const cur = await pool.query(`SELECT revoked, last_seen FROM license_devices WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId]);
  if (cur.rows[0]) {
    if (cur.rows[0].revoked) return { code: 'LICENSE_DEVICE_REVOKED', message: 'تم إلغاء ترخيص هذا الجهاز. تواصل مع مزوّد الخدمة.' };
    if (Date.now() - new Date(cur.rows[0].last_seen).getTime() > 10 * 60_000) {
      await pool.query(`UPDATE license_devices SET last_seen = now() WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId]);
    }
    return null;
  }
  // إدراج ذري يحترم الحد حتى مع طلبات متزامنة: قفل استشاري على العميل داخل معاملة ثم عدّ وإدراج.
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [tenantId]);
    const again = await client.query(`SELECT revoked FROM license_devices WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId]);
    if (again.rows[0]) return again.rows[0].revoked ? { code: 'LICENSE_DEVICE_REVOKED', message: 'تم إلغاء ترخيص هذا الجهاز. تواصل مع مزوّد الخدمة.' } : null;
    if (maxDevices !== null) {
      const c = await client.query(`SELECT count(*)::int AS n FROM license_devices WHERE tenant_id = $1 AND NOT revoked`, [tenantId]);
      if (c.rows[0].n >= maxDevices) return { code: 'LICENSE_DEVICE_LIMIT', message: 'بلغ الترخيص الحد الأقصى للأجهزة. تواصل مع مزوّد الخدمة لإضافة جهاز.' };
    }
    await client.query(`INSERT INTO license_devices(tenant_id, device_id, user_agent) VALUES ($1,$2,$3)`, [tenantId, deviceId, userAgent.slice(0, 200)]);
    return null;
  });
}

export async function listDevices(tenantId: string) {
  const { rows } = await pool.query(`SELECT device_id, label, user_agent, revoked, first_seen, last_seen FROM license_devices WHERE tenant_id = $1 ORDER BY first_seen`, [tenantId]);
  return rows;
}
export async function setDeviceRevoked(tenantId: string, deviceId: string, revoked: boolean) {
  const r = await pool.query(`UPDATE license_devices SET revoked = $3 WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId, revoked]);
  if (r.rowCount === 0) throw new NotFoundError('الجهاز غير موجود');
}
export async function removeDevice(tenantId: string, deviceId: string) {
  await pool.query(`DELETE FROM license_devices WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId]);
}
export async function renameDevice(tenantId: string, deviceId: string, label: string) {
  await pool.query(`UPDATE license_devices SET label = $3 WHERE tenant_id = $1 AND device_id = $2`, [tenantId, deviceId, label.slice(0, 80)]);
}

/* ───────────── الحدود (مستخدمون / فروع) ───────────── */
export async function usage(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND is_active)::int AS users,
            (SELECT count(*) FROM branches b JOIN companies c ON c.id = b.company_id WHERE c.tenant_id = $1 AND b.is_active)::int AS branches,
            (SELECT count(*) FROM license_devices WHERE tenant_id = $1 AND NOT revoked)::int AS devices`, [tenantId]);
  return rows[0] as { users: number; branches: number; devices: number };
}

export class LicenseLimitError extends AppError {
  constructor(message: string) { super(message, 402); (this as any).code = 'LICENSE_LIMIT'; }
}

export async function assertSeat(tenantId: string, kind: 'users' | 'branches') {
  const lic = await getLicense(tenantId);
  if (!lic) return;
  const max = kind === 'users' ? lic.maxUsers : lic.maxBranches;
  if (max === null) return;
  const u = await usage(tenantId);
  if (u[kind] >= max) throw new LicenseLimitError(kind === 'users' ? `بلغ الترخيص الحد الأقصى للمستخدمين (${max}). تواصل مع مزوّد الخدمة للترقية.` : `بلغ الترخيص الحد الأقصى للفروع (${max}). تواصل مع مزوّد الخدمة للترقية.`);
}
export async function tenantOfCompany(companyId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT tenant_id FROM companies WHERE id = $1`, [companyId]);
  return rows[0]?.tenant_id ?? null;
}

/** ما تراه الواجهة (شعار التنبيه) — بلا أسرار. */
export async function publicSummary(tenantId: string) {
  const lic = await getLicense(tenantId);
  if (!lic) return { licensed: false };
  const ev = evaluateLicense(lic);
  return { licensed: true, planType: lic.planType, state: ev.state, daysLeft: ev.daysLeft, expiresAt: lic.expiresAt, graceEndsAt: ev.graceEndsAt, expiredMode: lic.expiredMode, bindingMode: lic.bindingMode };
}

export async function listLicenses() {
  const { rows } = await pool.query(
    `SELECT t.id AS tenant_id, t.name,
            (SELECT c.display_name FROM companies c WHERE c.tenant_id = t.id ORDER BY c.created_at LIMIT 1) AS company_name,
            l.*,
            (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active)::int AS users_used,
            (SELECT count(*) FROM branches b JOIN companies c ON c.id = b.company_id WHERE c.tenant_id = t.id AND b.is_active)::int AS branches_used,
            (SELECT count(*) FROM license_devices d WHERE d.tenant_id = t.id AND NOT d.revoked)::int AS devices_used
       FROM tenants t LEFT JOIN tenant_licenses l ON l.tenant_id = t.id ORDER BY t.created_at DESC`);
  return rows.map((r) => {
    const lic = r.plan_type ? rowToLicense(r) : null;
    const ev = lic ? evaluateLicense(lic) : null;
    return {
      tenantId: r.tenant_id, name: r.name, companyName: r.company_name, license: lic, state: ev?.state ?? 'none', daysLeft: ev?.daysLeft ?? null, graceEndsAt: ev?.graceEndsAt ?? null,
      usage: { users: r.users_used, branches: r.branches_used, devices: r.devices_used },
    };
  });
}
