import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useCheck, useTransitionCheck } from '@/features/treasury/api';
import { useFiscalPeriods } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';
import AttachmentsPanel from '@/features/attachments/AttachmentsPanel';

const statusLabels: Record<string, string> = { pending: 'قيد الانتظار', deposited: 'تحت التحصيل', cleared: 'محصَّل', bounced: 'مرتد', cancelled: 'ملغى' };
const typeLabels: Record<string, string> = { incoming: 'شيك وارد', outgoing: 'شيك صادر' };

export default function CheckDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: check, isLoading, isError } = useCheck(id ?? null);
  const { data: fiscalPeriods } = useFiscalPeriods();
  const transition = useTransitionCheck();

  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [fiscalPeriodId, setFiscalPeriodId] = useState('');
  const [clearDate, setClearDate] = useState(() => new Date().toISOString().slice(0, 10));

  async function handleTransition(
    target: 'deposited' | 'cleared' | 'bounced' | 'cancelled',
    options: { reason?: string; fiscalPeriodId?: string; clearDate?: string } = {},
  ) {
    if (!id) return;
    setError(null);
    try {
      await transition.mutateAsync({ id, target, ...options });
      setReason('');
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !check) return <p className="text-sm text-red-600">تعذَّر تحميل الشيك.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/treasury/checks" className="text-sm text-slate-500 hover:underline">→ العودة لقائمة الشيكات</Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">{typeLabels[check.check_type]} رقم {check.check_number}</h1>
        <p className="text-sm text-slate-500">استحقاق {check.due_date} — {statusLabels[check.status]}</p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:grid-cols-3">
        <Field label="المبلغ" value={`${check.amount} ${check.currency_code}`} />
        <Field label="تاريخ الشيك" value={check.check_date} />
        {check.notes && <Field label="ملاحظات" value={check.notes} />}
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {check.status === 'pending' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">إيداع الشيك للتحصيل/الصرف</h2>
            <button
              onClick={() => handleTransition('deposited')}
              disabled={transition.isPending}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              إيداع الشيك
            </button>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">إلغاء الشيك</h2>
            <div className="flex gap-2">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="السبب (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <button
                onClick={() => reason.trim() ? handleTransition('cancelled', { reason }) : setError('السبب إلزامي')}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                إلغاء الشيك
              </button>
            </div>
          </div>
        </div>
      )}

      {check.status === 'deposited' && (
        <div className="space-y-4">
          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">
              {check.check_type === 'incoming' ? 'تأكيد التحصيل (تُنشأ حركة خزينة فعلية)' : 'تأكيد الصرف (تُنشأ حركة خزينة فعلية)'}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">الفترة المالية</span>
                <select value={fiscalPeriodId} onChange={(e) => setFiscalPeriodId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
                  <option value="">اختر فترة</option>
                  {fiscalPeriods?.map((p) => <option key={p.id} value={p.id}>{p.start_date} → {p.end_date}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">تاريخ التحصيل/الصرف</span>
                <input type="date" value={clearDate} onChange={(e) => setClearDate(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
            </div>
            <button
              onClick={() => fiscalPeriodId ? handleTransition('cleared', { fiscalPeriodId, clearDate }) : setError('الفترة المالية إلزامية')}
              disabled={transition.isPending}
              className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              تأكيد التحصيل/الصرف
            </button>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">ارتداد الشيك</h2>
            <div className="flex gap-2">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="سبب الارتداد (إلزامي)" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <button
                onClick={() => reason.trim() ? handleTransition('bounced', { reason }) : setError('السبب إلزامي')}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                تسجيل الارتداد
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6">
        <AttachmentsPanel entityType="check" entityId={check.id} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-medium text-slate-900">{value}</p>
    </div>
  );
}
