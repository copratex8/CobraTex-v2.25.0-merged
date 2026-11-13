import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useWarehouses, useFiscalPeriods, useActivities } from '@/features/catalog/api';
import { useBoms, useCreateProductionOrder } from '@/features/manufacturing/api';
import { extractErrorMessage } from '@/api/client';

export default function ProductionOrderCreatePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: boms } = useBoms();
  const { data: warehouses } = useWarehouses();
  const { data: fiscalPeriods } = useFiscalPeriods();
  const { data: activities } = useActivities();
  const createOrder = useCreateProductionOrder();

  const [bomId, setBomId] = useState(searchParams.get('bomId') ?? '');
  const [warehouseId, setWarehouseId] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [plannedOutputQuantity, setPlannedOutputQuantity] = useState('');
  const [activityId, setActivityId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await createOrder.mutateAsync({
        branchId, warehouseId, bomId, fiscalPeriodId, orderDate, plannedOutputQuantity, activityId: activityId || undefined,
      });
      navigate(`/manufacturing/orders/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">أمر تصنيع جديد</h1>

      <form onSubmit={handleSubmit} className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <Select label="قائمة المواد (BOM)" value={bomId} onChange={setBomId} required>
          <option value="">اختر قائمة مواد</option>
          {boms?.map((b) => <option key={b.id} value={b.id}>{b.name_ar} ({b.code})</option>)}
        </Select>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">الكمية المطلوب إنتاجها</span>
          <input value={plannedOutputQuantity} onChange={(e) => setPlannedOutputQuantity(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>
        <Select label="المخزن" value={warehouseId} onChange={setWarehouseId} required>
          <option value="">اختر مخزنًا</option>
          {warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name_ar}</option>)}
        </Select>
        <Select label="الفترة المالية" value={fiscalPeriodId} onChange={setFiscalPeriodId} required>
          <option value="">اختر فترة</option>
          {fiscalPeriods?.map((p) => <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>)}
        </Select>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الأمر</span>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>
        <Select label="النشاط (اختياري)" value={activityId} onChange={setActivityId}>
          <option value="">بلا تصنيف</option>
          {activities?.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name_ar}</option>)}
        </Select>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createOrder.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createOrder.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
        </button>
      </form>
    </div>
  );
}

function Select({
  label, value, onChange, required, children,
}: { label: string; value: string; onChange: (v: string) => void; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required={required}>
        {children}
      </select>
    </label>
  );
}
