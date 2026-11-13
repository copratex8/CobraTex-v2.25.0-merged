import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useReconciliation, useAutoMatch, useMatchLine, useUnmatchLine, useCompleteReconciliation,
} from '@/features/treasury/reconciliationApi';
import { useSafes } from '@/features/catalog/api';
import type { BankStatementLine } from '@/api/types';
import { extractErrorMessage } from '@/api/client';

export default function ReconciliationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: recon, isLoading, isError } = useReconciliation(id ?? null);
  const { data: safes } = useSafes();
  const autoMatch = useAutoMatch();
  const matchLine = useMatchLine();
  const unmatchLine = useUnmatchLine();
  const complete = useCompleteReconciliation();

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !recon || !id) return <p className="text-sm text-red-600">تعذَّر تحميل التسوية.</p>;
  const reconciliationId = id;

  const bank = safes?.find((s) => s.id === recon.safe_or_bank_id);
  const matchedCount = recon.lines?.filter((l) => l.matched_treasury_transaction_id || l.matched_treasury_transfer_id).length ?? 0;
  const totalLines = recon.lines?.length ?? 0;
  const computedBalance = (recon.lines ?? []).reduce((sum, l) => sum + Number(l.amount), Number(recon.opening_balance));
  const difference = computedBalance - Number(recon.statement_ending_balance);

  const candidates = [
    ...(recon.unmatchedTransactions ?? []).map((t) => ({
      value: `tx:${t.id}`, label: `سند ${t.transaction_type === 'receipt' ? 'قبض' : 'صرف'} ${t.document_number} — ${t.amount} ${t.currency_code} (${t.transaction_date})`,
    })),
    ...(recon.unmatchedTransfers ?? []).map((t) => ({
      value: `transfer:${t.id}`, label: `تحويل ${t.document_number} — ${t.amount} ${t.currency_code} (${t.transfer_date})`,
    })),
  ];

  function docLabel(line: BankStatementLine) {
    if (line.matched_treasury_transaction_id) {
      const tx = recon!.unmatchedTransactions?.find((t) => t.id === line.matched_treasury_transaction_id);
      return tx ? `سند ${tx.document_number}` : `سند مُطابَق`;
    }
    if (line.matched_treasury_transfer_id) {
      const tr = recon!.unmatchedTransfers?.find((t) => t.id === line.matched_treasury_transfer_id);
      return tr ? `تحويل ${tr.document_number}` : `تحويل مُطابَق`;
    }
    return null;
  }

  async function handleAutoMatch() {
    setError(null); setInfo(null);
    try {
      const result = await autoMatch.mutateAsync(reconciliationId);
      setInfo(`تمت مطابقة ${result.matchedCount} سطر تلقائيًا${result.ambiguousCount > 0 ? `، و${result.ambiguousCount} سطر بحاجة مطابقة يدوية (أكثر من مرشَّح محتمل)` : ''}.`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleManualMatch(lineId: string) {
    setError(null); setInfo(null);
    const selection = selections[lineId];
    if (!selection) { setError('اختر سندًا أو تحويلًا للمطابقة أولًا'); return; }
    const [kind, docId] = selection.split(':');
    try {
      await matchLine.mutateAsync({
        reconciliationId, lineId,
        treasuryTransactionId: kind === 'tx' ? docId : undefined,
        treasuryTransferId: kind === 'transfer' ? docId : undefined,
      });
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleUnmatch(lineId: string) {
    setError(null); setInfo(null);
    try { await unmatchLine.mutateAsync({ reconciliationId, lineId }); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleComplete() {
    setError(null); setInfo(null);
    try { await complete.mutateAsync(reconciliationId); } catch (err) { setError(extractErrorMessage(err)); }
  }

  return (
    <div>
      <div className="mb-4">
        <Link to="/treasury/reconciliations" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة التسويات</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">تسوية {bank?.name_ar ?? ''}</h1>
          <p className="text-sm text-slate-500">كشف بتاريخ {recon.statement_date} — {recon.status === 'completed' ? 'مكتملة' : 'قيد التنفيذ'}</p>
        </div>
        {recon.status === 'in_progress' && (
          <div className="flex gap-2">
            <button onClick={handleAutoMatch} disabled={autoMatch.isPending} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {autoMatch.isPending ? 'جارٍ المطابقة...' : 'مطابقة تلقائية'}
            </button>
            <button onClick={handleComplete} disabled={complete.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {complete.isPending ? 'جارٍ الإكمال...' : 'إكمال التسوية'}
            </button>
          </div>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:grid-cols-4">
        <Field label="الرصيد الافتتاحي" value={recon.opening_balance} />
        <Field label="رصيد الكشف الختامي" value={recon.statement_ending_balance} />
        <Field label="الرصيد المحسوب (افتتاحي + كل الأسطر)" value={computedBalance.toFixed(4)} />
        <Field label="الفرق" value={difference.toFixed(4)} highlight={difference !== 0} />
        <Field label="أسطر مُطابَقة" value={`${matchedCount} / ${totalLines}`} />
      </div>

      {info && <p className="mb-4 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-700">{info}</p>}
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">التاريخ</th>
              <th className="px-4 py-2 font-medium">الوصف</th>
              <th className="px-4 py-2 font-medium">المبلغ</th>
              <th className="px-4 py-2 font-medium">المطابقة</th>
            </tr>
          </thead>
          <tbody>
            {recon.lines?.map((line) => {
              const matched = docLabel(line);
              return (
                <tr key={line.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{line.line_date}</td>
                  <td className="px-4 py-3 text-slate-600">{line.description ?? '—'}</td>
                  <td className={`px-4 py-3 font-medium ${Number(line.amount) > 0 ? 'text-emerald-700' : 'text-red-600'}`}>{line.amount}</td>
                  <td className="px-4 py-3">
                    {matched ? (
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">{matched}</span>
                        {recon.status === 'in_progress' && (
                          <button onClick={() => handleUnmatch(line.id)} className="text-xs text-red-600 hover:underline">إلغاء</button>
                        )}
                      </div>
                    ) : recon.status === 'in_progress' ? (
                      <div className="flex items-center gap-2">
                        <select
                          value={selections[line.id] ?? ''}
                          onChange={(e) => setSelections((prev) => ({ ...prev, [line.id]: e.target.value }))}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        >
                          <option value="">اختر مستندًا</option>
                          {candidates.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                        <button onClick={() => handleManualMatch(line.id)} className="text-xs font-medium text-slate-700 hover:underline">طابق</button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">غير مُطابَق</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`font-medium ${highlight ? 'text-red-600' : 'text-slate-900'}`}>{value}</p>
    </div>
  );
}
