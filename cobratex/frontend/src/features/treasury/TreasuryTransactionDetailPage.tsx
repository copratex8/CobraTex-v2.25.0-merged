import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTreasuryTransaction, usePostTreasuryTransaction, useReverseTreasuryTransaction } from '@/features/treasury/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّل', cancelled: 'ملغى', reversed: 'معكوس' };
const typeLabels: Record<string, string> = { receipt: 'سند قبض', payment: 'سند صرف' };
const counterpartyLabels: Record<string, string> = { customer: 'عميل', supplier: 'مورد', other: 'طرف آخر' };

export default function TreasuryTransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: tx, isLoading, isError } = useTreasuryTransaction(id ?? null);
  const postTransaction = usePostTreasuryTransaction();
  const reverseTransaction = useReverseTreasuryTransaction();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function handlePost() {
    if (!id) return;
    setError(null);
    try { await postTransaction.mutateAsync(id); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleReverse() {
    if (!id) return;
    if (!reason.trim()) { setError('السبب إلزامي'); return; }
    setError(null);
    try { await reverseTransaction.mutateAsync({ id, reason }); setReason(''); } catch (err) { setError(extractErrorMessage(err)); }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !tx) return <p className="text-sm text-red-600">تعذَّر تحميل السند.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/treasury/transactions" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة السندات</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{typeLabels[tx.transaction_type]} {tx.document_number}</h1>
          <p className="text-sm text-slate-500">{tx.transaction_date} — {statusLabels[tx.status]}</p>
        </div>
        {tx.status === 'draft' && (
          <button onClick={handlePost} disabled={postTransaction.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postTransaction.isPending ? 'جارٍ الترحيل...' : 'ترحيل السند'}
          </button>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:grid-cols-3">
        <Field label="المبلغ" value={`${tx.amount} ${tx.currency_code}`} />
        <Field label="الطرف المقابل" value={counterpartyLabels[tx.counterparty_type]} />
        {tx.description && <Field label="الوصف" value={tx.description} />}
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {tx.status === 'posted' && (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">عكس السند</h2>
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
