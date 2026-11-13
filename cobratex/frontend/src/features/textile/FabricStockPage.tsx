/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, useGet } from '@/features/textile/shared';

/** محوّل كجم/متر/ياردة بالـGSM والعرض مع تسعير، ومخزون الرولات بالدرجة والعمر. */
export default function FabricStockPage() {
  const [c, setC] = useState({ gsm: '', widthCm: '', unit: 'kg', value: '', priceUnit: 'kg', price: '' });
  const ready = Number(c.gsm) > 0 && Number(c.widthCm) > 0 && Number(c.value) > 0;
  const params: any = { gsm: c.gsm, widthCm: c.widthCm, [c.unit === 'kg' ? 'kg' : c.unit === 'm' ? 'meters' : 'yards']: c.value, ...(c.price ? { [c.priceUnit === 'kg' ? 'pricePerKg' : 'pricePerMeter']: c.price } : {}) };
  const { data: r } = useGet<any>('/textile/convert/fabric', params, ready);
  const { data: st } = useGet<any>('/textile/reports/roll-stock');
  return (
    <div>
      <PageHeader title="الأقمشة: التحويل والمخزون" sub="كجم ↔ متر ↔ ياردة بالـGSM والعرض (والسعر للكيلو أو للمتر)، ومخزون الرولات حسب الدرجة والعمر." />
      <TextileNav />
      <Card title="محوّل الأقمشة">
        <div className="grid gap-3 md:grid-cols-6">
          <Field label="GSM"><input inputMode="decimal" className={inputCls} value={c.gsm} onChange={(e) => setC({ ...c, gsm: e.target.value })} /></Field>
          <Field label="العرض (سم)"><input inputMode="decimal" className={inputCls} value={c.widthCm} onChange={(e) => setC({ ...c, widthCm: e.target.value })} /></Field>
          <Field label="الكمية"><input inputMode="decimal" className={inputCls} value={c.value} onChange={(e) => setC({ ...c, value: e.target.value })} /></Field>
          <Field label="الوحدة"><select className={inputCls} value={c.unit} onChange={(e) => setC({ ...c, unit: e.target.value })}><option value="kg">كجم</option><option value="m">متر</option><option value="yd">ياردة</option></select></Field>
          <Field label="السعر (اختياري)"><input inputMode="decimal" className={inputCls} value={c.price} onChange={(e) => setC({ ...c, price: e.target.value })} /></Field>
          <Field label="سعر لكل"><select className={inputCls} value={c.priceUnit} onChange={(e) => setC({ ...c, priceUnit: e.target.value })}><option value="kg">كجم</option><option value="m">متر</option></select></Field>
        </div>
        {r && <div className="mt-3 grid gap-3 md:grid-cols-4"><Kpi label="كجم" value={num(r.kg, 3)} /><Kpi label="متر" value={num(r.meters, 2)} /><Kpi label="ياردة" value={num(r.yards, 2)} /><Kpi label="م²" value={num(r.sqMeters, 2)} />
          <Kpi label="كجم/متر" value={num(r.kgPerMeter, 4)} /><Kpi label="متر/كجم" value={num(r.metersPerKg, 3)} />{r.pricePerKg !== null && <><Kpi label="سعر/كجم" value={num(r.pricePerKg, 3)} /><Kpi label="سعر/متر" value={num(r.pricePerMeter, 3)} /></>}</div>}
      </Card>
      <Card title="مخزون الرولات">
        <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="رولات" value={st?.totalRolls ?? '—'} /><Kpi label="أمتار" value={st ? num(st.totalMeters, 1) : '—'} /><Kpi label="كجم" value={st ? num(st.totalKg, 1) : '—'} /><Kpi label="حصة الدرجة C %" value={st?.gradeCShare ?? '—'} tone={st?.gradeCShare > 10 ? 'bad' : 'good'} /></div>
        <DataTable rows={st?.groups} empty="لا رولات بالمخزن." cols={[{ h: 'الصنف', k: 'itemName' }, { h: 'الدرجة', k: 'grade' }, { h: 'رولات', k: 'rolls' }, { h: 'أمتار', r: (r) => num(r.meters, 1) }, { h: 'كجم', r: (r) => num(r.kg, 1) },
          { h: 'العمر 0-30 / 31-90 / 91-180 / +180', r: (r) => `${r.ageing['0-30']} / ${r.ageing['31-90']} / ${r.ageing['91-180']} / ${r.ageing['180+']}` }, { h: 'أقدم (يوم)', k: 'oldestDays' }]} />
      </Card>
    </div>
  );
}
