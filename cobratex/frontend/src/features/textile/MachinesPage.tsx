import { useState, type FormEvent } from 'react';
import { useBranches } from '@/features/catalog/api';
import { Card, DataTable, DateRange, Field, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const SHIFTS: Record<string, string> = { morning: 'صباحية', evening: 'مسائية', night: 'ليلية' };

/** الماكينات، سجل إنتاج الورديات، وكفاءة التشغيل (الفعلي مقابل الطاقة الاسمية). */
export default function MachinesPage() {
  const { data: machines } = useGet('/textile/machines');
  const { data: stages } = useGet('/textile/stages');
  const { data: branches } = useBranches();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: logs } = useGet('/textile/machine-logs', { from, to });
  const { data: eff } = useGet<{ machines: Row[]; downtime: Row[] }>('/textile/reports/machine-efficiency', { from, to });
  const { busy, post } = useAction();

  const [m, setM] = useState({ code: '', nameAr: '', nameEn: '', stageId: '', unitsCount: '1', ratedOutputPerHour: '0', outputUnit: 'kg' });
  const addMachine = async (e: FormEvent) => {
    e.preventDefault();
    const body = { code: m.code, nameAr: m.nameAr, nameEn: m.nameEn, unitsCount: Number(m.unitsCount), ratedOutputPerHour: m.ratedOutputPerHour, outputUnit: m.outputUnit, ...(m.stageId ? { stageId: m.stageId } : {}) };
    if (await post('/textile/machines', body, 'تمت إضافة الماكينة')) setM({ ...m, code: '', nameAr: '', nameEn: '' });
  };

  const [l, setL] = useState({ branchId: '', machineId: '', shift: 'morning', logDate: today(), runHours: '8', downtimeHours: '0', downtimeReason: '', outputQuantity: '', wasteQuantity: '0', energyKwh: '', operatorsCount: '' });
  const addLog = async (e: FormEvent) => {
    e.preventDefault();
    const body = { branchId: l.branchId || branches?.[0]?.id, machineId: l.machineId, shift: l.shift, logDate: l.logDate, runHours: l.runHours, downtimeHours: l.downtimeHours, outputQuantity: l.outputQuantity, wasteQuantity: l.wasteQuantity, ...(l.downtimeReason ? { downtimeReason: l.downtimeReason } : {}) };
    if (await post('/textile/machine-logs', body, 'تم تسجيل الوردية')) setL({ ...l, outputQuantity: '', downtimeHours: '0', downtimeReason: '', wasteQuantity: '0' });
  };

  return (
    <div>
      <PageHeader title="الماكينات وسجل الورديات" sub="الطاقة الاسمية في الساعة أساس حساب الكفاءة" />
      <TextileNav />
      <Card title="الماكينات">
        <DataTable rows={machines} cols={[
          { h: 'الكود', k: 'code' }, { h: 'الاسم', k: 'name_ar' }, { h: 'المرحلة', r: (r) => r.stage_name_ar ?? '—' }, { h: 'الوحدات (مغازل/أنوال)', k: 'units_count' },
          { h: 'الطاقة/ساعة', r: (r) => `${num(r.rated_output_per_hour, 3)} ${r.output_unit}` }, { h: 'الحالة', r: (r) => (r.is_active ? 'تعمل' : 'موقوفة') },
        ]} />
        <form onSubmit={addMachine} className="mt-4 grid gap-3 md:grid-cols-7">
          <Field label="الكود"><input required className={inputCls} dir="ltr" value={m.code} onChange={(e) => setM({ ...m, code: e.target.value })} /></Field>
          <Field label="الاسم (عربي)"><input required className={inputCls} value={m.nameAr} onChange={(e) => setM({ ...m, nameAr: e.target.value })} /></Field>
          <Field label="الاسم (إنجليزي)"><input required className={inputCls} dir="ltr" value={m.nameEn} onChange={(e) => setM({ ...m, nameEn: e.target.value })} /></Field>
          <Field label="المرحلة"><select className={inputCls} value={m.stageId} onChange={(e) => setM({ ...m, stageId: e.target.value })}><option value="">—</option>{stages?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
          <Field label="عدد الوحدات"><input className={inputCls} dir="ltr" value={m.unitsCount} onChange={(e) => setM({ ...m, unitsCount: e.target.value })} /></Field>
          <Field label="الطاقة/ساعة"><input className={inputCls} dir="ltr" value={m.ratedOutputPerHour} onChange={(e) => setM({ ...m, ratedOutputPerHour: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
        </form>
      </Card>

      <Card title="تسجيل وردية">
        <form onSubmit={addLog} className="grid gap-3 md:grid-cols-5">
          <Field label="الفرع"><select className={inputCls} value={l.branchId || branches?.[0]?.id || ''} onChange={(e) => setL({ ...l, branchId: e.target.value })}>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name_ar}</option>)}</select></Field>
          <Field label="الماكينة"><select required className={inputCls} value={l.machineId} onChange={(e) => setL({ ...l, machineId: e.target.value })}><option value="">—</option>{machines?.filter((x: Row) => x.is_active).map((x: Row) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field>
          <Field label="الوردية"><select className={inputCls} value={l.shift} onChange={(e) => setL({ ...l, shift: e.target.value })}>{Object.entries(SHIFTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" required className={inputCls} value={l.logDate} onChange={(e) => setL({ ...l, logDate: e.target.value })} /></Field>
          <Field label="ساعات التشغيل"><input required className={inputCls} dir="ltr" value={l.runHours} onChange={(e) => setL({ ...l, runHours: e.target.value })} /></Field>
          <Field label="ساعات التوقف"><input className={inputCls} dir="ltr" value={l.downtimeHours} onChange={(e) => setL({ ...l, downtimeHours: e.target.value })} /></Field>
          <Field label="سبب التوقف"><input className={inputCls} value={l.downtimeReason} onChange={(e) => setL({ ...l, downtimeReason: e.target.value })} placeholder="مطلوب عند وجود توقف" /></Field>
          <Field label="الإنتاج"><input required className={inputCls} dir="ltr" value={l.outputQuantity} onChange={(e) => setL({ ...l, outputQuantity: e.target.value })} /></Field>
          <Field label="الهالك"><input className={inputCls} dir="ltr" value={l.wasteQuantity} onChange={(e) => setL({ ...l, wasteQuantity: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy || !machines?.length}>حفظ الوردية</button></div>
        </form>
      </Card>

      <Card title="الكفاءة والاستغلال">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <DataTable rows={eff?.machines} empty="لا توجد سجلات في الفترة." cols={[
          { h: 'الماكينة', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'ورديات', k: 'shifts' }, { h: 'ساعات التشغيل', r: (r) => num(r.run_hours) }, { h: 'ساعات التوقف', r: (r) => num(r.downtime_hours) },
          { h: 'الإنتاج الفعلي', r: (r) => num(r.output, 1) }, { h: 'النظري', r: (r) => num(r.theoretical_output, 1) },
          { h: 'الكفاءة %', r: (r) => <b className={Number(r.efficiency_percent) < 80 ? 'text-red-700' : 'text-emerald-700'}>{num(r.efficiency_percent, 1)}</b> }, { h: 'الاستغلال %', r: (r) => num(r.utilization_percent, 1) },
        ]} />
        {eff && eff.downtime.length > 0 && (
          <div className="mt-4"><p className="mb-2 text-sm font-bold">أعلى أسباب التوقف</p>
            <DataTable rows={eff.downtime} cols={[{ h: 'السبب', r: (r) => r.reason ?? '—' }, { h: 'ساعات', r: (r) => num(r.hours) }, { h: 'مرات', k: 'occurrences' }]} /></div>
        )}
      </Card>

      <Card title="آخر السجلات">
        <DataTable rows={logs} cols={[
          { h: 'التاريخ', r: (r) => String(r.log_date).slice(0, 10) }, { h: 'الماكينة', r: (r) => r.machine_code }, { h: 'الوردية', r: (r) => SHIFTS[r.shift] },
          { h: 'تشغيل', r: (r) => num(r.run_hours) }, { h: 'توقف', r: (r) => num(r.downtime_hours) }, { h: 'السبب', r: (r) => r.downtime_reason ?? '—' },
          { h: 'إنتاج', r: (r) => num(r.output_quantity, 1) }, { h: 'هالك', r: (r) => num(r.waste_quantity, 1) },
        ]} />
      </Card>
    </div>
  );
}
