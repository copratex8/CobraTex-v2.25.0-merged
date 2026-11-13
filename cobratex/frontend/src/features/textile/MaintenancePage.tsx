import { useState, type FormEvent } from 'react';
import { Card, DataTable, DateRange, Field, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const TYPES: Record<string, string> = { preventive: 'وقائية', breakdown: 'عطل', inspection: 'فحص' };

/** خطط الصيانة الدورية، تسجيل الصيانة والأعطال، وتكلفتها وساعات التوقف لكل ماكينة. */
export default function MaintenancePage() {
  const { data: machines } = useGet('/textile/machines');
  const { data: plans } = useGet('/textile/maintenance/plans');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: logs } = useGet('/textile/maintenance/logs', { from, to });
  const { data: rep } = useGet('/textile/reports/maintenance', { from, to });
  const { busy, post, put } = useAction();

  const [p, setP] = useState({ machineId: '', taskName: '', intervalDays: '30' });
  const addPlan = async (e: FormEvent) => { e.preventDefault(); if (await post('/textile/maintenance/plans', { machineId: p.machineId, taskName: p.taskName, intervalDays: Number(p.intervalDays) }, 'تمت إضافة الخطة')) setP({ ...p, taskName: '' }); };

  const [l, setL] = useState({ machineId: '', planId: '', logType: 'preventive', logDate: today(), downtimeHours: '0', cost: '0', description: '' });
  const addLog = async (e: FormEvent) => {
    e.preventDefault();
    const body = { machineId: l.machineId, logType: l.logType, logDate: l.logDate, downtimeHours: l.downtimeHours, cost: l.cost, ...(l.planId ? { planId: l.planId } : {}), ...(l.description ? { description: l.description } : {}) };
    if (await post('/textile/maintenance/logs', body, 'تم تسجيل الصيانة')) setL({ ...l, planId: '', description: '', downtimeHours: '0', cost: '0' });
  };
  const planChoices = plans?.filter((x: Row) => x.is_active && x.machine_id === l.machineId) ?? [];

  return (
    <div>
      <PageHeader title="صيانة الماكينات" sub="الصيانة الوقائية تُحدِّث موعد الخطة تلقائيًا" />
      <TextileNav />
      <Card title="خطط الصيانة الدورية">
        <DataTable rows={plans} cols={[
          { h: 'الماكينة', r: (r) => `${r.machine_code} — ${r.machine_name_ar}` }, { h: 'المهمة', k: 'task_name' }, { h: 'كل (يوم)', k: 'interval_days' },
          { h: 'آخر تنفيذ', r: (r) => (r.last_done_date ? String(r.last_done_date).slice(0, 10) : '—') },
          { h: 'الاستحقاق', r: (r) => <span className={r.overdue && r.is_active ? 'font-bold text-red-700' : ''}>{String(r.next_due_date).slice(0, 10)}</span> },
          { h: 'مفعّلة', r: (r) => <input type="checkbox" checked={r.is_active} disabled={busy} onChange={(e) => void put(`/textile/maintenance/plans/${r.id}`, { isActive: e.target.checked })} /> },
        ]} />
        <form onSubmit={addPlan} className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label="الماكينة"><select required className={inputCls} value={p.machineId} onChange={(e) => setP({ ...p, machineId: e.target.value })}><option value="">—</option>{machines?.map((x: Row) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field>
          <Field label="المهمة"><input required className={inputCls} value={p.taskName} onChange={(e) => setP({ ...p, taskName: e.target.value })} placeholder="تزييت، ضبط شدّ، تنظيف…" /></Field>
          <Field label="كل كم يوم"><input required className={inputCls} dir="ltr" value={p.intervalDays} onChange={(e) => setP({ ...p, intervalDays: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة خطة</button></div>
        </form>
      </Card>

      <Card title="تسجيل صيانة / عطل">
        <form onSubmit={addLog} className="grid gap-3 md:grid-cols-4">
          <Field label="الماكينة"><select required className={inputCls} value={l.machineId} onChange={(e) => setL({ ...l, machineId: e.target.value, planId: '' })}><option value="">—</option>{machines?.map((x: Row) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field>
          <Field label="النوع"><select className={inputCls} value={l.logType} onChange={(e) => setL({ ...l, logType: e.target.value })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="الخطة (للوقائية)"><select className={inputCls} value={l.planId} onChange={(e) => setL({ ...l, planId: e.target.value })}><option value="">—</option>{planChoices.map((x: Row) => <option key={x.id} value={x.id}>{x.task_name}</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" required className={inputCls} value={l.logDate} onChange={(e) => setL({ ...l, logDate: e.target.value })} /></Field>
          <Field label="ساعات التوقف"><input className={inputCls} dir="ltr" value={l.downtimeHours} onChange={(e) => setL({ ...l, downtimeHours: e.target.value })} /></Field>
          <Field label="التكلفة"><input className={inputCls} dir="ltr" value={l.cost} onChange={(e) => setL({ ...l, cost: e.target.value })} /></Field>
          <Field label="الوصف"><input className={inputCls} value={l.description} onChange={(e) => setL({ ...l, description: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>حفظ</button></div>
        </form>
        <p className="mt-2 text-xs text-slate-400">تكلفة الصيانة هنا للمتابعة التشغيلية؛ قيدها المحاسبي يتم من مستند المصروف الأصلي.</p>
      </Card>

      <Card title="التكلفة والتوقف لكل ماكينة">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <DataTable rows={rep} cols={[{ h: 'الماكينة', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'أعطال', k: 'breakdowns' }, { h: 'وقائية', k: 'preventive' }, { h: 'ساعات توقف', r: (r) => num(r.downtime_hours) }, { h: 'التكلفة', r: (r) => num(r.cost) }]} />
      </Card>
      <Card title="السجل">
        <DataTable rows={logs} cols={[{ h: 'التاريخ', r: (r) => String(r.log_date).slice(0, 10) }, { h: 'الماكينة', k: 'machine_code' }, { h: 'النوع', r: (r) => TYPES[r.log_type] }, { h: 'توقف', r: (r) => num(r.downtime_hours) }, { h: 'التكلفة', r: (r) => num(r.cost) }, { h: 'الوصف', r: (r) => r.description ?? '—' }]} />
      </Card>
    </div>
  );
}
