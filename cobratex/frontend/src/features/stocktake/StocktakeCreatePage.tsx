import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useWarehouses, useFiscalPeriods, useItems } from '@/features/catalog/api';
import { useCreateStocktake } from '@/features/stocktake/api';
import { extractErrorMessage } from '@/api/client';

interface PendingLine {
  itemId: string;
  itemLabel: string;
  countedQuantity: string;
}

export default function StocktakeCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: warehouses } = useWarehouses();
  const { data: fiscalPeriods } = useFiscalPeriods();
  const { data: items } = useItems();
  const createStocktake = useCreateStocktake();

  const [warehouseId, setWarehouseId] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pendingItemId, setPendingItemId] = useState('');
  const [pendingQty, setPendingQty] = useState('');
  const [lines, setLines] = useState<PendingLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const activeItems = items?.filter((i) => i.is_active) ?? [];
  const availableItems = activeItems.filter((i) => !lines.some((l) => l.itemId === i.id));

  function addLine() {
    setError(null);
    const item = activeItems.find((i) => i.id === pendingItemId);
    if (!item) { setError('اختر صنفًا'); return; }
    if (!pendingQty || Number(pendingQty) < 0) { setError('أدخل كمية معدودة صحيحة (صفر أو أكبر)'); return; }
    setLines((prev) => [...prev, { itemId: item.id, itemLabel: `${item.name_ar} (${item.code})`, countedQuantity: pendingQty }]);
    setPendingItemId('');
    setPendingQty('');
  }

  function removeLine(itemId: string) {
    setLines((prev) => prev.filter((l) => l.itemId !== itemId));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (lines.length === 0) {
      setError('أضِف صنفًا واحدًا على الأقل بكميته المعدودة');
      return;
    }
    try {
      const created = await createStocktake.mutateAsync({
        branchId, warehouseId, fiscalPeriodId, countDate,
        lines: lines.map((l) => ({ itemId: l.itemId, countedQuantity: l.countedQuantity })),
      });
      navigate(`/inventory/stocktakes/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">جرد مخزني جديد</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-3 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">المخزن</span>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
              <option value="">اختر مخزنًا</option>
              {warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name_ar}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الفترة المالية</span>
            <select value={fiscalPeriodId} onChange={(e) => setFiscalPeriodId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
              <option value="">اختر فترة</option>
              {fiscalPeriods?.map((p) => <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الجرد</span>
            <input type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">إضافة أصناف للعدّ</h2>
          <p className="mb-3 text-xs text-slate-500">
            الفرق عن الرصيد الدفتري (فائض/عجز) يُحسَب تلقائيًا من الباك إند فور الحفظ — أدخل هنا فقط الكمية التي عددتها فعليًا.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[220px] flex-1">
              <span className="mb-1 block text-sm font-medium text-slate-700">الصنف</span>
              <select value={pendingItemId} onChange={(e) => setPendingItemId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                <option value="">اختر صنفًا</option>
                {availableItems.map((i) => <option key={i.id} value={i.id}>{i.name_ar} ({i.code})</option>)}
              </select>
            </label>
            <label className="block w-40">
              <span className="mb-1 block text-sm font-medium text-slate-700">الكمية المعدودة</span>
              <input value={pendingQty} onChange={(e) => setPendingQty(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <button type="button" onClick={addLine} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              + إضافة
            </button>
          </div>

          {lines.length > 0 && (
            <table className="mt-4 w-full text-start text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 font-medium">الصنف</th>
                  <th className="py-2 font-medium">الكمية المعدودة</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.itemId} className="border-b border-slate-100 last:border-0">
                    <td className="py-2">{l.itemLabel}</td>
                    <td className="py-2">{l.countedQuantity}</td>
                    <td className="py-2 text-end">
                      <button type="button" onClick={() => removeLine(l.itemId)} className="text-sm text-red-600 hover:underline">حذف</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createStocktake.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createStocktake.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
        </button>
      </form>
    </div>
  );
}
