import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient, backendOrigin } from '@/api/client';
import { useBrand } from '@/brand/BrandProvider';
import { APP_VERSION } from '@/cloud/updates';
import { toast } from '@/ui/toast';
import { useFrontendPlugins, type PluginContext } from '@/plugins/registry';

/** يستضيف إضافة واجهة (public/plugins/*.js) داخل غلاف التطبيق على المسار /ext/:pluginId. */
export default function ExternalPluginPage() {
  const { pluginId } = useParams();
  const plugins = useFrontendPlugins();
  const plugin = plugins.find((p) => p.id === pluginId);
  const brand = useBrand();
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!plugin || !host.current) return;
    const el = host.current;
    el.innerHTML = '';
    setError(null);
    const ctx: PluginContext = { api: apiClient, backendOrigin, brand, appVersion: APP_VERSION, toast, navigate };
    let cleanup: void | (() => void);
    try {
      cleanup = plugin.mount(el, ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch {
        /* تنظيف الإضافة لا يجب أن يكسر التنقل */
      }
      el.innerHTML = '';
    };
  }, [plugin, brand, navigate]);

  if (!plugin) {
    return <p className="text-sm text-slate-500">الإضافة «{pluginId}» غير موجودة أو لم تُحمَّل بعد.</p>;
  }
  return (
    <div>
      <div className="page-hdr">
        <div>
          <h1>{plugin.name}</h1>
          {plugin.description && <p>{plugin.description}</p>}
        </div>
      </div>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">تعذّر تشغيل الإضافة: {error}</p>}
      <div ref={host} />
    </div>
  );
}
