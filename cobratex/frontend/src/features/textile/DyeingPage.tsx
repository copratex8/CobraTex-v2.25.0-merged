import { useState, type FormEvent } from 'react';
import { useBranches, useItems } from '@/features/catalog/api';
import { apiClient } from '@/api/client';
import { Card, DataTable, DateRange, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const PROCESS: Record<string, string> = { exhaust: 'استنفاد', continuous: 'مستمر', pad_batch: 'باد باتش', reactive: 'تفاعلي', disperse: 'تشتت', vat: 'فات', other: 'أخرى' };
const BASIS: Record<string, string> = { percent_owf: '% من وزن الخامة', g_per_l: 'جم/لتر', kg_per_ton: 'كجم/طن' };
const BSTATUS: Record<string, string> = { planned: 'مخطط', running: 'تحت التشغيل', done: 'منتهية', rework: 'إعادة صباغة', rejected: 'مرفوضة' };

/** الصباغة: درجات الألوان ← وصفات بأساس الجرعة ← دفعات بنتيجة ΔE وثباتية، وحساب المواد المطلوبة. */
export default function DyeingPage() {
  const { data: shades } = useGet('/textile/dyeing/shades');
  const { data: recipes } = useGet('/textile/dyeing/recipes');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: batches } = useGet('/textile/dyeing/batches', { from, to });
  const { data: rep } = useGet<Row>('/textile/reports/dyeing', { from, to });
  const { data: machines } = useGet('/textile/machines');
  const { data: branches } = useBranches();
  const { data: items } = useItems();
  const { busy, post, put, run } = useAction();
  const [req, setReq] = useState<Row | null>(null);

  const [s, setS] = useState({ code: '', nameAr: '', nameEn: '', colorHex: '#3366cc', pantone: '' });
  const addShade = async (e: FormEvent) => {
    e.preventDefault();
    if (await post('/textile/dyeing/shades', { code: s.code, nameAr: s.nameAr, nameEn: s.nameEn || s.nameAr, colorHex: s.colorHex, ...(s.pantone ? { pantone: s.pantone } : {}) }, 'تمت إضافة الدرجة')) setS({ ...s, code: '', nameAr: '', nameEn: '', pantone: '' });
  };

  const [r, setR] = useState({ code: '', shadeId: '', processType: 'exhaust', liquorRatio: '10', temperatureC: '', durationMin: '' });
  const [rl, setRl] = useState<Array<{ itemId: string; amount: string; basis: string }>>([{ itemId: '', amount: '', basis: 'percent_owf' }]);
  const addRecipe = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      code: r.code, processType: r.processType, ...(r.shadeId ? { shadeId: r.shadeId } : {}), ...(r.liquorRatio ? { liquorRatio: r.liquorRatio } : {}),
      ...(r.temperatureC ? { temperatureC: r.temperatureC } : {}), ...(r.durationMin ? { durationMin: Number(r.durationMin) } : {}), lines: rl.filter((l) => l.itemId && l.amount),
    };
    if (await post('/textile/dyeing/recipes', body, 'تم حفظ الوصفة')) { setR({ ...r, code: '' }); setRl([{ itemId: '', amount: '', basis: 'percent_owf' }]); }
  };

  const [b, setB] = useState({ batchNo: '', recipeId: '', machineId: '', materialKg: '', batchDate: today() });
  const addBatch = async (e: FormEvent) => {
    e.preventDefault();
    const body = { branchId: branches?.[0]?.id, batchNo: b.batchNo, recipeId: b.recipeId, materialKg: b.materialKg, batchDate: b.batchDate, ...(b.machineId ? { machineId: b.machineId } : {}) };
    if (await post('/textile/dyeing/batches', body, 'تم إنشاء الدفعة')) setB({ ...b, batchNo: '', materialKg: '' });
  };
  const showReq = async (id: string) => setReq(await run(() => apiClient.get(`/textile/dyeing/batches/${id}/requirements`)));
  const [res, setRes] = useState<Record<string, Record<string, string>>>({});
  const setField = (id: string, k: string, v: string) => setRes({ ...res, [id]: { ...(res[id] ?? {}), [k]: v } });
  const saveResult = async (id: string) => {
    const v = res[id] ?? {};
    const body: Record<string, unknown> = {};
    for (const k of ['status', 'deltaE', 'shadeResult', 'fastnessWash', 'fastnessRub', 'fastnessLight', 'waterLiters', 'energyKwh', 'steamKg']) if (v[k]) body[k] = v[k];
    await put(`/textile/dyeing/batches/${id}/result`, body, 'تم حفظ النتيجة');
  };

  return (
    <div>
      <PageHeader title="الصباغة" sub="الدرجات والوصفات والدفعات ومطابقة اللون والثباتية" />
      <TextileNav />
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {rep && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="دفعات" value={rep.batches} hint={`${num(rep.totalKg, 0)} كجم`} />
          <Kpi label="إعادة صباغة" value={rep.redyeRatePercent ? `${num(rep.redyeRatePercent, 1)}%` : '—'} tone={Number(rep.redyeRatePercent) > 10 ? 'bad' : undefined} hint={`${rep.redyeBatches} دفعة`} />
          <Kpi label="ماء لتر/كجم" value={rep.waterLitersPerKg ? num(rep.waterLitersPerKg, 1) : '—'} />
          <Kpi label="كهرباء kWh/كجم" value={rep.kwhPerKg ? num(rep.kwhPerKg, 2) : '—'} />
        </div>
      )}

      <Card title="دفعات الصباغة">
        <DataTable rows={batches} cols={[
          { h: 'الدفعة', k: 'batch_no' }, { h: 'الوصفة', r: (x) => x.recipe_code ?? '—' }, { h: 'الدرجة', r: (x) => x.shade_name_ar ?? '—' }, { h: 'كجم', r: (x) => num(x.material_kg, 1) }, { h: 'التاريخ', r: (x) => String(x.batch_date).slice(0, 10) },
          { h: 'الحالة', r: (x) => BSTATUS[x.status] ?? x.status }, { h: 'ΔE', r: (x) => x.delta_e ?? '—' },
          { h: 'اللون', r: (x) => (x.shade_result === 'pass' ? <b className="text-emerald-700">مطابق</b> : x.shade_result === 'fail' ? <b className="text-red-700">غير مطابق</b> : '—') },
          {
            h: 'نتيجة', r: (x) => (
              <span className="flex flex-wrap items-center gap-1">
                <select className={inputCls + ' !w-28'} value={res[x.id]?.status ?? ''} onChange={(e) => setField(x.id, 'status', e.target.value)}><option value="">الحالة</option>{Object.entries(BSTATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input className={inputCls + ' !w-16'} dir="ltr" placeholder="ΔE" value={res[x.id]?.deltaE ?? ''} onChange={(e) => setField(x.id, 'deltaE', e.target.value)} />
                <input className={inputCls + ' !w-16'} dir="ltr" placeholder="ماء ل" value={res[x.id]?.waterLiters ?? ''} onChange={(e) => setField(x.id, 'waterLiters', e.target.value)} />
                <input className={inputCls + ' !w-16'} dir="ltr" placeholder="kWh" value={res[x.id]?.energyKwh ?? ''} onChange={(e) => setField(x.id, 'energyKwh', e.target.value)} />
                <button className="btn btn-sm btn-gold" disabled={busy} onClick={() => void saveResult(x.id)}>حفظ</button>
                <button className="btn btn-sm btn-outline" onClick={() => void showReq(x.id)}>المواد</button>
              </span>
            ),
          },
        ]} />
        {req && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="mb-2 font-bold">المواد المطلوبة للدفعة {req.batchNo} ({num(req.materialKg, 1)} كجم، نسبة حمّام {req.liquorRatio ?? '—'})</p>
            <DataTable rows={req.requirements} cols={[{ h: 'المادة', r: (x) => `${x.itemCode} — ${x.itemName}` }, { h: 'الكمية كجم', r: (x) => num(x.kg ?? x.quantityKg ?? x.quantity, 3) }]} />
          </div>
        )}
        <form onSubmit={addBatch} className="mt-4 grid gap-3 md:grid-cols-6">
          <Field label="رقم الدفعة"><input required className={inputCls} dir="ltr" value={b.batchNo} onChange={(e) => setB({ ...b, batchNo: e.target.value })} /></Field>
          <Field label="الوصفة"><select required className={inputCls} value={b.recipeId} onChange={(e) => setB({ ...b, recipeId: e.target.value })}><option value="">—</option>{recipes?.map((x: Row) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></Field>
          <Field label="الماكينة"><select className={inputCls} value={b.machineId} onChange={(e) => setB({ ...b, machineId: e.target.value })}><option value="">—</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code}</option>)}</select></Field>
          <Field label="وزن الخامة كجم"><input required className={inputCls} dir="ltr" value={b.materialKg} onChange={(e) => setB({ ...b, materialKg: e.target.value })} /></Field>
          <Field label="التاريخ"><input type="date" className={inputCls} value={b.batchDate} onChange={(e) => setB({ ...b, batchDate: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>دفعة جديدة</button></div>
        </form>
      </Card>

      <Card title="الوصفات">
        <DataTable rows={recipes} cols={[{ h: 'الكود', k: 'code' }, { h: 'الدرجة', r: (x) => x.shade_name_ar ?? '—' }, { h: 'العملية', r: (x) => PROCESS[x.process_type] ?? x.process_type }, { h: 'نسبة الحمّام', r: (x) => x.liquor_ratio ?? '—' }, { h: 'حرارة °م', r: (x) => x.temperature_c ?? '—' }, { h: 'زمن د', r: (x) => x.duration_min ?? '—' }]} />
        <form onSubmit={addRecipe} className="mt-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-6">
            <Field label="كود الوصفة"><input required className={inputCls} dir="ltr" value={r.code} onChange={(e) => setR({ ...r, code: e.target.value })} /></Field>
            <Field label="الدرجة"><select className={inputCls} value={r.shadeId} onChange={(e) => setR({ ...r, shadeId: e.target.value })}><option value="">—</option>{shades?.map((x: Row) => <option key={x.id} value={x.id}>{x.name_ar}</option>)}</select></Field>
            <Field label="العملية"><select className={inputCls} value={r.processType} onChange={(e) => setR({ ...r, processType: e.target.value })}>{Object.entries(PROCESS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="نسبة الحمّام 1:"><input className={inputCls} dir="ltr" value={r.liquorRatio} onChange={(e) => setR({ ...r, liquorRatio: e.target.value })} /></Field>
            <Field label="حرارة °م"><input className={inputCls} dir="ltr" value={r.temperatureC} onChange={(e) => setR({ ...r, temperatureC: e.target.value })} /></Field>
            <Field label="الزمن (د)"><input className={inputCls} dir="ltr" value={r.durationMin} onChange={(e) => setR({ ...r, durationMin: e.target.value })} /></Field>
          </div>
          {rl.map((l, i) => (
            <div key={i} className="grid gap-3 md:grid-cols-4">
              <Field label={`مادة ${i + 1} (صبغة/كيماويات)`}><select className={inputCls} value={l.itemId} onChange={(e) => setRl(rl.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}><option value="">—</option>{items?.map((it) => <option key={it.id} value={it.id}>{it.code} — {it.name_ar}</option>)}</select></Field>
              <Field label="الجرعة"><input className={inputCls} dir="ltr" value={l.amount} onChange={(e) => setRl(rl.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /></Field>
              <Field label="الأساس"><select className={inputCls} value={l.basis} onChange={(e) => setRl(rl.map((x, j) => (j === i ? { ...x, basis: e.target.value } : x)))}>{Object.entries(BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            </div>
          ))}
          <div className="flex gap-2"><button type="button" className="btn btn-sm btn-outline" onClick={() => setRl([...rl, { itemId: '', amount: '', basis: 'percent_owf' }])}>+ مادة</button><button className="btn btn-gold" disabled={busy}>حفظ الوصفة</button></div>
        </form>
      </Card>

      <Card title="درجات الألوان">
        <DataTable rows={shades} cols={[{ h: 'اللون', r: (x) => <span className="inline-block h-4 w-8 rounded ring-1 ring-slate-300" style={{ background: x.color_hex ?? '#ccc' }} /> }, { h: 'الكود', k: 'code' }, { h: 'الاسم', k: 'name_ar' }, { h: 'Pantone', r: (x) => x.pantone ?? '—' }, { h: 'الحالة', r: (x) => (x.is_active ? 'نشطة' : 'موقوفة') }]} />
        <form onSubmit={addShade} className="mt-4 grid gap-3 md:grid-cols-6">
          <Field label="الكود"><input required className={inputCls} dir="ltr" value={s.code} onChange={(e) => setS({ ...s, code: e.target.value })} /></Field>
          <Field label="الاسم (عربي)"><input required className={inputCls} value={s.nameAr} onChange={(e) => setS({ ...s, nameAr: e.target.value })} /></Field>
          <Field label="الاسم (إنجليزي)"><input className={inputCls} dir="ltr" value={s.nameEn} onChange={(e) => setS({ ...s, nameEn: e.target.value })} /></Field>
          <Field label="اللون"><input type="color" className={inputCls + ' h-9'} value={s.colorHex} onChange={(e) => setS({ ...s, colorHex: e.target.value })} /></Field>
          <Field label="Pantone"><input className={inputCls} dir="ltr" value={s.pantone} onChange={(e) => setS({ ...s, pantone: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
        </form>
      </Card>
    </div>
  );
}
