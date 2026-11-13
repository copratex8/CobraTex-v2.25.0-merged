import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useItems, useActivities } from '@/features/catalog/api';
import { useCreateBom } from '@/features/manufacturing/api';
import { extractErrorMessage } from '@/api/client';

const costTypeLabels = { labor: 'عمالة', overhead: 'مصاريف تشغيل', other: 'أخرى' } as const;
type CostType = keyof typeof costTypeLabels;

interface PendingOperation {
  name: string;
  costType: CostType;
  costAmount: string;
}

interface PendingLine {
  componentItemId: string;
  label: string;
  quantity: string;
  wastePercent: string;
}

export default function BomCreatePage() {
  const navigate = useNavigate();
  const { data: items } = useItems();
  const { data: activities } = useActivities();
  const createBom = useCreateBom();

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [outputItemId, setOutputItemId] = useState('');
  const [outputQuantity, setOutputQuantity] = useState('1');
  const [activityId, setActivityId] = useState('');

  const [pendingItemId, setPendingItemId] = useState('');
  const [pendingQty, setPendingQty] = useState('');
  const [pendingWaste, setPendingWaste] = useState('0');
  const [lines, setLines] = useState<PendingLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [opName, setOpName] = useState('');
  const [opType, setOpType] = useState<CostType>('labor');
  const [opCost, setOpCost] = useState('');
  const [operations, setOperations] = useState<PendingOperation[]>([]);

  const activeItems = items?.filter((i) => i.is_active) ?? [];
  const componentChoices = activeItems.filter((i) => i.id !== outputItemId && !lines.some((l) => l.componentItemId === i.id));

  function addLine() {
    setError(null);
    const item = activeItems.find((i) => i.id === pendingItemId);
    if (!item) { setError('اختر صنفًا مكوِّنًا'); return; }
    if (!pendingQty || Number(pendingQty) <= 0) { setError('أدخل كمية صحيحة أكبر من صفر'); return; }
    const waste = pendingWaste === '' ? '0' : pendingWaste;
    if (Number(waste) < 0 || Number(waste) >= 100) { setError('نسبة الهالك يجب أن تكون بين 0 و99.99'); return; }
    setLines((prev) => [...prev, { componentItemId: item.id, label: `${item.name_ar} (${item.code})`, quantity: pendingQty, wastePercent: waste }]);
    setPendingItemId(''); setPendingQty(''); setPendingWaste('0');
  }

  function addOperation() {
    setError(null);
    if (!opName.trim()) { setError('أدخل اسم المرحلة'); return; }
    if (opCost === '' || Number(opCost) < 0) { setError('أدخل تكلفة صحيحة (صفر أو أكبر)'); return; }
    setOperations((prev) => [...prev, { name: opName.trim(), costType: opType, costAmount: opCost }]);
    setOpName(''); setOpCost('');
  }

  function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.componentItemId !== id));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (lines.length === 0) { setError('أضِف مكوّنًا واحدًا على الأقل'); return; }
    try {
      const created = await createBom.mutateAsync({
        code, nameAr, nameEn, outputItemId, outputQuantity, activityId: activityId || undefined,
        lines: lines.map((l) => ({ componentItemId: l.componentItemId, quantity: l.quantity, wastePercent: l.wastePercent })),
        operations: operations.length > 0 ? operations : undefined,
      });
      navigate(`/manufacturing/boms/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">قائمة مواد جديدة</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 md:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الكود</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الاسم بالعربية</span>
            <input value={nameAr} onChange={(e) => setNameAr(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الاسم بالإنجليزية</span>
            <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الصنف المُنتَج</span>
            <select value={outputItemId} onChange={(e) => setOutputItemId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
              <option value="">اختر صنفًا</option>
              {activeItems.map((i) => <option key={i.id} value={i.id}>{i.name_ar} ({i.code})</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">كمية الوصفة (كم وحدة تُنتِجها هذه المكوّنات)</span>
            <input value={outputQuantity} onChange={(e) => setOutputQuantity(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">النشاط (اختياري)</span>
            <select value={activityId} onChange={(e) => setActivityId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="">بلا تصنيف</option>
              {activities?.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.name_ar}</option>)}
            </select>
          </label>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">المكوّنات</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[220px] flex-1">
              <span className="mb-1 block text-sm font-medium text-slate-700">المكوِّن</span>
              <select value={pendingItemId} onChange={(e) => setPendingItemId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                <option value="">اختر صنفًا</option>
                {componentChoices.map((i) => <option key={i.id} value={i.id}>{i.name_ar} ({i.code})</option>)}
              </select>
            </label>
            <label className="block w-40">
              <span className="mb-1 block text-sm font-medium text-slate-700">الكمية اللازمة (نظريًا)</span>
              <input value={pendingQty} onChange={(e) => setPendingQty(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block w-32">
              <span className="mb-1 block text-sm font-medium text-slate-700">هالك %</span>
              <input value={pendingWaste} onChange={(e) => setPendingWaste(e.target.value)} placeholder="0" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <button type="button" onClick={addLine} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              + إضافة
            </button>
          </div>

          {lines.length > 0 && (
            <table className="mt-4 w-full text-start text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 font-medium">المكوِّن</th>
                  <th className="py-2 font-medium">الكمية</th>
                  <th className="py-2 font-medium">هالك %</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.componentItemId} className="border-b border-slate-100 last:border-0">
                    <td className="py-2">{l.label}</td>
                    <td className="py-2">{l.quantity}</td>
                    <td className="py-2 text-slate-500">{Number(l.wastePercent) > 0 ? `${l.wastePercent}%` : '—'}</td>
                    <td className="py-2 text-end">
                      <button type="button" onClick={() => removeLine(l.componentItemId)} className="text-sm text-red-600 hover:underline">حذف</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">مراحل التصنيع وتكلفة التحويل (اختياري)</h2>
          <p className="mb-3 text-xs text-slate-500">
            كل مرحلة (مثل غزل، نسيج، تشطيب) بتكلفة عمالة أو مصاريف تشغيل لإنتاج كمية الوصفة كاملة. تدخل في تكلفة الصنف المُنتَج، وتُضرَب في نسبة الكمية عند إنشاء أمر التصنيع.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[200px] flex-1">
              <span className="mb-1 block text-sm font-medium text-slate-700">اسم المرحلة</span>
              <input value={opName} onChange={(e) => setOpName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block w-40">
              <span className="mb-1 block text-sm font-medium text-slate-700">النوع</span>
              <select value={opType} onChange={(e) => setOpType(e.target.value as CostType)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                {Object.entries(costTypeLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="block w-36">
              <span className="mb-1 block text-sm font-medium text-slate-700">التكلفة</span>
              <input value={opCost} onChange={(e) => setOpCost(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <button type="button" onClick={addOperation} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              + إضافة مرحلة
            </button>
          </div>
          {operations.length > 0 && (
            <table className="mt-4 w-full text-start text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">المرحلة</th>
                  <th className="py-2 font-medium">النوع</th>
                  <th className="py-2 font-medium">التكلفة</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {operations.map((o, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 text-slate-400">{i + 1}</td>
                    <td className="py-2">{o.name}</td>
                    <td className="py-2 text-slate-600">{costTypeLabels[o.costType]}</td>
                    <td className="py-2">{o.costAmount}</td>
                    <td className="py-2 text-end">
                      <button type="button" onClick={() => setOperations((prev) => prev.filter((_, idx) => idx !== i))} className="text-sm text-red-600 hover:underline">حذف</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createBom.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createBom.isPending ? 'جارٍ الحفظ...' : 'حفظ قائمة المواد'}
        </button>
      </form>
    </div>
  );
}
