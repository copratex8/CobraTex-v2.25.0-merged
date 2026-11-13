import { useState, type FormEvent } from 'react';
import Modal from '@/components/Modal';
import { useAuth } from '@/auth/AuthContext';
import { useCreateSafeOrBank } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';

interface Props {
  onClose: () => void;
}

export default function SafeCreateModal({ onClose }: Props) {
  const { user } = useAuth();
  const branchId = user?.branchIds[0] ?? '';
  const createSafe = useCreateSafeOrBank();

  const [form, setForm] = useState({
    code: '', nameAr: '', nameEn: '', kind: 'safe' as 'safe' | 'bank', currencyCode: 'EGP',
    bankName: '', accountNumber: '', iban: '',
  });
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createSafe.mutateAsync({
        branchId,
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        kind: form.kind,
        currencyCode: form.currencyCode,
        bankName: form.kind === 'bank' ? (form.bankName || undefined) : undefined,
        accountNumber: form.kind === 'bank' ? (form.accountNumber || undefined) : undefined,
        iban: form.kind === 'bank' ? (form.iban || undefined) : undefined,
      });
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <Modal title="خزينة / بنك جديد" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="الكود" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">النوع</span>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as 'safe' | 'bank' })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="safe">خزينة نقدية</option>
              <option value="bank">حساب بنكي</option>
            </select>
          </label>
        </div>
        <Field label="الاسم بالعربية" value={form.nameAr} onChange={(v) => setForm({ ...form, nameAr: v })} required />
        <Field label="الاسم بالإنجليزية" value={form.nameEn} onChange={(v) => setForm({ ...form, nameEn: v })} required />
        <Field label="عملة الخزينة/البنك" value={form.currencyCode} onChange={(v) => setForm({ ...form, currencyCode: v.toUpperCase() })} required maxLength={3} />

        {form.kind === 'bank' && (
          <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
            <Field label="اسم البنك" value={form.bankName} onChange={(v) => setForm({ ...form, bankName: v })} required />
            <Field label="رقم الحساب" value={form.accountNumber} onChange={(v) => setForm({ ...form, accountNumber: v })} required />
            <div className="col-span-2">
              <Field label="IBAN (اختياري)" value={form.iban} onChange={(v) => setForm({ ...form, iban: v })} />
            </div>
          </div>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={createSafe.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {createSafe.isPending ? 'جارٍ الحفظ...' : 'حفظ'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label, value, onChange, required, maxLength,
}: { label: string; value: string; onChange: (v: string) => void; required?: boolean; maxLength?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        maxLength={maxLength}
      />
    </label>
  );
}
