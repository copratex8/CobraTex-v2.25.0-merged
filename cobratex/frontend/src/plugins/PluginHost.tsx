import { useEffect, useState } from 'react';
import { backendOrigin, getStoredToken } from '@/api/client';
import type { PluginDescriptor } from '@/plugins/api';

const loadedScripts = new Set<string>();

/**
 * يُحمِّل ملف JS الخاص بإضافة (Web Component خام، لا يعتمد على React) عبر import() ديناميكي وقت
 * التشغيل — لا استيراد ثابت، لا في شجرة الحزمة المبنية بـ Vite إطلاقًا. إضافة جديدة أو محدَّثة
 * على الخادم تظهر بمجرد تحديث الصفحة، **بلا أي npm run build للواجهة نفسها**.
 *
 * بعد التحميل، يُركَّب الوسم المخصَّص (customElementTag) كعنصر DOM خام عبر JSX (React يمرّر أي
 * وسم غير معروف مباشرة كعنصر HTML عادي) — لا حاجة لمشاركة نسخة React بين المضيف والإضافة.
 */
export default function PluginHost({ plugin }: { plugin: PluginDescriptor }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'unsupported'>('loading');

  useEffect(() => {
    if (!plugin.frontendEntryUrl || !plugin.customElementTag) {
      setStatus('unsupported');
      return;
    }
    const url = `${backendOrigin}${plugin.frontendEntryUrl}`;
    if (loadedScripts.has(url)) {
      setStatus('ready');
      return;
    }
    import(/* @vite-ignore */ url)
      .then(() => {
        loadedScripts.add(url);
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, [plugin]);

  if (status === 'unsupported') {
    return <p className="text-sm text-slate-400">هذه الإضافة لا تملك واجهة عرض (backend فقط).</p>;
  }
  if (status === 'loading') return <p className="text-sm text-slate-500">جارٍ تحميل الإضافة...</p>;
  if (status === 'error') return <p className="text-sm text-red-600">تعذَّر تحميل ملف الإضافة من الخادم.</p>;

  const Tag = plugin.customElementTag as string;
  return (
    <div>
      <Tag auth-token={getStoredToken() ?? ''} api-base={`${backendOrigin}/api`} />
    </div>
  );
}
