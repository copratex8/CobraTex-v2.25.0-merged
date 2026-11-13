import { useParams, Link } from 'react-router-dom';
import { useState } from 'react';
import { useGoodsReceipt, usePostGoodsReceipt } from '@/features/goodsReceipts/api';
import { extractErrorMessage } from '@/api/client';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّل', cancelled: 'ملغى' };

export default function GoodsReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: receipt, isLoading, isError } = useGoodsReceipt(id ?? null);
  const postReceipt = usePostGoodsReceipt();
  const [error, setError] = useState<string | null>(null);

  async function handlePost() {
    if (!id) return;
    setError(null);
    try {
      await postReceipt.mutateAsync(id);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !receipt) return <p className="text-sm text-red-600">تعذَّر تحميل الاستلام.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/purchasing/receipts" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة الاستلامات</Link>
      </div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">استلام {receipt.document_number}</h1>
          <p className="text-sm text-slate-500">{receipt.receipt_date} — {statusLabels[receipt.status]}</p>
        </div>
        {receipt.status === 'draft' && (
          <button onClick={handlePost} disabled={postReceipt.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {postReceipt.isPending ? 'جارٍ الترحيل...' : 'ترحيل الاستلام'}
          </button>
        )}
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">الكمية</th>
              <th className="px-4 py-3 font-medium">تكلفة الوحدة</th>
              <th className="px-4 py-3 font-medium">المُفوتَر منها</th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines?.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">{line.quantity}</td>
                <td className="px-4 py-3">{line.unit_cost}</td>
                <td className="px-4 py-3 text-slate-500">{line.invoiced_quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {receipt.status === 'posted' && (
        <p className="mt-4 text-sm text-slate-500">
          يمكن الآن إصدار فاتورة مورد لهذا الاستلام من <Link to="/purchasing/invoices/new" className="font-medium text-slate-700 hover:underline">فواتير الشراء</Link>.
        </p>
      )}
    </div>
  );
}
