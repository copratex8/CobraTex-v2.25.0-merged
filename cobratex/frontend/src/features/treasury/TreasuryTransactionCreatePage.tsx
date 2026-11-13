import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useCustomers } from '@/features/customers/api';
import { useSuppliers } from '@/features/suppliers/api';
import { useSafes, useAccounts, useFiscalPeriods } from '@/features/catalog/api';
import { useCreateTreasuryTransaction } from '@/features/treasury/api';
import { extractErrorMessage } from '@/api/client';

type CounterpartyType = 'customer' | 'supplier' | 'other';

export default function TreasuryTransactionCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: customersPage } = useCustomers(1, 100);
  const { data: suppliersPage } = useSuppliers(1, 100);
  const { data: safes } = useSafes();
  const { data: accounts } = useAccounts();
  const { data: fiscalPeriods } = useFiscalPeriods();
  const createTransaction = useCreateTreasuryTransaction();

  const [transactionType, setTransactionType] = useState<'receipt' | 'payment'>('receipt');
  const [safeOrBankId, setSafeOrBankId] = useState('');
  const [counterpartyType, setCounterpartyType] = useState<CounterpartyType>('customer');
  const [counterpartyCustomerId, setCounterpartyCustomerId] = useState('');
  const [counterpartySupplierId, setCounterpartySupplierId] = useState('');
  const [contraAccountId, setContraAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EGP');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [transactionDate, setTransactionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await createTransaction.mutateAsync({
        branchId, safeOrBankId, transactionType, counterpartyType,
        counterpartyCustomerId: counterpartyType === 'customer' ? counterpartyCustomerId : undefined,
        counterpartySupplierId: counterpartyType === 'supplier' ? counterpartySupplierId : undefined,
        contraAccountId: counterpartyType === 'other' ? contraAccountId : undefined,
        amount, currencyCode, transactionDate, fiscalPeriodId, description: description || undefined,
      });
      navigate(`/treasury/transactions/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">سند قبض/صرف جديد</h1>

      <form onSubmit={handleSubmit} className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">نوع السند</span>
          <div className="flex gap-3">
            <button type="button" onClick={() => setTransactionType('receipt')} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${transactionType === 'receipt' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-600'}`}>
              سند قبض
            </button>
            <button type="button" onClick={() => setTransactionType('payment')} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${transactionType === 'payment' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-slate-300 text-slate-600'}`}>
              سند صرف
            </button>
          </div>
        </label>

        <Select label="الخزينة / البنك" value={safeOrBankId} onChange={setSafeOrBankId} required>
          <option value="">اختر خزينة أو بنكًا</option>
          {safes?.map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
        </Select>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">الطرف المقابل</span>
          <div className="flex gap-2">
            {(['customer', 'supplier', 'other'] as CounterpartyType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCounterpartyType(t)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${counterpartyType === t ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 text-slate-600'}`}
              >
                {t === 'customer' ? 'عميل' : t === 'supplier' ? 'مورد' : 'طرف آخر'}
              </button>
            ))}
          </div>
        </label>

        {counterpartyType === 'customer' && (
          <Select label="العميل" value={counterpartyCustomerId} onChange={setCounterpartyCustomerId} required>
            <option value="">اختر عميلًا</option>
            {customersPage?.data.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
          </Select>
        )}
        {counterpartyType === 'supplier' && (
          <Select label="المورد" value={counterpartySupplierId} onChange={setCounterpartySupplierId} required>
            <option value="">اختر موردًا</option>
            {suppliersPage?.data.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
          </Select>
        )}
        {counterpartyType === 'other' && (
          <Select label="الحساب المقابل" value={contraAccountId} onChange={setContraAccountId} required>
            <option value="">اختر حسابًا</option>
            {accounts?.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name_ar}</option>)}
          </Select>
        )}

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
          <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ السند</span>
          <input type="date" value={transactionDate} onChange={(e) => setTransactionDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">وصف (اختياري)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createTransaction.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createTransaction.isPending ? 'جارٍ الحفظ...' : 'حفظ كمسودة'}
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
