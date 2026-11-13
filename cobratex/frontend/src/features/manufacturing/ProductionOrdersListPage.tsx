import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProductionOrders } from '@/features/manufacturing/api';
import { useItems } from '@/features/catalog/api';
import PaginationControls from '@/components/PaginationControls';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مُنفَّذ', reversed: 'معكوس' };
const statusColors: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600', posted: 'bg-emerald-100 text-emerald-700', reversed: 'bg-amber-100 text-amber-700',
};

export default function ProductionOrdersListPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useProductionOrders(page);
  const { data: items } = useItems();
  const itemName = (id: string) => items?.find((i) => i.id === id)?.name_ar ?? '—';

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">أوامر التصنيع</h1>
        <Link to="/manufacturing/orders/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + أمر تصنيع جديد
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل أوامر التصنيع.</p>}
        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">رقم المستند</th>
                  <th className="px-4 py-3 font-medium">الصنف المُنتَج</th>
                  <th className="px-4 py-3 font-medium">الكمية</th>
                  <th className="px-4 py-3 font-medium">التاريخ</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((o) => (
                  <tr key={o.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{o.document_number}</td>
                    <td className="px-4 py-3 text-slate-600">{itemName(o.output_item_id)}</td>
                    <td className="px-4 py-3 text-slate-600">{o.planned_output_quantity}</td>
                    <td className="px-4 py-3 text-slate-600">{o.order_date}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[o.status]}`}>{statusLabels[o.status]}</span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Link to={`/manufacturing/orders/${o.id}`} className="text-sm font-medium text-slate-700 hover:underline">عرض</Link>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">لا توجد أوامر تصنيع بعد</td></tr>}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
