import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useSafes, useFiscalPeriods } from '@/features/catalog/api';
import { useCreateTreasuryTransfer } from '@/features/treasury/api';
import { extractErrorMessage } from '@/api/client';

export default function TreasuryTransferCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: safes } = useSafes();
  const { data: fiscalPeriods } = useFiscalPeriods();
  const createTransfer = useCreateTreasuryTransfer();

  const [fromSafeOrBankId, setFromSafeOrBankId] = useState('');
  const [toSafeOrBankId, setToSafeOrBankId] = useState('');
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EGP');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [transferDate, setTransferDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (fromSafeOrBankId && fromSafeOrBankId === toSafeOrBankId) {
      setError('لا يمكن التحويل من خزينة/بنك إلى نفسه');
      return;
    }
    try {
      const created = await createTransfer.mutateAsync({
        branchId, fromSafeOrBankId, toSafeOrBankId, amount, currencyCode, transferDate, fiscalPeriodId,
      });
      navigate(`/treasury/transfers/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">تحويل جديد</h1>

      <form onSubmit={handleSubmit} className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <Select label="من (المصدر)" value={fromSafeOrBankId} onChange={setFromSafeOrBankId} required>
          <option value="">اختر خزينة أو بنكًا</option>
          {safes?.map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
        </Select>
        <Select label="إلى (الوجهة)" value={toSafeOrBankId} onChange={setToSafeOrBankId} required>
          <option value="">اختر خزينة أو بنكًا</option>
          {safes?.filter((s) => s.id !== fromSafeOrBankId).map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
        </Select>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">المبلغ</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">العملة</span>
            <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} maxLength={3} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <Select label="الفترة المالية" value={fiscalPeriodId} onChange={setFiscalPeriodId} required>
          <option value="">اختر فترة</option>
          {fiscalPeriods?.map((p) => <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>)}
        </Select>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ التحويل</span>
          <input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createTransfer.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createTransfer.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
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
