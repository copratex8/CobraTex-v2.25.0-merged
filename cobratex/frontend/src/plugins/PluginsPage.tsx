import { Link } from 'react-router-dom';
import { usePluginManifest } from '@/plugins/api';
import PluginHost from '@/plugins/PluginHost';
import { useFrontendPlugins, useLoadReports } from '@/plugins/registry';

/**
 * صفحة الإضافات: تسرد كل ما اكتشفه الباك إند فعليًا في مجلد plugins/ عند آخر إقلاع (لا قائمة
 * ثابتة مكتوبة هنا) — إضافة جديدة تظهر هنا فور إسقاط مجلدها على الخادم وإعادة تشغيل العملية،
 * بلا أي تعديل أو بناء لهذه الصفحة نفسها.
 */
export default function PluginsPage() {
  const { data: plugins, isLoading, isError } = usePluginManifest();
  const frontendPlugins = useFrontendPlugins();
  const loadReports = useLoadReports();
  const failedReports = loadReports.filter((r) => !r.ok);

  return (
    <div>
      <h1 className="mb-2 text-xl font-bold text-slate-900">الإضافات (Plugins)</h1>
      <p className="mb-6 text-sm text-slate-500">
        أنشطة خارجية أُضيفت للنظام دون تعديل الكود الأساسي أو إعادة تغليف المشروع — كل ما يظهر هنا اكتُشف تلقائيًا من الخادم.
      </p>

      <h2 className="mb-3 text-sm font-bold text-slate-900">إضافات الواجهة (public/plugins)</h2>
      <div className="mb-8 space-y-3">
        {frontendPlugins.length === 0 && <p className="text-sm text-slate-400">لا توجد إضافات واجهة مُحمَّلة.</p>}
        {frontendPlugins.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">{p.section?.icon ?? '🔌'} {p.name}</h3>
              <p className="text-xs text-slate-500">{p.id}{p.version ? `@${p.version}` : ''}{p.description ? ` — ${p.description}` : ''}</p>
            </div>
            <Link to={`/ext/${p.id}`} className="text-sm font-medium text-slate-700 hover:underline">فتح</Link>
          </div>
        ))}
        {failedReports.map((r) => (
          <p key={r.file} className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">تعذّر تحميل {r.file}: {r.error}</p>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-bold text-slate-900">إضافات الخادم (backend/plugins)</h2>
      {isLoading && <p className="text-sm text-slate-500">جارٍ التحميل...</p>}
      {isError && <p className="text-sm text-red-600">تعذَّر تحميل قائمة الإضافات.</p>}
      {plugins?.length === 0 && <p className="text-sm text-slate-400">لا توجد إضافات مُحمَّلة حاليًا.</p>}

      <div className="space-y-4">
        {plugins?.map((plugin) => (
          <div key={plugin.name} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">{plugin.navLabel ?? plugin.name}</h2>
                <p className="text-xs text-slate-500">{plugin.name}@{plugin.version} — {plugin.description}</p>
              </div>
            </div>
            <PluginHost plugin={plugin} />
          </div>
        ))}
      </div>
    </div>
  );
}
