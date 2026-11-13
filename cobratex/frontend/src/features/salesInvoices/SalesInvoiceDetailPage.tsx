import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useSalesInvoice, usePostSalesInvoice, useCancelSalesInvoice, useReverseSalesInvoice,
} from '@/features/salesInvoices/api';
import { extractErrorMessage } from '@/api/client';
import AttachmentsPanel from '@/features/attachments/AttachmentsPanel';

const statusLabels: Record<string, string> = {
  draft: 'مسودة', posted: 'مرحَّلة', cancelled: 'ملغاة', reversed: 'معكوسة',
};

export default function SalesInvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: invoice, isLoading, isError } = useSalesInvoice(id ?? null);
  const postInvoice = usePostSalesInvoice();
  const cancelInvoice = useCancelSalesInvoice();
  const reverseInvoice = useReverseSalesInvoice();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function handlePost() {
    if (!id) return;
    setError(null);
    try {
      await postInvoice.mutateAsync(id);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  async function handleCancelOrReverse(action: 'cancel' | 'reverse') {
    if (!id) return;
    if (!reason.trim()) {
      setError('السبب إلزامي');
      return;
    }
    setError(null);
    try {
      if (action === 'cancel') await cancelInvoice.mutateAsync({ id, reason });
      else await reverseInvoice.mutateAsync({ id, reason });
      setReason('');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !invoice) return <p className="text-sm text-red-600">تعذَّر تحميل الفاتورة.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/sales/invoices" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة الفواتير</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">فاتورة {invoice.document_number}</h1>
          <p className="text-sm text-slate-500">{invoice.invoice_date} — {statusLabels[invoice.status]}</p>
        </div>
        {invoice.status === 'draft' && (
          <button
            onClick={handlePost}
            disabled={postInvoice.isPending}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {postInvoice.isPending ? 'جارٍ الترحيل...' : 'ترحيل الفاتورة'}
          </button>
        )}
      </div>

      <div className="mb-6">
        <Link
          to={`/sales/invoices/${invoice.id}/print`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          طباعة / PDF
        </Link>
      </div>

      <div className="mb-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">الكمية</th>
              <th className="px-4 py-3 font-medium">سعر الوحدة</th>
              <th className="px-4 py-3 font-medium">الخصم %</th>
              <th className="px-4 py-3 font-medium">الصافي</th>
              <th className="px-4 py-3 font-medium">الضريبة</th>
              <th className="px-4 py-3 font-medium">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines?.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">{line.quantity}</td>
                <td className="px-4 py-3">{line.unit_price}</td>
                <td className="px-4 py-3">{line.discount_percent}</td>
                <td className="px-4 py-3">{line.subtotal}</td>
                <td className="px-4 py-3">{line.tax_amount}</td>
                <td className="px-4 py-3 font-medium text-slate-900">{line.line_total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {invoice.status === 'draft' && (
        <ActionBox title="إلغاء الفاتورة (لم تُرحَّل بعد)" reason={reason} setReason={setReason} onConfirm={() => handleCancelOrReverse('cancel')} label="إلغاء" />
      )}
      {invoice.status === 'posted' && (
        <ActionBox title="عكس الفاتورة (مرحَّلة بالفعل)" reason={reason} setReason={setReason} onConfirm={() => handleCancelOrReverse('reverse')} label="عكس" />
      )}

      <div className="mt-6">
        <AttachmentsPanel entityType="sales_invoice" entityId={invoice.id} />
      </div>
    </div>
  );
}

function ActionBox({
  title, reason, setReason, onConfirm, label,
}: { title: string; reason: string; setReason: (v: string) => void; onConfirm: () => void; label: string }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      <div className="flex gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="السبب (إلزامي)"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button onClick={onConfirm} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
          {label}
        </button>
      </div>
    </div>
  );
}
