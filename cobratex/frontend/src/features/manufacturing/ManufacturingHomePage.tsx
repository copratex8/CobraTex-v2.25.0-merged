import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompany, useUpdateManufacturingEnabled } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';

const sections = [
  { to: '/manufacturing/activities', title: 'الأنشطة', desc: 'عرِّف أنشطة شركتك (غزل، نسيج، تجميع، أو أي تصنيف آخر) لتصنيف قوائم المواد وأوامر التصنيع عليها.' },
  { to: '/manufacturing/boms', title: 'قوائم المواد (BOM)', desc: 'وصفة إنتاج: أي مكوّنات وبأي كمية ونسبة هالك تلزم لإنتاج صنف واحد.' },
  { to: '/manufacturing/orders', title: 'أوامر التصنيع', desc: 'تنفيذ وصفة إنتاج فعليًا: استهلاك المكوّنات وإنتاج الصنف الناتج بالتكلفة الفعلية.' },
];

export default function ManufacturingHomePage() {
  const { data: company } = useCompany();
  const updateEnabled = useUpdateManufacturingEnabled();
  const [error, setError] = useState<string | null>(null);

  async function toggle(enabled: boolean) {
    setError(null);
    try { await updateEnabled.mutateAsync(enabled); } catch (err) { setError(extractErrorMessage(err)); }
  }

  const enabled = company?.manufacturing_enabled ?? true;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1 className="text-xl font-bold text-slate-900">التصنيع</h1>
        {company && (
          <label className="flex shrink-0 items-center gap-2 rounded-xl bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200">
            <span className="text-sm font-medium text-slate-700">{enabled ? 'الوحدة مفعَّلة' : 'الوحدة معطَّلة'}</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => toggle(e.target.checked)}
              disabled={updateEnabled.isPending}
              className="h-4 w-8 cursor-pointer accent-slate-900"
            />
          </label>
        )}
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!enabled && (
        <div className="mb-6 rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
          وحدة التصنيع معطَّلة حاليًا — كل قوائم المواد وأوامر التصنيع السابقة محفوظة كما هي وستعود فور
          إعادة التفعيل من المفتاح أعلاه. الأقسام أدناه غير قابلة للفتح طالما هي معطَّلة، وهذه الصفحة
          نفسها (لإعادة التفعيل) تبقى دائمًا متاحة من القائمة الجانبية.
        </div>
      )}

      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${enabled ? '' : 'pointer-events-none opacity-40'}`}>
        {sections.map((s) => (
          <Link key={s.to} to={s.to} className="block rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:ring-slate-400">
            <h2 className="mb-2 font-semibold text-slate-900">{s.title}</h2>
            <p className="text-sm text-slate-500">{s.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
