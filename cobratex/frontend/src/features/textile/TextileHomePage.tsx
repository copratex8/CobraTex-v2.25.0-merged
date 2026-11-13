import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, DataTable, DateRange, Kpi, PageHeader, TextileNav, num, useGet, type Row } from '@/features/textile/shared';

interface Dash {
  orders: Row; wastePercent: string | null; wasteByStage: Row[]; machineEfficiencyPercent: string | null; utilizationPercent: string | null;
  topDowntime: Row[]; rolls: Row[]; quality: Row; maintenance: Row;
}

/** لوحة مؤشرات المصنع: إنتاج، هالك مقابل القياسي، كفاءة الماكينات، جودة، صيانة. */
export default function TextileHomePage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: d, isError } = useGet<Dash>('/textile/dashboard', { from, to });
  const { data: due } = useGet<Row[]>('/textile/maintenance/due', { days: 7 });

  return (
    <div>
      <PageHeader title="الغزل والنسيج" sub="مراحل الإنتاج، الهوالك، الماكينات، الجودة والصيانة" />
      <TextileNav />
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {isError && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">تعذّر تحميل المؤشرات (تأكد أن وحدة التصنيع مفعَّلة ولديك صلاحية textile.report.view).</p>}
      {d && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="أوامر منفَّذة" value={d.orders.posted} hint={`${d.orders.draft} مسودة`} />
            <Kpi label="الهالك الفعلي" value={d.wastePercent ? `${num(d.wastePercent, 2)}%` : '—'} hint="من الخامة الرئيسية" />
            <Kpi label="كفاءة الماكينات" value={d.machineEfficiencyPercent ? `${num(d.machineEfficiencyPercent, 1)}%` : '—'} hint={d.utilizationPercent ? `استغلال ${num(d.utilizationPercent, 1)}%` : undefined} />
            <Kpi label="خسارة الهالك غير العادي" value={num(d.orders.abnormal_loss)} tone={Number(d.orders.abnormal_loss) > 0 ? 'bad' : 'good'} hint={`استرداد هوالك ${num(d.orders.recovered_value)}`} />
            <Kpi label="اختبارات الجودة" value={d.quality.total} hint={`${d.quality.failed} راسب`} tone={d.quality.failed > 0 ? 'bad' : undefined} />
            <Kpi label="صيانة متأخرة" value={d.maintenance.overdue} tone={d.maintenance.overdue > 0 ? 'bad' : 'good'} hint={`${d.maintenance.due_soon} خلال 7 أيام`} />
            <Kpi label="رولات مفحوصة" value={d.rolls.reduce((a: number, r: Row) => a + r.rolls, 0)} hint={d.rolls.map((r: Row) => `${r.grade}: ${r.rolls}`).join(' · ') || undefined} />
            <Kpi label="إجمالي تكلفة الأوامر" value={num(d.orders.total_cost, 0)} />
          </div>
          <Card title="الهالك الفعلي مقابل القياسي حسب المرحلة" badge="أوامر منفَّذة">
            <DataTable rows={d.wasteByStage} cols={[
              { h: 'المرحلة', r: (r) => r.nameAr ?? 'بلا مرحلة' }, { h: 'القياسي %', r: (r) => num(r.standard, 2) },
              { h: 'الفعلي %', r: (r) => <b className={Number(r.actual) > Number(r.standard) ? 'text-red-700' : 'text-emerald-700'}>{num(r.actual, 2)}</b> },
            ]} />
          </Card>
        </>
      )}
      <Card title="صيانة مستحقة (متأخرة أو خلال 7 أيام)">
        <DataTable rows={due} empty="لا توجد صيانة مستحقة." cols={[
          { h: 'الماكينة', r: (r) => `${r.machine_code} — ${r.machine_name_ar}` }, { h: 'المهمة', k: 'task_name' },
          { h: 'الاستحقاق', r: (r) => <span className={r.overdue ? 'font-bold text-red-700' : ''}>{String(r.next_due_date).slice(0, 10)}{r.overdue ? ' (متأخرة)' : ''}</span> },
        ]} />
        <p className="mt-3 text-xs text-slate-500">لتسجيل الإنتاج الفعلي والهالك لأمر تصنيع: افتح الأمر من <Link className="underline" to="/manufacturing/orders">أوامر التصنيع</Link> ثم «الإنتاج الفعلي والهالك».</p>
      </Card>
    </div>
  );
}
