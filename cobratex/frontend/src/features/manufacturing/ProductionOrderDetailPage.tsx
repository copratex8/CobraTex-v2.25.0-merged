import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useProductionOrder, usePostProductionOrder, useReverseProductionOrder, useUpdateOperationCosts } from '@/features/manufacturing/api';
import { useItems } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مُنفَّذ', reversed: 'معكوس' };
const costTypeLabels: Record<string, string> = { labor: 'عمالة', overhead: 'مصاريف تشغيل', other: 'أخرى' };

export default function ProductionOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: order, isLoading, isError } = useProductionOrder(id ?? null);
  const { data: items } = useItems();
  const postOrder = usePostProductionOrder();
  const reverseOrder = useReverseProductionOrder();
  const updateCosts = useUpdateOperationCosts();
  const [actuals, setActuals] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const itemName = (itemId: string) => items?.find((i) => i.id === itemId)?.name_ar ?? itemId;

  async function handlePost() {
    if (!id) return;
    setError(null);
    try { await postOrder.mutateAsync(id); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleSaveCosts() {
    if (!id) return;
    setError(null);
    const operations = Object.entries(actuals).filter(([, v]) => v !== '').map(([operationId, actualCost]) => ({ operationId, actualCost }));
    if (operations.length === 0) return;
    try { await updateCosts.mutateAsync({ id, operations }); setActuals({}); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleReverse() {
    if (!id) return;
    if (!reason.trim()) { setError('السبب إلزامي'); return; }
    setError(null);
    try { await reverseOrder.mutateAsync({ id, reason }); setReason(''); } catch (err) { setError(extractErrorMessage(err)); }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !order) return <p className="text-sm text-red-600">تعذَّر تحميل أمر التصنيع.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/manufacturing/orders" className="text-sm text-slate-500 hover:underline">→ العودة لأوامر التصنيع</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">أمر تصنيع {order.document_number}</h1>
          <p className="text-sm text-slate-500">{order.order_date} — {statusLabels[order.status]}</p>
        </div>
        <Link to={`/textile/orders/${order.id}`} className="rounded-lg border border-amber-500 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-50">الإنتاج الفعلي والهالك (غزل ونسيج)</Link>
        {order.status === 'draft' && (
          <button onClick={handlePost} disabled={postOrder.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postOrder.isPending ? 'جارٍ التنفيذ...' : 'تنفيذ الأمر'}
          </button>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:grid-cols-4">
        <Field label="الصنف المُنتَج" value={itemName(order.output_item_id)} />
        <Field label="الكمية المخطَّطة" value={order.planned_output_quantity} />
        {order.materials_cost && <Field label="تكلفة المواد" value={`${order.materials_cost} ${order.currency_code}`} />}
        {order.conversion_cost && Number(order.conversion_cost) > 0 && <Field label="تكلفة التحويل (عمالة/تشغيل)" value={`${order.conversion_cost} ${order.currency_code}`} />}
        {order.total_cost && <Field label="إجمالي التكلفة" value={`${order.total_cost} ${order.currency_code}`} />}
        {order.actual_output_quantity && <Field label="الكمية المُنتَجة فعليًا" value={order.actual_output_quantity} />}
      </div>

      <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">المكوِّن</th>
              <th className="px-4 py-2 font-medium">الكمية المخطَّطة (شاملة الهالك)</th>
              <th className="px-4 py-2 font-medium">هالك %</th>
              <th className="px-4 py-2 font-medium">المستهلَك فعليًا</th>
              <th className="px-4 py-2 font-medium">تكلفة الوحدة</th>
              <th className="px-4 py-2 font-medium">تكلفة السطر</th>
            </tr>
          </thead>
          <tbody>
            {order.lines?.map((l) => (
              <tr key={l.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">{itemName(l.component_item_id)}</td>
                <td className="px-4 py-3 text-slate-600">{l.planned_quantity}</td>
                <td className="px-4 py-3 text-slate-500">{Number(l.waste_percent) > 0 ? `${l.waste_percent}%` : '—'}</td>
                <td className="px-4 py-3 text-slate-600">{l.consumed_quantity ?? '—'}</td>
                <td className="px-4 py-3 text-slate-600">{l.unit_cost ?? '—'}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{l.line_cost ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {order.operations && order.operations.length > 0 && (
        <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-900">مراحل التصنيع وتكلفة التحويل</h2>
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">المرحلة</th>
                <th className="px-4 py-2 font-medium">النوع</th>
                <th className="px-4 py-2 font-medium">المخطَّطة</th>
                <th className="px-4 py-2 font-medium">الفعلية</th>
              </tr>
            </thead>
            <tbody>
              {order.operations.map((o, i) => (
                <tr key={o.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                  <td className="px-4 py-3">{o.name}</td>
                  <td className="px-4 py-3 text-slate-600">{costTypeLabels[o.cost_type]}</td>
                  <td className="px-4 py-3 text-slate-600">{o.planned_cost}</td>
                  <td className="px-4 py-3">
                    {order.status === 'draft' ? (
                      <input
                        value={actuals[o.id] ?? (o.actual_cost ?? '')}
                        onChange={(e) => setActuals((prev) => ({ ...prev, [o.id]: e.target.value }))}
                        placeholder={o.planned_cost}
                        className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      />
                    ) : (
                      <span className="text-slate-600">{o.actual_cost ?? '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {order.status === 'draft' && (
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
              <p className="text-xs text-slate-500">اترك الحقل فارغًا لاعتماد التكلفة المخطَّطة عند التنفيذ.</p>
              <button onClick={handleSaveCosts} disabled={updateCosts.isPending || Object.keys(actuals).length === 0} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {updateCosts.isPending ? 'جارٍ الحفظ...' : 'حفظ التكاليف الفعلية'}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {order.status === 'posted' && (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">عكس الأمر</h2>
          <div className="flex gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button onClick={handleReverse} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">عكس</button>
          </div>
        </div>
      )}

      {order.status === 'reversed' && order.cancelled_reason && (
        <p className="text-sm text-slate-500">سبب العكس: {order.cancelled_reason}</p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-medium text-slate-900">{value}</p>
    </div>
  );
}
