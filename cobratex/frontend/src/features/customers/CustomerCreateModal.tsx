import { useState, type FormEvent } from 'react';
import Modal from '@/components/Modal';
import { useCreateCustomer } from '@/features/customers/api';
import { extractErrorMessage } from '@/api/client';

interface Props {
  onClose: () => void;
}

export default function CustomerCreateModal({ onClose }: Props) {
  const createCustomer = useCreateCustomer();
  const [form, setForm] = useState({ code: '', nameAr: '', nameEn: '', currencyCode: 'EGP', creditLimit: '', paymentTermDays: '' });
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createCustomer.mutateAsync({
        code: form.code,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        currencyCode: form.currencyCode,
        creditLimit: form.creditLimit || undefined,
        paymentTermDays: form.paymentTermDays ? Number(form.paymentTermDays) : undefined,
      });
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <Modal title="عميل جديد" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="الكود" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
          <Field label="عملة التعامل" value={form.currencyCode} onChange={(v) => setForm({ ...form, currencyCode: v.toUpperCase() })} required maxLength={3} />
        </div>
        <Field label="الاسم بالعربية" value={form.nameAr} onChange={(v) => setForm({ ...form, nameAr: v })} required />
        <Field label="الاسم بالإنجليزية" value={form.nameEn} onChange={(v) => setForm({ ...form, nameEn: v })} required />
        <div className="grid grid-cols-2 gap-3">
          <Field label="حد الائتمان (اختياري)" value={form.creditLimit} onChange={(v) => setForm({ ...form, creditLimit: v })} />
          <Field label="مهلة السداد (أيام)" value={form.paymentTermDays} onChange={(v) => setForm({ ...form, paymentTermDays: v })} />
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={createCustomer.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {createCustomer.isPending ? 'جارٍ الحفظ...' : 'حفظ'}
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
