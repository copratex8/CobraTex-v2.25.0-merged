import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useStocktake, usePostStocktake, useReverseStocktake } from '@/features/stocktake/api';
import { useItems } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّل', reversed: 'معكوس' };

export default function StocktakeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: st, isLoading, isError } = useStocktake(id ?? null);
  const { data: items } = useItems();
  const postStocktake = usePostStocktake();
  const reverseStocktake = useReverseStocktake();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const itemLabel = (itemId: string) => items?.find((i) => i.id === itemId)?.name_ar ?? itemId;

  async function handlePost() {
    if (!id) return;
    setError(null);
    try { await postStocktake.mutateAsync(id); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleReverse() {
    if (!id) return;
    if (!reason.trim()) { setError('السبب إلزامي'); return; }
    setError(null);
    try { await reverseStocktake.mutateAsync({ id, reason }); setReason(''); } catch (err) { setError(extractErrorMessage(err)); }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !st) return <p className="text-sm text-red-600">تعذَّر تحميل مستند الجرد.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/inventory/stocktakes" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة الجرد</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">جرد {st.document_number}</h1>
          <p className="text-sm text-slate-500">{st.count_date} — {statusLabels[st.status]}</p>
        </div>
        {st.status === 'draft' && (
          <button onClick={handlePost} disabled={postStocktake.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postStocktake.isPending ? 'جارٍ الترحيل...' : 'ترحيل الجرد'}
          </button>
        )}
      </div>

      <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">الصنف</th>
              <th className="px-4 py-2 font-medium">الرصيد الدفتري</th>
              <th className="px-4 py-2 font-medium">المعدود فعليًا</th>
              <th className="px-4 py-2 font-medium">الفرق</th>
              <th className="px-4 py-2 font-medium">قيمة الفرق</th>
            </tr>
          </thead>
          <tbody>
            {st.lines?.map((line) => {
              const variance = Number(line.variance_quantity);
              return (
                <tr key={line.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">{itemLabel(line.item_id)}</td>
                  <td className="px-4 py-3 text-slate-600">{line.system_quantity}</td>
                  <td className="px-4 py-3 text-slate-600">{line.counted_quantity}</td>
                  <td className={`px-4 py-3 font-medium ${variance > 0 ? 'text-emerald-700' : variance < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                    {variance > 0 ? '+' : ''}{line.variance_quantity}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{line.variance_value}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {st.status === 'posted' && (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">عكس الجرد</h2>
          <div className="flex gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button onClick={handleReverse} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">عكس</button>
          </div>
        </div>
      )}

      {st.status === 'reversed' && st.cancelled_reason && (
        <p className="text-sm text-slate-500">سبب العكس: {st.cancelled_reason}</p>
      )}
    </div>
  );
}
