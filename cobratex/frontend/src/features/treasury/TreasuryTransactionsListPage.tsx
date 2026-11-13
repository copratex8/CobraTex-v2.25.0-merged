import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTreasuryTransactions } from '@/features/treasury/api';
import PaginationControls from '@/components/PaginationControls';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّل', cancelled: 'ملغى', reversed: 'معكوس' };
const statusColors: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600', posted: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700', reversed: 'bg-amber-100 text-amber-700',
};
const typeLabels: Record<string, string> = { receipt: 'قبض', payment: 'صرف' };

export default function TreasuryTransactionsListPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useTreasuryTransactions(page);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">سندات القبض والصرف</h1>
        <Link to="/treasury/transactions/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + سند جديد
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة السندات.</p>}
        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">رقم المستند</th>
                  <th className="px-4 py-3 font-medium">النوع</th>
                  <th className="px-4 py-3 font-medium">التاريخ</th>
                  <th className="px-4 py-3 font-medium">المبلغ</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((t) => (
                  <tr key={t.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{t.document_number}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.transaction_type === 'receipt' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'}`}>
                        {typeLabels[t.transaction_type]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{t.transaction_date}</td>
                    <td className="px-4 py-3 text-slate-600">{t.amount} {t.currency_code}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[t.status]}`}>{statusLabels[t.status]}</span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link to={`/treasury/transactions/${t.id}`} className="text-sm font-medium text-slate-700 hover:underline">عرض</Link>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">لا توجد سندات بعد</td></tr>}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
