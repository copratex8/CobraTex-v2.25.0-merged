/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { Card, DataTable, DateRange, Field, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const ROLE: Record<string, string> = { main: 'أساسي', warp: 'سدى', weft: 'لحمة', pile: 'وبرة', ground: 'أرضية' };
const STATUS: Record<string, string> = { draft: 'مسودة', locked: 'مثبَّتة (الحالية)', superseded: 'قديمة' };
const first = () => today().slice(0, 8) + '01';
type L = { yarnItemId: string; role: string; percent: string };

/** نسب الخيوط لكل صنف ولكل ماكينة: مسودة قابلة للتعديل ← تثبيت ← إصدار جديد عند تغيّر النسب. */
export default function BlendPage() {
  const { data: items } = useQuery({ queryKey: ['items-100'], queryFn: async () => (await apiClient.get('/items', { params: { page: 1, pageSize: 100 } })).data });
  const { data: machines } = useGet('/textile/machines');
  const [itemId, setItemId] = useState('');
  const { data: recipes } = useGet<any[]>('/textile/blend-recipes', itemId ? { itemId } : {});
  const { busy, post, put, run } = useAction();
  const list: any[] = Array.isArray(items) ? items : items?.data ?? [];
  const nm = (id: string) => list.find((i) => i.id === id)?.name_ar ?? '';

  const [editId, setEditId] = useState<string | null>(null);
  const [f, setF] = useState({ itemId: '', machineId: '', name: '', wastePercent: '0', notes: '' });
  const [lines, setLines] = useState<L[]>([{ yarnItemId: '', role: 'main', percent: '' }, { yarnItemId: '', role: 'main', percent: '' }]);
  const total = Math.round(lines.reduce((s, l) => s + Math.round(Number(l.percent || 0) * 1e4), 0)) / 1e4;
  const setLine = (i: number, p: Partial<L>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const body = () => ({ name: f.name, wastePercent: Number(f.wastePercent || 0), ...(f.notes ? { notes: f.notes } : {}), lines: lines.filter((l) => l.yarnItemId && l.percent).map((l) => ({ yarnItemId: l.yarnItemId, role: l.role, percent: Number(l.percent) })) });
  const reset = () => { setEditId(null); setF({ itemId, machineId: '', name: '', wastePercent: '0', notes: '' }); setLines([{ yarnItemId: '', role: 'main', percent: '' }, { yarnItemId: '', role: 'main', percent: '' }]); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (editId) await put(`/textile/blend-recipes/${editId}`, body(), 'حُفظت المسودة');
    else await post('/textile/blend-recipes', { itemId: f.itemId || itemId, ...(f.machineId ? { machineId: f.machineId } : {}), ...body() }, 'أُنشئت مسودة');
    reset();
  };
  const edit = (r: any) => { setEditId(r.id); setF({ itemId: r.item_id, machineId: r.machine_id ?? '', name: r.name, wastePercent: String(r.waste_percent), notes: r.notes ?? '' }); setLines(r.lines.map((l: any) => ({ yarnItemId: l.yarn_item_id, role: l.role, percent: String(l.percent) }))); };
  const newVer = (r: any) => { const reason = window.prompt('سبب تغيير النسب؟'); if (reason && reason.length >= 3) post(`/textile/blend-recipes/${r.id}/new-version`, { reason }, 'أُنشئ إصدار جديد (مسودة)'); };
  const copyTo = (r: any) => { const mid = window.prompt('رقم/كود الماكينة المنسوخ إليها (كما في الماكينات):'); const m = (machines as Row[] | undefined)?.find((x) => x.code === mid); if (!m) { if (mid) window.alert('ماكينة غير موجودة'); return; } post(`/textile/blend-recipes/${r.id}/new-version`, { reason: 'نسخ لماكينة ' + m.code, machineId: m.id }, 'نُسخت كمسودة للماكينة'); };

  const genBom = (r: any) => window.confirm('توليد قائمة مواد من هذه الوصفة (1 كجم مخرج، بنود الخيوط بنسبها وهالكها)؟') && post(`/textile/blend-recipes/${r.id}/generate-bom`, {}, 'وُلِّدت قائمة المواد');
  const { data: cmp } = useGet<any>(`/textile/blend-recipes/item/${itemId}/cost-comparison`, {}, !!itemId);
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today());
  const { data: rep } = useGet<any[]>('/textile/blend-recipes/report', { from, to });

  return (
    <div>
      <PageHeader title="نسب الخيوط (الوصفات)" sub="نسب مئوية من وزن المنتج. الوصفة العامة للصنف، ويمكن وصفة مخصّصة لماكينة بعينها. بعد التثبيت لا تُعدَّل — أي تغيير يكون إصدارًا جديدًا." />
      <TextileNav />
      <Card title={editId ? 'تعديل المسودة' : 'وصفة جديدة'}>
        <form onSubmit={save} className="grid gap-3 md:grid-cols-4">
          <Field label="الصنف (القماش/الغزل المنتَج)"><select required disabled={!!editId} className={inputCls} value={f.itemId || itemId} onChange={(e) => { setF({ ...f, itemId: e.target.value }); setItemId(e.target.value); }}><option value="">—</option>{list.map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}</select></Field>
          <Field label="الماكينة"><select disabled={!!editId} className={inputCls} value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value })}><option value="">(افتراضية لكل الماكينات)</option>{(machines as Row[] | undefined)?.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name_ar}</option>)}</select></Field>
          <Field label="اسم الوصفة"><input required className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="هالك %"><input inputMode="decimal" className={inputCls} value={f.wastePercent} onChange={(e) => setF({ ...f, wastePercent: e.target.value })} /></Field>
          <div className="md:col-span-4">
            {lines.map((l, i) => (
              <div key={i} className="mb-2 grid gap-2 md:grid-cols-4">
                <select className={inputCls} value={l.yarnItemId} onChange={(e) => setLine(i, { yarnItemId: e.target.value })}><option value="">— خيط —</option>{list.map((it) => <option key={it.id} value={it.id}>{it.name_ar}</option>)}</select>
                <select className={inputCls} value={l.role} onChange={(e) => setLine(i, { role: e.target.value })}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <input inputMode="decimal" placeholder="النسبة %" className={inputCls} value={l.percent} onChange={(e) => setLine(i, { percent: e.target.value })} />
                <button type="button" className="btn" onClick={() => setLines(lines.filter((_, k) => k !== i))} disabled={lines.length <= 1}>حذف</button>
              </div>
            ))}
            <button type="button" className="btn" onClick={() => setLines([...lines, { yarnItemId: '', role: 'main', percent: '' }])}>+ خيط</button>
            <span className={`mx-3 text-sm ${Math.abs(total - 100) < 0.0001 ? 'text-emerald-700' : 'text-amber-700'}`}>المجموع: {total}% {Math.abs(total - 100) < 0.0001 ? '✔' : '(يجب 100% للتثبيت)'}</span>
          </div>
          <div className="flex items-end gap-2"><button className="btn btn-gold" disabled={busy}>{editId ? 'حفظ التعديل' : 'حفظ كمسودة'}</button>{editId && <button type="button" className="btn" onClick={reset}>إلغاء</button>}</div>
        </form>
      </Card>
      <Card title="الوصفات والإصدارات">
        <DataTable rows={recipes} empty="لا وصفات." cols={[
          { h: 'الصنف', k: 'item_name' }, { h: 'النطاق', r: (r) => (r.machine_code ? `ماكينة ${r.machine_code}` : 'افتراضية') }, { h: 'الإصدار', r: (r) => `${r.name} (v${r.version_no})` },
          { h: 'الحالة', r: (r) => <span className={r.status === 'locked' ? 'font-bold text-emerald-700' : r.status === 'draft' ? 'text-amber-700' : 'text-slate-400'}>{STATUS[r.status]}</span> },
          { h: 'النسب', r: (r) => r.lines.map((l: any) => `${l.yarn_name} ${num(l.percent, 2)}%${l.role !== 'main' ? ` (${ROLE[l.role]})` : ''}`).join(' + ') }, { h: 'هالك', r: (r) => `${num(r.waste_percent, 2)}%` },
          { h: '', r: (r) => (
            <div className="flex flex-wrap gap-1">
              {r.status === 'draft' && <><button className="btn" disabled={busy} onClick={() => edit(r)}>تعديل</button>
                <button className="btn btn-gold" disabled={busy} onClick={() => window.confirm('تثبيت الوصفة؟ لن تُعدَّل بعد ذلك، وستحلّ محل الوصفة الحالية لنفس النطاق.') && post(`/textile/blend-recipes/${r.id}/lock`, {}, 'ثُبِّتت')}>تثبيت</button>
                <button className="btn" disabled={busy} onClick={() => window.confirm('حذف المسودة؟') && run(async () => apiClient.delete(`/textile/blend-recipes/${r.id}`), 'حُذفت')}>حذف</button></>}
              {r.status === 'locked' && <button className="btn" disabled={busy} onClick={() => genBom(r)}>توليد قائمة مواد</button>}
              {r.status !== 'draft' && <><button className="btn" disabled={busy} onClick={() => newVer(r)}>إصدار جديد بنسب مختلفة</button><button className="btn" disabled={busy} onClick={() => copyTo(r)}>نسخ لماكينة</button></>}
            </div>) }]} />
      </Card>
      {itemId && <Card title="مقارنة تكلفة الكجم بين الوصفات (من متوسط تكلفة رصيد الخيوط)">
        {cmp?.cheapest && <p className="mb-2 text-sm text-emerald-700">الأرخص: {cmp.cheapest.name} v{cmp.cheapest.version} {cmp.cheapest.machineCode ? `(ماكينة ${cmp.cheapest.machineCode})` : '(افتراضية)'} — {num(cmp.cheapest.totalCostPerKg, 2)}/كجم{cmp.savingVsDearestPerKg ? ` — توفير ${num(cmp.savingVsDearestPerKg, 2)} عن الأغلى` : ''}</p>}
        <DataTable rows={cmp?.recipes} empty="ثبِّت وصفة أولًا." cols={[{ h: 'الوصفة', r: (r) => `${r.name} v${r.version}` }, { h: 'النطاق', r: (r) => (r.machineCode ? `ماكينة ${r.machineCode}` : 'افتراضية') }, { h: 'الحالة', r: (r) => STATUS[r.status] }, { h: 'تكلفة الخيوط/كجم', r: (r) => (r.complete ? num(r.materialCostPerKg, 2) : 'ناقصة (خيط بلا رصيد/تكلفة)') }]} />
      </Card>}
      <Card title="الإنتاج والاستهلاك النظري لكل ماكينة ووصفة">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <DataTable rows={rep} empty="لا إنتاج مربوط بوصفة في الفترة (اربط أمر التصنيع بوصفة وسجّل إنتاج الماكينة عليه)." cols={[
          { h: 'الماكينة', r: (r) => `${r.machineCode} ${r.machineName}` }, { h: 'الصنف', k: 'itemName' }, { h: 'الوصفة', r: (r) => `${r.recipeName} v${r.version}` },
          { h: 'الإنتاج', r: (r) => num(r.output, 1) }, { h: 'ساعات', r: (r) => num(r.runHours, 1) },
          { h: 'الخيوط (نظريًا)', r: (r) => r.yarnUsage.map((y: any) => `${y.yarnName} ${num(y.quantity, 1)}`).join(' — ') }]} />
      </Card>
      <p className="text-xs text-slate-500">ربط الأمر: POST /textile/production-orders/:id/blend (تلقائي بحسب ماكينة الأمر)، ومقارنة الفعلي بالنسب: GET /textile/production-orders/:id/blend-variance. {nm('')}</p>
    </div>
  );
}
