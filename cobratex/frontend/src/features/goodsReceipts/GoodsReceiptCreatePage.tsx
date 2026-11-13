import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useSuppliers } from '@/features/suppliers/api';
import { useItems, useWarehouses } from '@/features/catalog/api';
import { useCreateGoodsReceipt, type GoodsReceiptLineInput } from '@/features/goodsReceipts/api';
import { extractErrorMessage } from '@/api/client';

interface LineRow extends GoodsReceiptLineInput {
  key: number;
}
let nextKey = 1;
function emptyLine(): LineRow {
  return { key: nextKey++, itemId: '', uomId: '', quantity: '1', unitCost: '0' };
}

export default function GoodsReceiptCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: suppliersPage } = useSuppliers(1, 100);
  const { data: items } = useItems();
  const { data: warehouses } = useWarehouses();
  const createReceipt = useCreateGoodsReceipt();

  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  function updateLine(key: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function onItemChange(key: number, itemId: string) {
    const item = items?.find((i) => i.id === itemId);
    updateLine(key, { itemId, uomId: item?.base_uom_id ?? '' });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const receipt = await createReceipt.mutateAsync({
        branchId, warehouseId, supplierId, receiptDate,
        lines: lines.map(({ key: _key, ...rest }) => rest),
      });
      navigate(`/purchasing/receipts/${receipt.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">استلام مخزون جديد</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-3 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <Select label="المورد" value={supplierId} onChange={setSupplierId} required>
            <option value="">اختر موردًا</option>
            {suppliersPage?.data.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
          </Select>
          <Select label="المخزن" value={warehouseId} onChange={setWarehouseId} required>
            <option value="">اختر مخزنًا</option>
            {warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name_ar}</option>)}
          </Select>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الاستلام</span>
            <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">الصنف</th>
                <th className="px-3 py-2 font-medium">الكمية</th>
                <th className="px-3 py-2 font-medium">تكلفة الوحدة</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2">
                    <select value={line.itemId} onChange={(e) => onItemChange(line.key, e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" required>
                      <option value="">اختر صنفًا</option>
                      {items?.filter((i) => i.is_active).map((i) => <option key={i.id} value={i.id}>{i.name_ar} ({i.code})</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input value={line.quantity} onChange={(e) => updateLine(line.key, { quantity: e.target.value })} className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" required />
                  </td>
                  <td className="px-3 py-2">
                    <input value={line.unitCost} onChange={(e) => updateLine(line.key, { unitCost: e.target.value })} className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" required />
                  </td>
                  <td className="px-3 py-2">
                    {lines.length > 1 && (
                      <button type="button" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))} className="text-red-500 hover:text-red-700">حذف</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-slate-200 px-4 py-3">
            <button type="button" onClick={() => setLines((prev) => [...prev, emptyLine()])} className="text-sm font-medium text-slate-700 hover:underline">+ إضافة سطر</button>
          </div>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createReceipt.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createReceipt.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
        </button>
      </form>
    </div>
  );
}

function Select({ label, value, onChange, required, children }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required={required}>
        {children}
      </select>
    </label>
  );
}
