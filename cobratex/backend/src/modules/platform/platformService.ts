import { pool } from '@/db/pool';
import { NotFoundError, ValidationError } from '@/shared/errors';

/**
 * مستوى التحكم عن بُعد (Control Plane) — يقرؤه حارس الطلبات (platformGuard) ويكتبه المطوّر عبر
 * لوحة المطور فقط. كل الحالة في PostgreSQL نفسه (لا خدمة إضافية) فتبقى الحزمة مجانية بالكامل.
 */

export type ServiceStatus = 'active' | 'suspended';
export type Severity = 'info' | 'success' | 'warning' | 'critical';

export interface ServiceState { status: ServiceStatus; message: string }
interface ControlState { global: ServiceState; tenants: Map<string, ServiceState> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const CACHE_MS = 10_000;
let cache: { at: number; state: ControlState } | null = null;
export function invalidateControlCache() { cache = null; }

export async function getControlState(): Promise<ControlState> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  const [g, t] = await Promise.all([
    pool.query(`SELECT value FROM platform_settings WHERE key = 'service'`),
    pool.query(`SELECT tenant_id, status, message FROM tenant_service_status WHERE status = 'suspended'`),
  ]);
  const gv = (g.rows[0]?.value ?? {}) as Partial<ServiceState>;
  const state: ControlState = {
    global: { status: gv.status === 'suspended' ? 'suspended' : 'active', message: gv.message ?? '' },
    tenants: new Map(t.rows.map((r) => [r.tenant_id as string, { status: r.status as ServiceStatus, message: r.message as string }])),
  };
  cache = { at: Date.now(), state };
  return state;
}

export interface EffectiveStatus { status: ServiceStatus; message: string; scope: 'global' | 'tenant' | null }

export async function getEffectiveStatus(tenantId?: string | null): Promise<EffectiveStatus> {
  const s = await getControlState();
  if (s.global.status === 'suspended') return { ...s.global, scope: 'global' };
  const t = tenantId ? s.tenants.get(tenantId) : undefined;
  if (t?.status === 'suspended') return { ...t, scope: 'tenant' };
  return { status: 'active', message: '', scope: null };
}

export const DEFAULT_SUSPENDED_MESSAGE = 'تم إيقاف الخدمة مؤقتًا. يرجى التواصل مع مزوّد الخدمة.';

/** ما تعرضه شاشة الدخول (عام بلا مصادقة): حالة التشغيل + الإشعارات الفعّالة الآن. */
export async function getPublicStatus(tenantId?: string | null) {
  const effective = await getEffectiveStatus(tenantId);
  const { rows } = await pool.query(
    `SELECT id, title, body, severity FROM platform_announcements
      WHERE is_active
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at > now())
        AND (tenant_id IS NULL OR tenant_id = $1)
      ORDER BY created_at DESC LIMIT 10`,
    [isUuid(tenantId) ? tenantId : null],
  );
  return {
    status: effective.status,
    message: effective.status === 'suspended' ? effective.message || DEFAULT_SUSPENDED_MESSAGE : '',
    scope: effective.scope,
    announcements: rows,
    update: await getClientUpdate(),
    serverTime: new Date().toISOString(),
  };
}

export async function audit(action: string, detail: Record<string, unknown>) {
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ($1, $2)`, [action, JSON.stringify(detail)]);
}

function assertStatus(status: unknown): asserts status is ServiceStatus {
  if (status !== 'active' && status !== 'suspended') throw new ValidationError('الحالة يجب أن تكون active أو suspended');
}

export async function setGlobalService(status: unknown, message: unknown) {
  assertStatus(status);
  const msg = typeof message === 'string' ? message.slice(0, 500) : '';
  await pool.query(
    `INSERT INTO platform_settings(key, value, updated_at) VALUES ('service', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ status, message: msg })],
  );
  invalidateControlCache();
  await audit('service.global', { status, message: msg });
  return { status, message: msg };
}

export async function setTenantService(tenantId: string, status: unknown, message: unknown) {
  if (!isUuid(tenantId)) throw new ValidationError('معرّف العميل غير صالح');
  assertStatus(status);
  const msg = typeof message === 'string' ? message.slice(0, 500) : '';
  const exists = await pool.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
  if (exists.rows.length === 0) throw new NotFoundError('العميل غير موجود');
  await pool.query(
    `INSERT INTO tenant_service_status(tenant_id, status, message, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id) DO UPDATE SET status = EXCLUDED.status, message = EXCLUDED.message, updated_at = now()`,
    [tenantId, status, msg],
  );
  invalidateControlCache();
  await audit('service.tenant', { tenantId, status, message: msg });
  return { tenantId, status, message: msg };
}

export async function listTenants() {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.created_at,
            (SELECT c.display_name FROM companies c WHERE c.tenant_id = t.id ORDER BY c.created_at LIMIT 1) AS company_name,
            COALESCE(s.status, 'active') AS status, COALESCE(s.message, '') AS message
       FROM tenants t LEFT JOIN tenant_service_status s ON s.tenant_id = t.id
      ORDER BY t.created_at DESC`,
  );
  return rows;
}

export interface AnnouncementInput {
  tenantId?: string | null; title?: unknown; body?: unknown; severity?: unknown;
  isActive?: unknown; startsAt?: unknown; endsAt?: unknown;
}

function parseDate(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ValidationError(`تاريخ غير صالح: ${field}`);
  return d.toISOString();
}

export async function listAnnouncements() {
  const { rows } = await pool.query(
    `SELECT a.*, (SELECT name FROM tenants t WHERE t.id = a.tenant_id) AS tenant_name
       FROM platform_announcements a ORDER BY created_at DESC LIMIT 200`,
  );
  return rows;
}

export async function createAnnouncement(input: AnnouncementInput) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new ValidationError('عنوان الإشعار مطلوب');
  const severity = (input.severity ?? 'info') as Severity;
  if (!['info', 'success', 'warning', 'critical'].includes(severity)) throw new ValidationError('درجة الإشعار غير صالحة');
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (tenantId && !isUuid(tenantId)) throw new ValidationError('معرّف العميل غير صالح');
  const { rows } = await pool.query(
    `INSERT INTO platform_announcements(tenant_id, title, body, severity, is_active, starts_at, ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenantId, title.slice(0, 200), typeof input.body === 'string' ? input.body.slice(0, 2000) : '', severity,
      input.isActive === false ? false : true, parseDate(input.startsAt, 'startsAt'), parseDate(input.endsAt, 'endsAt')],
  );
  await audit('announcement.create', { id: rows[0].id, title, tenantId, severity });
  return rows[0];
}

export async function updateAnnouncement(id: string, input: AnnouncementInput) {
  if (!isUuid(id)) throw new ValidationError('معرّف غير صالح');
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (input.title !== undefined) add('title', String(input.title).trim().slice(0, 200));
  if (input.body !== undefined) add('body', String(input.body).slice(0, 2000));
  if (input.severity !== undefined) {
    if (!['info', 'success', 'warning', 'critical'].includes(String(input.severity))) throw new ValidationError('درجة الإشعار غير صالحة');
    add('severity', input.severity);
  }
  if (input.isActive !== undefined) add('is_active', !!input.isActive);
  if (input.startsAt !== undefined) add('starts_at', parseDate(input.startsAt, 'startsAt'));
  if (input.endsAt !== undefined) add('ends_at', parseDate(input.endsAt, 'endsAt'));
  if (sets.length === 0) throw new ValidationError('لا توجد حقول للتعديل');
  vals.push(id);
  const { rows } = await pool.query(`UPDATE platform_announcements SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  if (rows.length === 0) throw new NotFoundError('الإشعار غير موجود');
  await audit('announcement.update', { id, fields: Object.keys(input) });
  return rows[0];
}

export async function deleteAnnouncement(id: string) {
  if (!isUuid(id)) throw new ValidationError('معرّف غير صالح');
  const { rowCount } = await pool.query(`DELETE FROM platform_announcements WHERE id = $1`, [id]);
  if (!rowCount) throw new NotFoundError('الإشعار غير موجود');
  await audit('announcement.delete', { id });
}

export async function listAudit(limit = 50) {
  const { rows } = await pool.query(`SELECT id, action, detail, created_at FROM platform_audit ORDER BY id DESC LIMIT $1`, [Math.min(limit, 200)]);
  return rows;
}

/* ───────────── سياسة التحديث عن بُعد (يتحكم بها المطوّر): أحدث إصدار + أدنى إصدار مسموح (إجباري) ───────────── */
export interface ClientUpdatePolicy { latestVersion: string; minVersion: string; message: string }
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const cmp = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export async function getClientUpdate(): Promise<ClientUpdatePolicy> {
  const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'client_update'`);
  const v = (rows[0]?.value ?? {}) as Partial<ClientUpdatePolicy>;
  return { latestVersion: v.latestVersion ?? '', minVersion: v.minVersion ?? '', message: v.message ?? '' };
}

export async function setClientUpdate(input: { latestVersion?: unknown; minVersion?: unknown; message?: unknown }) {
  const latest = typeof input.latestVersion === 'string' ? input.latestVersion.trim() : '';
  const min = typeof input.minVersion === 'string' ? input.minVersion.trim() : '';
  if (latest && !SEMVER.test(latest)) throw new ValidationError('أحدث إصدار يجب أن يكون بصيغة 1.2.3');
  if (min && !SEMVER.test(min)) throw new ValidationError('أدنى إصدار يجب أن يكون بصيغة 1.2.3');
  if (latest && min && cmp(min, latest) > 0) throw new ValidationError('أدنى إصدار لا يمكن أن يتجاوز أحدث إصدار (سيُقفل الجميع)');
  const message = typeof input.message === 'string' ? input.message.slice(0, 300) : '';
  const value = { latestVersion: latest, minVersion: min, message };
  await pool.query(
    `INSERT INTO platform_settings(key, value, updated_at) VALUES ('client_update', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(value)]);
  await audit('update.policy', value);
  return value;
}

/* منع إعادة استخدام رمز TOTP نفسه داخل نافذته (Replay) */
export async function getLastTotpCounter(): Promise<number> {
  const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'dev_totp_last'`);
  return Number(rows[0]?.value?.counter ?? 0);
}
export async function setLastTotpCounter(counter: number) {
  await pool.query(
    `INSERT INTO platform_settings(key, value, updated_at) VALUES ('dev_totp_last', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ counter })]);
}
