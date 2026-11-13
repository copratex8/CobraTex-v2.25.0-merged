/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, DateRange, Kpi, PageHeader, TextileNav, num, today, useGet } from '@/features/textile/shared';

const first = () => today().slice(0, 8) + '01';
/** البيع حسب نوع الدفع (نقدي/آجل/شيك/تحويل): الإيراد قبل الضريبة بعملة الأساس. */
export default function SalesPaymentPage() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today());
  const { data: r } = useGet<any>('/textile/reports/sales-by-payment', { from, to });
  return (
    <div>
      <PageHeader title="البيع حسب نوع الدفع" sub="فواتير مرحَّلة. نوع الدفع يُحدَّد عند إنشاء الفاتورة؛ الفواتير بلا نوع تظهر «غير محدد»." />
      <TextileNav />
      <Card>
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <div className="mb-3 grid gap-3 md:grid-cols-3"><Kpi label="الفواتير" value={r ? String(r.totals.invoices) : '—'} /><Kpi label="الإيراد" value={r ? num(r.totals.revenue, 2) : '—'} /></div>
        {r?.note && <p className="text-sm text-amber-700">⚠️ {r.note}</p>}
        <DataTable rows={r?.types} empty="لا فواتير." cols={[{ h: 'النوع', k: 'label' }, { h: 'فواتير', k: 'invoices' }, { h: 'الإيراد', r: (x) => num(x.revenue, 2) }, { h: 'الضريبة', r: (x) => num(x.tax, 2) }, { h: 'النسبة', r: (x) => `${num(x.percent, 1)}%` }]} />
      </Card>
      <Card title="حسب العميل">
        <DataTable rows={r?.customers} empty="—" cols={[{ h: 'العميل', k: 'customerName' }, { h: 'نقدي', r: (x) => num(x.cash ?? 0, 2) }, { h: 'آجل', r: (x) => num(x.credit ?? 0, 2) }, { h: 'شيك', r: (x) => num(x.cheque ?? 0, 2) }, { h: 'تحويل', r: (x) => num(x.transfer ?? 0, 2) }, { h: 'غير محدد', r: (x) => num(x.unspecified ?? 0, 2) }, { h: 'الإجمالي', r: (x) => <b>{num(x.total, 2)}</b> }]} />
      </Card>
    </div>
  );
}
