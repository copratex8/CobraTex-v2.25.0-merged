import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useSuppliers } from '@/features/suppliers/api';
import { useFiscalPeriods, useItems } from '@/features/catalog/api';
import { usePostedReceiptsForSupplier } from '@/features/goodsReceipts/api';
import { useCreatePurchaseInvoice } from '@/features/purchaseInvoices/api';
import { extractErrorMessage } from '@/api/client';
import { useCurrencyChoice } from '@/ui/CurrencyFields';

interface SelectedLine {
  goodsReceiptLineId: string;
  itemLabel: string;
  remaining: number;
  quantity: string;
  unitCost: string;
}

export default function PurchaseInvoiceCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: suppliersPage } = useSuppliers(1, 100);
  const { data: fiscalPeriods } = useFiscalPeriods();
  const { data: items } = useItems();
  const createInvoice = useCreatePurchaseInvoice();

  const [supplierId, setSupplierId] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<Record<string, SelectedLine>>({});
  const [error, setError] = useState<string | null>(null);
  const fx = useCurrencyChoice();

  const { data: receipts, isLoading: receiptsLoading } = usePostedReceiptsForSupplier(supplierId || null);

  function itemLabel(itemId: string) {
    const item = items?.find((i) => i.id === itemId);
    return item ? `${item.name_ar} (${item.code})` : itemId;
  }

  function toggleLine(receiptLine: { id: string; item_id: string; quantity: string; unit_cost: string; invoiced_quantity: string }) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[receiptLine.id]) {
        delete next[receiptLine.id];
      } else {
        const remaining = Number(receiptLine.quantity) - Number(receiptLine.invoiced_quantity);
        next[receiptLine.id] = {
          goodsReceiptLineId: receiptLine.id, itemLabel: itemLabel(receiptLine.item_id),
          remaining, quantity: String(remaining), unitCost: receiptLine.unit_cost,
        };
      }
      return next;
    });
  }

  function updateSelected(id: string, patch: Partial<SelectedLine>) {
    setSelected((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const lines = Object.values(selected);
    if (lines.length === 0) {
      setError('اختر سطرًا واحدًا على الأقل من استلام مرحَّل لهذا المورد');
      return;
    }
    try {
      const invoice = await createInvoice.mutateAsync({
        branchId, supplierId, fiscalPeriodId, ...fx.payload, invoiceDate,
        lines: lines.map(({ goodsReceiptLineId, quantity, unitCost }) => ({ goodsReceiptLineId, quantity, unitCost })),
      });
      navigate(`/purchasing/invoices/${invoice.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">فاتورة شراء جديدة</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {fx.fields}
        <div className="grid grid-cols-3 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">المورد</span>
            <select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setSelected({}); }} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
              <option value="">اختر موردًا</option>
              {suppliersPage?.data.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
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
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الفاتورة</span>
            <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">أسطر استلامات مرحَّلة متاحة للفوترة</h2>
            {!supplierId && <p className="mt-1 text-sm text-slate-400">اختر موردًا أولًا لعرض استلاماته المرحَّلة.</p>}
          </div>
          {receiptsLoading && <p className="p-4 text-sm text-slate-500">جارٍ التحميل...</p>}
          {receipts && receipts.length === 0 && supplierId && (
            <p className="p-4 text-sm text-slate-400">لا توجد استلامات مرحَّلة لهذا المورد بعد — أنشئ استلامًا وارحّله أولًا.</p>
          )}
          {receipts?.map((receipt) => (
            <div key={receipt.id} className="border-b border-slate-100 px-4 py-3 last:border-0">
              <p className="mb-2 text-xs font-medium text-slate-500">استلام {receipt.document_number} — {receipt.receipt_date}</p>
              {receipt.lines?.filter((l) => Number(l.quantity) - Number(l.invoiced_quantity) > 0).map((line) => {
                const isSelected = !!selected[line.id];
                return (
                  <div key={line.id} className="mb-2 flex items-center gap-3 rounded-lg border border-slate-200 p-2 text-sm">
                    <input type="checkbox" checked={isSelected} onChange={() => toggleLine(line)} />
                    <span className="flex-1">{itemLabel(line.item_id)} — المتبقي: {(Number(line.quantity) - Number(line.invoiced_quantity)).toFixed(2)}</span>
                    {isSelected && (
                      <>
                        <input
                          value={selected[line.id].quantity}
                          onChange={(e) => updateSelected(line.id, { quantity: e.target.value })}
                          className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                          placeholder="الكمية"
                        />
                        <input
                          value={selected[line.id].unitCost}
                          onChange={(e) => updateSelected(line.id, { unitCost: e.target.value })}
                          className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                          placeholder="تكلفة الوحدة"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createInvoice.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createInvoice.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
        </button>
      </form>
    </div>
  );
}
