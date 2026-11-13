import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { pool } from '@/db/pool';

/**
 * نظام الإضافات (Plugins): يسمح بإضافة "أنشطة" خارجية (مسارات API جديدة، منطق مستقل) دون تعديل
 * أي كود أساسي ودون إعادة تغليف/بناء المشروع بالكامل — فقط بإسقاط مجلد إضافة جديد في مجلد
 * `plugins/` (خارج `src/`، لا يمر عبر tsc إطلاقًا) وإعادة تشغيل العملية (لا حتى إعادة بناء).
 *
 * كل إضافة = مجلد يحتوي:
 * - `plugin.json`: بيانات وصفية (name, version, description, enabled).
 * - `index.js`: كائن CommonJS عادي (لا TypeScript، يعمل مباشرة تحت Node بلا تجميع) يُصدِّر
 *   دالة `registerRoutes(router, sdk)` اختيارية تُسجِّل مسارات على router مشترك.
 *
 * الإضافة تُحمَّل ضمن نفس authMiddleware — أي مسار تُسجِّله يحصل تلقائيًا على req.ctx
 * (RequestContext) مُشتقًا من التوكن، بنفس عزل الشركة/الفرع/الصلاحيات المطبَّق على كل شيء آخر.
 * الاتفاق: تُسمِّي الإضافة مساراتها دائمًا بادئة `/plugins/<name>/...` لتفادي أي تعارض.
 */

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  /** مسار نسبي داخل مجلد الإضافة لملف JS خاص بالواجهة الأمامية (Web Component خام، راجع تعليق serveStatic أدناه). */
  frontendEntry?: string;
  /** اسم الوسم المخصَّص (Custom Element tag) الذي يُعرِّفه frontendEntry، لتركيبه في الواجهة تلقائيًا. */
  customElementTag?: string;
  /** تسمية عنصر التنقّل في الشريط الجانبي إن أُريد للإضافة رابطًا مباشرًا هناك. */
  navLabel?: string;
}

export interface PluginSdk {
  /** اتصال قاعدة البيانات المشترك نفسه — الإضافة يمكنها إنشاء جداولها الخاصة (بادئة باسمها لتفادي التعارض) وقراءتها/الكتابة إليها مباشرة. */
  pool: typeof pool;
}

export interface PluginModule {
  registerRoutes?: (router: Router, sdk: PluginSdk) => void;
  /** اختياري: يُستدعى يدويًا (لا تلقائيًا عند كل إقلاع) عبر سكريبت منفصل لتهيئة جداول الإضافة الخاصة. */
  migrate?: (dbPool: typeof pool) => Promise<void>;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  description?: string;
  dir: string;
  frontendEntry?: string;
  customElementTag?: string;
  navLabel?: string;
}

const DEFAULT_PLUGINS_DIR = path.resolve(process.cwd(), 'plugins');

/** يكتشف كل مجلدات الإضافات الصالحة (لها plugin.json قابل للقراءة، وenabled ليست false صراحةً). */
export function discoverPlugins(pluginsDir: string = process.env.PLUGINS_DIR || DEFAULT_PLUGINS_DIR): { manifest: PluginManifest; dir: string }[] {
  if (!fs.existsSync(pluginsDir)) return [];
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const found: { manifest: PluginManifest; dir: string }[] = [];
  for (const entry of entries) {
    const dir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
      if (manifest.enabled === false) continue;
      found.push({ manifest, dir });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[plugins] فشل قراءة plugin.json في ${dir}:`, err);
    }
  }
  return found;
}

/** يُحمِّل إضافة واحدة عبر require() قياسي (يعتمد على تخزين Node المؤقت الطبيعي للموديولات —
 * تغيير كود إضافة يتطلب إعادة تشغيل العملية، لا إعادة بناء). */
function loadPluginModule(dir: string): PluginModule | null {
  const entryPath = path.join(dir, 'index.js');
  if (!fs.existsSync(entryPath)) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return require(entryPath) as PluginModule;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[plugins] فشل تحميل ${entryPath}:`, err);
    return null;
  }
}

/** يكتشف ويُحمِّل كل الإضافات المفعَّلة، ويُرجع Router واحدًا جاهزًا للتركيب + قائمة بما نجح تحميله. */
export function loadAllPlugins(pluginsDir?: string): { router: Router; loaded: LoadedPlugin[] } {
  const router = Router();
  const loaded: LoadedPlugin[] = [];
  const discovered = discoverPlugins(pluginsDir);
  for (const { manifest, dir } of discovered) {
    const mod = loadPluginModule(dir);
    if (!mod) continue;
    try {
      mod.registerRoutes?.(router, { pool });
      loaded.push({
        name: manifest.name, version: manifest.version, description: manifest.description, dir,
        frontendEntry: manifest.frontendEntry, customElementTag: manifest.customElementTag, navLabel: manifest.navLabel,
      });
      // eslint-disable-next-line no-console
      console.log(`[plugins] تم تحميل: ${manifest.name}@${manifest.version}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[plugins] فشل تسجيل مسارات الإضافة ${manifest.name}:`, err);
    }
  }
  return { router, loaded };
}
