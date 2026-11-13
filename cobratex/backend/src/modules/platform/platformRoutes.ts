import crypto from 'crypto';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import { UnauthorizedError, ValidationError } from '@/shared/errors';
import * as svc from '@/modules/platform/platformService';
import * as brandSvc from '@/modules/platform/brandingService';
import { provisionTenant } from '@/modules/tenancy/provisioning';
import * as lic from '@/modules/platform/licenseService';
import * as rc from '@/modules/platform/remoteControlService';
import { ipAllowed, verifyTotp } from '@/modules/platform/devSecurity';
import * as act from '@/modules/platform/activityModules';
import * as pi from '@/modules/platform/pluginInstaller';
import path from 'path';

export const platformRouter = Router();

/* ───────────── عام (بلا مصادقة): تستهلكه شاشة تسجيل الدخول ───────────── */
// مسار عام يلمس القاعدة: حدّ للمعدّل لكل IP (يعمل بدقة خلف البروكسي بفضل trust proxy).
const publicStatusLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
platformRouter.get('/public/status', publicStatusLimiter, async (req, res, next) => {
  try {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : null;
    res.set('Cache-Control', 'no-store');
    res.json(await svc.getPublicStatus(tenantId));
  } catch (err) {
    next(err);
  }
});

/* ───────────── لوحة المطور: مصادقة مستقلة تمامًا عن مستخدمي العملاء ───────────── */
const devSecretKey = () => `${process.env.DEVELOPER_JWT_SECRET ?? config.jwtAccessSecret}|developer-panel`;
const DEV_TTL = '4h';

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest();
}

function requireDeveloper(req: Request, _res: Response, next: NextFunction) {
  if (!ipAllowed(req)) return next(new UnauthorizedError('غير مصرَّح'));
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(new UnauthorizedError('مطلوب تسجيل دخول المطوّر'));
  try {
    const claims = jwt.verify(header.slice(7), devSecretKey(), { algorithms: ['HS256'] }) as { role?: string };
    if (claims.role !== 'platform_developer') throw new Error('role');
    next();
  } catch {
    next(new UnauthorizedError('جلسة المطوّر غير صالحة أو منتهية'));
  }
}

const devLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'محاولات كثيرة، حاول لاحقًا' },
});

const LOGIN_FAILED = 'بيانات الدخول غير صحيحة'; // رسالة واحدة لكل أسباب الفشل (لا نكشف أي عامل أخطأ)

platformRouter.post('/developer/login', devLoginLimiter, async (req, res, next) => {
  try {
    const secret = process.env.DEVELOPER_SECRET;
    // غير مُفعَّلة ما لم يُضبط DEVELOPER_SECRET (8+ أحرف): تبدو كمسار غير موجود. وكذلك لأي IP خارج القائمة المسموحة.
    if (!secret || secret.length < 8) return res.status(404).json({ error: 'غير متاح' });
    if (!ipAllowed(req)) {
      await svc.audit('developer.login.denied_ip', { ip: req.ip });
      return res.status(404).json({ error: 'غير متاح' });
    }
    const given = typeof req.body?.secret === 'string' ? req.body.secret : '';
    const secretOk = crypto.timingSafeEqual(sha256(given), sha256(secret));

    // عامل ثانٍ (TOTP): يُفعَّل بضبط DEVELOPER_TOTP_SECRET (Base32). يُرفض الرمز المُعاد استخدامه.
    let totpOk = true;
    let counter: number | null = null;
    const totpSecret = process.env.DEVELOPER_TOTP_SECRET;
    if (totpSecret) {
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      counter = verifyTotp(totpSecret, code);
      totpOk = counter !== null && counter > (await svc.getLastTotpCounter());
    }
    if (!secretOk || !totpOk) {
      await svc.audit('developer.login.failed', { ip: req.ip, secretOk, totpOk });
      return res.status(401).json({ error: LOGIN_FAILED });
    }
    if (counter !== null) await svc.setLastTotpCounter(counter);
    await svc.audit('developer.login', { ip: req.ip });
    const token = jwt.sign({ role: 'platform_developer' }, devSecretKey(), { expiresIn: DEV_TTL, algorithm: 'HS256' });
    res.json({ token, expiresIn: DEV_TTL, twoFactor: !!totpSecret });
  } catch (err) {
    next(err);
  }
});

platformRouter.get('/developer/overview', requireDeveloper, async (_req, res, next) => {
  try {
    const [state, tenants, announcements, audit, update] = await Promise.all([
      svc.getControlState(), svc.listTenants(), svc.listAnnouncements(), svc.listAudit(30), svc.getClientUpdate(),
    ]);
    res.json({ global: state.global, tenants, announcements, audit, update });
  } catch (err) {
    next(err);
  }
});

platformRouter.put('/developer/service', requireDeveloper, async (req, res, next) => {
  try {
    res.json(await svc.setGlobalService(req.body?.status, req.body?.message));
  } catch (err) {
    next(err);
  }
});

platformRouter.put('/developer/tenants/:id/service', requireDeveloper, async (req, res, next) => {
  try {
    res.json(await svc.setTenantService(String(req.params.id), req.body?.status, req.body?.message));
  } catch (err) {
    next(err);
  }
});

platformRouter.post('/developer/announcements', requireDeveloper, async (req, res, next) => {
  try {
    res.status(201).json(await svc.createAnnouncement(req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

platformRouter.patch('/developer/announcements/:id', requireDeveloper, async (req, res, next) => {
  try {
    res.json(await svc.updateAnnouncement(String(req.params.id), req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

platformRouter.delete('/developer/announcements/:id', requireDeveloper, async (req, res, next) => {
  try {
    await svc.deleteAnnouncement(String(req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const pluginsDir = () => process.env.PLUGINS_DIR || path.resolve(process.cwd(), 'plugins');
const coreVersion = () => { try { return require('fs').readFileSync(path.resolve(process.cwd(), 'VERSION'), 'utf8').trim(); } catch { return undefined; } };
platformRouter.get('/developer/plugins', requireDeveloper, (_req, res, next) => { try { res.json({ installed: pi.listInstalled(pluginsDir()), installerEnabled: !!process.env.PLUGIN_PUBLIC_KEY, coreVersion: coreVersion() ?? null }); } catch (err) { next(err); } });
// الرفع ثنائي (application/octet-stream) كي لا يمر بمحلل JSON العام (حدّه الافتراضي صغير) — حد 12MB هنا.
platformRouter.post('/developer/plugins/install', requireDeveloper, express.raw({ type: 'application/octet-stream', limit: '12mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ValidationError('أرسل الحزمة كجسم ثنائي (Content-Type: application/octet-stream)');
    let raw: unknown; try { raw = JSON.parse(req.body.toString('utf8')); } catch { throw new ValidationError('الحزمة ليست JSON صالحًا'); }
    const { pool } = await import('@/db/pool');
    res.json(await pi.installBundle(raw, { pluginsDir: pluginsDir(), publicKey: (process.env.PLUGIN_PUBLIC_KEY ?? '').replace(/\\n/g, '\n') || undefined, coreVersion: coreVersion(), allowDowngrade: req.query.allowDowngrade === '1',
      migrate: async (dir) => { const m = require(path.join(dir, 'index.js')); if (typeof m.migrate === 'function') await m.migrate(pool); } }));
  } catch (err) { next(err); }
});
platformRouter.post('/developer/plugins/:name/rollback', requireDeveloper, (req, res, next) => { try { res.json(pi.rollbackPlugin(pluginsDir(), String(req.params.name))); } catch (err) { next(err); } });
platformRouter.get('/developer/activity', requireDeveloper, async (_req, res, next) => {
  try { res.json({ modules: act.MODULES, profiles: act.PROFILES, companies: await act.listCompaniesActivity() }); } catch (err) { next(err); }
});
platformRouter.put('/developer/companies/:id/activity', requireDeveloper, async (req, res, next) => {
  try {
    if (!svc.isUuid(String(req.params.id))) throw new ValidationError('معرّف الشركة غير صالح');
    res.json(await act.setCompanyActivity(String(req.params.id), { profile: req.body?.profile, overrides: req.body?.overrides, resetOverrides: req.body?.resetOverrides === true }));
  } catch (err) { next(err); }
});

/* ───────────── التراخيص (لوحة المطور) ───────────── */
platformRouter.get('/developer/licenses', requireDeveloper, async (_req, res, next) => { try { res.json({ items: await lic.listLicenses(), plans: lic.PLAN_TYPES, licenseRequired: process.env.LICENSE_REQUIRED === '1' }); } catch (err) { next(err); } });
platformRouter.put('/developer/tenants/:id/license', requireDeveloper, async (req, res, next) => { try { res.json(await lic.upsertLicense(String(req.params.id), req.body ?? {})); } catch (err) { next(err); } });
platformRouter.post('/developer/tenants/:id/license/extend', requireDeveloper, async (req, res, next) => { try { res.json(await lic.extendLicense(String(req.params.id), req.body?.unit, req.body?.amount)); } catch (err) { next(err); } });
platformRouter.delete('/developer/tenants/:id/license', requireDeveloper, async (req, res, next) => { try { if (!svc.isUuid(String(req.params.id))) throw new ValidationError('معرّف العميل غير صالح'); await lic.deleteLicense(String(req.params.id)); res.status(204).end(); } catch (err) { next(err); } });
platformRouter.get('/developer/tenants/:id/devices', requireDeveloper, async (req, res, next) => { try { if (!svc.isUuid(String(req.params.id))) throw new ValidationError('معرّف العميل غير صالح'); res.json(await lic.listDevices(String(req.params.id))); } catch (err) { next(err); } });
platformRouter.patch('/developer/tenants/:id/devices/:deviceId', requireDeveloper, async (req, res, next) => {
  try {
    const t = String(req.params.id), d = String(req.params.deviceId);
    if (!svc.isUuid(t)) throw new ValidationError('معرّف العميل غير صالح');
    if (typeof req.body?.revoked === 'boolean') await lic.setDeviceRevoked(t, d, req.body.revoked);
    if (typeof req.body?.label === 'string') await lic.renameDevice(t, d, req.body.label);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
platformRouter.delete('/developer/tenants/:id/devices/:deviceId', requireDeveloper, async (req, res, next) => { try { if (!svc.isUuid(String(req.params.id))) throw new ValidationError('معرّف العميل غير صالح'); await lic.removeDevice(String(req.params.id), String(req.params.deviceId)); res.status(204).end(); } catch (err) { next(err); } });

/* ───────────── هوية العملاء وإنشاؤهم وإدارة مستخدميهم (2.23.0) ───────────── */
const brandLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
platformRouter.get('/public/brand', brandLimiter, async (req, res, next) => {
  try {
    const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : null);
    const r = await brandSvc.resolveBrand({ host: q('host'), slug: q('c'), tenantId: q('t') });
    res.set('Cache-Control', 'no-store').json(r ?? { tenantId: null, brand: {} });
  } catch (err) { next(err); }
});
platformRouter.get('/developer/tenants/:id/branding', requireDeveloper, async (req, res, next) => { try { if (!svc.isUuid(String(req.params.id))) throw new ValidationError('معرّف العميل غير صالح'); res.json(await brandSvc.getBranding(String(req.params.id))); } catch (err) { next(err); } });
platformRouter.put('/developer/tenants/:id/branding', requireDeveloper, async (req, res, next) => { try { res.json(await brandSvc.setBranding(String(req.params.id), req.body ?? {})); } catch (err) { next(err); } });
platformRouter.get('/developer/tenants/:id/users', requireDeveloper, async (req, res, next) => { try { if (!svc.isUuid(String(req.params.id))) throw new ValidationError('معرّف العميل غير صالح'); res.json(await brandSvc.listTenantUsers(String(req.params.id))); } catch (err) { next(err); } });
platformRouter.post('/developer/tenants/:id/users/:userId/reset-password', requireDeveloper, async (req, res, next) => { try { res.json(await brandSvc.resetUserPassword(String(req.params.id), String(req.params.userId), req.body?.password)); } catch (err) { next(err); } });
platformRouter.patch('/developer/tenants/:id/users/:userId', requireDeveloper, async (req, res, next) => { try { if (typeof req.body?.active !== 'boolean') throw new ValidationError('active مطلوب (true/false)'); await brandSvc.setUserActive(String(req.params.id), String(req.params.userId), req.body.active); res.json({ ok: true }); } catch (err) { next(err); } });
/** إنشاء عميل جديد كاملًا من اللوحة (بديل curl /bootstrap): شركة + مالك + هوية + ترخيص اختياريان. */
platformRouter.post('/developer/tenants', requireDeveloper, async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const need = (v: unknown, n: string) => { if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${n} مطلوب`); return v.trim(); };
    const tenantName = need(b.tenantName, 'اسم العميل'); const companyLegalName = need(b.companyLegalName, 'الاسم القانوني للشركة'); const ownerEmail = need(b.ownerEmail, 'بريد المالك').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new ValidationError('بريد المالك غير صالح');
    const ownerPassword = typeof b.ownerPassword === 'string' && b.ownerPassword ? b.ownerPassword : brandSvc.generatePassword();
    if (ownerPassword.length < 8) throw new ValidationError('كلمة المرور 8 أحرف على الأقل');
    // تحقق مسبق من الهوية والترخيص حتى لا يُنشأ عميل ناقص عند خطأ إدخال لاحق.
    brandSvc.sanitizeBrand(b.brand);
    const ids = await provisionTenant({ tenantName, companyLegalName, companyDisplayName: typeof b.companyDisplayName === 'string' && b.companyDisplayName ? b.companyDisplayName : undefined, ownerFullName: typeof b.ownerFullName === 'string' && b.ownerFullName ? b.ownerFullName : undefined, ownerEmail, ownerPassword });
    const warnings: string[] = [];
    if (b.brand || b.slug || b.domains) { try { await brandSvc.setBranding(ids.tenantId, { slug: b.slug, brand: b.brand, domains: b.domains }); } catch (e) { warnings.push('الهوية لم تُحفظ: ' + (e as Error).message); } }
    if (b.license) { try { await lic.upsertLicense(ids.tenantId, b.license); } catch (e) { warnings.push('الترخيص لم يُحفظ: ' + (e as Error).message); } }
    await pi_audit(ids.tenantId, tenantName);
    res.status(201).json({ tenantId: ids.tenantId, companyId: ids.companyId, ownerEmail, ownerPassword, link: b.slug ? `?c=${String(b.slug).toLowerCase()}` : `?t=${ids.tenantId}`, warnings });
  } catch (err) { next(err); }
});
/* ───────────── سياسة التحديث الإجباري + إشعارات المطوّر + تذكيرات انتهاء الترخيص ───────────── */
platformRouter.put('/developer/update', requireDeveloper, async (req, res, next) => {
  try { res.json(await svc.setClientUpdate(req.body ?? {})); } catch (err) { next(err); }
});
platformRouter.post('/developer/notify', requireDeveloper, async (req, res, next) => {
  try { res.status(201).json(await rc.broadcast(req.body ?? {})); } catch (err) { next(err); }
});
platformRouter.post('/developer/reminders/run', requireDeveloper, async (_req, res, next) => {
  try { res.json(await rc.runReminders()); } catch (err) { next(err); }
});

/** Vercel Cron (vercel.json) يرسل Authorization: Bearer $CRON_SECRET. بلا CRON_SECRET (16+ حرفًا) يبدو المسار غير موجود. */
platformRouter.get('/cron/license-reminders', async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 16) return res.status(404).json({ error: 'غير متاح' });
    const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!crypto.timingSafeEqual(sha256(given), sha256(secret))) return res.status(401).json({ error: 'غير مصرَّح' });
    res.json(await rc.runReminders());
  } catch (err) { next(err); }
});

async function pi_audit(tenantId: string, name: string) {
  const { pool } = await import('@/db/pool');
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('tenant.create', $1)`, [JSON.stringify({ tenantId, name })]);
}
