/**
 * مُهايئ Supabase Storage عبر REST فقط (بلا SDK). يُفعَّل عند ضبط SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY
 * (سرّ خادم — لا يُوضع في الواجهة). الحاوية خاصة (Private) والوصول كله عبر الـAPI بعد فحص الصلاحيات.
 * بدون المتغيرين: يعمل النظام كما كان (BYTEA في القاعدة).
 */
export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'attachments';
const base = () => `${(process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/storage/v1`;
const headers = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` });
export const storageEnabled = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const url = (p: string) => `${base()}/object/${STORAGE_BUCKET}/${enc(p)}`;
const TIMEOUT_MS = 20_000;
async function call(u: string, init: RequestInit) { return fetch(u, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }

export const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
/** مسار آمن بلا اسم الملف الأصلي: {company}/{entityType}/{id}.{ext} (الاسم الأصلي محفوظ في الجدول). */
export const objectPath = (companyId: string, entityType: string, id: string, mime: string) => `${companyId}/${entityType}/${id}.${EXT_BY_MIME[mime] ?? 'bin'}`;

export async function putObject(path: string, data: Buffer, mime: string): Promise<void> {
  const r = await call(url(path), { method: 'POST', headers: { ...headers(), 'Content-Type': mime, 'x-upsert': 'false' }, body: new Uint8Array(data) });
  if (!r.ok) throw new Error(`فشل رفع الملف إلى التخزين (${r.status})`);
}
export async function getObject(path: string): Promise<Buffer> {
  const r = await call(url(path), { method: 'GET', headers: headers() });
  if (!r.ok) throw new Error(`تعذّر قراءة الملف من التخزين (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}
export async function removeObject(path: string): Promise<void> {
  const r = await call(url(path), { method: 'DELETE', headers: headers() });
  if (!r.ok && r.status !== 404) throw new Error(`فشل حذف الملف من التخزين (${r.status})`);
}
