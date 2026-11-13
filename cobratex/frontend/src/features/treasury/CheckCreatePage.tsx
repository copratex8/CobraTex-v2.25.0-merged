import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useCustomers } from '@/features/customers/api';
import { useSuppliers } from '@/features/suppliers/api';
import { useSafes } from '@/features/catalog/api';
import { useRegisterCheck } from '@/features/treasury/api';
import { extractErrorMessage } from '@/api/client';

export default function CheckCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: customersPage } = useCustomers(1, 100);
  const { data: suppliersPage } = useSuppliers(1, 100);
  const { data: safes } = useSafes();
  const registerCheck = useRegisterCheck();

  const [checkType, setCheckType] = useState<'incoming' | 'outgoing'>('incoming');
  const [safeOrBankId, setSafeOrBankId] = useState('');
  const [checkNumber, setCheckNumber] = useState('');
  const [checkDate, setCheckDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EGP');
  const [counterpartyCustomerId, setCounterpartyCustomerId] = useState('');
  const [counterpartySupplierId, setCounterpartySupplierId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await registerCheck.mutateAsync({
        branchId, safeOrBankId, checkType, checkNumber, checkDate, dueDate, amount, currencyCode,
        counterpartyCustomerId: checkType === 'incoming' ? counterpartyCustomerId : undefined,
        counterpartySupplierId: checkType === 'outgoing' ? counterpartySupplierId : undefined,
        notes: notes || undefined,
      });
      navigate(`/treasury/checks/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">تسجيل شيك جديد</h1>

      <form onSubmit={handleSubmit} className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">نوع الشيك</span>
          <div className="flex gap-3">
            <button type="button" onClick={() => setCheckType('incoming')} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${checkType === 'incoming' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-600'}`}>
              شيك وارد (من عميل)
            </button>
            <button type="button" onClick={() => setCheckType('outgoing')} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${checkType === 'outgoing' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-slate-300 text-slate-600'}`}>
              شيك صادر (لمورد)
            </button>
          </div>
        </label>

        {checkType === 'incoming' ? (
          <Select label="العميل" value={counterpartyCustomerId} onChange={setCounterpartyCustomerId} required>
            <option value="">اختر عميلًا</option>
            {customersPage?.data.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
          </Select>
        ) : (
          <Select label="المورد" value={counterpartySupplierId} onChange={setCounterpartySupplierId} required>
            <option value="">اختر موردًا</option>
            {suppliersPage?.data.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
          </Select>
        )}

        <Select label="الخزينة / البنك (المودَع لديه الشيك)" value={safeOrBankId} onChange={setSafeOrBankId} required>
          <option value="">اختر خزينة أو بنكًا</option>
          {safes?.map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
        </Select>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">رقم الشيك</span>
            <input value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">العملة</span>
            <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} maxLength={3} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الشيك</span>
            <input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الاستحقاق</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">المبلغ</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">ملاحظات (اختياري)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={registerCheck.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {registerCheck.isPending ? 'جارٍ الحفظ...' : 'تسجيل الشيك'}
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
