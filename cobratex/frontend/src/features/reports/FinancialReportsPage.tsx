/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, DateRange, Field, Kpi, inputCls, num, today, useGet } from '@/features/textile/shared';

type Tab = 'receivable' | 'payable' | 'income' | 'balance' | 'vat' | 'cash' | 'cheques' | 'slow' | 'reorder';
const TABS: Array<[Tab, string]> = [['receivable', 'أعمار المدينين'], ['payable', 'أعمار الدائنين'], ['income', 'قائمة الدخل'], ['balance', 'المركز المالي'], ['vat', 'إقرار القيمة المضافة'], ['cash', 'توقّع السيولة'], ['cheques', 'جدول الشيكات'], ['slow', 'المخزون الراكد'], ['reorder', 'اقتراحات إعادة الطلب']];
const first = () => today().slice(0, 8) + '01';

function Aging({ kind }: { kind: 'receivable' | 'payable' }) {
  const [asOf, setAsOf] = useState(today());
  const { data: r } = useGet<any>('/accounting/reports/aging', { kind, asOf });
  const cols: any[] = [{ h: kind === 'receivable' ? 'العميل' : 'المورد', r: (x: any) => `${x.code} — ${x.name}` }, ...(r?.buckets ?? []).map((b: any) => ({ h: b.label, r: (x: any) => num(x[b.key], 2) })), { h: 'الإجمالي', r: (x: any) => <b>{num(x.total, 2)}</b> }, { h: 'متأخر', r: (x: any) => <span className="text-red-700">{num(x.overdue, 2)}</span> }, { h: 'دفعات مقدمة', r: (x: any) => num(x.unallocatedAdvance, 2) }];
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-5"><Field label="حتى تاريخ"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Kpi label="إجمالي المستحق" value={r ? num(r.totals.total, 2) : '—'} /><Kpi label="المتأخر عن المهلة" value={r ? num(r.totals.overdue, 2) : '—'} tone="bad" /><Kpi label="دفعات مقدمة" value={r ? num(r.unallocatedAdvances, 2) : '—'} /><Kpi label="الصافي" value={r ? num(r.netExposure, 2) : '—'} /></div>
      {r && <p className="mb-2 text-xs text-slate-500">{r.note}</p>}
      <DataTable rows={r?.parties} empty="لا أرصدة مستحقة." cols={cols} />
    </Card>
  );
}

function Lines({ rows }: { rows?: any[] }) { return <DataTable rows={rows} empty="—" cols={[{ h: 'الحساب', r: (x: any) => `${x.code} — ${x.name}` }, { h: 'المبلغ', r: (x: any) => num(x.amount, 2) }]} />; }

function Income() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today());
  const { data: r } = useGet<any>('/accounting/reports/income-statement', { from, to });
  return (
    <Card>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="الإيرادات" value={r ? num(r.totalRevenue, 2) : '—'} /><Kpi label="المصروفات" value={r ? num(r.totalExpense, 2) : '—'} /><Kpi label="صافي الدخل" value={r ? num(r.netIncome, 2) : '—'} tone={r && r.netIncome < 0 ? 'bad' : 'good'} /><Kpi label="هامش الربح %" value={r?.margin === null || !r ? '—' : num(r.margin, 2)} /></div>
      <h3 className="mb-1 font-semibold">الإيرادات</h3><Lines rows={r?.revenue} /><h3 className="mb-1 mt-4 font-semibold">المصروفات</h3><Lines rows={r?.expenses} />
    </Card>
  );
}

function Balance() {
  const [asOf, setAsOf] = useState(today());
  const { data: r } = useGet<any>('/accounting/reports/balance-sheet', { asOf });
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-5"><Field label="حتى تاريخ"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <Kpi label="الأصول" value={r ? num(r.totalAssets, 2) : '—'} /><Kpi label="الخصوم" value={r ? num(r.totalLiabilities, 2) : '—'} /><Kpi label="حقوق الملكية + أرباح الفترة" value={r ? num(r.totalEquity + r.currentEarnings, 2) : '—'} /><Kpi label="التوازن" value={r ? (r.balanced ? 'متوازن ✓' : 'غير متوازن ✗') : '—'} tone={r && !r.balanced ? 'bad' : 'good'} /></div>
      <div className="grid gap-4 md:grid-cols-2">
        <div><h3 className="mb-1 font-semibold">الأصول</h3><Lines rows={r?.assets} /></div>
        <div><h3 className="mb-1 font-semibold">الخصوم</h3><Lines rows={r?.liabilities} /><h3 className="mb-1 mt-4 font-semibold">حقوق الملكية</h3><Lines rows={r?.equity} />{r && <p className="mt-2 text-sm">صافي أرباح متراكمة غير مُقفَلة: <b>{num(r.currentEarnings, 2)}</b></p>}</div>
      </div>
    </Card>
  );
}

function Vat() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today());
  const { data: r } = useGet<any>('/accounting/reports/vat-return', { from, to });
  return (
    <Card>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="ضريبة المخرجات (مبيعات)" value={r ? num(r.totals.outputTax, 2) : '—'} /><Kpi label="ضريبة المدخلات (مشتريات/مصروفات)" value={r ? num(r.totals.inputTax, 2) : '—'} />
        <Kpi label={r && r.netPayable < 0 ? 'مستردّة' : 'مستحقة السداد'} value={r ? num(Math.abs(r.netPayable), 2) : '—'} tone={r && r.netPayable < 0 ? 'good' : 'bad'} /><Kpi label="مطابقة الدفتر" value={r ? (r.ledger.reconciled ? 'مطابق ✓' : 'يوجد فرق ✗') : '—'} tone={r && !r.ledger.reconciled ? 'bad' : 'good'} /></div>
      {r?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
      <DataTable rows={r?.rows} empty="لا حركة ضريبية في الفترة." cols={[{ h: 'نوع الضريبة', k: 'name' }, { h: 'وعاء المبيعات', r: (x: any) => num(x.outputBase, 2) }, { h: 'ضريبة المخرجات', r: (x: any) => num(x.outputTax, 2) }, { h: 'وعاء المشتريات', r: (x: any) => num(x.inputBase, 2) }, { h: 'ضريبة المدخلات', r: (x: any) => num(x.inputTax, 2) }]} />
    </Card>
  );
}

function Cash() {
  const [asOf, setAsOf] = useState(today()); const [weeks, setWeeks] = useState('13');
  const { data: r } = useGet<any>('/accounting/reports/cash-forecast', { asOf, weeks });
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-5"><Field label="من تاريخ"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><Field label="عدد الأسابيع"><input className={inputCls} inputMode="numeric" value={weeks} onChange={(e) => setWeeks(e.target.value)} /></Field>
        <Kpi label="الرصيد الافتتاحي (خزائن/بنوك)" value={r ? num(r.opening, 2) : '—'} /><Kpi label="الرصيد الختامي المتوقَّع" value={r ? num(r.closing, 2) : '—'} tone={r && r.closing < 0 ? 'bad' : 'good'} /><Kpi label="أدنى رصيد" value={r ? `${num(r.lowest.closing, 2)} (أسبوع ${r.lowest.week})` : '—'} tone={r && r.lowest.closing < 0 ? 'bad' : undefined} /></div>
      {r?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-red-700">⚠️ {w}</p>)}{r && <p className="mb-2 text-xs text-slate-500">{r.note}</p>}
      <DataTable rows={r?.weeks} empty="—" cols={[{ h: 'الأسبوع', r: (x: any) => `${x.n}: ${x.from} → ${x.to}` }, { h: 'مقبوضات', r: (x: any) => num(x.inflow, 2) }, { h: 'منها متأخر', r: (x: any) => num(x.overdueInflow, 2) }, { h: 'مدفوعات', r: (x: any) => num(x.outflow, 2) }, { h: 'منها متأخر', r: (x: any) => num(x.overdueOutflow, 2) }, { h: 'الصافي', r: (x: any) => num(x.net, 2) }, { h: 'الرصيد', r: (x: any) => <b className={x.closing < 0 ? 'text-red-700' : ''}>{num(x.closing, 2)}</b> }]} />
    </Card>
  );
}

function Cheques() {
  const [asOf, setAsOf] = useState(today()); const { data: r } = useGet<any>('/accounting/reports/cheque-schedule', { asOf });
  const cols = [{ h: 'الفئة', r: (b: any) => b.label }, { h: 'واردة (تحصيل)', r: (b: any) => num(r.incoming[b.key], 2) }, { h: 'صادرة (سداد)', r: (b: any) => num(r.outgoing[b.key], 2) }];
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-4"><Field label="حتى تاريخ"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><Kpi label="واردة" value={r ? num(r.incoming.total, 2) : '—'} /><Kpi label="صادرة" value={r ? num(r.outgoing.total, 2) : '—'} /><Kpi label="الصافي" value={r ? num(r.net, 2) : '—'} /></div>
      {r?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
      <DataTable rows={r?.buckets} empty="—" cols={cols} />
      <h3 className="mb-1 mt-4 font-semibold">الشيكات</h3>
      <DataTable rows={r?.cheques} empty="لا شيكات معلّقة." cols={[{ h: 'رقم', k: 'number' }, { h: 'النوع', r: (x: any) => (x.type === 'incoming' ? 'وارد' : 'صادر') }, { h: 'الطرف', k: 'party' }, { h: 'الاستحقاق', k: 'due' }, { h: 'أيام', r: (x: any) => <span className={x.daysToDue < 0 ? 'text-red-700' : ''}>{x.daysToDue}</span> }, { h: 'المبلغ', r: (x: any) => `${num(x.amount, 2)} ${x.currency}` }, { h: 'بالأساس', r: (x: any) => num(x.base, 2) }, { h: 'الحالة', r: (x: any) => (x.status === 'pending' ? 'معلّق' : 'مودَع') }]} />
    </Card>
  );
}

function Slow() {
  const [asOf, setAsOf] = useState(today()); const [days, setDays] = useState('90'); const { data: r } = useGet<any>('/accounting/reports/slow-moving', { asOf, thresholdDays: days });
  return (
    <Card>
      <div className="mb-3 grid gap-3 md:grid-cols-5"><Field label="حتى تاريخ"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><Field label="راكد منذ (يوم)"><input className={inputCls} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <Kpi label="قيمة الراكد" value={r ? num(r.totals.total, 2) : '—'} tone="bad" /><Kpi label="قيمة المخزون" value={r ? num(r.stockValue, 2) : '—'} /><Kpi label="نسبة الراكد %" value={r ? num(r.idleShare, 2) : '—'} /></div>
      {r && <p className="mb-2 text-xs text-slate-500">{r.note}</p>}
      <DataTable rows={r?.items} empty="لا أصناف راكدة." cols={[{ h: 'الصنف', r: (x: any) => `${x.code} — ${x.name}` }, { h: 'الكمية', r: (x: any) => num(x.quantity, 2) }, { h: 'القيمة', r: (x: any) => num(x.value, 2) }, { h: 'آخر صرف', r: (x: any) => (x.neverIssued ? 'لم يُصرف' : x.lastIssueDate) }, { h: 'أيام الركود', r: (x: any) => <b>{x.daysIdle}</b> }, { h: 'الفئة', r: (x: any) => r.buckets.find((b: any) => b.key === x.bucket)?.label }]} />
    </Card>
  );
}

function Reorder() {
  const { data: r } = useGet<any>('/accounting/reports/reorder', {});
  return (
    <Card>
      <p className="mb-2 text-xs text-slate-500">المتاح (الرصيد − المحجوز) + الوارد من أوامر الشراء المؤكدة ≤ نقطة الطلب ⇒ يُقترح الأكبر من «كمية الطلب» أو العجز حتى ضعف النقطة.</p>
      <DataTable rows={r?.items} empty="لا أصناف تحت نقطة الطلب." cols={[{ h: 'الصنف', r: (x: any) => `${x.code} — ${x.name}` }, { h: 'المتاح', r: (x: any) => num(x.available, 2) }, { h: 'وارد', r: (x: any) => num(x.incoming, 2) }, { h: 'نقطة الطلب', r: (x: any) => num(x.reorderPoint, 2) },
        { h: 'الحالة', r: (x: any) => <b className={x.urgency === 'out_of_stock' ? 'text-red-700' : 'text-amber-700'}>{x.urgency === 'out_of_stock' ? 'نفد' : 'تحت النقطة'}</b> }, { h: 'الكمية المقترحة', r: (x: any) => <b>{num(x.suggestedQty, 2)}</b> }]} />
    </Card>
  );
}

/** تقارير مالية: أعمار الديون، قائمة الدخل، المركز المالي، إعادة الطلب (٢.١١.٠). */
export default function FinancialReportsPage() {
  const [tab, setTab] = useState<Tab>('receivable');
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-slate-900">التقارير المالية</h1>
      <div className="mb-4 flex flex-wrap gap-2">{TABS.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`rounded px-3 py-1.5 text-sm ${tab === k ? 'bg-slate-900 text-white' : 'bg-white ring-1 ring-slate-300'}`}>{l}</button>)}</div>
      {tab === 'receivable' && <Aging kind="receivable" />}{tab === 'payable' && <Aging kind="payable" />}{tab === 'income' && <Income />}{tab === 'balance' && <Balance />}{tab === 'vat' && <Vat />}{tab === 'cash' && <Cash />}{tab === 'cheques' && <Cheques />}{tab === 'slow' && <Slow />}{tab === 'reorder' && <Reorder />}
    </div>
  );
}
