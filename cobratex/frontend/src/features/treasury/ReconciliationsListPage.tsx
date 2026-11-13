import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useReconciliations } from '@/features/treasury/reconciliationApi';
import { useSafes } from '@/features/catalog/api';
import PaginationControls from '@/components/PaginationControls';

const statusLabels: Record<string, string> = { in_progress: 'قيد التنفيذ', completed: 'مكتملة' };
const statusColors: Record<string, string> = { in_progress: 'bg-amber-100 text-amber-700', completed: 'bg-emerald-100 text-emerald-700' };

export default function ReconciliationsListPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useReconciliations(page);
  const { data: safes } = useSafes();

  const bankLabel = (id: string) => safes?.find((s) => s.id === id)?.name_ar ?? '—';

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">التسوية البنكية</h1>
        <Link to="/treasury/reconciliations/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + تسوية جديدة
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة التسويات.</p>}
        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">البنك</th>
                  <th className="px-4 py-3 font-medium">تاريخ الكشف</th>
                  <th className="px-4 py-3 font-medium">رصيد الكشف</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{bankLabel(r.safe_or_bank_id)}</td>
                    <td className="px-4 py-3 text-slate-600">{r.statement_date}</td>
                    <td className="px-4 py-3 text-slate-600">{r.statement_ending_balance}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[r.status]}`}>{statusLabels[r.status]}</span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link to={`/treasury/reconciliations/${r.id}`} className="text-sm font-medium text-slate-700 hover:underline">عرض</Link>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">لا توجد تسويات بعد</td></tr>}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
