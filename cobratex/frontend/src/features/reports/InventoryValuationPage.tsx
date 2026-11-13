import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInventoryValuation } from '@/features/reports/api';
import { useWarehouses } from '@/features/catalog/api';

export default function InventoryValuationPage() {
  const [warehouseId, setWarehouseId] = useState('');
  const [onlyWithStock, setOnlyWithStock] = useState(true);
  const { data: warehouses } = useWarehouses();
  const { data, isLoading, isError } = useInventoryValuation(warehouseId || undefined, onlyWithStock);

  return (
    <div>
      <div className="mb-4">
        <Link to="/reports" className="text-sm text-slate-500 hover:underline">→ العودة للتقارير</Link>
      </div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">تقييم المخزون</h1>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">المخزن</span>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
            <option value="">كل المخازن</option>
            {warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name_ar}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={onlyWithStock} onChange={(e) => setOnlyWithStock(e.target.checked)} />
          إخفاء الأصناف بلا رصيد
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
                  <th className="px-4 py-3 font-medium">الصنف</th>
                  <th className="px-4 py-3 font-medium">المخزن</th>
                  <th className="px-4 py-3 font-medium">الكمية المتاحة</th>
                  <th className="px-4 py-3 font-medium">متوسط التكلفة</th>
                  <th className="px-4 py-3 font-medium">القيمة</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={`${l.warehouse_id}-${l.item_id}-${l.batch_id ?? ''}`} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-900">{l.item_name_ar} ({l.item_code})</td>
                    <td className="px-4 py-3 text-slate-600">{l.warehouse_name_ar}</td>
                    <td className="px-4 py-3">{l.quantity_on_hand}</td>
                    <td className="px-4 py-3">{l.weighted_average_cost}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{l.stock_value}</td>
                  </tr>
                ))}
                {data.lines.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">لا بيانات لعرضها</td></tr>
                )}
              </tbody>
            </table>
            <div className="border-t border-slate-200 px-4 py-3 text-end text-sm font-semibold text-slate-900">
              إجمالي قيمة المخزون: {data.totalValue}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
