import { useState } from 'react';
import { useSafes } from '@/features/catalog/api';
import SafeCreateModal from '@/features/treasury/SafeCreateModal';

const kindLabels: Record<string, string> = { safe: 'خزينة نقدية', bank: 'حساب بنكي' };

export default function SafesListPage() {
  const [showCreate, setShowCreate] = useState(false);
  const { data: safes, isLoading, isError } = useSafes();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">الخزائن والبنوك</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + خزينة/بنك جديد
        </button>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة الخزائن والبنوك.</p>}
        {safes && (
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">الكود</th>
                <th className="px-4 py-3 font-medium">الاسم</th>
                <th className="px-4 py-3 font-medium">النوع</th>
                <th className="px-4 py-3 font-medium">العملة</th>
                <th className="px-4 py-3 font-medium">تفاصيل البنك</th>
              </tr>
            </thead>
            <tbody>
              {safes.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{s.code}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{s.name_ar}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.kind === 'bank' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'}`}>
                      {kindLabels[s.kind]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{s.currency_code}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {s.kind === 'bank' ? `${s.bank_name ?? ''} — ${s.account_number ?? ''}` : '—'}
                  </td>
                </tr>
              ))}
              {safes.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-400">لا توجد خزائن أو بنوك بعد</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && <SafeCreateModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}
