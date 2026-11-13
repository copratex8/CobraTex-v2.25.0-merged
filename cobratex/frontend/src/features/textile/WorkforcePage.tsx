import { useState, type FormEvent } from 'react';
import { useBranches } from '@/features/catalog/api';
import { Card, DataTable, DateRange, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const SHIFTS: Record<string, string> = { morning: 'صباحية', evening: 'مسائية', night: 'ليلية' };

/** العمالة وحوافز الإنتاج: العمال، معدّلات الحافز، إنتاج كل عامل بالوردية، وكشف الحافز بعد خصم المعيب. */
export default function WorkforcePage() {
  const { data: workers } = useGet('/textile/workers');
  const { data: rates } = useGet('/textile/incentive-rates');
  const { data: stages } = useGet('/textile/stages');
  const { data: machines } = useGet('/textile/machines');
  const { data: branches } = useBranches();
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const { data: rep } = useGet<{ workers: Row[]; totalIncentive: string; unratedLogs: number }>('/textile/reports/incentives', { from, to });
  const { data: logs } = useGet('/textile/worker-logs', { from, to });
  const { busy, post, run } = useAction();

  const [w, setW] = useState({ code: '', nameAr: '', jobTitle: '', stageId: '' });
  const addWorker = async (e: FormEvent) => {
    e.preventDefault();
    if (await post('/textile/workers', { code: w.code, nameAr: w.nameAr, ...(w.jobTitle ? { jobTitle: w.jobTitle } : {}), ...(w.stageId ? { stageId: w.stageId } : {}) }, 'تمت إضافة العامل')) setW({ code: '', nameAr: '', jobTitle: '', stageId: '' });
  };
  const [r, setR] = useState({ stageId: '', ratePerUnit: '', bonusThreshold: '', bonusRatePerUnit: '', effectiveFrom: today() });
  const addRate = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ratePerUnit: r.ratePerUnit, effectiveFrom: r.effectiveFrom, ...(r.stageId ? { stageId: r.stageId } : {}), ...(r.bonusThreshold ? { bonusThreshold: r.bonusThreshold, ...(r.bonusRatePerUnit ? { bonusRatePerUnit: r.bonusRatePerUnit } : {}) } : {}) };
    if (await post('/textile/incentive-rates', body, 'تمت إضافة المعدّل')) setR({ ...r, ratePerUnit: '', bonusThreshold: '', bonusRatePerUnit: '' });
  };
  const [l, setL] = useState({ workerId: '', machineId: '', logDate: today(), shift: 'morning', quantity: '', defectiveQuantity: '' });
  const addLog = async (e: FormEvent) => {
    e.preventDefault();
    const body = { branchId: branches?.[0]?.id, workerId: l.workerId, logDate: l.logDate, shift: l.shift, quantity: l.quantity, ...(l.machineId ? { machineId: l.machineId } : {}), ...(l.defectiveQuantity ? { defectiveQuantity: l.defectiveQuantity } : {}) };
    if (await post('/textile/worker-logs', body, 'تم تسجيل الإنتاج')) setL({ ...l, quantity: '', defectiveQuantity: '' });
  };
  const removeRate = (id: string) => void run(() => import('@/api/client').then(({ apiClient }) => apiClient.delete(`/textile/incentive-rates/${id}`)), 'تم حذف المعدّل');

  return (
    <div>
      <PageHeader title="العمالة وحوافز الإنتاج" sub="دفتر تشغيلي لحساب الحافز؛ الأجور الفعلية تُصرف من نظام الرواتب لديك" />
      <TextileNav />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Kpi label="إجمالي الحوافز بالفترة" value={num(rep?.totalIncentive)} />
        <Kpi label="عمال بإنتاج مسجَّل" value={rep?.workers.length ?? '—'} />
        <Kpi label="سجلات بلا معدّل حافز" value={rep?.unratedLogs ?? '—'} tone={rep && rep.unratedLogs > 0 ? 'bad' : 'good'} hint="أضف معدّلًا لوحدتها حتى تُحتسب" />
      </div>
      <Card title="كشف الحوافز">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <DataTable rows={rep?.workers} empty="لا إنتاج مسجَّل في الفترة." cols={[{ h: 'العامل', r: (x) => `${x.code} — ${x.name_ar}` }, { h: 'ورديات', k: 'shifts' }, { h: 'الإنتاج', r: (x) => num(x.total_quantity, 1) }, { h: 'المعيب', r: (x) => num(x.defective_quantity, 1) },
          { h: 'معيب %', r: (x) => num(x.defect_percent, 2) }, { h: 'الصافي', r: (x) => num(x.net_quantity, 1) }, { h: 'الحافز', r: (x) => <b>{num(x.incentive)}</b> }, { h: 'بلا معدّل', r: (x) => (x.unrated_logs ? <span className="text-red-700">{x.unrated_logs}</span> : '—') }]} />
      </Card>
      <Card title="تسجيل إنتاج وردية">
        <form onSubmit={addLog} className="grid gap-3 md:grid-cols-7">
          <Field label="العامل"><select required className={inputCls} value={l.workerId} onChange={(e) => setL({ ...l, workerId: e.target.value })}><option value="">—</option>{workers?.filter((x: Row) => x.is_active).map((x: Row) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field>
          <Field label="الماكينة"><select className={inputCls} value={l.machineId} onChange={(e) => setL({ ...l, machineId: e.target.value })}><option value="">—</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code}</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" required className={inputCls} value={l.logDate} onChange={(e) => setL({ ...l, logDate: e.target.value })} /></Field>
          <Field label="الوردية"><select className={inputCls} value={l.shift} onChange={(e) => setL({ ...l, shift: e.target.value })}>{Object.entries(SHIFTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="الكمية (كجم)"><input required className={inputCls} dir="ltr" value={l.quantity} onChange={(e) => setL({ ...l, quantity: e.target.value })} /></Field>
          <Field label="المعيب"><input className={inputCls} dir="ltr" value={l.defectiveQuantity} onChange={(e) => setL({ ...l, defectiveQuantity: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>تسجيل</button></div>
        </form>
        <div className="mt-4"><DataTable rows={logs} empty="لا سجلات." cols={[{ h: 'التاريخ', r: (x) => String(x.log_date).slice(0, 10) }, { h: 'العامل', r: (x) => x.worker_name }, { h: 'الماكينة', r: (x) => x.machine_code ?? '—' }, { h: 'الوردية', r: (x) => SHIFTS[x.shift] }, { h: 'الكمية', r: (x) => num(x.quantity, 1) }, { h: 'المعيب', r: (x) => num(x.defective_quantity, 1) }]} /></div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="معدّلات الحافز">
          <DataTable rows={rates} empty="لا معدّلات بعد." cols={[{ h: 'المرحلة', r: (x) => x.stage_name ?? 'كل المراحل' }, { h: 'للوحدة', r: (x) => num(x.rate_per_unit, 4) }, { h: 'الحدّ', r: (x) => num(x.bonus_threshold, 1) }, { h: 'معدّل الزيادة', r: (x) => num(x.bonus_rate_per_unit, 4) }, { h: 'من', r: (x) => String(x.effective_from).slice(0, 10) },
            { h: '', r: (x) => <button className="btn btn-sm btn-danger" onClick={() => removeRate(x.id)}>حذف</button> }]} />
          <form onSubmit={addRate} className="mt-3 grid gap-2 md:grid-cols-3">
            <Field label="المرحلة"><select className={inputCls} value={r.stageId} onChange={(e) => setR({ ...r, stageId: e.target.value })}><option value="">كل المراحل</option>{stages?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
            <Field label="المعدّل / كجم"><input required className={inputCls} dir="ltr" value={r.ratePerUnit} onChange={(e) => setR({ ...r, ratePerUnit: e.target.value })} /></Field>
            <Field label="سريان من"><input type="date" required className={inputCls} value={r.effectiveFrom} onChange={(e) => setR({ ...r, effectiveFrom: e.target.value })} /></Field>
            <Field label="حدّ الوردية (اختياري)"><input className={inputCls} dir="ltr" value={r.bonusThreshold} onChange={(e) => setR({ ...r, bonusThreshold: e.target.value })} /></Field>
            <Field label="معدّل ما فوق الحدّ"><input className={inputCls} dir="ltr" value={r.bonusRatePerUnit} onChange={(e) => setR({ ...r, bonusRatePerUnit: e.target.value })} /></Field>
            <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة معدّل</button></div>
          </form>
        </Card>
        <Card title="العمال">
          <DataTable rows={workers} empty="لا عمال." cols={[{ h: 'الكود', k: 'code' }, { h: 'الاسم', k: 'name_ar' }, { h: 'الوظيفة', r: (x) => x.job_title ?? '—' }, { h: 'المرحلة', r: (x) => x.stage_name ?? '—' }, { h: 'نشط', r: (x) => (x.is_active ? 'نعم' : 'لا') }]} />
          <form onSubmit={addWorker} className="mt-3 grid gap-2 md:grid-cols-4">
            <Field label="الكود"><input required className={inputCls} dir="ltr" value={w.code} onChange={(e) => setW({ ...w, code: e.target.value })} /></Field>
            <Field label="الاسم"><input required className={inputCls} value={w.nameAr} onChange={(e) => setW({ ...w, nameAr: e.target.value })} /></Field>
            <Field label="الوظيفة"><input className={inputCls} value={w.jobTitle} onChange={(e) => setW({ ...w, jobTitle: e.target.value })} /></Field>
            <Field label="المرحلة"><select className={inputCls} value={w.stageId} onChange={(e) => setW({ ...w, stageId: e.target.value })}><option value="">—</option>{stages?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
            <div className="md:col-span-4"><button className="btn btn-gold" disabled={busy}>إضافة عامل</button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}
