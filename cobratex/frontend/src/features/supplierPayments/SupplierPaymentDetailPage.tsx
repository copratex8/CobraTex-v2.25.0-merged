import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useSupplierPayment, usePostSupplierPayment, useReverseSupplierPayment, useAllocateSupplierPayment, useSupplierOpenInvoices,
} from '@/features/supplierPayments/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّلة', cancelled: 'ملغاة', reversed: 'معكوسة' };

export default function SupplierPaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: payment, isLoading, isError } = useSupplierPayment(id ?? null);
  const postPayment = usePostSupplierPayment();
  const reversePayment = useReverseSupplierPayment();
  const allocatePayment = useAllocateSupplierPayment();
  const { data: openInvoices } = useSupplierOpenInvoices(payment?.status === 'posted' ? payment.supplier_id : null);

  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [allocAmounts, setAllocAmounts] = useState<Record<string, string>>({});

  const allocatedTotal = (payment?.allocations ?? []).reduce((s, a) => s + Number(a.allocated_amount), 0);
  const unallocatedRemaining = payment ? Number(payment.amount) - allocatedTotal : 0;

  async function handlePost() {
    if (!id) return;
    setError(null);
    try { await postPayment.mutateAsync(id); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleReverse() {
    if (!id) return;
    if (!reason.trim()) { setError('السبب إلزامي'); return; }
    setError(null);
    try { await reversePayment.mutateAsync({ id, reason }); setReason(''); } catch (err) { setError(extractErrorMessage(err)); }
  }

  async function handleAllocate() {
    if (!id) return;
    const allocations = Object.entries(allocAmounts)
      .filter(([, amount]) => Number(amount) > 0)
      .map(([supplierInvoiceId, amount]) => ({ supplierInvoiceId, amount }));
    if (allocations.length === 0) { setError('حدِّد مبلغًا لفاتورة واحدة على الأقل'); return; }
    setError(null);
    try {
      await allocatePayment.mutateAsync({ id, allocations });
      setAllocAmounts({});
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !payment) return <p className="text-sm text-red-600">تعذَّر تحميل الدفعة.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/purchasing/payments" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة الدفعات</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">دفعة {payment.document_number}</h1>
          <p className="text-sm text-slate-500">{payment.payment_date} — {payment.amount} {payment.currency_code} — {statusLabels[payment.status]}</p>
        </div>
        {payment.status === 'draft' && (
          <button onClick={handlePost} disabled={postPayment.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postPayment.isPending ? 'جارٍ الترحيل...' : 'ترحيل الدفعة'}
          </button>
        )}
      </div>

      {payment.allocations && payment.allocations.length > 0 && (
        <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold text-slate-900">التخصيصات الحالية</h2></div>
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr><th className="px-4 py-2 font-medium">الفاتورة</th><th className="px-4 py-2 font-medium">المبلغ المخصَّص</th></tr>
            </thead>
            <tbody>
              {payment.allocations.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{a.supplier_invoice_id}</td>
                  <td className="px-4 py-3">{a.allocated_amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {payment.status === 'posted' && unallocatedRemaining > 0 && (
        <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">تخصيص لفاتورة (المتبقي غير المخصَّص من الدفعة: {unallocatedRemaining.toFixed(2)})</h2>
          </div>
          {!openInvoices?.length && <p className="p-4 text-sm text-slate-400">لا توجد فواتير مفتوحة لهذا المورد حاليًا.</p>}
          {openInvoices?.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 text-sm last:border-0">
              <span className="flex-1">{inv.document_number} — المتبقي: {Number(inv.remaining).toFixed(2)}</span>
              <input
                value={allocAmounts[inv.id] ?? ''}
                onChange={(e) => setAllocAmounts((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                placeholder="المبلغ"
                className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
          ))}
          {!!openInvoices?.length && (
            <div className="border-t border-slate-200 px-4 py-3">
              <button onClick={handleAllocate} disabled={allocatePayment.isPending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {allocatePayment.isPending ? 'جارٍ التخصيص...' : 'تخصيص'}
              </button>
            </div>
          )}
        </div>
      )}

      {payment.status === 'posted' && (
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">عكس الدفعة</h2>
          <div className="flex gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <button onClick={handleReverse} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">عكس</button>
          </div>
        </div>
      )}
    </div>
  );
}
