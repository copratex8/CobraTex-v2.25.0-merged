/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

const CAT: Record<string, string> = { warp: 'سدى', weft: 'لحمة', knit: 'ترايكو', dye: 'صباغة', finish: 'تجهيز', yarn: 'غزل', other: 'أخرى' };

/** كتالوج عيوب القماش + فحص رول بتسجيل العيوب بالنوع (النقاط تُحسب تلقائيًا) + باريتو العيوب. */
export default function DefectsPage() {
  const { data: types } = useGet('/textile/defect-types');
  const { data: pareto } = useGet('/textile/reports/defect-pareto');
  const { busy, post } = useAction();
  const [t, setT] = useState({ code: '', nameAr: '', category: 'other', points: 2 });
  const [roll, setRoll] = useState({ rollNo: '', lengthM: '', widthCm: '', weightKg: '' });
  const [lines, setLines] = useState<Array<{ defectTypeId: string; occurrences: string }>>([{ defectTypeId: '', occurrences: '1' }]);
  const active: Row[] = (types ?? []).filter((x: Row) => x.is_active);
  const pts = (id: string) => Number(active.find((x) => x.id === id)?.points ?? 0);
  const total = lines.reduce((s, l) => s + pts(l.defectTypeId) * (Number(l.occurrences) || 0), 0);

  const addType = async (e: FormEvent) => { e.preventDefault(); if (await post('/textile/defect-types', t, 'أُضيف نوع العيب')) setT({ ...t, code: '', nameAr: '' }); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const defects = lines.filter((l) => l.defectTypeId).map((l) => ({ defectTypeId: l.defectTypeId, occurrences: Number(l.occurrences) }));
    const r = await post<any>('/textile/rolls-with-defects', { rollNo: roll.rollNo, lengthM: Number(roll.lengthM), widthCm: Number(roll.widthCm), ...(roll.weightKg ? { weightKg: Number(roll.weightKg) } : {}), defects }, 'سُجِّل الرول');
    if (r) { setRoll({ rollNo: '', lengthM: '', widthCm: '', weightKg: '' }); setLines([{ defectTypeId: '', occurrences: '1' }]); }
  };

  return (
    <div>
      <PageHeader title="كتالوج العيوب وفحص الرولات" sub="نقاط الرول = مجموع (عدد × نقاط نوع العيب) ثم تُحوَّل لنقاط/100 ياردة² والدرجة">
        <button className="btn" disabled={busy} onClick={() => post('/textile/defect-types/seed', {}, 'تم تحميل الكتالوج الافتراضي')}>تحميل الكتالوج الافتراضي</button>
      </PageHeader>
      <TextileNav />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="فحص رول بالعيوب">
          <form onSubmit={submit} className="grid gap-3 md:grid-cols-4">
            <Field label="رقم الرول"><input required className={inputCls} value={roll.rollNo} onChange={(e) => setRoll({ ...roll, rollNo: e.target.value })} /></Field>
            <Field label="الطول (م)"><input required inputMode="decimal" className={inputCls} value={roll.lengthM} onChange={(e) => setRoll({ ...roll, lengthM: e.target.value })} /></Field>
            <Field label="العرض (سم)"><input required inputMode="decimal" className={inputCls} value={roll.widthCm} onChange={(e) => setRoll({ ...roll, widthCm: e.target.value })} /></Field>
            <Field label="الوزن (كجم)"><input inputMode="decimal" className={inputCls} value={roll.weightKg} onChange={(e) => setRoll({ ...roll, weightKg: e.target.value })} /></Field>
            <div className="md:col-span-4 space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <select className={inputCls} value={l.defectTypeId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, defectTypeId: e.target.value } : x)))}>
                    <option value="">— نوع العيب —</option>{active.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar} ({x.points})</option>)}
                  </select>
                  <input className={inputCls + ' max-w-24'} inputMode="numeric" value={l.occurrences} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, occurrences: e.target.value } : x)))} />
                  <button type="button" className="btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="btn" onClick={() => setLines([...lines, { defectTypeId: '', occurrences: '1' }])}>+ عيب</button>
            </div>
            <div className="md:col-span-4 flex items-center justify-between"><b>إجمالي النقاط: {total}</b><button className="btn btn-gold" disabled={busy}>حفظ الرول</button></div>
          </form>
        </Card>
        <Card title="إضافة نوع عيب">
          <form onSubmit={addType} className="grid gap-3 md:grid-cols-4">
            <Field label="الكود"><input required className={inputCls} value={t.code} onChange={(e) => setT({ ...t, code: e.target.value })} /></Field>
            <Field label="الاسم"><input required className={inputCls} value={t.nameAr} onChange={(e) => setT({ ...t, nameAr: e.target.value })} /></Field>
            <Field label="التصنيف"><select className={inputCls} value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })}>{Object.entries(CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="النقاط (1-4)"><select className={inputCls} value={t.points} onChange={(e) => setT({ ...t, points: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></Field>
            <div className="md:col-span-4"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
          </form>
          <DataTable rows={types} empty="لا كتالوج بعد — اضغط «تحميل الكتالوج الافتراضي»." cols={[{ h: 'الكود', k: 'code' }, { h: 'العيب', k: 'name_ar' }, { h: 'التصنيف', r: (r) => CAT[r.category] ?? r.category }, { h: 'نقاط', k: 'points' }]} />
        </Card>
      </div>
      <Card title="باريتو العيوب (الأكثر تسبّبًا في النقاط)">
        <DataTable rows={pareto} empty="لا عيوب مسجَّلة بالنوع بعد." cols={[{ h: 'العيب', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'مرات', k: 'occurrences' }, { h: 'رولات', k: 'rolls' }, { h: 'نقاط', k: 'points' }, { h: 'النسبة %', r: (r) => num(r.sharePercent, 1) }, { h: 'تراكمي %', r: (r) => num(r.cumulativePercent, 1) }]} />
      </Card>
    </div>
  );
}
