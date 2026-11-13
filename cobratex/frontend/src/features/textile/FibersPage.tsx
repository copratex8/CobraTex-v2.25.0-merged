import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const FIBERS: Record<string, string> = { cotton: 'قطن', polyester: 'بوليستر', viscose: 'فسكوز', acrylic: 'أكريليك', wool: 'صوف', nylon: 'نايلون', blend: 'خليط', other: 'أخرى' };
const LOT_STATUS: Record<string, string> = { available: 'متاح', in_use: 'قيد الاستخدام', consumed: 'مستهلك', rejected: 'مرفوض' };
const PROPS: Array<[string, string]> = [['stapleLengthMm', 'طول التيلة مم'], ['micronaire', 'مايكرونير'], ['strengthGtex', 'المتانة g/tex'], ['uniformityPercent', 'الانتظام %'], ['shortFiberPercent', 'التيلة القصيرة %'], ['trashPercent', 'الشوائب %'], ['moisturePercent', 'الرطوبة %']];

/** لوطات الألياف (بخصائص HVI) وخطط الخلط بمتوسطات مرجَّحة وأقصى كمية ممكنة. */
export default function FibersPage() {
  const { data: lots } = useGet('/textile/fiber-lots');
  const { data: plans } = useGet('/textile/mixing-plans');
  const { busy, post, put, run } = useAction();
  const [detail, setDetail] = useState<Row | null>(null);

  const empty = { lotCode: '', fiberType: 'cotton', variety: '', origin: '', supplierName: '', balesCount: '', netWeightKg: '', stapleLengthMm: '', micronaire: '', strengthGtex: '', uniformityPercent: '', shortFiberPercent: '', trashPercent: '', moisturePercent: '', pricePerKg: '' };
  const [f, setF] = useState(empty);
  const addLot = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { lotCode: f.lotCode, fiberType: f.fiberType, netWeightKg: f.netWeightKg, receivedDate: today() };
    for (const k of ['variety', 'origin', 'supplierName', 'stapleLengthMm', 'micronaire', 'strengthGtex', 'uniformityPercent', 'shortFiberPercent', 'trashPercent', 'moisturePercent', 'pricePerKg'] as const) if (f[k]) body[k] = f[k];
    if (f.balesCount) body.balesCount = Number(f.balesCount);
    if (await post('/textile/fiber-lots', body, 'تم تسجيل اللوط')) setF(empty);
  };

  const [plan, setPlan] = useState({ planNo: '', name: '', targetCountNe: '' });
  const [lines, setLines] = useState<Array<{ lotId: string; percent: string }>>([{ lotId: '', percent: '' }]);
  const total = lines.reduce((a, l) => a + (Number(l.percent) || 0), 0);
  const addPlan = async (e: FormEvent) => {
    e.preventDefault();
    const body = { planNo: plan.planNo, name: plan.name, ...(plan.targetCountNe ? { targetCountNe: plan.targetCountNe } : {}), lines: lines.filter((l) => l.lotId && l.percent) };
    if (await post('/textile/mixing-plans', body, 'تم حفظ خطة الخلط')) { setPlan({ planNo: '', name: '', targetCountNe: '' }); setLines([{ lotId: '', percent: '' }]); }
  };
  const open = async (id: string) => { const d = await run(() => import('@/api/client').then(({ apiClient }) => apiClient.get(`/textile/mixing-plans/${id}`))); setDetail(d); };

  return (
    <div>
      <PageHeader title="الألياف وخطط الخلط" sub="لوطات القطن/البوليستر بخصائصها، وحساب خصائص الخلطة" />
      <TextileNav />
      <Card title="لوطات الألياف">
        <DataTable rows={lots} cols={[
          { h: 'اللوط', k: 'lot_code' }, { h: 'النوع', r: (r) => FIBERS[r.fiber_type] ?? r.fiber_type }, { h: 'الصنف/المنشأ', r: (r) => [r.variety, r.origin].filter(Boolean).join(' / ') || '—' },
          { h: 'الوزن كجم', r: (r) => num(r.net_weight_kg, 1) }, { h: 'طول التيلة', r: (r) => num(r.staple_length_mm, 1) }, { h: 'مايكرونير', r: (r) => num(r.micronaire, 2) },
          { h: 'المتانة', r: (r) => num(r.strength_gtex, 1) }, { h: 'سعر/كجم', r: (r) => num(r.price_per_kg, 2) }, { h: 'الحالة', r: (r) => LOT_STATUS[r.status] ?? r.status },
          { h: '', r: (r) => r.status === 'available' ? <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => put(`/textile/fiber-lots/${r.id}`, { status: 'consumed' }, 'تم تعليم اللوط مستهلكًا')}>مستهلك</button> : null },
        ]} />
        <form onSubmit={addLot} className="mt-4 grid gap-3 md:grid-cols-6">
          <Field label="كود اللوط"><input required className={inputCls} dir="ltr" value={f.lotCode} onChange={(e) => setF({ ...f, lotCode: e.target.value })} /></Field>
          <Field label="نوع الليف"><select className={inputCls} value={f.fiberType} onChange={(e) => setF({ ...f, fiberType: e.target.value })}>{Object.entries(FIBERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="الصنف (جيزة 86…)"><input className={inputCls} value={f.variety} onChange={(e) => setF({ ...f, variety: e.target.value })} /></Field>
          <Field label="المنشأ"><input className={inputCls} value={f.origin} onChange={(e) => setF({ ...f, origin: e.target.value })} /></Field>
          <Field label="المورد"><input className={inputCls} value={f.supplierName} onChange={(e) => setF({ ...f, supplierName: e.target.value })} /></Field>
          <Field label="عدد البالات"><input className={inputCls} dir="ltr" value={f.balesCount} onChange={(e) => setF({ ...f, balesCount: e.target.value })} /></Field>
          <Field label="صافي الوزن كجم"><input required className={inputCls} dir="ltr" value={f.netWeightKg} onChange={(e) => setF({ ...f, netWeightKg: e.target.value })} /></Field>
          <Field label="طول التيلة مم"><input className={inputCls} dir="ltr" value={f.stapleLengthMm} onChange={(e) => setF({ ...f, stapleLengthMm: e.target.value })} /></Field>
          <Field label="مايكرونير"><input className={inputCls} dir="ltr" value={f.micronaire} onChange={(e) => setF({ ...f, micronaire: e.target.value })} /></Field>
          <Field label="المتانة g/tex"><input className={inputCls} dir="ltr" value={f.strengthGtex} onChange={(e) => setF({ ...f, strengthGtex: e.target.value })} /></Field>
          <Field label="الانتظام %"><input className={inputCls} dir="ltr" value={f.uniformityPercent} onChange={(e) => setF({ ...f, uniformityPercent: e.target.value })} /></Field>
          <Field label="تيلة قصيرة %"><input className={inputCls} dir="ltr" value={f.shortFiberPercent} onChange={(e) => setF({ ...f, shortFiberPercent: e.target.value })} /></Field>
          <Field label="شوائب %"><input className={inputCls} dir="ltr" value={f.trashPercent} onChange={(e) => setF({ ...f, trashPercent: e.target.value })} /></Field>
          <Field label="رطوبة %"><input className={inputCls} dir="ltr" value={f.moisturePercent} onChange={(e) => setF({ ...f, moisturePercent: e.target.value })} /></Field>
          <Field label="سعر الكجم"><input className={inputCls} dir="ltr" value={f.pricePerKg} onChange={(e) => setF({ ...f, pricePerKg: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة لوط</button></div>
        </form>
      </Card>

      <Card title="خطط الخلط (Laydown)">
        <DataTable rows={plans} cols={[
          { h: 'الرقم', k: 'plan_no' }, { h: 'الاسم', k: 'name' }, { h: 'Ne المستهدف', r: (r) => num(r.target_count_ne, 1) }, { h: 'اللوطات', k: 'n' },
          { h: 'مجموع النسب', r: (r) => <b className={Number(r.total) === 100 ? 'text-emerald-700' : 'text-red-700'}>{num(r.total, 2)}%</b> }, { h: 'الحالة', r: (r) => (r.status === 'approved' ? 'معتمدة' : 'مسودة') },
          { h: '', r: (r) => <button className="btn btn-sm btn-outline" onClick={() => void open(r.id)}>عرض</button> },
        ]} />
        {detail && (
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="mb-2 font-bold">{detail.plan_no} — {detail.name}</p>
            <DataTable rows={detail.lines} cols={[{ h: 'اللوط', k: 'lot_code' }, { h: 'النسبة %', r: (r) => num(r.percent, 2) }, { h: 'المتاح كجم', r: (r) => num(r.net_weight_kg, 1) }]} />
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              {PROPS.map(([k, label]) => <div key={k} className="rounded bg-white p-2 ring-1 ring-slate-200"><p className="text-xs text-slate-500">{label}</p><p className="font-bold">{detail.blend.properties[k] ? num(detail.blend.properties[k], 2) : '—'}</p></div>)}
              <div className="rounded bg-white p-2 ring-1 ring-slate-200"><p className="text-xs text-slate-500">أقصى خلطة كجم</p><p className="font-bold">{detail.blend.maxMixKg ? num(detail.blend.maxMixKg, 0) : '—'}</p><p className="text-[10px] text-slate-400">يحدّدها: {detail.blend.limitingLot ?? '—'}</p></div>
              <div className="rounded bg-white p-2 ring-1 ring-slate-200"><p className="text-xs text-slate-500">تكلفة كجم الخلطة</p><p className="font-bold">{detail.blend.costPerKg ? num(detail.blend.costPerKg, 2) : '—'}</p></div>
            </div>
            {detail.blend.warnings.map((w: string) => <p key={w} className="mt-2 text-xs text-amber-700">⚠ {w}</p>)}
            {detail.status !== 'approved' && <button className="btn btn-sm btn-success mt-3" disabled={busy} onClick={async () => { if (await post(`/textile/mixing-plans/${detail.id}/approve`, {}, 'تم اعتماد الخطة')) setDetail(null); }}>اعتماد الخطة</button>}
          </div>
        )}
        <form onSubmit={addPlan} className="mt-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="رقم الخطة"><input required className={inputCls} dir="ltr" value={plan.planNo} onChange={(e) => setPlan({ ...plan, planNo: e.target.value })} /></Field>
            <Field label="الاسم"><input required className={inputCls} value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} /></Field>
            <Field label="Ne المستهدف"><input className={inputCls} dir="ltr" value={plan.targetCountNe} onChange={(e) => setPlan({ ...plan, targetCountNe: e.target.value })} /></Field>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid gap-3 md:grid-cols-4">
              <Field label={`اللوط ${i + 1}`}><select className={inputCls} value={l.lotId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, lotId: e.target.value } : x)))}><option value="">—</option>{lots?.filter((x: Row) => x.status !== 'rejected').map((x: Row) => <option key={x.id} value={x.id}>{x.lot_code} ({FIBERS[x.fiber_type]})</option>)}</select></Field>
              <Field label="النسبة %"><input className={inputCls} dir="ltr" value={l.percent} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} /></Field>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setLines([...lines, { lotId: '', percent: '' }])}>+ لوط</button>
            <span className={`text-sm font-bold ${Math.abs(total - 100) < 0.005 ? 'text-emerald-700' : 'text-red-700'}`}>المجموع {total.toFixed(2)}%</span>
            <button className="btn btn-gold" disabled={busy}>حفظ الخطة</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
