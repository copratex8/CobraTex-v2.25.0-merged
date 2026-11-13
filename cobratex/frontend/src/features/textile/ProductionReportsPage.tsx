import { useState } from 'react';
import { Card, DataTable, DateRange, PageHeader, TextileNav, num, useGet, type Row } from '@/features/textile/shared';

const pctCls = (v: unknown, bad = 0) => (Number(v) > bad ? 'font-bold text-red-700' : 'text-emerald-700');

/** تقارير الإنتاج اليومية، ميزان المادة (الفاقد غير المفسَّر)، كفاءة OEE، وانحراف التكلفة عن المعيار. */
export default function ProductionReportsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: daily } = useGet('/textile/reports/daily-production', { from, to });
  const { data: bal } = useGet<{ orders: Row[]; byStage: Row[] }>('/textile/reports/material-balance', { from, to });
  const { data: oee } = useGet('/textile/reports/oee', { from, to });
  const { data: cv } = useGet('/textile/reports/cost-variance', { from, to });

  return (
    <div>
      <PageHeader title="تقارير الإنتاج والتكلفة" sub="إنتاج يومي، ميزان المادة، OEE، انحراف التكلفة" />
      <TextileNav />
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />

      <Card title="الإنتاج اليومي حسب المرحلة">
        <DataTable rows={daily} cols={[
          { h: 'التاريخ', r: (r) => String(r.log_date).slice(0, 10) }, { h: 'المرحلة', k: 'stage_name' }, { h: 'ماكينات', k: 'machines' }, { h: 'الإنتاج', r: (r) => `${num(r.output, 1)} ${r.output_unit}` },
          { h: 'الهالك', r: (r) => num(r.waste, 1) }, { h: 'هالك %', r: (r) => (r.wastePercent ? num(r.wastePercent, 2) : '—') }, { h: 'ساعات تشغيل', r: (r) => num(r.run_hours, 1) }, { h: 'توقف', r: (r) => num(r.downtime_hours, 1) },
        ]} />
      </Card>

      <Card title="ميزان المادة (المُدخَل − المخرجات − الهالك المسجَّل)" badge="الفرق = فاقد غير مرئي أو تسجيل ناقص">
        <DataTable rows={bal?.byStage} empty="لا أوامر منفَّذة قابلة للمقارنة." cols={[
          { h: 'المرحلة', r: (r) => r.stageNameAr ?? 'بلا مرحلة' }, { h: 'أوامر', k: 'orders' }, { h: 'المُدخَل', r: (r) => num(r.inputQty, 1) }, { h: 'غير مفسَّر', r: (r) => num(r.unexplainedQty, 1) },
          { h: '%', r: (r) => <span className={pctCls(r.unexplainedPercent, 1)}>{r.unexplainedPercent ? num(r.unexplainedPercent, 2) : '—'}</span> },
        ]} />
        <p className="mb-2 mt-4 text-sm font-bold">تفصيل الأوامر</p>
        <DataTable rows={bal?.orders} cols={[
          { h: 'الأمر', k: 'documentNumber' }, { h: 'المرحلة', r: (r) => r.stageNameAr ?? '—' }, { h: 'مُدخَل', r: (r) => num(r.mainInputQty, 1) }, { h: 'مخرجات', r: (r) => num(r.outputQty, 1) }, { h: 'هالك', r: (r) => num(r.recordedWasteQty, 1) },
          { h: 'غير مفسَّر %', r: (r) => (r.comparable ? <span className={pctCls(r.unexplainedPercent, 1)}>{num(r.unexplainedPercent, 2)}</span> : 'غير قابل للمقارنة') },
        ]} />
      </Card>

      <Card title="كفاءة الماكينات (OEE)">
        <DataTable rows={oee} cols={[
          { h: 'الماكينة', r: (r) => `${r.code} — ${r.nameAr}` }, { h: 'ورديات', k: 'shifts' }, { h: 'تشغيل س', r: (r) => num(r.runHours, 1) }, { h: 'توقف س', r: (r) => num(r.downtimeHours, 1) },
          { h: 'الإتاحة %', r: (r) => num(r.availability, 1) }, { h: 'الأداء %', r: (r) => num(r.performance, 1) }, { h: 'الجودة %', r: (r) => num(r.quality, 1) },
          { h: 'OEE %', r: (r) => <b>{num(r.oee, 1)}</b> }, { h: 'kWh/وحدة', r: (r) => (r.kwhPerUnit ? num(r.kwhPerUnit, 3) : '—') }, { h: 'إنتاج/ساعة عامل', r: (r) => (r.outputPerOperatorHour ? num(r.outputPerOperatorHour, 2) : '—') },
        ]} />
      </Card>

      <Card title="انحراف التكلفة عن الوصفة" badge="موجب = أغلى من المعيار">
        <DataTable rows={cv} cols={[
          { h: 'الأمر', k: 'documentNumber' }, { h: 'التاريخ', r: (r) => String(r.orderDate).slice(0, 10) }, { h: 'الصنف', r: (r) => `${r.itemCode} — ${r.itemNameAr}` }, { h: 'الكمية', r: (r) => num(r.outputQty, 1) },
          { h: 'فعلي/وحدة', r: (r) => num(r.actualUnitCost, 3) }, { h: 'معياري/وحدة', r: (r) => num(r.standardUnitCost, 3) }, { h: 'الانحراف', r: (r) => <span className={pctCls(r.variance)}>{num(r.variance, 3)}</span> },
          { h: '%', r: (r) => (r.variancePercent ? num(r.variancePercent, 1) : '—') },
        ]} />
      </Card>
    </div>
  );
}
