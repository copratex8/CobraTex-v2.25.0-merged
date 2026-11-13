/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, inputCls, num, today, useAction, useGet } from '@/features/textile/shared';

const METHODS: Record<string, string> = { straight_line: 'قسط ثابت', declining_balance: 'قسط متناقص (٢×)' };
const STATUS: Record<string, string> = { active: 'نشط', fully_depreciated: 'مُهلَك بالكامل', disposed: 'مستبعَد' };

/** سجل الأصول الثابتة، تشغيل الإهلاك الشهري، العكس، والاستبعاد/البيع (٢.١٢.٠). */
export default function FixedAssetsPage() {
  const { data: reg } = useGet<any>('/assets', {});
  const { data: accounts } = useGet<any[]>('/accounting/accounts', {});
  const [sel, setSel] = useState<string | null>(null);
  const { data: card } = useGet<any>(sel ? `/assets/${sel}` : '/assets/none', {}, !!sel);
  const a = useAction();
  const [f, setF] = useState<any>({ code: '', nameAr: '', acquisitionDate: today(), cost: '', salvageValue: '0', usefulLifeMonths: '60', method: 'straight_line', assetAccountId: '', accumulatedAccountId: '', expenseAccountId: '', acquisitionCreditAccountId: '' });
  const [through, setThrough] = useState(today()); const [preview, setPreview] = useState<any>(null);
  const [rev, setRev] = useState({ periodEnd: '', reason: '' });
  const [d, setD] = useState<any>({ date: today(), proceeds: '0', proceedsAccountId: '', gainLossAccountId: '' });
  const accOpts = (types: string[]) => (accounts ?? []).filter((x) => types.includes(x.account_type)).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>);
  const sel_ = (k: string, types: string[]) => <select className={inputCls} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">— اختر —</option>{accOpts(types)}</select>;
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">الأصول الثابتة والإهلاك</h1>
      <div className="mb-3 grid gap-3 md:grid-cols-3"><Kpi label="إجمالي التكلفة" value={reg ? num(reg.totals.cost, 2) : '—'} /><Kpi label="مجمّع الإهلاك" value={reg ? num(reg.totals.accumulated, 2) : '—'} /><Kpi label="صافي القيمة الدفترية" value={reg ? num(reg.totals.netBookValue, 2) : '—'} tone="good" /></div>
      <Card title="تشغيل الإهلاك الشهري">
        <div className="grid gap-3 md:grid-cols-4"><Field label="حتى نهاية شهر"><input type="date" className={inputCls} value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
          <button className="rounded bg-slate-200 px-3 py-2 text-sm" disabled={a.busy} onClick={async () => setPreview(await a.post('/assets/depreciation/run', { through, dryRun: true }))}>معاينة</button>
          <button className="rounded bg-slate-900 px-3 py-2 text-sm text-white" disabled={a.busy} onClick={async () => { if (confirm('ترحيل قيود الإهلاك؟')) { await a.post('/assets/depreciation/run', { through }, 'رُحِّل الإهلاك'); setPreview(null); } }}>ترحيل</button></div>
        {preview && <div className="mt-3"><p className="text-sm">الإجمالي: <b>{num(preview.total, 2)}</b></p><DataTable rows={preview.months} empty="لا إهلاك مستحق." cols={[{ h: 'نهاية الشهر', k: 'periodEnd' }, { h: 'عدد الأصول', k: 'assets' }, { h: 'المبلغ', r: (x: any) => num(x.total, 2) }]} /></div>}
        <div className="mt-4 grid gap-3 md:grid-cols-4"><Field label="عكس شهر (نهاية الشهر)"><input type="date" className={inputCls} value={rev.periodEnd} onChange={(e) => setRev({ ...rev, periodEnd: e.target.value })} /></Field><Field label="السبب"><input className={inputCls} value={rev.reason} onChange={(e) => setRev({ ...rev, reason: e.target.value })} /></Field>
          <button className="self-end rounded bg-red-700 px-3 py-2 text-sm text-white" disabled={a.busy || !rev.periodEnd} onClick={() => confirm('عكس إهلاك الشهر كاملًا؟') && a.post('/assets/depreciation/reverse', rev, 'عُكس الشهر')}>عكس</button></div>
      </Card>
      <Card title="السجل"><DataTable rows={reg?.assets} empty="لا أصول." cols={[{ h: 'الكود', r: (x: any) => <button className="text-blue-700 underline" onClick={() => setSel(x.id)}>{x.code}</button> }, { h: 'الاسم', k: 'name_ar' }, { h: 'الاقتناء', r: (x: any) => String(x.acquisition_date).slice(0, 10) }, { h: 'التكلفة', r: (x: any) => num(x.cost, 2) }, { h: 'المجمّع', r: (x: any) => num(x.accumulated_depreciation, 2) }, { h: 'الدفترية', r: (x: any) => num(x.net_book_value, 2) }, { h: 'الطريقة', r: (x: any) => METHODS[x.method] }, { h: 'الحالة', r: (x: any) => STATUS[x.status] }]} /></Card>
      {card && <Card title={`بطاقة الأصل ${card.asset.code}`}>
        <div className="grid gap-4 md:grid-cols-2"><div><h3 className="mb-1 font-semibold">الإهلاك المرحَّل</h3><DataTable rows={card.history} empty="—" cols={[{ h: 'الشهر', k: 'period_end' }, { h: 'المبلغ', r: (x: any) => num(x.amount, 2) }, { h: 'الحالة', r: (x: any) => (x.status === 'posted' ? 'مرحَّل' : 'معكوس') }]} /></div>
          <div><h3 className="mb-1 font-semibold">الجدول المتوقَّع</h3><DataTable rows={card.schedule} empty="—" cols={[{ h: '#', k: 'n' }, { h: 'الشهر', k: 'periodEnd' }, { h: 'القسط', r: (x: any) => num(x.amount, 2) }, { h: 'الدفترية بعده', r: (x: any) => num(x.nbv, 2) }]} /></div></div>
        {card.asset.status !== 'disposed' && <div className="mt-4 grid gap-3 md:grid-cols-5"><Field label="تاريخ الاستبعاد"><input type="date" className={inputCls} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field><Field label="حصيلة البيع"><input className={inputCls} inputMode="decimal" value={d.proceeds} onChange={(e) => setD({ ...d, proceeds: e.target.value })} /></Field>
          <Field label="حساب الحصيلة"><select className={inputCls} value={d.proceedsAccountId} onChange={(e) => setD({ ...d, proceedsAccountId: e.target.value })}><option value="">—</option>{accOpts(['asset'])}</select></Field><Field label="حساب ربح/خسارة"><select className={inputCls} value={d.gainLossAccountId} onChange={(e) => setD({ ...d, gainLossAccountId: e.target.value })}><option value="">—</option>{accOpts(['revenue', 'expense'])}</select></Field>
          <button className="self-end rounded bg-red-700 px-3 py-2 text-sm text-white" disabled={a.busy || !d.gainLossAccountId} onClick={() => confirm('استبعاد الأصل بقيد ربح/خسارة؟') && a.post(`/assets/${card.asset.id}/dispose`, { ...d, proceedsAccountId: d.proceedsAccountId || undefined }, 'استُبعد الأصل')}>استبعاد/بيع</button></div>}
      </Card>}
      <Card title="أصل جديد">
        <p className="mb-2 text-xs text-slate-500">قيد الاقتناء اختياري: اختر حساب المقابل (خزينة/مورد/رأس مال) ليُرحَّل Dr الأصل / Cr المقابل. اتركه فارغًا إن سُجّل الاقتناء بفاتورة مورد أو قيد يدوي.</p>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="الكود"><input className={inputCls} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field><Field label="الاسم"><input className={inputCls} value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
          <Field label="تاريخ الاقتناء"><input type="date" className={inputCls} value={f.acquisitionDate} onChange={(e) => setF({ ...f, acquisitionDate: e.target.value })} /></Field><Field label="التكلفة"><input className={inputCls} inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
          <Field label="قيمة الخردة"><input className={inputCls} inputMode="decimal" value={f.salvageValue} onChange={(e) => setF({ ...f, salvageValue: e.target.value })} /></Field><Field label="العمر (شهر)"><input className={inputCls} inputMode="numeric" value={f.usefulLifeMonths} onChange={(e) => setF({ ...f, usefulLifeMonths: e.target.value })} /></Field>
          <Field label="الطريقة"><select className={inputCls} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="حساب الأصل">{sel_('assetAccountId', ['asset'])}</Field><Field label="حساب مجمّع الإهلاك">{sel_('accumulatedAccountId', ['asset', 'liability'])}</Field><Field label="حساب مصروف الإهلاك">{sel_('expenseAccountId', ['expense'])}</Field><Field label="ترحيل قيد الاقتناء — حساب المقابل (اختياري)">{sel_('acquisitionCreditAccountId', ['asset', 'liability', 'equity'])}</Field>
        </div>
        <button className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white" disabled={a.busy || !f.code || !f.nameAr || !f.cost || !f.assetAccountId || !f.accumulatedAccountId || !f.expenseAccountId} onClick={() => a.post('/assets', { ...f, usefulLifeMonths: Number(f.usefulLifeMonths), acquisitionCreditAccountId: f.acquisitionCreditAccountId || undefined }, 'أُضيف الأصل')}>حفظ</button>
      </Card>
    </div>
  );
}
