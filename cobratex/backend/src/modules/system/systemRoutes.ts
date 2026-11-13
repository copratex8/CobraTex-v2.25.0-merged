import fs from 'fs';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import type { LoadedPlugin } from '@/plugins/loader';

export const systemRouter = Router();

/** ملف VERSION نصي بسيط في جذر المشروع — يُحدَّث يدويًا (أو عبر CI) مع كل إصدار، بلا أي منطق بناء إضافي. */
function readVersion(): string {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), 'VERSION'), 'utf-8').trim();
  } catch {
    return '0.0.0-unknown';
  }
}

systemRouter.get('/system/version', (_req, res) => {
  res.json({ version: readVersion() });
});

/** لا صلاحية مطلوبة عمدًا — معلومات الإصدار/الإضافات المُحمَّلة ليست حسّاسة، ومفيدة لأدوات المراقبة الخارجية أيضًا. */
systemRouter.get('/system/plugins', (req, res) => {
  const loaded = (req.app.get('loadedPlugins') as LoadedPlugin[] | undefined) ?? [];
  res.json({
    plugins: loaded.map(({ name, version, description, frontendEntry, customElementTag, navLabel }) => ({
      name, version, description, customElementTag: customElementTag ?? null, navLabel: navLabel ?? null,
      // مسار عام يُقدَّم عبر express.static (راجع app.ts) — الواجهة تجلبه مباشرة عبر import() ديناميكي.
      frontendEntryUrl: frontendEntry ? `/plugin-assets/${name}/${frontendEntry}` : null,
    })),
  });
});

/**
 * فحص تحديث خارجي: يقرأ من رابط خارجي مُهيَّأ عبر UPDATE_FEED_URL (ملف JSON بسيط
 * {"latestVersion": "...", "downloadUrl": "...", "notes": "..."}) — لا يوجد خادم تحديث مركزي
 * جاهز مسبقًا (Anthropic لا تُشغِّل واحدًا)، لكن الآلية جاهزة وتعمل فوريًا بمجرد ضبط هذا المتغير
 * ليشير لأي رابط JSON ثابت (GitHub raw، S3 عام، أي استضافة ثابتة). بلا ضبطه، يُرجع الحالة
 * الحالية فقط بصراحة بلا ادّعاء اتصال لا يحدث.
 */
// مسار عام يستدعي رابطًا خارجيًا: حدّ للمعدّل كي لا يصبح أداة تضخيم/إغراق.
const updateCheckLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

systemRouter.get('/system/update-check', updateCheckLimiter, async (req, res, next) => {
  try {
    const currentVersion = typeof req.query.currentVersion === 'string' ? req.query.currentVersion : readVersion();
    const feedUrl = process.env.UPDATE_FEED_URL;
    if (!feedUrl) {
      res.json({
        currentVersion, latestVersion: readVersion(), updateAvailable: false,
        note: 'لم يُضبط UPDATE_FEED_URL — لا مصدر تحديث خارجي مُهيَّأ لهذا الخادم بعد.',
      });
      return;
    }
    if (!/^https:\/\//i.test(feedUrl)) throw new Error('UPDATE_FEED_URL يجب أن يكون https');
    const response = await fetch(feedUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`تعذَّر الوصول لمصدر التحديث: HTTP ${response.status}`);
    const feed = (await response.json()) as {
      latestVersion: string; downloadUrl?: string; notes?: string;
      announcement?: string; license?: { status?: string; message?: string };
    };
    res.json({
      currentVersion,
      latestVersion: feed.latestVersion,
      updateAvailable: feed.latestVersion !== currentVersion,
      downloadUrl: feed.downloadUrl ?? null,
      notes: feed.notes ?? null,
      // إضافات CobraTex (اختيارية في ملف التغذية): شريط إعلان إداري + حالة ترخيص العميل (active|expired|suspended).
      announcement: feed.announcement ?? null,
      license: feed.license ?? null,
    });
  } catch (err) {
    next(err);
  }
});
