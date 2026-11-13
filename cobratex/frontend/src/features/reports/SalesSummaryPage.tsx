import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSalesSummary } from '@/features/reports/api';

const groupLabels: Record<string, string> = { item: 'الصنف', customer: 'العميل', day: 'اليوم' };

function firstDayOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export default function SalesSummaryPage() {
  const [fromDate, setFromDate] = useState(firstDayOfMonth);
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState<'item' | 'customer' | 'day'>('item');
  const { data, isLoading, isError } = useSalesSummary(fromDate, toDate, groupBy);

  function rowLabel(l: { item_name_ar?: string; item_code?: string; customer_name_ar?: string; day?: string }) {
    if (groupBy === 'item') return `${l.item_name_ar} (${l.item_code})`;
    if (groupBy === 'customer') return l.customer_name_ar;
    return l.day;
  }

  return (
    <div>
      <div className="mb-4">
        <Link to="/reports" className="text-sm text-slate-500 hover:underline">→ العودة للتقارير</Link>
      </div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">ملخَّص المبيعات</h1>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">من تاريخ</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">إلى تاريخ</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">تجميع حسب</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="item">الصنف</option>
            <option value="customer">العميل</option>
            <option value="day">اليوم</option>
          </select>
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
                  <th className="px-4 py-3 font-medium">{groupLabels[groupBy]}</th>
                  <th className="px-4 py-3 font-medium">عدد الفواتير</th>
                  {groupBy !== 'customer' && groupBy !== 'day' && <th className="px-4 py-3 font-medium">الكمية</th>}
                  <th className="px-4 py-3 font-medium">إجمالي المبيعات</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{rowLabel(l)}</td>
                    <td className="px-4 py-3">{l.invoice_count}</td>
                    {groupBy !== 'customer' && groupBy !== 'day' && <td className="px-4 py-3">{l.total_quantity}</td>}
                    <td className="px-4 py-3 font-medium text-slate-900">{l.total_sales}</td>
                  </tr>
                ))}
                {data.lines.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">لا مبيعات في هذه الفترة</td></tr>
                )}
              </tbody>
            </table>
            <div className="border-t border-slate-200 px-4 py-3 text-end text-sm font-semibold text-slate-900">
              الإجمالي الكلي: {data.grandTotal}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
