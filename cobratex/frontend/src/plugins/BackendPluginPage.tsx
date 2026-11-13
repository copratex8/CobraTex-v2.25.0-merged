import { Link, useParams } from 'react-router-dom';
import { usePluginManifest } from '@/plugins/api';
import PluginHost from '@/plugins/PluginHost';

/** صفحة مستقلة لإضافة باك إند واحدة (من backend/plugins/*) — المسار /plugins/:name. */
export default function BackendPluginPage() {
  const { name } = useParams();
  const { data: plugins, isLoading } = usePluginManifest();
  const plugin = plugins?.find((p) => p.name === name);

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (!plugin) {
    return (
      <p className="text-sm text-slate-500">
        الإضافة غير موجودة. <Link to="/plugins" className="font-medium underline">كل الإضافات</Link>
      </p>
    );
  }
  return (
    <div>
      <div className="page-hdr">
        <div>
          <h1>{plugin.navLabel ?? plugin.name}</h1>
          <p>{plugin.name}@{plugin.version}{plugin.description ? ` — ${plugin.description}` : ''}</p>
        </div>
      </div>
      <div className="card">
        <PluginHost plugin={plugin} />
      </div>
    </div>
  );
}
