import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useSafes } from '@/features/catalog/api';
import { useCreateReconciliation } from '@/features/treasury/reconciliationApi';
import { extractErrorMessage } from '@/api/client';

interface PendingLine {
  lineDate: string;
  description: string;
  amount: string;
  reference: string;
}

export default function ReconciliationCreatePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';

  const { data: safes } = useSafes();
  const createReconciliation = useCreateReconciliation();

  const [safeOrBankId, setSafeOrBankId] = useState('');
  const [statementDate, setStatementDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [openingBalance, setOpeningBalance] = useState('0');
  const [statementEndingBalance, setStatementEndingBalance] = useState('');

  const [pendingLine, setPendingLine] = useState<PendingLine>({ lineDate: statementDate, description: '', amount: '', reference: '' });
  const [lines, setLines] = useState<PendingLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  function addLine() {
    setError(null);
    if (!pendingLine.lineDate || !pendingLine.amount || Number(pendingLine.amount) === 0) {
      setError('أدخل تاريخًا ومبلغًا صحيحًا (غير صفري) للسطر');
      return;
    }
    setLines((prev) => [...prev, pendingLine]);
    setPendingLine({ lineDate: statementDate, description: '', amount: '', reference: '' });
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (lines.length === 0) {
      setError('أضِف سطرًا واحدًا على الأقل من كشف الحساب البنكي');
      return;
    }
    try {
      const created = await createReconciliation.mutateAsync({
        branchId, safeOrBankId, statementDate, openingBalance, statementEndingBalance,
        lines: lines.map((l) => ({ lineDate: l.lineDate, description: l.description || undefined, amount: l.amount, reference: l.reference || undefined })),
      });
      navigate(`/treasury/reconciliations/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">تسوية بنكية جديدة</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 md:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">البنك</span>
            <select value={safeOrBankId} onChange={(e) => setSafeOrBankId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
              <option value="">اختر بنكًا</option>
              {safes?.filter((s) => s.kind === 'bank').map((s) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ الكشف</span>
            <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">الرصيد الافتتاحي</span>
            <input value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">رصيد الكشف الختامي</span>
            <input value={statementEndingBalance} onChange={(e) => setStatementEndingBalance(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required />
          </label>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">أسطر كشف الحساب</h2>
          <p className="mb-3 text-xs text-slate-500">أدخل كل حركة كما وردت في كشف البنك — موجب للإيداع، سالب للسحب (مثال: -150.5).</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block w-40">
              <span className="mb-1 block text-sm font-medium text-slate-700">التاريخ</span>
              <input type="date" value={pendingLine.lineDate} onChange={(e) => setPendingLine({ ...pendingLine, lineDate: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block min-w-[200px] flex-1">
              <span className="mb-1 block text-sm font-medium text-slate-700">الوصف</span>
              <input value={pendingLine.description} onChange={(e) => setPendingLine({ ...pendingLine, description: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block w-36">
              <span className="mb-1 block text-sm font-medium text-slate-700">المبلغ</span>
              <input value={pendingLine.amount} onChange={(e) => setPendingLine({ ...pendingLine, amount: e.target.value })} placeholder="-150.5" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block w-32">
              <span className="mb-1 block text-sm font-medium text-slate-700">المرجع</span>
              <input value={pendingLine.reference} onChange={(e) => setPendingLine({ ...pendingLine, reference: e.target.value })} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <button type="button" onClick={addLine} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              + إضافة
            </button>
          </div>

          {lines.length > 0 && (
            <table className="mt-4 w-full text-start text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 font-medium">التاريخ</th>
                  <th className="py-2 font-medium">الوصف</th>
                  <th className="py-2 font-medium">المبلغ</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2">{l.lineDate}</td>
                    <td className="py-2 text-slate-600">{l.description || '—'}</td>
                    <td className={`py-2 font-medium ${Number(l.amount) > 0 ? 'text-emerald-700' : 'text-red-600'}`}>{l.amount}</td>
                    <td className="py-2 text-end">
                      <button type="button" onClick={() => removeLine(i)} className="text-sm text-red-600 hover:underline">حذف</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={createReconciliation.isPending} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createReconciliation.isPending ? 'جارٍ الحفظ...' : 'حفظ وبدء المطابقة'}
        </button>
      </form>
    </div>
  );
}
