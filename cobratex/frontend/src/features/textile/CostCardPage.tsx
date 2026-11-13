/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, DateRange, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useGet } from '@/features/textile/shared';

const UT: Record<string, string> = { electricity: 'كهرباء', steam: 'بخار', water: 'ماء', gas: 'غاز', compressed_air: 'هواء مضغوط', other: 'أخرى' };
const BASIS: Record<string, string> = { actual: 'فعلي', estimate: 'تقدير', books: 'من بنود الأمر', standard: 'معدّلات معيارية', none: '—' };
const first = () => today().slice(0, 8) + '01';

/** بطاقة تكلفة أمر التصنيع + ترتيب الأوامر بتكلفة الكجم. */
export default function CostCardPage() {
  const [from, setFrom] = useState(first()); const [to, setTo] = useState(today());
  const [orderId, setOrderId] = useState(''); const [withUtil, setWithUtil] = useState(true);
  const { data: rank } = useGet<any>('/textile/reports/order-costs', { from, to });
  const { data: c, error } = useGet<any>(`/textile/production-orders/${orderId}/cost-card`, { includeUtilities: String(withUtil) }, !!orderId);
  return (
    <div>
      <PageHeader title="بطاقة تكلفة الأمر" sub="مواد + تحويل + مرافق فعلية + حوافز − استرداد. تحليلية: لا تغيّر قيود التصنيع. الخسارة غير العادية تظهر منفصلة." />
      <TextileNav />
      <Card title="ترتيب الأوامر المرحَّلة بتكلفة الكجم">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <div className="mb-3 grid gap-3 md:grid-cols-3"><Kpi label="أوامر" value={rank?.count ?? '—'} /><Kpi label="الأرخص (كجم)" value={rank?.cheapest ? `${rank.cheapest.orderNo}: ${num(rank.cheapest.costPerKg, 3)}` : '—'} tone="good" /><Kpi label="الأغلى (كجم)" value={rank?.dearest ? `${rank.dearest.orderNo}: ${num(rank.dearest.costPerKg, 3)}` : '—'} tone="bad" /></div>
        <DataTable rows={rank?.orders} empty="لا أوامر مرحَّلة." cols={[{ h: 'الأمر', k: 'orderNo' }, { h: 'تكلفة/كجم', r: (r) => num(r.costPerKg, 3) }, { h: 'تكلفة/متر', r: (r) => num(r.costPerMeter, 3) }, { h: 'الصافي', r: (r) => num(r.netProductCost, 2) }, { h: 'التصافي %', r: (r) => num(r.yieldPercent, 1) },
          { h: 'خسارة غير عادية', r: (r) => num(r.abnormalLoss, 2) }, { h: '⚠️', k: 'warnings' }, { h: '', r: (r) => <button className="btn" onClick={() => setOrderId(r.orderId)}>البطاقة</button> }]} />
      </Card>
      <Card title="البطاقة">
        <div className="mb-3 grid gap-3 md:grid-cols-3">
          <Field label="معرّف الأمر"><input className={inputCls} value={orderId} onChange={(e) => setOrderId(e.target.value.trim())} /></Field>
          <label className="flex items-end gap-2 text-sm"><input type="checkbox" checked={withUtil} onChange={(e) => setWithUtil(e.target.checked)} /> تضمين فواتير المرافق</label>
        </div>
        {error && <p className="text-sm text-red-700">{(error as any)?.response?.data?.message ?? 'تعذّر الحساب'}</p>}
        {c && (<>
          <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="صافي تكلفة المنتج" value={num(c.netProductCost, 2)} /><Kpi label="تكلفة الكجم" value={num(c.costPerKg, 3)} /><Kpi label="تكلفة المتر" value={num(c.costPerMeter, 3)} /><Kpi label="التصافي %" value={num(c.yieldPercent, 1)} /></div>
          <DataTable rows={[
            { n: 'المواد', v: c.lines.materials, b: BASIS[c.lines.materialsBasis] }, { n: 'التحويل', v: c.lines.conversion, b: BASIS[c.lines.conversionBasis] },
            ...c.lines.utilities.map((u: any) => ({ n: `مرافق: ${UT[u.kind] ?? u.kind}`, v: u.amount, b: 'فاتورة موزَّعة' })), { n: 'حوافز العمال', v: c.lines.incentives, b: 'فعلي' },
            { n: 'الإجمالي', v: c.gross, b: '' }, { n: '(−) استرداد هالك', v: -c.recovered, b: '' }, { n: '(−) خسارة غير عادية → أرباح وخسائر', v: -c.abnormalLoss, b: '' }, { n: 'الصافي', v: c.netProductCost, b: '' }]}
            cols={[{ h: 'البند', k: 'n' }, { h: 'القيمة', r: (r) => num(r.v, 2) }, { h: 'الأساس', k: 'b' }]} />
          {c.materialVariance !== null && <p className="mt-2 text-sm">انحراف المواد عن الخطة: <b className={c.materialVariance > 0 ? 'text-red-700' : 'text-emerald-700'}>{num(c.materialVariance, 2)}</b></p>}
          {c.linkedSale && <p className="text-sm">سعر بيع السطر المرتبط: {num(c.linkedSale.unitPrice, 2)} — هامش/كجم تقريبي: <b>{num(c.linkedSale.marginPerKg, 2)}</b></p>}
          {c.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
        </>)}
      </Card>
    </div>
  );
}
