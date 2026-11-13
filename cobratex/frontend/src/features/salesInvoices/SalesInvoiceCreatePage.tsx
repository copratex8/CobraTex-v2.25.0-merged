import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useCustomers } from '@/features/customers/api';
import { useItems, useWarehouses, useFiscalPeriods } from '@/features/catalog/api';
import { useCreateSalesInvoice, type SalesInvoiceLineInput } from '@/features/salesInvoices/api';
import { apiClient, extractErrorMessage } from '@/api/client';

interface LineRow extends SalesInvoiceLineInput {
  key: number;
}

let nextKey = 1;
function emptyLine(): LineRow {
  return { key: nextKey++, itemId: '', uomId: '', quantity: '1', unitPrice: '0', discountPercent: '0' };
}

export default function SalesInvoiceCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: customersPage } = useCustomers(1, 100);
  const { data: items } = useItems();
  const { data: warehouses } = useWarehouses();
  const { data: fiscalPeriods } = useFiscalPeriods();
  const createInvoice = useCreateSalesInvoice();

  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [currencyCode, setCurrencyCode] = useState('EGP');
  const [exchangeRate, setExchangeRate] = useState('');
  const [paymentType, setPaymentType] = useState<'' | 'cash' | 'credit' | 'cheque' | 'transfer'>('');
  const { data: currencies } = useQuery({ queryKey: ['fx-currencies'], queryFn: async () => (await apiClient.get<Array<{ code: string; name_ar: string | null; name: string; is_active: boolean; isBase: boolean }>>('/fx/currencies')).data, retry: false, staleTime: 60_000 });
  const base = currencies?.find((c) => c.isBase)?.code ?? 'EGP';
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  function updateLine(key: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function onItemChange(key: number, itemId: string) {
    const item = items?.find((i) => i.id === itemId);
    updateLine(key, { itemId, uomId: item?.base_uom_id ?? '' });
  }

  const lineTotal = (line: LineRow) => {
    const qty = Number(line.quantity) || 0;
    const price = Number(line.unitPrice) || 0;
    const discount = Number(line.discountPercent) || 0;
    return qty * price * (1 - discount / 100);
  };
  const invoiceTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const invoice = await createInvoice.mutateAsync({
        branchId,
        warehouseId,
        customerId,
        fiscalPeriodId,
        currencyCode,
        ...(currencyCode !== base && exchangeRate ? { exchangeRate } : {}),
        ...(paymentType ? { paymentType } : {}),
        invoiceDate,
        lines: lines.map(({ key: _key, ...rest }) => rest),
      });
      navigate(`/sales/invoices/${invoice.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">فاتورة بيع جديدة</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 md:grid-cols-4">
          <Select label="العميل" value={customerId} onChange={setCustomerId} required>
            <option value="">اختر عميلًا</option>
            {customersPage?.data.filter((c) => c.is_active).map((c) => (
              <option key={c.id} value={c.id}>{c.name_ar}</option>
            ))}
          </Select>
          <Select label="المخزن" value={warehouseId} onChange={setWarehouseId} required>
            <option value="">اختر مخزنًا</option>
            {warehouses?.map((w) => (
              <option key={w.id} value={w.id}>{w.name_ar}</option>
            ))}
          </Select>
          <Select label="الفترة المالية" value={fiscalPeriodId} onChange={setFiscalPeriodId} required>
            <option value="">اختر فترة</option>
            {fiscalPeriods?.map((p) => (
              <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>
            ))}
          </Select>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الفاتورة</span>
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">العملة</span>
            <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {(currencies?.filter((c) => c.is_active) ?? [{ code: 'EGP', name_ar: 'جنيه مصري', name: 'EGP', is_active: true, isBase: true }]).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name_ar ?? c.name}</option>)}
            </select>
          </label>
          {currencyCode !== base && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">سعر الصرف (اتركه فارغًا لجلبه من الجدول)</span>
              <input value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} inputMode="decimal" placeholder="تلقائي" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">نوع الدفع</span>
            <select value={paymentType} onChange={(e) => setPaymentType(e.target.value as typeof paymentType)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="">غير محدد</option><option value="cash">نقدي</option><option value="credit">آجل</option><option value="cheque">شيك</option><option value="transfer">تحويل</option>
            </select>
          </label>
        </div>

        <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">الصنف</th>
                <th className="px-3 py-2 font-medium">الكمية</th>
                <th className="px-3 py-2 font-medium">سعر الوحدة</th>
                <th className="px-3 py-2 font-medium">خصم %</th>
                <th className="px-3 py-2 font-medium">الإجمالي</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2">
                    <select
                      value={line.itemId}
                      onChange={(e) => onItemChange(line.key, e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      required
                    >
                      <option value="">اختر صنفًا</option>
                      {items?.filter((i) => i.is_active).map((i) => (
                        <option key={i.id} value={i.id}>{i.name_ar} ({i.code})</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      required
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={line.unitPrice}
                      onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                      className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                      required
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={line.discountPercent}
                      onChange={(e) => updateLine(line.key, { discountPercent: e.target.value })}
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </td>
                  <td className="px-3 py-2 font-medium text-slate-900">{lineTotal(line).toFixed(2)}</td>
                  <td className="px-3 py-2">
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                        className="text-red-500 hover:text-red-700"
                      >
                        حذف
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
            <button
              type="button"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="text-sm font-medium text-slate-700 hover:underline"
            >
              + إضافة سطر
            </button>
            <span className="text-sm font-semibold text-slate-900">الإجمالي التقريبي: {invoiceTotal.toFixed(2)}</span>
          </div>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={createInvoice.isPending}
          className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {createInvoice.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
        </button>
      </form>
    </div>
  );
}

function Select({
  label, value, onChange, required, children,
}: { label: string; value: string; onChange: (v: string) => void; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        required={required}
      >
        {children}
      </select>
    </label>
  );
}
