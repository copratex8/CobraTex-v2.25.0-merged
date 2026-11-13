import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTreasuryTransfer, usePostTreasuryTransfer, useReverseTreasuryTransfer } from '@/features/treasury/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّل', cancelled: 'ملغى', reversed: 'معكوس' };

export default function TreasuryTransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: transfer, isLoading, isError } = useTreasuryTransfer(id ?? null);
  const postTransfer = usePostTreasuryTransfer();
  const reverseTransfer = useReverseTreasuryTransfer();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function handlePost() {
    if (!id) return;
    setError(null);
    try { await postTransfer.mutateAsync(id); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleReverse() {
    if (!id) return;
    if (!reason.trim()) { setError('السبب إلزامي'); return; }
    setError(null);
    try { await reverseTransfer.mutateAsync({ id, reason }); setReason(''); } catch (err) { setError(extractErrorMessage(err)); }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !transfer) return <p className="text-sm text-red-600">تعذَّر تحميل التحويل.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/treasury/transfers" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة التحويلات</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">تحويل {transfer.document_number}</h1>
          <p className="text-sm text-slate-500">{transfer.transfer_date} — {statusLabels[transfer.status]}</p>
        </div>
        {transfer.status === 'draft' && (
          <button onClick={handlePost} disabled={postTransfer.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postTransfer.isPending ? 'جارٍ الترحيل...' : 'ترحيل التحويل'}
          </button>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:grid-cols-3">
        <Field label="المبلغ" value={`${transfer.amount} ${transfer.currency_code}`} />
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {transfer.status === 'posted' && (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">عكس التحويل</h2>
          <div className="flex gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button onClick={handleReverse} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">عكس</button>
          </div>
        </div>
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
