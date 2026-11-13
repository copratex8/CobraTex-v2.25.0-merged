/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, useAction, useGet } from '@/features/textile/shared';

type S = { name: string; ratePerHour: string; units: string; efficiencyPercent: string; hoursPerDay: string; unitsPerFinal: string; setupHoursPerDay: string; breakdownPercent: string };
const blank = (): S => ({ name: '', ratePerHour: '', units: '1', efficiencyPercent: '85', hoursPerDay: '22', unitsPerFinal: '1', setupHoursPerDay: '', breakdownPercent: '' });

/** محاكي طاقة الخط المتسلسل: يحدّد المرحلة الأضيق (الاختناق) وأثر إضافة وحدة وعدد الوحدات اللازمة لهدف يومي. */
export default function SimulatorPage() {
  const { data: defs } = useGet<any[]>('/textile/simulator/defaults');
  const { busy, post } = useAction();
  const [stages, setStages] = useState<S[]>([blank()]);
  const [target, setTarget] = useState('');
  const [demand, setDemand] = useState('');
  const [res, setRes] = useState<any>(null);

  const load = () => defs && setStages(defs.map((d) => ({ name: d.name, ratePerHour: String(d.ratePerHour), units: String(d.units), efficiencyPercent: String(d.efficiencyPercent), hoursPerDay: String(d.hoursPerDay), unitsPerFinal: String(d.unitsPerFinal), setupHoursPerDay: '', breakdownPercent: '' })));
  const set = (i: number, k: keyof S, v: string) => setStages(stages.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const run = async () => {
    const r = await post('/textile/simulator/run', {
      stages: stages.map((s) => ({ name: s.name || '—', ratePerHour: Number(s.ratePerHour), units: Number(s.units), efficiencyPercent: Number(s.efficiencyPercent), hoursPerDay: Number(s.hoursPerDay), unitsPerFinal: Number(s.unitsPerFinal), ...(s.setupHoursPerDay ? { setupHoursPerDay: Number(s.setupHoursPerDay) } : {}), ...(s.breakdownPercent ? { breakdownPercent: Number(s.breakdownPercent) } : {}) })),
      ...(target ? { targetPerDay: Number(target) } : {}), ...(demand ? { demandQty: Number(demand) } : {}),
    });
    setRes(r);
  };

  return (
    <div>
      <PageHeader title="محاكي طاقة الخط (الاختناق)" sub="طاقة كل مرحلة مُحوَّلة لوحدة المنتج النهائي؛ أضيق مرحلة تحدّد طاقة الخط كله">
        <button className="btn" onClick={load} disabled={!defs || defs.length === 0}>تحميل من الماكينات ({defs?.length ?? 0})</button>
      </PageHeader>
      <TextileNav />
      <Card title="المراحل">
        <div className="space-y-2">
          <div className="hidden grid-cols-9 gap-2 text-xs text-slate-500 md:grid"><span>المرحلة</span><span>طاقة/ساعة</span><span>عدد الوحدات</span><span>الكفاءة %</span><span>ساعات/يوم</span><span>وحدات لكل 1 نهائي (شامل الهالك)</span><span>تجهيز (ساعة/يوم)</span><span>أعطال %</span><span /></div>
          {stages.map((s, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-9">
              {(['name', 'ratePerHour', 'units', 'efficiencyPercent', 'hoursPerDay', 'unitsPerFinal', 'setupHoursPerDay', 'breakdownPercent'] as const).map((k) => <input key={k} className={inputCls} inputMode={k === 'name' ? 'text' : 'decimal'} value={s[k]} onChange={(e) => set(i, k, e.target.value)} />)}
              <button className="btn" onClick={() => setStages(stages.filter((_, j) => j !== i))} disabled={stages.length === 1}>✕</button>
            </div>
          ))}
          <button className="btn" onClick={() => setStages([...stages, blank()])}>+ مرحلة</button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="هدف يومي (نهائي/يوم)"><input className={inputCls} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
          <Field label="كمية طلب (لحساب الأيام)"><input className={inputCls} inputMode="decimal" value={demand} onChange={(e) => setDemand(e.target.value)} /></Field>
          <button className="btn btn-gold" disabled={busy} onClick={run}>محاكاة</button>
        </div>
      </Card>
      {res && (
        <>
          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <Kpi label="طاقة الخط/يوم" value={num(res.lineCapacityPerDay, 1)} />
            <Kpi label="الاختناق" value={res.bottleneckStage} tone="bad" />
            <Kpi label="بإضافة وحدة للاختناق" value={`+${num(res.withOneMoreUnit.gainPercent, 1)}%`} hint={`التالي: ${res.withOneMoreUnit.nextBottleneck}`} tone="good" />
            <Kpi label="أيام الطلب" value={res.daysForDemand ?? '—'} />
          </div>
          {res.target && <p className={`mb-3 text-sm ${res.target.met ? 'text-emerald-700' : 'text-red-700'}`}>{res.target.met ? '✔ الهدف اليومي متاح.' : `✖ عجز ${num(res.target.shortfallPerDay, 1)} نهائي/يوم عن الهدف.`}</p>}
          <Card title="النتيجة بالمراحل">
            <DataTable rows={res.stages} cols={[{ h: 'المرحلة', r: (r) => <b className={r.isBottleneck ? 'text-red-700' : ''}>{r.name}{r.isBottleneck ? ' ⛔' : ''}</b> }, { h: 'طاقة (نهائي/يوم)', r: (r) => num(r.finalPerDay, 1) }, { h: 'استغلال عند طاقة الخط %', r: (r) => num(r.utilizationPercent, 1) }, { h: 'وحدات لازمة للهدف', r: (r) => r.unitsNeededForTarget ?? '—' }]} />
          </Card>
        </>
      )}
    </div>
  );
}
