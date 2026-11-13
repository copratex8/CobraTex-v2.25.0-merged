import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useChecks } from '@/features/treasury/api';
import PaginationControls from '@/components/PaginationControls';

const statusLabels: Record<string, string> = { pending: 'قيد الانتظار', deposited: 'تحت التحصيل', cleared: 'محصَّل', bounced: 'مرتد', cancelled: 'ملغى' };
const statusColors: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600', deposited: 'bg-sky-100 text-sky-700',
  cleared: 'bg-emerald-100 text-emerald-700', bounced: 'bg-red-100 text-red-700', cancelled: 'bg-amber-100 text-amber-700',
};
const typeLabels: Record<string, string> = { incoming: 'وارد', outgoing: 'صادر' };

export default function ChecksListPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useChecks(page);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">الشيكات</h1>
        <Link to="/treasury/checks/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + تسجيل شيك
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة الشيكات.</p>}
        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">رقم الشيك</th>
                  <th className="px-4 py-3 font-medium">النوع</th>
                  <th className="px-4 py-3 font-medium">تاريخ الاستحقاق</th>
                  <th className="px-4 py-3 font-medium">المبلغ</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{c.check_number}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.check_type === 'incoming' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'}`}>
                        {typeLabels[c.check_type]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{c.due_date}</td>
                    <td className="px-4 py-3 text-slate-600">{c.amount} {c.currency_code}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[c.status]}`}>{statusLabels[c.status]}</span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link to={`/treasury/checks/${c.id}`} className="text-sm font-medium text-slate-700 hover:underline">عرض</Link>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">لا توجد شيكات مسجَّلة بعد</td></tr>}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
