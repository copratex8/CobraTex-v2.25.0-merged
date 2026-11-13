/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, DateRange, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useGet } from '@/features/textile/shared';

const first = () => today().slice(0, 8) + '01';
/** انحراف أسعار البيع عن قائمة الأسعار: الأثر بعملة الأساس (سالب = بيع بأقل من القائمة). */
export default function PriceDeviationPage() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today()); const [pct, setPct] = useState('');
  const { data: r } = useGet<any>('/textile/reports/price-deviation', { from, to, minPercent: pct });
  return (
    <div>
      <PageHeader title="انحراف أسعار البيع" sub="مقارنة سعر كل سطر فاتورة مرحَّلة بسعر قائمة الأسعار الفعّالة (قائمة العميل وإلا الافتراضية) بحدّ الكمية المناسب." />
      <TextileNav />
      <Card>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <div className="mb-3 grid gap-3 md:grid-cols-5"><Field label="أقل نسبة انحراف %"><input className={inputCls} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          <Kpi label="أسطر منحرفة" value={r ? String(r.totals.deviatedLines) : '—'} /><Kpi label="خصومات" value={r ? num(r.totals.discounts, 2) : '—'} /><Kpi label="علاوات" value={r ? num(r.totals.premiums, 2) : '—'} /><Kpi label="الصافي" value={r ? num(r.totals.net, 2) : '—'} /></div>
        {r?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
        <DataTable rows={r?.lines} empty="لا انحرافات." cols={[{ h: 'الفاتورة', k: 'invoiceNo' }, { h: 'التاريخ', k: 'date' }, { h: 'العميل', k: 'customerName' }, { h: 'الصنف', k: 'itemName' }, { h: 'الكمية', r: (x) => num(x.quantity, 2) }, { h: 'سعر القائمة', r: (x) => `${num(x.listPrice, 4)} ${x.currency}` }, { h: 'سعر البيع', r: (x) => num(x.soldPrice, 4) },
          { h: 'الانحراف', r: (x) => <b className={x.diff < 0 ? 'text-red-700' : 'text-green-700'}>{num(x.diffPercent, 2)}%</b> }, { h: 'الأثر', r: (x) => num(x.impactBase, 2) }]} />
      </Card>
      <Card title="حسب العميل"><DataTable rows={r?.byCustomer} empty="—" cols={[{ h: 'العميل', k: 'name' }, { h: 'أسطر', k: 'lines' }, { h: 'الأثر', r: (x) => num(x.impact, 2) }]} /></Card>
      <Card title="حسب الصنف"><DataTable rows={r?.byItem} empty="—" cols={[{ h: 'الصنف', k: 'name' }, { h: 'أسطر', k: 'lines' }, { h: 'الأثر', r: (x) => num(x.impact, 2) }]} /></Card>
    </div>
  );
}
