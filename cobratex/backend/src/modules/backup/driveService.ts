import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '@/db/pool';
import { config } from '@/config';
import { AppError } from '@/shared/errors';
import { sealSecret, openSecret } from '@/shared/secretBox';
import {
  backupDir, createBackupFile, pruneLocalBackups, BACKUP_NAME_RE, type BackupFileInfo,
} from '@/modules/backup/backupService';

/**
 * ربط Google Drive عبر REST الرسمي (OAuth 2.0 + Drive API v3) باستخدام fetch المدمج في Node 22/Electron.
 * لا يحتاج أي حزمة npm إضافية، فيُضمَّن تلقائيًا في الـexe ويعمل على Vercel دون تضخيم الحزمة.
 * النطاق drive.file: يرى التطبيق الملفات التي أنشأها هو فقط (لا يقرأ بقية Drive).
 * العناوين قابلة للتبديل عبر GOOGLE_OAUTH_BASE / GOOGLE_API_BASE لأغراض الاختبار.
 */

const oauthAuth = () => process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com/o/oauth2/v2/auth';
const oauthToken = () => (process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com') + '/token';
const apiBase = () => process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

export interface BackupSettings {
  googleClientId: string | null;
  hasClientSecret: boolean;
  googleAccountEmail: string | null;
  driveConnected: boolean;
  driveFolderName: string;
  autoEnabled: boolean;
  retentionCount: number;
  lastBackupAt: string | null;
  lastBackupStatus: string | null;
  lastBackupError: string | null;
  lastBackupName: string | null;
}

interface Row {
  google_client_id: string | null; google_client_secret_enc: string | null; google_refresh_token_enc: string | null;
  google_account_email: string | null; drive_folder_id: string | null; drive_folder_name: string;
  auto_enabled: boolean; retention_count: number; last_backup_at: Date | null;
  last_backup_status: string | null; last_backup_error: string | null; last_backup_name: string | null;
}

async function row(): Promise<Row> {
  const r = await pool.query(`SELECT * FROM backup_settings WHERE id = 1`);
  if (!r.rows[0]) throw new AppError('إعدادات النسخ الاحتياطي غير مهيأة (شغّل الهجرات)', 500);
  return r.rows[0] as Row;
}

export async function getSettings(): Promise<BackupSettings> {
  const s = await row();
  return {
    googleClientId: s.google_client_id,
    hasClientSecret: !!s.google_client_secret_enc,
    googleAccountEmail: s.google_account_email,
    driveConnected: !!s.google_refresh_token_enc,
    driveFolderName: s.drive_folder_name,
    autoEnabled: s.auto_enabled,
    retentionCount: s.retention_count,
    lastBackupAt: s.last_backup_at ? s.last_backup_at.toISOString() : null,
    lastBackupStatus: s.last_backup_status,
    lastBackupError: s.last_backup_error,
    lastBackupName: s.last_backup_name,
  };
}

export interface SettingsInput {
  googleClientId?: string; googleClientSecret?: string; driveFolderName?: string;
  autoEnabled?: boolean; retentionCount?: number;
}

export async function saveSettings(input: SettingsInput): Promise<BackupSettings> {
  const before = await row();
  const idChanged = input.googleClientId !== undefined && input.googleClientId !== (before.google_client_id ?? '');
  const folderChanged = input.driveFolderName !== undefined && input.driveFolderName !== before.drive_folder_name;
  await pool.query(
    `UPDATE backup_settings SET
       google_client_id = COALESCE($1, google_client_id),
       google_client_secret_enc = COALESCE($2, google_client_secret_enc),
       drive_folder_name = COALESCE($3, drive_folder_name),
       auto_enabled = COALESCE($4, auto_enabled),
       retention_count = COALESCE($5, retention_count),
       drive_folder_id = CASE WHEN $6 THEN NULL ELSE drive_folder_id END,
       updated_at = now()
     WHERE id = 1`,
    [
      input.googleClientId?.trim() || null,
      input.googleClientSecret ? sealSecret(input.googleClientSecret.trim()) : null,
      input.driveFolderName?.trim() || null,
      input.autoEnabled ?? null,
      input.retentionCount ?? null,
      folderChanged,
    ],
  );
  // تغيير حساب التطبيق (client id) يُبطل الربط السابق: refresh token يخص العميل القديم.
  if (idChanged && before.google_refresh_token_enc) await disconnectDrive();
  return getSettings();
}

// ---------- OAuth ----------

function credentials(s: Row): { id: string; secret: string } {
  if (!s.google_client_id || !s.google_client_secret_enc) {
    throw new AppError('أدخل Client ID وClient Secret الخاصَّين بـ Google أولًا', 409);
  }
  return { id: s.google_client_id, secret: openSecret(s.google_client_secret_enc) };
}

export async function buildAuthUrl(redirectUri: string, userId: string): Promise<string> {
  const { id } = credentials(await row());
  const state = jwt.sign({ purpose: 'drive-oauth', userId }, config.jwtAccessSecret, { expiresIn: '10m' });
  const u = new URL(oauthAuth());
  u.search = new URLSearchParams({
    client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  }).toString();
  return u.toString();
}

export function verifyState(state: string): void {
  try {
    const c = jwt.verify(state, config.jwtAccessSecret) as { purpose?: string };
    if (c.purpose !== 'drive-oauth') throw new Error('bad purpose');
  } catch {
    throw new AppError('انتهت صلاحية طلب الربط أو أنه غير صالح — أعد المحاولة', 400);
  }
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string }> {
  const res = await fetch(oauthToken(), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(body.error_description || body.error || res.status);
    throw new AppError(`رفض Google الطلب: ${msg}`, res.status === 400 || res.status === 401 ? 400 : 502);
  }
  return body as never;
}

export async function completeAuth(code: string, redirectUri: string): Promise<{ email: string | null }> {
  const { id, secret } = credentials(await row());
  const t = await tokenRequest({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!t.refresh_token) {
    throw new AppError('لم يُرجِع Google رمز تحديث. أزل صلاحية التطبيق من حسابك على Google ثم أعد الربط', 400);
  }
  let email: string | null = null;
  if (t.id_token) {
    try { email = (JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()) as { email?: string }).email ?? null; } catch { /* اختياري */ }
  }
  await pool.query(
    `UPDATE backup_settings SET google_refresh_token_enc = $1, google_account_email = $2, drive_folder_id = NULL, updated_at = now() WHERE id = 1`,
    [sealSecret(t.refresh_token), email],
  );
  return { email };
}

export async function disconnectDrive(): Promise<void> {
  await pool.query(
    `UPDATE backup_settings SET google_refresh_token_enc = NULL, google_account_email = NULL, drive_folder_id = NULL, updated_at = now() WHERE id = 1`,
  );
}

async function accessToken(s: Row): Promise<string> {
  if (!s.google_refresh_token_enc) throw new AppError('Google Drive غير مربوط', 409);
  const { id, secret } = credentials(s);
  const t = await tokenRequest({ client_id: id, client_secret: secret, refresh_token: openSecret(s.google_refresh_token_enc), grant_type: 'refresh_token' });
  return t.access_token;
}

// ---------- Drive API ----------

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AppError('رفض Google Drive الصلاحية — أعد ربط الحساب', 502);
    throw new AppError(`خطأ من Google Drive (${res.status}): ${text.slice(0, 200)}`, 502);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function ensureFolder(token: string, s: Row): Promise<string> {
  if (s.drive_folder_id) {
    try {
      const f = await api<{ id: string; trashed?: boolean }>(token, `${apiBase()}/drive/v3/files/${s.drive_folder_id}?fields=id,trashed`);
      if (!f.trashed) return f.id;
    } catch { /* حُذف المجلد: ننشئ غيره */ }
  }
  const q = `name='${esc(s.drive_folder_name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await api<{ files: Array<{ id: string }> }>(token, `${apiBase()}/drive/v3/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`);
  let id = found.files[0]?.id;
  if (!id) {
    const created = await api<{ id: string }>(token, `${apiBase()}/drive/v3/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.drive_folder_name, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = created.id;
  }
  await pool.query(`UPDATE backup_settings SET drive_folder_id = $1 WHERE id = 1`, [id]);
  return id;
}

export interface DriveFile { id: string; name: string; sizeBytes: number; createdAt: string }

async function listDrive(token: string, folderId: string): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed=false and name contains 'cobratex-'`;
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const r = await api<{ files: Array<{ id: string; name: string; size?: string; createdTime: string }>; nextPageToken?: string }>(
      token,
      `${apiBase()}/drive/v3/files?${new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,size,createdTime)', orderBy: 'createdTime desc', pageSize: '100', ...(pageToken ? { pageToken } : {}) })}`,
    );
    for (const f of r.files) if (BACKUP_NAME_RE.test(f.name)) out.push({ id: f.id, name: f.name, sizeBytes: Number(f.size ?? 0), createdAt: f.createdTime });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

export async function listDriveBackups(): Promise<DriveFile[]> {
  const s = await row();
  const token = await accessToken(s);
  return listDrive(token, await ensureFolder(token, s));
}

/** يرفع ملف نسخة إلى مجلد Drive (رفع قابل للاستئناف بطلب واحد) ثم يطبّق سياسة الاحتفاظ على Drive. */
export async function uploadToDrive(filePath: string): Promise<{ id: string; name: string }> {
  const s = await row();
  const token = await accessToken(s);
  const folderId = await ensureFolder(token, s);
  const name = path.basename(filePath);
  const body = fs.readFileSync(filePath);

  const init = await fetch(`${apiBase()}/upload/drive/v3/files?uploadType=resumable&fields=id,name`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(body.length),
    },
    body: JSON.stringify({ name, parents: [folderId] }),
  });
  const loc = init.headers.get('location');
  if (!init.ok || !loc) throw new AppError(`تعذّر بدء الرفع إلى Google Drive (${init.status})`, 502);
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }, body });
  if (!put.ok) throw new AppError(`فشل رفع النسخة إلى Google Drive (${put.status})`, 502);
  const file = (await put.json()) as { id: string; name: string };

  // الاحتفاظ: نُبقي أحدث N نسخة على Drive.
  try {
    const all = await listDrive(token, folderId);
    for (const old of all.slice(s.retention_count)) {
      await api(token, `${apiBase()}/drive/v3/files/${old.id}`, { method: 'DELETE' });
    }
  } catch { /* التنظيف لا يُفشل النسخة */ }
  return file;
}

/** ينزّل نسخة من Drive إلى مجلد النسخ المحلي ويُرجع مسارها (جاهزة للاستعادة). */
export async function downloadFromDrive(fileId: string): Promise<string> {
  const s = await row();
  const token = await accessToken(s);
  const meta = await api<{ name: string }>(token, `${apiBase()}/drive/v3/files/${encodeURIComponent(fileId)}?fields=name`);
  if (!BACKUP_NAME_RE.test(meta.name)) throw new AppError('الملف ليس نسخة CobraTex', 422);
  const res = await fetch(`${apiBase()}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new AppError(`تعذّر تنزيل النسخة من Google Drive (${res.status})`, 502);
  const dest = path.join(backupDir(), meta.name);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// ---------- التشغيل المجمَّع ----------

export interface RunResult extends BackupFileInfo { drive: { id: string; name: string } | null; driveError: string | null; pruned: string[] }

async function recordResult(status: 'ok' | 'partial' | 'failed', name: string | null, error: string | null) {
  await pool.query(
    `UPDATE backup_settings SET last_backup_at = now(), last_backup_status = $1, last_backup_name = $2, last_backup_error = $3 WHERE id = 1`,
    [status, name, error],
  );
}

/** نسخة كاملة: ملف محلي + رفع إلى Drive (إن كان مربوطًا وطُلب) + تنظيف محلي. فشل Drive لا يُسقط النسخة المحلية. */
export async function runBackup(opts: { uploadToDrive: boolean; appVersion?: string }): Promise<RunResult> {
  let info: BackupFileInfo;
  try {
    info = await createBackupFile(opts.appVersion);
  } catch (err) {
    await recordResult('failed', null, (err as Error).message).catch(() => undefined);
    throw err;
  }
  const s = await row();
  let drive: RunResult['drive'] = null;
  let driveError: string | null = null;
  if (opts.uploadToDrive && s.google_refresh_token_enc) {
    try { drive = await uploadToDrive(info.path); } catch (err) { driveError = (err as Error).message; }
  }
  const pruned = pruneLocalBackups(s.retention_count);
  await recordResult(driveError ? 'partial' : 'ok', info.name, driveError);
  return { ...info, drive, driveError, pruned };
}

// ---------- الجدولة ----------

let timer: NodeJS.Timeout | null = null;

/** تحقق دوري كل ساعة: إن فُعِّلت النسخ التلقائية ومرّ أكثر من 24 ساعة على آخر نسخة ناجحة → ينفّذ نسخة. للعمليات طويلة العمر فقط (exe/Render). */
export function startBackupScheduler(appVersion: string): void {
  if (timer || process.env.VERCEL) return;
  const tick = async () => {
    try {
      const s = await row();
      if (!s.auto_enabled) return;
      const last = s.last_backup_at?.getTime() ?? 0;
      if (Date.now() - last < 24 * 3600 * 1000) return;
      await runBackup({ uploadToDrive: true, appVersion });
    } catch { /* يُسجَّل في last_backup_error عند الفشل؛ نعيد المحاولة في الساعة التالية */ }
  };
  timer = setInterval(tick, 3600 * 1000);
  timer.unref();
  setTimeout(tick, 30_000).unref();
}
