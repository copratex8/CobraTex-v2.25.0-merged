import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSalesInvoices } from '@/features/salesInvoices/api';
import PaginationControls from '@/components/PaginationControls';

const statusLabels: Record<string, string> = {
  draft: 'مسودة', posted: 'مرحَّلة', cancelled: 'ملغاة', reversed: 'معكوسة',
};
const statusColors: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  posted: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
  reversed: 'bg-amber-100 text-amber-700',
};

export default function SalesInvoicesListPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useSalesInvoices(page);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">فواتير البيع</h1>
        <Link to="/sales/invoices/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + فاتورة جديدة
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة الفواتير.</p>}

        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">رقم المستند</th>
                  <th className="px-4 py-3 font-medium">التاريخ</th>
                  <th className="px-4 py-3 font-medium">العملة</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{invoice.document_number}</td>
                    <td className="px-4 py-3 text-slate-600">{invoice.invoice_date}</td>
                    <td className="px-4 py-3 text-slate-600">{invoice.currency_code}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[invoice.status]}`}>
                        {statusLabels[invoice.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link to={`/sales/invoices/${invoice.id}`} className="text-sm font-medium text-slate-700 hover:underline">
                        عرض
                      </Link>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">لا توجد فواتير بعد</td>
                  </tr>
                )}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
