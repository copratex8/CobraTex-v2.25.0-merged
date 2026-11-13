import { useState, type FormEvent } from 'react';
import { useItems } from '@/features/catalog/api';
import { Card, DataTable, Field, PageHeader, STAGE_LABELS, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

type Tab = 'stages' | 'waste' | 'tests';

/** إعداد المراحل (نسب هالك قياسية)، أنواع الهالك (قابلة للاسترداد أم لا)، وأنواع اختبارات الجودة وحدودها. */
export default function TextileSetupPage() {
  const [tab, setTab] = useState<Tab>('stages');
  return (
    <div>
      <PageHeader title="المراحل والهوالك والجودة" sub="النسب القياسية قيم مرجعية — عايِرها على بيانات مصنعك" />
      <TextileNav />
      <div className="mb-4 flex gap-2">
        {([['stages', 'مراحل الإنتاج'], ['waste', 'أنواع الهالك'], ['tests', 'أنواع اختبارات الجودة']] as Array<[Tab, string]>).map(([k, l]) => (
          <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'stages' && <Stages />}
      {tab === 'waste' && <WasteTypes />}
      {tab === 'tests' && <TestTypes />}
    </div>
  );
}

function Stages() {
  const { data } = useGet('/textile/stages');
  const { busy, post, put } = useAction();
  const [f, setF] = useState({ code: '', nameAr: '', nameEn: '', stageType: 'ring_spinning', standardWastePercent: '0' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await post('/textile/stages', { ...f, sortOrder: 500 }, 'تمت إضافة المرحلة')) setF({ ...f, code: '', nameAr: '', nameEn: '' });
  };
  return (
    <Card title="مراحل الإنتاج">
      <DataTable rows={data} cols={[
        { h: 'الكود', k: 'code' }, { h: 'الاسم', k: 'name_ar' }, { h: 'النوع', r: (r) => STAGE_LABELS[r.stage_type] ?? r.stage_type },
        { h: 'هالك قياسي %', r: (r) => (
          <input defaultValue={r.standard_waste_percent} key={r.standard_waste_percent} className="w-24 rounded border border-slate-300 px-2 py-1 text-sm" dir="ltr"
            onBlur={(e) => { if (e.target.value !== String(r.standard_waste_percent) && /^\d+(\.\d{1,4})?$/.test(e.target.value)) void put(`/textile/stages/${r.id}`, { standardWastePercent: e.target.value }, 'تم الحفظ'); }} />
        ) },
        { h: 'مفعّلة', r: (r) => <input type="checkbox" checked={r.is_active} disabled={busy} onChange={(e) => void put(`/textile/stages/${r.id}`, { isActive: e.target.checked })} /> },
      ]} />
      <form onSubmit={submit} className="mt-4 grid gap-3 md:grid-cols-6">
        <Field label="الكود"><input required className={inputCls} dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="الاسم (عربي)"><input required className={inputCls} value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
        <Field label="الاسم (إنجليزي)"><input required className={inputCls} dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
        <Field label="النوع"><select className={inputCls} value={f.stageType} onChange={(e) => setF({ ...f, stageType: e.target.value })}>{Object.entries(STAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="هالك قياسي %"><input className={inputCls} dir="ltr" value={f.standardWastePercent} onChange={(e) => setF({ ...f, standardWastePercent: e.target.value })} /></Field>
        <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
      </form>
    </Card>
  );
}

function WasteTypes() {
  const { data } = useGet('/textile/waste-types');
  const { data: stages } = useGet('/textile/stages');
  const { data: items } = useItems();
  const { busy, post, put } = useAction();
  const [f, setF] = useState({ code: '', nameAr: '', nameEn: '', stageId: '', isRecoverable: true, recoveryItemId: '', recoveryUnitValue: '0' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { code: f.code, nameAr: f.nameAr, nameEn: f.nameEn, isRecoverable: f.isRecoverable, recoveryUnitValue: f.recoveryUnitValue, ...(f.stageId ? { stageId: f.stageId } : {}), ...(f.recoveryItemId ? { recoveryItemId: f.recoveryItemId } : {}) };
    if (await post('/textile/waste-types', body, 'تمت إضافة نوع الهالك')) setF({ ...f, code: '', nameAr: '', nameEn: '' });
  };
  return (
    <Card title="أنواع الهالك" badge="الاسترداد يُدخل الهالك للمخزن بقيمة تخفض تكلفة المنتج">
      <DataTable rows={data} cols={[
        { h: 'الكود', k: 'code' }, { h: 'الاسم', k: 'name_ar' }, { h: 'المرحلة', r: (r) => r.stage_name_ar ?? '—' },
        { h: 'قابل للاسترداد', r: (r) => (r.is_recoverable ? 'نعم' : 'لا (فاقد)') }, { h: 'صنف الاسترداد', r: (r) => r.recovery_item_name_ar ?? '—' },
        { h: 'قيمة الكيلو', r: (r) => num(r.recovery_unit_value, 4) },
        { h: 'مفعّل', r: (r) => <input type="checkbox" checked={r.is_active} disabled={busy} onChange={(e) => void put(`/textile/waste-types/${r.id}`, { isActive: e.target.checked })} /> },
      ]} />
      <form onSubmit={submit} className="mt-4 grid gap-3 md:grid-cols-4">
        <Field label="الكود"><input required className={inputCls} dir="ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="الاسم (عربي)"><input required className={inputCls} value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
        <Field label="الاسم (إنجليزي)"><input required className={inputCls} dir="ltr" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} /></Field>
        <Field label="المرحلة"><select className={inputCls} value={f.stageId} onChange={(e) => setF({ ...f, stageId: e.target.value })}><option value="">—</option>{stages?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
        <Field label="قابل للاسترداد"><select className={inputCls} value={String(f.isRecoverable)} onChange={(e) => setF({ ...f, isRecoverable: e.target.value === 'true' })}><option value="true">نعم</option><option value="false">لا (فاقد)</option></select></Field>
        <Field label="صنف الهالك بالمخزن"><select className={inputCls} value={f.recoveryItemId} onChange={(e) => setF({ ...f, recoveryItemId: e.target.value })}><option value="">—</option>{items?.filter((i) => i.is_active).map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}</select></Field>
        <Field label="قيمة استرداد الوحدة"><input className={inputCls} dir="ltr" value={f.recoveryUnitValue} onChange={(e) => setF({ ...f, recoveryUnitValue: e.target.value })} /></Field>
        <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
      </form>
    </Card>
  );
}

function TestTypes() {
  const { data } = useGet('/textile/quality/types');
  const { busy, put } = useAction();
  const limit = (r: Row, k: 'min_value' | 'max_value', body: 'minValue' | 'maxValue') => (
    <input defaultValue={r[k] ?? ''} key={`${r.id}${k}${r[k]}`} className="w-24 rounded border border-slate-300 px-2 py-1 text-sm" dir="ltr" placeholder="—"
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(r[k] ?? '') && (v === '' || /^-?\d+(\.\d{1,4})?$/.test(v))) void put(`/textile/quality/types/${r.id}`, { [body]: v === '' ? null : v }, 'تم الحفظ'); }} />
  );
  return (
    <Card title="أنواع اختبارات الجودة" badge="حدود القبول فارغة حتى تضبطها">
      <DataTable rows={data} cols={[
        { h: 'الكود', k: 'code' }, { h: 'الاختبار', k: 'name_ar' }, { h: 'ينطبق على', r: (r) => ({ fiber: 'ألياف', yarn: 'غزل', fabric: 'قماش', other: 'أخرى' } as Record<string, string>)[r.applies_to] },
        { h: 'الوحدة', r: (r) => r.unit ?? '—' }, { h: 'أدنى', r: (r) => limit(r, 'min_value', 'minValue') }, { h: 'أعلى', r: (r) => limit(r, 'max_value', 'maxValue') },
        { h: 'مفعّل', r: (r) => <input type="checkbox" checked={r.is_active} disabled={busy} onChange={(e) => void put(`/textile/quality/types/${r.id}`, { isActive: e.target.checked })} /> },
      ]} />
    </Card>
  );
}
