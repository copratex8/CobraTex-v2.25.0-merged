/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, DateRange, Kpi, PageHeader, TextileNav, num, today, useGet } from '@/features/textile/shared';

const first = () => today().slice(0, 8) + '01';
const pc = (v: any) => (v === null || v === undefined ? '—' : `${num(v, 1)}%`);

/** ربحية العملاء والأصناف: إيراد − تكلفة بضاعة (دفترية) − مطالبات مسوّاة، مع تكلفة المصنع التحليلية وتغطيتها. */
export default function ProfitabilityPage() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today());
  const { data: p } = useGet<any>('/textile/reports/profitability', { from, to });
  return (
    <div>
      <PageHeader title="ربحية العملاء والأصناف" sub="الإيراد من فواتير مرحَّلة قبل الضريبة. التكلفة الدفترية من تكلفة البضاعة المسجَّلة عند الترحيل؛ والتحليلية من تكلفة كجم أوامر المصدر لما سُلِّم بإذن مربوط بالفاتورة." />
      <TextileNav />
      <Card>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="الإيراد" value={p ? num(p.totals.revenue, 2) : '—'} /><Kpi label="الهامش الدفتري" value={p ? num(p.totals.bookMargin, 2) : '—'} /><Kpi label="هامش %" value={p ? pc(p.totals.bookMarginPercent) : '—'} /><Kpi label="مطالبات مسوّاة" value={p ? num(p.totals.claimsSettled, 2) : '—'} tone={p?.totals.claimsSettled ? 'bad' : 'good'} /></div>
        {p?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
      </Card>
      <Card title="العملاء (مرتَّبون بالصافي بعد المطالبات)">
        <DataTable rows={p?.customers} empty="لا فواتير مرحَّلة في الفترة." cols={[{ h: 'العميل', k: 'customerName' }, { h: 'فواتير', k: 'invoices' }, { h: 'الإيراد', r: (r) => num(r.revenue, 2) }, { h: 'تكلفة دفترية', r: (r) => num(r.bookCogs, 2) },
          { h: 'الهامش', r: (r) => `${num(r.bookMargin, 2)} (${pc(r.bookMarginPercent)})` }, { h: 'تكلفة المصنع التحليلية', r: (r) => (r.analyticalCost === null ? '—' : `${num(r.analyticalCost, 2)} (تغطية ${pc(r.analyticalCoveragePercent)})`) },
          { h: 'مطالبات', r: (r) => num(r.claimsSettled, 2) }, { h: 'الصافي', r: (r) => <b className={r.netMarginAfterClaims < 0 ? 'text-red-700' : ''}>{num(r.netMarginAfterClaims, 2)} ({pc(r.netMarginPercent)})</b> }]} />
      </Card>
      <Card title="الأصناف">
        <DataTable rows={p?.items} empty="—" cols={[{ h: 'الصنف', k: 'itemName' }, { h: 'الكمية', r: (r) => num(r.quantity, 1) }, { h: 'متوسط السعر', r: (r) => num(r.avgPrice, 2) }, { h: 'الإيراد', r: (r) => num(r.revenue, 2) }, { h: 'التكلفة', r: (r) => num(r.bookCogs, 2) }, { h: 'الهامش', r: (r) => `${num(r.margin, 2)} (${pc(r.marginPercent)})` }]} />
      </Card>
    </div>
  );
}
