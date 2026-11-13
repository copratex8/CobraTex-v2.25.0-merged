import { registerPlugin, setLoadReports, type CobraPlugin, type PluginLoadReport } from '@/plugins/registry';
import { APP_VERSION } from '@/cloud/updates';

interface ManifestEntryObject { file: string; id?: string; version?: string; enabled?: boolean }
interface PluginsManifest { plugins: (string | ManifestEntryObject)[] }

declare global {
  interface Window {
    /** واجهة عامة للإضافات الكلاسيكية (على غرار PLUGIN_API في الهدى). */
    CobraTex?: { registerPlugin: typeof registerPlugin; apiVersion: number; appVersion: string };
  }
}

function isPlugin(v: unknown): v is CobraPlugin {
  return !!v && typeof v === 'object' && typeof (v as CobraPlugin).id === 'string' && typeof (v as CobraPlugin).mount === 'function';
}

/**
 * يقرأ public/plugins/manifest.json (بلا تخزين مؤقت) ويحمّل كل ملف إضافة عبر import() ديناميكي وقت التشغيل.
 * الإضافة إما تستدعي window.CobraTex.registerPlugin({...}) أو تُصدِّر الكائن كـ default. فشل إضافة واحدة
 * لا يوقف غيرها. أضف ?v=<version> في المانيفست لإجبار المتصفح على جلب نسخة محدَّثة.
 */
export async function loadFrontendPlugins(): Promise<PluginLoadReport[]> {
  window.CobraTex = { registerPlugin, apiVersion: 1, appVersion: APP_VERSION };

  let manifest: PluginsManifest = { plugins: [] };
  try {
    const res = await fetch('/plugins/manifest.json', { cache: 'no-store' });
    if (res.ok) manifest = (await res.json()) as PluginsManifest;
  } catch {
    /* لا مانيفست = لا إضافات واجهة — النظام يعمل طبيعيًا */
  }

  const entries = (Array.isArray(manifest.plugins) ? manifest.plugins : []).map((e) =>
    typeof e === 'string' ? ({ file: e } as ManifestEntryObject) : e,
  );

  const reports: PluginLoadReport[] = [];
  for (const entry of entries) {
    if (!entry?.file || entry.enabled === false) continue;
    if (!/^[\w.-]+\.js$/.test(entry.file)) {
      reports.push({ file: entry.file ?? '?', ok: false, error: 'اسم ملف غير صالح (يجب أن يكون ملف .js مباشرًا داخل /plugins)' });
      continue;
    }
    try {
      const url = `${window.location.origin}/plugins/${entry.file}${entry.version ? `?v=${encodeURIComponent(entry.version)}` : ''}`;
      const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      if (isPlugin(mod.default)) registerPlugin(mod.default);
      reports.push({ file: entry.file, ok: true, id: entry.id });
    } catch (err) {
      reports.push({ file: entry.file, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  setLoadReports(reports);
  return reports;
}
