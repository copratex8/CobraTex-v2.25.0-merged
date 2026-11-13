import { useState, type FormEvent } from 'react';
import { useActivities, useCreateActivity, useUpdateActivityStatus } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';

export default function ActivitiesListPage() {
  const { data: activities, isLoading, isError } = useActivities();
  const createActivity = useCreateActivity();
  const updateStatus = useUpdateActivityStatus();

  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createActivity.mutateAsync({ nameAr, nameEn });
      setNameAr(''); setNameEn('');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">الأنشطة</h1>
      <p className="mb-6 text-sm text-slate-500">
        عرِّف أنشطة شركتك الخاصة (مثال: غزل، نسيج، صباغة — أو تجميع، تعبئة، أي تصنيف تحتاجه). تُستخدَم لتصنيف قوائم المواد وأوامر التصنيع وحركات المخزون اختياريًا.
      </p>

      <form onSubmit={handleSubmit} className="mb-6 flex flex-wrap items-end gap-3 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <label className="block min-w-[180px] flex-1">
          <span className="mb-1 block text-sm font-medium text-slate-700">الاسم بالعربية</span>
          <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>
        <label className="block min-w-[180px] flex-1">
          <span className="mb-1 block text-sm font-medium text-slate-700">الاسم بالإنجليزية</span>
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>
        <button type="submit" disabled={createActivity.isPending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createActivity.isPending ? 'جارٍ الحفظ...' : '+ إضافة نشاط'}
        </button>
      </form>
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة الأنشطة.</p>}
        {activities && (
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">الاسم</th>
                <th className="px-4 py-3 font-medium">الحالة</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.id} className={`border-b border-slate-100 last:border-0 ${a.is_active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-3 font-medium text-slate-900">{a.name_ar}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${a.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                      {a.is_active ? 'نشط' : 'معطَّل'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-end">
                    <button
                      onClick={() => updateStatus.mutate({ id: a.id, isActive: !a.is_active })}
                      disabled={updateStatus.isPending}
                      className="text-sm font-medium text-slate-700 hover:underline disabled:opacity-50"
                    >
                      {a.is_active ? 'تعطيل' : 'تفعيل'}
                    </button>
                  </td>
                </tr>
              ))}
              {activities.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">لا توجد أنشطة بعد</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
