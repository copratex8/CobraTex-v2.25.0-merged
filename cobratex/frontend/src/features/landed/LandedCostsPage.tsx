/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, DateRange, Field, Kpi, inputCls, num, today, useAction, useGet } from '@/features/textile/shared';

const METHODS: Record<string, string> = { value: 'بالقيمة', quantity: 'بالكمية', weight: 'بالوزن', volume: 'بالحجم', equal: 'بالتساوي', manual: 'نِسَب يدوية' };
type Tab = 'new' | 'docs' | 'report' | 'settings';
const first = () => today().slice(0, 8) + '01';

function Settings() {
  const { data: s } = useGet<any>('/landed-costs/settings', {}); const { data: accounts } = useGet<any[]>('/accounting/accounts', {}); const a = useAction();
  const [f, setF] = useState<any>(null); const v = f ?? (s && { defaultMethod: s.default_method, allowedMethods: s.allowed_methods, consumedPolicy: s.consumed_policy, inventoryAccountId: s.inventory_account_id ?? '', varianceAccountId: s.variance_account_id ?? '' });
  if (!v) return <Card>جارٍ التحميل…</Card>;
  const set = (k: string, x: any) => setF({ ...v, [k]: x });
  const opts = (types: string[]) => (accounts ?? []).filter((x) => types.includes(x.account_type)).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>);
  return (
    <Card title="إعدادات الشركة للتكاليف الإضافية">
      <p className="mb-2 text-xs text-slate-500">كل شركة تختار الطرق المسموحة وسياسة الجزء المستهلَك والحسابات — الباقي يظهر للمستخدم تلقائيًا.</p>
      <div className="mb-3 flex flex-wrap gap-3">{Object.entries(METHODS).map(([k, l]) => <label key={k} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={v.allowedMethods.includes(k)} onChange={(e) => set('allowedMethods', e.target.checked ? [...v.allowedMethods, k] : v.allowedMethods.filter((x: string) => x !== k))} />{l}</label>)}</div>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="الطريقة الافتراضية"><select className={inputCls} value={v.defaultMethod} onChange={(e) => set('defaultMethod', e.target.value)}>{v.allowedMethods.map((k: string) => <option key={k} value={k}>{METHODS[k]}</option>)}</select></Field>
        <Field label="الجزء المستهلَك من الكمية"><select className={inputCls} value={v.consumedPolicy} onChange={(e) => set('consumedPolicy', e.target.value)}><option value="expense_consumed">يُحمَّل على حساب الفروق/تكلفة المبيعات</option><option value="capitalize_remaining">يُرسمَل كله على المتبقي بالمخزون</option></select></Field>
        <Field label="حساب المخزون"><select className={inputCls} value={v.inventoryAccountId} onChange={(e) => set('inventoryAccountId', e.target.value)}><option value="">—</option>{opts(['asset'])}</select></Field>
        <Field label="حساب الفروق / تكلفة المبيعات"><select className={inputCls} value={v.varianceAccountId} onChange={(e) => set('varianceAccountId', e.target.value)}><option value="">—</option>{opts(['expense'])}</select></Field>
      </div>
      <button className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white" disabled={a.busy} onClick={() => a.put('/landed-costs/settings', { ...v, inventoryAccountId: v.inventoryAccountId || null, varianceAccountId: v.varianceAccountId || null }, 'حُفظت الإعدادات')}>حفظ</button>
      <div className="mt-4 border-t pt-3"><p className="mb-2 text-xs text-slate-500">بعد تشغيل «إعادة بناء الرصيد من السجل» يضيع أثر التكاليف الإضافية على متوسط التكلفة — هذا الزر يعيده (آمن للتكرار).</p>
        <button className="rounded bg-slate-200 px-4 py-2 text-sm" disabled={a.busy} onClick={async () => { const r = await a.post<any>('/landed-costs/reapply', {}); if (r) alert(`فُحص ${r.checked} رصيد، عُدِّل ${r.changed}`); }}>إعادة تطبيق التكاليف الإضافية على المتوسط</button></div>
    </Card>
  );
}

function NewDoc() {
  const { data: s } = useGet<any>('/landed-costs/settings', {}); const { data: accounts } = useGet<any[]>('/accounting/accounts', {});
  const { data: rcpts } = useGet<any>('/purchasing/receipts', { page: 1, pageSize: 50 }); const a = useAction();
  const [rid, setRid] = useState(''); const { data: rc } = useGet<any>(rid ? `/purchasing/receipts/${rid}` : '/purchasing/receipts/none', {}, !!rid);
  const [date, setDate] = useState(today()); const [method, setMethod] = useState('');
  const [comps, setComps] = useState<any[]>([{ name: 'شحن', amount: '', currency: '', method: '', creditAccountId: '' }]);
  const [extra, setExtra] = useState<Record<string, any>>({}); const [pv, setPv] = useState<any>(null);
  const allowed: string[] = s?.allowed_methods ?? Object.keys(METHODS); const m = method || s?.default_method || 'value';
  const lines = (rc?.lines ?? []);
  const body = () => ({ docDate: date, method: m, components: comps.map((c) => ({ name: c.name, amount: c.amount, currency: c.currency || undefined, method: c.method || undefined, creditAccountId: c.creditAccountId })), lines: lines.map((l: any) => ({ goodsReceiptLineId: l.id, weight: extra[l.id]?.weight || undefined, volume: extra[l.id]?.volume || undefined, manualPercent: extra[l.id]?.pct || undefined })) });
  const setC = (i: number, k: string, v: string) => setComps(comps.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const setX = (id: string, k: string, v: string) => setExtra({ ...extra, [id]: { ...extra[id], [k]: v } });
  const liab = (accounts ?? []).filter((x) => ['liability', 'asset'].includes(x.account_type));
  return (
    <Card title="مستند تكاليف إضافية">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="إيصال الاستلام"><select className={inputCls} value={rid} onChange={(e) => { setRid(e.target.value); setPv(null); }}><option value="">— اختر —</option>{(rcpts?.data ?? []).filter((r: any) => r.status === 'posted').map((r: any) => <option key={r.id} value={r.id}>{r.document_number} — {String(r.receipt_date).slice(0, 10)}</option>)}</select></Field>
        <Field label="التاريخ"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="طريقة التوزيع الافتراضية"><select className={inputCls} value={m} onChange={(e) => setMethod(e.target.value)}>{allowed.map((k) => <option key={k} value={k}>{METHODS[k]}</option>)}</select></Field>
      </div>
      <h3 className="mb-1 mt-4 font-semibold">المكوّنات</h3>
      {comps.map((c, i) => (
        <div key={i} className="mb-2 grid gap-2 md:grid-cols-6">
          <input className={inputCls} placeholder="الاسم (شحن/جمارك…)" value={c.name} onChange={(e) => setC(i, 'name', e.target.value)} /><input className={inputCls} placeholder="المبلغ" inputMode="decimal" value={c.amount} onChange={(e) => setC(i, 'amount', e.target.value)} />
          <input className={inputCls} placeholder="العملة (اختياري)" maxLength={3} value={c.currency} onChange={(e) => setC(i, 'currency', e.target.value.toUpperCase())} />
          <select className={inputCls} value={c.method} onChange={(e) => setC(i, 'method', e.target.value)}><option value="">طريقة المستند</option>{allowed.map((k) => <option key={k} value={k}>{METHODS[k]}</option>)}</select>
          <select className={inputCls} value={c.creditAccountId} onChange={(e) => setC(i, 'creditAccountId', e.target.value)}><option value="">حساب الدائن (مورد/خزينة)</option>{liab.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select>
          <button className="rounded bg-slate-200 px-2 text-sm" onClick={() => setComps(comps.filter((_, j) => j !== i))}>حذف</button>
        </div>))}
      <button className="mb-3 text-sm text-blue-700 underline" onClick={() => setComps([...comps, { name: '', amount: '', currency: '', method: '', creditAccountId: '' }])}>+ مكوّن</button>
      {rid && <DataTable rows={lines} empty="لا أسطر." cols={[{ h: 'الصنف', k: 'item_id' }, { h: 'الكمية', r: (l: any) => num(l.quantity, 2) }, { h: 'تكلفة الوحدة', r: (l: any) => num(l.unit_cost, 4) },
        { h: 'الوزن', r: (l: any) => <input className={inputCls} inputMode="decimal" value={extra[l.id]?.weight ?? ''} onChange={(e) => setX(l.id, 'weight', e.target.value)} /> }, { h: 'الحجم', r: (l: any) => <input className={inputCls} inputMode="decimal" value={extra[l.id]?.volume ?? ''} onChange={(e) => setX(l.id, 'volume', e.target.value)} /> }, { h: 'النسبة %', r: (l: any) => <input className={inputCls} inputMode="decimal" value={extra[l.id]?.pct ?? ''} onChange={(e) => setX(l.id, 'pct', e.target.value)} /> }]} />}
      <div className="mt-3 flex gap-2">
        <button className="rounded bg-slate-200 px-4 py-2 text-sm" disabled={a.busy || !rid} onClick={async () => setPv(await a.post('/landed-costs/preview', body()))}>معاينة التوزيع</button>
        <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white" disabled={a.busy || !rid} onClick={async () => { if (confirm('ترحيل قيد التكاليف الإضافية وتحديث متوسط التكلفة؟') && (await a.post('/landed-costs', body(), 'رُحِّل المستند'))) setPv(null); }}>ترحيل</button>
      </div>
      {pv && <div className="mt-4"><div className="mb-2 grid gap-3 md:grid-cols-3"><Kpi label="الإجمالي" value={num(pv.total, 2)} /><Kpi label="يُرسمَل في المخزون" value={num(pv.capitalized, 2)} tone="good" /><Kpi label="يُحمَّل كمصروف (مستهلَك)" value={num(pv.expensed, 2)} /></div>
        <DataTable rows={pv.lines} empty="—" cols={[{ h: 'سطر', k: 'goodsReceiptLineId' }, { h: 'الموزَّع', r: (l: any) => num(l.allocated, 2) }, { h: 'مرسمَل', r: (l: any) => num(l.capitalized, 2) }, { h: 'مصروف', r: (l: any) => num(l.expensed, 2) }, { h: 'لكل وحدة', r: (l: any) => num(l.unitLanded, 4) }, { h: 'المتوسط قبل', r: (l: any) => num(l.wacBefore, 4) }, { h: 'المتوسط بعد', r: (l: any) => num(l.wacAfter, 4) }]} /></div>}
    </Card>
  );
}

function Docs() {
  const { data } = useGet<any[]>('/landed-costs', {}); const a = useAction();
  return <Card title="المستندات"><DataTable rows={data} empty="لا مستندات." cols={[{ h: 'الرقم', k: 'doc_no' }, { h: 'التاريخ', k: 'doc_date' }, { h: 'الطريقة', r: (x: any) => METHODS[x.default_method] }, { h: 'الإجمالي', r: (x: any) => num(x.total_amount, 2) }, { h: 'مرسمَل', r: (x: any) => num(x.capitalized_total, 2) }, { h: 'مصروف', r: (x: any) => num(x.expensed_total, 2) }, { h: 'الحالة', r: (x: any) => (x.status === 'posted' ? 'مرحَّل' : 'معكوس') },
    { h: '', r: (x: any) => x.status === 'posted' && <button className="text-red-700 underline" onClick={() => { const reason = prompt('سبب العكس؟'); if (reason) void a.post(`/landed-costs/${x.id}/reverse`, { reason }, 'عُكس المستند'); }}>عكس</button> }]} /></Card>;
}

function Report() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today()); const { data: r } = useGet<any>('/landed-costs/report', { from, to });
  return (
    <Card title="أثر التكاليف الإضافية"><DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <div className="mb-3 grid gap-3 md:grid-cols-2"><Kpi label="قيمة المشتريات" value={r ? num(r.totals.purchaseValue, 2) : '—'} /><Kpi label="التكاليف الإضافية" value={r ? num(r.totals.landed, 2) : '—'} /></div>
      <h3 className="mb-1 font-semibold">حسب الصنف</h3><DataTable rows={r?.byItem} empty="—" cols={[{ h: 'الصنف', r: (x: any) => `${x.code} — ${x.name}` }, { h: 'الكمية', r: (x: any) => num(x.qty, 2) }, { h: 'قيمة الشراء', r: (x: any) => num(x.purchaseValue, 2) }, { h: 'التكلفة الإضافية', r: (x: any) => num(x.landed, 2) }, { h: 'الزيادة %', r: (x: any) => num(x.upliftPercent, 2) }, { h: 'لكل وحدة', r: (x: any) => num(x.landedPerUnit, 4) }]} />
      <h3 className="mb-1 mt-4 font-semibold">حسب المكوّن</h3><DataTable rows={r?.byComponent} empty="—" cols={[{ h: 'المكوّن', k: 'name' }, { h: 'العدد', k: 'count' }, { h: 'الإجمالي', r: (x: any) => num(x.total, 2) }]} />
    </Card>
  );
}

/** التكاليف الإضافية على المشتريات: إعدادات الشركة، مستند بكل طرق التوزيع، معاينة، عكس، وتقرير (٢.١٤.٠). */
export default function LandedCostsPage() {
  const [tab, setTab] = useState<Tab>('new');
  const T: Array<[Tab, string]> = [['new', 'مستند جديد'], ['docs', 'المستندات'], ['report', 'التقرير'], ['settings', 'الإعدادات']];
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">التكاليف الإضافية على المشتريات</h1>
      <div className="mb-4 flex gap-2">{T.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`rounded px-3 py-1.5 text-sm ${tab === k ? 'bg-slate-900 text-white' : 'bg-white ring-1 ring-slate-300'}`}>{l}</button>)}</div>
      {tab === 'new' && <NewDoc />}{tab === 'docs' && <Docs />}{tab === 'report' && <Report />}{tab === 'settings' && <Settings />}
    </div>
  );
}
