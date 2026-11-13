import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useSalesInvoices, useSalesInvoice } from '@/features/salesInvoices/api';
import { useCustomers } from '@/features/customers/api';
import { useFiscalPeriods } from '@/features/catalog/api';
import { useCreateSalesReturn } from '@/features/salesReturns/api';
import { extractErrorMessage } from '@/api/client';

export default function SalesReturnCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const [customerFilter, setCustomerFilter] = useState('');
  const { data: customersPage } = useCustomers(1, 100);
  const { data: invoicesPage } = useSalesInvoices(1, 100, { status: 'posted', customerId: customerFilter });
  const postedInvoices = invoicesPage?.data ?? [];
  const { data: fiscalPeriods } = useFiscalPeriods();
  const createReturn = useCreateSalesReturn();

  const [invoiceId, setInvoiceId] = useState('');
  const { data: invoice } = useSalesInvoice(invoiceId || null);
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [returnDate, setReturnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const returnableLines = (invoice?.lines ?? [])
    .map((line) => ({ line, remaining: Number(line.quantity) - Number(line.returned_quantity) }))
    .filter((l) => l.remaining > 0);

  function setQuantity(lineId: string, remaining: number, raw: string) {
    if (raw === '') { setQuantities((prev) => ({ ...prev, [lineId]: '' })); return; }
    const clamped = Math.min(Math.max(Number(raw) || 0, 0), remaining);
    setQuantities((prev) => ({ ...prev, [lineId]: String(clamped) }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const lines = Object.entries(quantities)
      .filter(([, qty]) => Number(qty) > 0)
      .map(([salesInvoiceLineId, quantity]) => ({ salesInvoiceLineId, quantity }));
    if (lines.length === 0) {
      setError('حدِّد كمية إرجاع لسطر واحد على الأقل');
      return;
    }
    try {
      const created = await createReturn.mutateAsync({
        branchId, warehouseId: invoice!.warehouse_id, salesInvoiceId: invoiceId, fiscalPeriodId, returnDate, lines,
      });
      navigate(`/sales/returns/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">مرتجع بيع جديد</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تصفية بالعميل (اختياري)</span>
            <select
              value={customerFilter}
              onChange={(e) => { setCustomerFilter(e.target.value); setInvoiceId(''); setQuantities({}); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">كل العملاء</option>
              {customersPage?.data.map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">فاتورة البيع (مرحَّلة)</span>
            <select
              value={invoiceId}
              onChange={(e) => { setInvoiceId(e.target.value); setQuantities({}); }}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            >
              <option value="">اختر فاتورة</option>
              {postedInvoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.document_number}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الفترة المالية</span>
            <select value={fiscalPeriodId} onChange={(e) => setFiscalPeriodId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
              <option value="">اختر فترة</option>
              {fiscalPeriods?.map((p) => <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ المرتجع</span>
            <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        {invoice && (
          <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">الكمية الأصلية بالفاتورة</th>
                  <th className="px-4 py-2 font-medium">مُرجَع سابقًا</th>
                  <th className="px-4 py-2 font-medium">المتبقي القابل للإرجاع</th>
                  <th className="px-4 py-2 font-medium">سعر الوحدة</th>
                  <th className="px-4 py-2 font-medium">كمية الإرجاع</th>
                </tr>
              </thead>
              <tbody>
                {returnableLines.map(({ line, remaining }) => (
                  <tr key={line.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">{line.quantity}</td>
                    <td className="px-4 py-3 text-slate-500">{line.returned_quantity}</td>
                    <td className="px-4 py-3 font-medium text-emerald-700">{remaining.toFixed(4)}</td>
                    <td className="px-4 py-3">{line.unit_price}</td>
                    <td className="px-4 py-3">
                      <input
                        value={quantities[line.id] ?? ''}
                        onChange={(e) => setQuantity(line.id, remaining, e.target.value)}
                        placeholder="0"
                        max={remaining}
                        min={0}
                        className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      />
                    </td>
                  </tr>
                ))}
                {returnableLines.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">كل أسطر هذه الفاتورة أُرجِعت بالكامل بالفعل</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={createReturn.isPending || !invoice}
          className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {createReturn.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
        </button>
      </form>
    </div>
  );
}

