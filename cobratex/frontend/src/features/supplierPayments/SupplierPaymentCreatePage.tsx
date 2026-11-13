import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useSuppliers } from '@/features/suppliers/api';
import { useSafes, useFiscalPeriods } from '@/features/catalog/api';
import { useCreateSupplierPayment } from '@/features/supplierPayments/api';
import { extractErrorMessage } from '@/api/client';
import { useCurrencyChoice } from '@/ui/CurrencyFields';

export default function SupplierPaymentCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: suppliersPage } = useSuppliers(1, 100);
  const { data: safes } = useSafes();
  const { data: fiscalPeriods } = useFiscalPeriods();
  const createPayment = useCreateSupplierPayment();

  const [supplierId, setSupplierId] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const fx = useCurrencyChoice();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const payment = await createPayment.mutateAsync({
        branchId, supplierId, fiscalPeriodId, ...fx.payload, paymentDate, amount, paymentAccountId,
      });
      navigate(`/purchasing/payments/${payment.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">دفعة مورد جديدة</h1>
      <p className="mb-4 text-sm text-slate-500">
        تُسجَّل الدفعة أولًا (دفعة مقدمة غير مخصَّصة)، ثم تُرحَّل، ثم يمكن تخصيصها لفاتورة أو أكثر من صفحة التفاصيل.
      </p>

      <form onSubmit={handleSubmit} className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        {fx.fields}
        <Select label="المورد" value={supplierId} onChange={setSupplierId} required>
          <option value="">اختر موردًا</option>
          {suppliersPage?.data.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
        </Select>
        <Select label="الخزينة / الحساب الدافع" value={paymentAccountId} onChange={setPaymentAccountId} required>
          <option value="">اختر خزينة أو حسابًا بنكيًا</option>
          {safes?.map((s) => <option key={s.id} value={s.linked_account_id}>{s.name_ar}</option>)}
        </Select>
        <Select label="الفترة المالية" value={fiscalPeriodId} onChange={setFiscalPeriodId} required>
          <option value="">اختر فترة</option>
          {fiscalPeriods?.map((p) => <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>)}
        </Select>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">المبلغ</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الدفعة</span>
          <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createPayment.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createPayment.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
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
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required={required}>
        {children}
      </select>
    </label>
  );
}
