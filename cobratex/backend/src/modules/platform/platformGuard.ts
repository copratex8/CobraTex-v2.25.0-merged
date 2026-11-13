import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import * as lic_ from '@/modules/platform/licenseService';
import { tenantFromSupabaseToken } from '@/shared/supabaseAuth';
import { getEffectiveStatus, DEFAULT_SUSPENDED_MESSAGE, isUuid } from '@/modules/platform/platformService';

/** مسارات تبقى متاحة دائمًا (حتى أثناء الإيقاف): حالة المنصة العامة، لوحة المطور، معلومات النظام، الإعداد الأول. */
const ALWAYS_OPEN = ['/public', '/developer', '/system', '/bootstrap', '/cron'];

export async function tenantFromRequest(req: Request): Promise<string | null> {
  // تسجيل الدخول: tenantId في الجسم.
  const bodyTenant = (req.body as { tenantId?: unknown } | undefined)?.tenantId;
  if (isUuid(bodyTenant)) return bodyTenant;
  // طلب مُصادَق: نتحقق من توقيع التوكن (فلا يمكن انتحال عميل آخر لتفادي الإيقاف).
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = jwt.verify(header.slice(7), config.jwtAccessSecret) as { tenantId?: string };
      if (isUuid(claims.tenantId)) return claims.tenantId;
    } catch { /* ليس توكنًا قديمًا — جرّب توكن Supabase */ }
    const supaTenant = await tenantFromSupabaseToken(header.slice(7)); // يتحقق من التوقيع (JWKS)
    if (isUuid(supaTenant)) return supaTenant;
  }
  // تجديد الجلسة: refreshToken في الجسم (نقرأ tenantId منه؛ التحقق الفعلي يتم في خدمة التجديد).
  const refresh = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (typeof refresh === 'string') {
    const decoded = jwt.decode(refresh) as { tenantId?: string } | null;
    if (isUuid(decoded?.tenantId)) return decoded!.tenantId!;
  }
  return null;
}

/**
 * زر الإيقاف عن بُعد: إن كانت المنصة (أو عميل بعينه) موقوفة من لوحة المطور، يُرفض كل طلب API
 * برمز 503 + code=SERVICE_SUSPENDED + رسالة المطوّر. إنفاذ حقيقي من الخادم (لا حاجز واجهة فقط).
 * أي عطل في قراءة الحالة (جدول غير موجود قبل الترحيل مثلًا) يفتح الباب (fail-open) كي لا تُعطِّل
 * طبقة التحكم الخدمةَ نفسها.
 */
export async function platformGuard(req: Request, res: Response, next: NextFunction) {
  if (ALWAYS_OPEN.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  try {
    const status = await getEffectiveStatus(await tenantFromRequest(req));
    if (status.status === 'suspended') {
      return res.status(503).json({
        error: status.message || DEFAULT_SUSPENDED_MESSAGE,
        code: 'SERVICE_SUSPENDED',
        scope: status.scope,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[platformGuard] تعذّر قراءة حالة التشغيل — تم السماح بالطلب:', (err as Error).message);
  }
  return next();
}

/**
 * حارس الترخيص (2.22.0): انتهاء/مهلة سماح/ربط بنطاق أو جهاز. يأتي بعد platformGuard.
 * fail-open عند عطل القراءة (جدول غير مُهاجَر مثلًا) حتى لا تُعطِّل طبقة التحكم الخدمة نفسها.
 * عميل بلا صف ترخيص = بلا قيود، إلا إن ضُبط LICENSE_REQUIRED=1.
 */
export async function licenseGuard(req: Request, res: Response, next: NextFunction) {
  if (ALWAYS_OPEN.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  try {
    const tenantId = await tenantFromRequest(req);
    if (!tenantId) return next();
    const lic = await lic_.getLicense(tenantId);
    const rawDev = req.get('x-device-id');
    const d = lic_.decide(lic, {
      method: req.method, path: req.path, origin: req.get('origin') ?? req.get('referer') ?? null,
      deviceId: rawDev && lic_.DEVICE_RE.test(rawDev) ? rawDev : null,
    }, new Date(), process.env.LICENSE_REQUIRED === '1');
    if (!d.allow) return res.status(d.status).json({ error: d.message, code: d.code });
    if (d.needsDevice && lic) {
      const rej = await lic_.registerDevice(tenantId, rawDev as string, req.get('user-agent') ?? '', lic.maxDevices);
      if (rej) return res.status(403).json({ error: rej.message, code: rej.code });
    }
    if (lic) {
      const ev = lic_.evaluateLicense(lic);
      res.set('X-License-State', ev.state + (ev.daysLeft !== null ? `;days=${ev.daysLeft}` : ''));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[licenseGuard] تعذّر فحص الترخيص — تم السماح بالطلب:', (err as Error).message);
  }
  return next();
}
