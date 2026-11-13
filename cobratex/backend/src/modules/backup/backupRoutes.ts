import fs from 'fs';
import os from 'os';
import path from 'path';
import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { pool } from '@/db/pool';
import { AppError } from '@/shared/errors';
import { authMiddleware } from '@/middleware/authMiddleware';
import { requirePermission } from '@/middleware/permissionMiddleware';
import { validate } from '@/middleware/validate';
import {
  listLocalBackups, localBackupPath, restoreBackupFile, BACKUP_NAME_RE, readBackupHeader, backupDir,
} from '@/modules/backup/backupService';
import {
  getSettings, saveSettings, buildAuthUrl, completeAuth, disconnectDrive, verifyState, runBackup,
  listDriveBackups, downloadFromDrive,
} from '@/modules/backup/driveService';

/**
 * النسخ الاحتياطي يشمل قاعدة البيانات كلها، لذلك في نشر متعدد المستأجرين يملك مالك أي عميل بيانات الآخرين.
 * يُسمح به افتراضيًا فقط حين يوجد مستأجر واحد (نشر عميل واحد/exe)، أو بقرار صريح BACKUP_ALLOW_MULTI_TENANT=true.
 */
async function assertAllowed(): Promise<void> {
  if (process.env.BACKUP_ALLOW_MULTI_TENANT === 'true') return;
  const r = await pool.query(`SELECT count(*)::int AS n FROM tenants`);
  if (r.rows[0].n > 1) {
    throw new AppError('النسخ الاحتياطي الكامل متاح للتثبيت الخاص بعميل واحد فقط. على النشر المشترك ينفّذه المطوّر (BACKUP_ALLOW_MULTI_TENANT).', 403);
  }
}

const appVersion = () => {
  try { return fs.readFileSync(path.resolve(process.cwd(), 'VERSION'), 'utf-8').trim(); } catch { return 'unknown'; }
};

function redirectUri(req: Request): string {
  const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/api/backup/google/callback`;
}

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_q, f, cb) => cb(null, `restore-${Date.now()}-${Math.random().toString(36).slice(2)}.cbk`) }),
  limits: { fileSize: Number(process.env.BACKUP_MAX_UPLOAD_MB || 1024) * 1024 * 1024 },
});

export const backupCallbackRouter = Router();

/** (مُركَّب تحت /api/backup) عودة Google بعد الموافقة: بلا توكن JWT (المتصفح يُعاد توجيهه) — الحماية عبر state موقَّع قصير العمر. */
backupCallbackRouter.get('/google/callback', async (req, res) => {
  // helmet يمنع السكربت المضمَّن ويقطع window.opener (COOP) — هذه الصفحة وحدها تحتاج الاثنين لتُبلِّغ نافذة البرنامج بالنتيجة.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  const page = (ok: boolean, msg: string) => res.status(ok ? 200 : 400).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>CobraTex</title><body style="font-family:system-ui;text-align:center;padding:48px;background:#0D1B2A;color:#fff" dir="rtl">` +
    `<h2 style="color:${ok ? '#C9A84C' : '#ff8a8a'}">${msg.replace(/</g, '&lt;')}</h2><p>يمكنك إغلاق هذه النافذة والعودة إلى البرنامج.</p>` +
    `<script>try{window.opener&&window.opener.postMessage({type:'cobratex-drive',ok:${ok}},'*')}catch(e){};setTimeout(function(){window.close()},1800)</script></body>`,
  );
  try {
    if (req.query.error) throw new AppError('تم إلغاء الربط من Google', 400);
    verifyState(String(req.query.state ?? ''));
    const { email } = await completeAuth(String(req.query.code ?? ''), redirectUri(req));
    page(true, `تم ربط Google Drive${email ? ` (${email})` : ''} بنجاح`);
  } catch (err) {
    page(false, (err as Error).message);
  }
});

export const backupRouter = Router();
backupRouter.use(authMiddleware, requirePermission('system.backup.manage'));
backupRouter.use(async (_req, _res, next) => { try { await assertAllowed(); next(); } catch (e) { next(e); } });

backupRouter.get('/status', async (_req, res, next) => {
  try {
    res.json({ settings: await getSettings(), local: listLocalBackups(), dir: backupDir() });
  } catch (e) { next(e); }
});

const settingsSchema = z.strictObject({
  googleClientId: z.string().max(300).optional(),
  googleClientSecret: z.string().max(300).optional(),
  driveFolderName: z.string().min(1).max(100).optional(),
  autoEnabled: z.boolean().optional(),
  retentionCount: z.number().int().min(1).max(365).optional(),
});
backupRouter.put('/settings', validate({ body: settingsSchema }), async (req, res, next) => {
  try { res.json(await saveSettings(req.body)); } catch (e) { next(e); }
});

backupRouter.post('/create', validate({ body: z.strictObject({ uploadToDrive: z.boolean().optional() }) }), async (req, res, next) => {
  try { res.status(201).json(await runBackup({ uploadToDrive: !!req.body.uploadToDrive, appVersion: appVersion() })); } catch (e) { next(e); }
});

backupRouter.get('/download/:name', (req, res, next) => {
  try {
    const p = localBackupPath(String(req.params.name));
    res.download(p, path.basename(p));
  } catch (e) { next(e); }
});

backupRouter.delete('/local/:name', (req, res, next) => {
  try { fs.rmSync(localBackupPath(String(req.params.name))); res.status(204).end(); } catch (e) { next(e); }
});

const confirmSchema = z.strictObject({ confirm: z.literal('RESTORE') });

/** استعادة من نسخة محلية موجودة. تتطلب كتابة RESTORE صراحةً لأنها تستبدل كل البيانات. */
backupRouter.post('/restore/local/:name', validate({ body: confirmSchema }), async (req, res, next) => {
  try { res.json(await restoreBackupFile(localBackupPath(String(req.params.name)), appVersion())); } catch (e) { next(e); }
});

/** استعادة من ملف .cbk يرفعه المستخدم من جهازه (مثلًا نُزِّل سابقًا من Drive يدويًا). */
backupRouter.post('/restore/upload', upload.single('file'), async (req, res, next) => {
  const tmp = req.file?.path;
  try {
    if (!tmp) throw new AppError('الملف مطلوب', 422);
    if (req.body?.confirm !== 'RESTORE') throw new AppError('اكتب RESTORE للتأكيد', 422);
    await readBackupHeader(tmp);
    res.json(await restoreBackupFile(tmp, appVersion()));
  } catch (e) { next(e); } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
});

backupRouter.get('/google/auth-url', async (req, res, next) => {
  try { res.json({ url: await buildAuthUrl(redirectUri(req), req.ctx.userId), redirectUri: redirectUri(req) }); } catch (e) { next(e); }
});
backupRouter.post('/google/disconnect', async (_req, res, next) => {
  try { await disconnectDrive(); res.json(await getSettings()); } catch (e) { next(e); }
});
backupRouter.get('/drive/files', async (_req, res, next) => {
  try { res.json(await listDriveBackups()); } catch (e) { next(e); }
});
backupRouter.post('/restore/drive', validate({ body: z.strictObject({ confirm: z.literal('RESTORE'), fileId: z.string().min(5).max(200) }) }), async (req, res, next) => {
  try {
    const p = await downloadFromDrive(req.body.fileId);
    if (!BACKUP_NAME_RE.test(path.basename(p))) throw new AppError('اسم ملف غير صالح', 422);
    res.json(await restoreBackupFile(p, appVersion()));
  } catch (e) { next(e); }
});
