import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTrialBalance } from '@/features/reports/api';

const typeLabels: Record<string, string> = {
  asset: 'أصول', liability: 'خصوم', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات',
};

export default function TrialBalancePage() {
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [fromDate, setFromDate] = useState('');
  const [onlyWithActivity, setOnlyWithActivity] = useState(true);
  const { data, isLoading, isError } = useTrialBalance(asOfDate, fromDate || undefined, onlyWithActivity);

  return (
    <div>
      <div className="mb-4">
        <Link to="/reports" className="text-sm text-slate-500 hover:underline">→ العودة للتقارير</Link>
      </div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">ميزان المراجعة</h1>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">من تاريخ (اختياري)</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">حتى تاريخ</span>
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={onlyWithActivity} onChange={(e) => setOnlyWithActivity(e.target.checked)} />
          إخفاء الحسابات الخاملة
        </label>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل التقرير.</p>}
        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">الكود</th>
                  <th className="px-4 py-3 font-medium">الحساب</th>
                  <th className="px-4 py-3 font-medium">النوع</th>
                  <th className="px-4 py-3 font-medium">مدين</th>
                  <th className="px-4 py-3 font-medium">دائن</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-slate-600">{a.code}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{a.name_ar}</td>
                    <td className="px-4 py-3 text-slate-500">{typeLabels[a.account_type]}</td>
                    <td className="px-4 py-3">{Number(a.total_debit) > 0 ? a.total_debit : '—'}</td>
                    <td className="px-4 py-3">{Number(a.total_credit) > 0 ? a.total_credit : '—'}</td>
                  </tr>
                ))}
                {data.accounts.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">لا حسابات لعرضها</td></tr>
                )}
              </tbody>
            </table>
            <div className="flex justify-end gap-6 border-t border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">
              <span>إجمالي المدين: {data.totals.debit.toFixed(2)}</span>
              <span>إجمالي الدائن: {data.totals.credit.toFixed(2)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
