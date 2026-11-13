/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { apiClient } from '@/api/client';
import { Card, DataTable, Field, Kpi, inputCls, num, today, useAction, useGet } from '@/features/textile/shared';

/** إقفال الفترات المالية وقيد إقفال السنة (٢.١٦.٠). */
export default function PeriodClosingPage() {
  const { data: periods } = useGet<any[]>('/accounting/fiscal-periods', {}); const { data: accounts } = useGet<any[]>('/accounting/accounts', {}); const { data: closings } = useGet<any[]>('/accounting/year-end', {});
  const a = useAction(); const [sel, setSel] = useState<string | null>(null);
  const { data: chk } = useGet<any>(sel ? `/accounting/fiscal-periods/${sel}/pre-close` : '/accounting/fiscal-periods/none/pre-close', {}, !!sel);
  const y = today().slice(0, 4);
  const [ye, setYe] = useState<any>({ fromDate: `${y}-01-01`, toDate: `${y}-12-31`, retainedAccountId: '' }); const [pv, setPv] = useState<any>(null);
  const eq = (accounts ?? []).filter((x) => x.account_type === 'equity');
  const body = () => ({ ...ye });
  const { data: snaps } = useGet<any[]>('/accounting/carry-forward', {}); const [cfTo, setCfTo] = useState(`${y}-12-31`); const [cp, setCp] = useState<any>(null); const [cfTab, setCfTab] = useState<'accounts' | 'customers' | 'suppliers' | 'inventory'>('accounts'); const [ver, setVer] = useState<any>(null);
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">إقفال الفترات والسنة المالية</h1>
      <Card title="الفترات المالية">
        <p className="mb-2 text-xs text-slate-500">الفترة المقفلة تمنع قاعدة البيانات نفسها من ترحيل أي قيد فيها. القيود غير المرحَّلة تمنع الإقفال؛ المسودات من المستندات تظهر تحذيرًا.</p>
        <DataTable rows={periods} empty="لا فترات." cols={[{ h: 'من', r: (x: any) => String(x.start_date).slice(0, 10) }, { h: 'إلى', r: (x: any) => String(x.end_date).slice(0, 10) }, { h: 'الحالة', r: (x: any) => <b className={x.status === 'closed' ? 'text-red-700' : 'text-emerald-700'}>{x.status === 'closed' ? 'مقفلة' : 'مفتوحة'}</b> },
          { h: '', r: (x: any) => (x.status === 'open' ? <button className="text-blue-700 underline" onClick={() => setSel(x.id)}>فحص وإقفال</button> : <button className="text-amber-700 underline" onClick={() => { const reason = prompt('سبب إعادة الفتح؟'); if (reason) void a.post(`/accounting/fiscal-periods/${x.id}/reopen`, { reason }, 'أُعيد فتح الفترة'); }}>إعادة فتح</button>) }]} />
      </Card>
      {sel && chk && <Card title="فحص ما قبل الإقفال">
        <div className="mb-2 grid gap-3 md:grid-cols-3"><Kpi label="الفترة" value={`${chk.startDate} → ${chk.endDate}`} /><Kpi label="قيود تمنع الإقفال" value={String(chk.blockers.length)} tone={chk.blockers.length ? 'bad' : 'good'} /><Kpi label="تحذيرات" value={String(chk.warnings.length)} /></div>
        {chk.blockers.map((w: string, i: number) => <p key={i} className="text-sm text-red-700">⛔ {w}</p>)}{chk.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
        <button className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={a.busy || !chk.canClose} onClick={async () => { if (confirm('إقفال الفترة؟ لن يُرحَّل فيها أي قيد بعد ذلك.') && (await a.post(`/accounting/fiscal-periods/${sel}/close`, {}, 'أُقفلت الفترة'))) setSel(null); }}>إقفال الفترة</button>
      </Card>}
      <Card title="قيد إقفال السنة">
        <p className="mb-2 text-xs text-slate-500">يُصفِّر الإيرادات والمصروفات ويُرحِّل الصافي إلى الأرباح المرحَّلة. أصدِره قبل إقفال آخر فترة في السنة. قائمة الدخل تستثنيه فتبقى تُظهر أرقام السنة.</p>
        <div className="grid gap-3 md:grid-cols-4"><Field label="من"><input type="date" className={inputCls} value={ye.fromDate} onChange={(e) => setYe({ ...ye, fromDate: e.target.value })} /></Field><Field label="إلى"><input type="date" className={inputCls} value={ye.toDate} onChange={(e) => setYe({ ...ye, toDate: e.target.value })} /></Field>
          <Field label="حساب الأرباح المرحَّلة"><select className={inputCls} value={ye.retainedAccountId} onChange={(e) => setYe({ ...ye, retainedAccountId: e.target.value })}><option value="">— اختر —</option>{eq.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field></div>
        <div className="mt-3 flex gap-2"><button className="rounded bg-slate-200 px-4 py-2 text-sm" disabled={a.busy || !ye.retainedAccountId} onClick={async () => setPv(await a.post('/accounting/year-end/preview', body()))}>معاينة</button>
          <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white" disabled={a.busy || !ye.retainedAccountId} onClick={async () => { if (confirm('ترحيل قيد إقفال السنة؟') && (await a.post('/accounting/year-end', body(), 'رُحِّل قيد الإقفال'))) setPv(null); }}>ترحيل قيد الإقفال</button></div>
        {pv && <div className="mt-3"><div className="mb-2 grid gap-3 md:grid-cols-3"><Kpi label="الإيرادات" value={num(pv.revenue, 2)} /><Kpi label="المصروفات" value={num(pv.expense, 2)} /><Kpi label={pv.netIncome < 0 ? 'صافي الخسارة' : 'صافي الربح'} value={num(Math.abs(pv.netIncome), 2)} tone={pv.netIncome < 0 ? 'bad' : 'good'} /></div>
          <DataTable rows={pv.accounts} empty="—" cols={[{ h: 'الحساب', r: (x: any) => `${x.code} — ${x.name}` }, { h: 'النوع', r: (x: any) => (x.type === 'revenue' ? 'إيراد' : 'مصروف') }, { h: 'الرصيد', r: (x: any) => num(x.balance, 2) }]} /></div>}
      </Card>
      <Card title="ترحيل الأرصدة إلى السنة الجديدة">
        <p className="mb-2 text-xs text-slate-500">بعد قيد إقفال السنة: تُرحَّل بالكامل أرصدة الميزانية والعملاء والموردين والمخزون (كمية وقيمة)، ولا تُرحَّل الإيرادات والمصروفات (أُقفلت في الأرباح المرحَّلة). لا قيد افتتاحي جديد لأن الدفتر تراكمي (كان سيضاعف الأرصدة) — الناتج لقطة موثّقة قابلة للمقارنة، وتُنشأ فترة السنة الجديدة إن غابت.</p>
        <div className="flex flex-wrap items-end gap-2"><Field label="نهاية السنة"><input type="date" className={inputCls} value={cfTo} onChange={(e) => setCfTo(e.target.value)} /></Field>
          <button className="rounded bg-slate-200 px-4 py-2 text-sm" disabled={a.busy} onClick={async () => setCp(await a.post('/accounting/carry-forward/preview', { toDate: cfTo }))}>معاينة</button>
          <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={a.busy || !cp?.canCreate} onClick={async () => { if (confirm('ترحيل الأرصدة وإنشاء فترة السنة الجديدة؟') && (await a.post('/accounting/carry-forward', { toDate: cfTo }, 'رُحِّلت الأرصدة'))) setCp(null); }}>ترحيل الأرصدة</button></div>
        {cp && <div className="mt-3">
          {cp.blockers.map((w: string, i: number) => <p key={i} className="text-sm text-red-700">⛔ {w}</p>)}{cp.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
          <div className="my-2 grid gap-3 md:grid-cols-5"><Kpi label="مدين الميزانية" value={num(cp.accountTotals.debit, 2)} /><Kpi label="دائن الميزانية" value={num(cp.accountTotals.credit, 2)} /><Kpi label="العملاء" value={num(cp.customers.net, 2)} /><Kpi label="الموردون" value={num(cp.suppliers.net, 2)} /><Kpi label="المخزون" value={num(cp.inventoryTotal, 2)} /></div>
          <p className="mb-2 text-xs text-slate-500">فتح السنة الجديدة: {cp.openingDate} — {cp.nextPeriod.exists ? 'الفترة موجودة' : `ستُنشأ الفترة ${cp.nextPeriod.start} → ${cp.nextPeriod.end}`}. {cp.excluded.note}</p>
          <div className="mb-2 flex gap-2">{([['accounts', 'حسابات الميزانية'], ['customers', 'العملاء'], ['suppliers', 'الموردون'], ['inventory', 'المخزون']] as const).map(([k, l]) => <button key={k} className={`rounded px-3 py-1 text-sm ${cfTab === k ? 'bg-slate-900 text-white' : 'bg-slate-200'}`} onClick={() => setCfTab(k)}>{l}</button>)}</div>
          {cfTab === 'accounts' && <DataTable rows={cp.accounts} empty="—" cols={[{ h: 'الكود', k: 'code' }, { h: 'الحساب', k: 'name' }, { h: 'مدين', r: (x: any) => num(x.debit, 2) }, { h: 'دائن', r: (x: any) => num(x.credit, 2) }]} />}
          {cfTab === 'customers' && <DataTable rows={cp.customers.rows} empty="—" cols={[{ h: 'الكود', k: 'code' }, { h: 'العميل', k: 'name' }, { h: 'فواتير مفتوحة', r: (x: any) => x.invoices.map((i: any) => i.documentNumber).join('، ') }, { h: 'دفعات مقدمة', r: (x: any) => num(x.advance, 2) }, { h: 'الرصيد', r: (x: any) => num(x.net, 2) }]} />}
          {cfTab === 'suppliers' && <DataTable rows={cp.suppliers.rows} empty="—" cols={[{ h: 'الكود', k: 'code' }, { h: 'المورد', k: 'name' }, { h: 'فواتير مفتوحة', r: (x: any) => x.invoices.map((i: any) => i.documentNumber).join('، ') }, { h: 'دفعات مقدمة', r: (x: any) => num(x.advance, 2) }, { h: 'الرصيد', r: (x: any) => num(x.net, 2) }]} />}
          {cfTab === 'inventory' && <DataTable rows={cp.inventory} empty="—" cols={[{ h: 'الصنف', r: (x: any) => `${x.code} — ${x.name}` }, { h: 'المخزن', k: 'warehouse' }, { h: 'الكمية', r: (x: any) => num(x.quantity, 3) }, { h: 'متوسط التكلفة', r: (x: any) => num(x.unitCost, 2) }, { h: 'القيمة', r: (x: any) => num(x.value, 2) }]} />}
        </div>}
        <h3 className="mb-1 mt-4 text-sm font-bold">اللقطات المرحَّلة</h3>
        <DataTable rows={snaps} empty="لا لقطات." cols={[{ h: 'نهاية السنة', k: 'to_date' }, { h: 'الافتتاح', k: 'opening_date' }, { h: 'عملاء', r: (x: any) => num(x.totals.customers, 2) }, { h: 'موردون', r: (x: any) => num(x.totals.suppliers, 2) }, { h: 'مخزون', r: (x: any) => num(x.totals.inventory, 2) }, { h: 'الحالة', r: (x: any) => (x.status === 'posted' ? 'مرحَّلة' : 'معكوسة') },
          { h: '', r: (x: any) => x.status === 'posted' && <span className="flex gap-3"><button className="text-blue-700 underline" onClick={async () => { const r = await a.run<any>(() => apiClient.get(`/accounting/carry-forward/${x.id}/verify`)); setVer(r); }}>مطابقة</button><button className="text-red-700 underline" onClick={() => { const reason = prompt('سبب العكس؟'); if (reason) void a.post(`/accounting/carry-forward/${x.id}/reverse`, { reason }, 'عُكست اللقطة'); }}>عكس</button></span> }]} />
        {ver && <p className={`mt-2 text-sm ${ver.matches ? 'text-emerald-700' : 'text-red-700'}`}>{ver.matches ? '✅ اللقطة مطابقة للأرصدة الحالية.' : '⛔ فروق: ' + ver.differences.join(' • ')}</p>}
      </Card>
      <Card title="قيود الإقفال السابقة"><DataTable rows={closings} empty="لا قيود." cols={[{ h: 'من', k: 'from_date' }, { h: 'إلى', k: 'to_date' }, { h: 'الإيرادات', r: (x: any) => num(x.revenue_total, 2) }, { h: 'المصروفات', r: (x: any) => num(x.expense_total, 2) }, { h: 'الصافي', r: (x: any) => num(x.net_income, 2) }, { h: 'الحالة', r: (x: any) => (x.status === 'posted' ? 'مرحَّل' : 'معكوس') },
        { h: '', r: (x: any) => x.status === 'posted' && <button className="text-red-700 underline" onClick={() => { const reason = prompt('سبب العكس؟ (الفترة يجب أن تكون مفتوحة)'); if (reason) void a.post(`/accounting/year-end/${x.id}/reverse`, { reason }, 'عُكس قيد الإقفال'); }}>عكس</button> }]} /></Card>
    </div>
  );
}
