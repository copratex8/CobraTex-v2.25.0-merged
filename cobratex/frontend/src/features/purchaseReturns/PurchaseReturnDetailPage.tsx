import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { usePurchaseReturn, usePostPurchaseReturn, useReversePurchaseReturn } from '@/features/purchaseReturns/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّلة', cancelled: 'ملغاة', reversed: 'معكوسة' };

export default function PurchaseReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: ret, isLoading, isError } = usePurchaseReturn(id ?? null);
  const postReturn = usePostPurchaseReturn();
  const reverseReturn = useReversePurchaseReturn();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function handlePost() {
    if (!id) return;
    setError(null);
    try { await postReturn.mutateAsync(id); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleReverse() {
    if (!id) return;
    if (!reason.trim()) { setError('السبب إلزامي'); return; }
    setError(null);
    try { await reverseReturn.mutateAsync({ id, reason }); setReason(''); } catch (err) { setError(extractErrorMessage(err)); }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !ret) return <p className="text-sm text-red-600">تعذَّر تحميل المرتجع.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/purchasing/returns" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة المرتجعات</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">مرتجع {ret.document_number}</h1>
          <p className="text-sm text-slate-500">{ret.return_date} — {statusLabels[ret.status]}</p>
        </div>
        {ret.status === 'draft' && (
          <button onClick={handlePost} disabled={postReturn.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postReturn.isPending ? 'جارٍ الترحيل...' : 'ترحيل المرتجع'}
          </button>
        )}
      </div>

      <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">الكمية</th>
              <th className="px-4 py-3 font-medium">الصافي</th>
              <th className="px-4 py-3 font-medium">الضريبة</th>
              <th className="px-4 py-3 font-medium">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {ret.lines?.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">{line.quantity}</td>
                <td className="px-4 py-3">{line.subtotal}</td>
                <td className="px-4 py-3">{line.tax_amount}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{line.line_total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {ret.status === 'posted' && (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">عكس المرتجع</h2>
          <div className="flex gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button onClick={handleReverse} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">عكس</button>
          </div>
        </div>
      )}
    </div>
  );
}
