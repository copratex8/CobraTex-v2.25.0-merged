import { useState, type FormEvent } from 'react';
import Modal from '@/components/Modal';
import { useUoms, useItemCategories, useCreateItem } from '@/features/catalog/api';
import { extractErrorMessage } from '@/api/client';

const kindLabels: Record<string, string> = {
  raw_material: 'مادة خام', fabric: 'قماش', thread: 'خيط', finished_good: 'منتج تام', generic: 'عام',
};

interface Props {
  onClose: () => void;
}

export default function ItemCreateModal({ onClose }: Props) {
  const { data: uoms } = useUoms();
  const { data: categories } = useItemCategories();
  const createItem = useCreateItem();

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [itemKind, setItemKind] = useState<'raw_material' | 'fabric' | 'thread' | 'finished_good' | 'generic'>('generic');
  const [baseUomId, setBaseUomId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createItem.mutateAsync({
        code, nameAr, nameEn, itemKind, baseUomId, categoryId: categoryId || undefined,
      });
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  }

  return (
    <Modal title="صنف جديد" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="الكود" value={code} onChange={setCode} required />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">النوع</span>
            <select value={itemKind} onChange={(e) => setItemKind(e.target.value as typeof itemKind)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        <Field label="الاسم بالعربية" value={nameAr} onChange={setNameAr} required />
        <Field label="الاسم بالإنجليزية" value={nameEn} onChange={setNameEn} required />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">وحدة القياس الأساسية</span>
          <select value={baseUomId} onChange={(e) => setBaseUomId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" required>
            <option value="">اختر وحدة</option>
            {uoms?.map((u) => <option key={u.id} value={u.id}>{u.name_ar} ({u.symbol})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">فئة الصنف (اختياري)</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="">بلا فئة</option>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
          </select>
        </label>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">إلغاء</button>
          <button type="submit" disabled={createItem.isPending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {createItem.isPending ? 'جارٍ الحفظ...' : 'حفظ'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
    </label>
  );
}
