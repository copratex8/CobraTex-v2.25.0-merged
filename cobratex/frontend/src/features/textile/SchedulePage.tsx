import { useState, type FormEvent } from 'react';
import { Card, DataTable, DateRange, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const addDays = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);

/** جدولة الإنتاج: أوامر المسودة على الماكينات مع كشف التعارض ونسبة حمل كل ماكينة. */
export default function SchedulePage() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(addDays(today(), 30));
  const { data } = useGet<{ orders: Row[]; conflicts: Row[]; load: Row[] }>('/textile/schedule', { from, to });
  const { data: machines } = useGet('/textile/machines');
  const { data: drafts } = useGet<any>('/manufacturing/orders', { page: 1, pageSize: 100 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const { busy, put } = useAction();
  const [f, setF] = useState({ orderId: '', machineId: '', plannedStart: today(), plannedEnd: addDays(today(), 3), force: false });
  const orders: Row[] = ((Array.isArray(drafts) ? drafts : drafts?.data ?? []) as Row[]).filter((o) => o.status === 'draft');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await put(`/textile/orders/${f.orderId}/schedule`, { plannedStart: f.plannedStart, plannedEnd: f.plannedEnd, ...(f.machineId ? { machineId: f.machineId } : {}), ...(f.force ? { force: true } : {}) }, 'تمت الجدولة');
  };

  return (
    <div>
      <PageHeader title="جدولة الإنتاج" sub="تعارض أمرين على نفس الماكينة يُرفض ما لم تختر «تجاوز التعارض»" />
      <TextileNav />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Kpi label="أوامر مجدولة بالفترة" value={data?.orders.length ?? '—'} />
        <Kpi label="تعارضات" value={data?.conflicts.length ?? '—'} tone={data && data.conflicts.length > 0 ? 'bad' : 'good'} />
        <Kpi label="أعلى حمل ماكينة" value={data ? `${Math.max(0, ...data.load.map((l) => Number(l.load_percent)))}%` : '—'} />
      </div>
      <Card title="جدولة أمر">
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-6">
          <Field label="أمر التصنيع (مسودة)"><select required className={inputCls} value={f.orderId} onChange={(e) => setF({ ...f, orderId: e.target.value })}><option value="">—</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.document_number}</option>)}</select></Field>
          <Field label="الماكينة"><select className={inputCls} value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value })}><option value="">(ماكينة الأمر)</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code} — {m.name_ar}</option>)}</select></Field>
          <Field label="من"><input type="date" required className={inputCls} value={f.plannedStart} onChange={(e) => setF({ ...f, plannedStart: e.target.value })} /></Field>
          <Field label="إلى"><input type="date" required className={inputCls} value={f.plannedEnd} onChange={(e) => setF({ ...f, plannedEnd: e.target.value })} /></Field>
          <label className="flex items-end gap-2 text-sm"><input type="checkbox" checked={f.force} onChange={(e) => setF({ ...f, force: e.target.checked })} /> تجاوز التعارض</label>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>حفظ الجدولة</button></div>
        </form>
      </Card>
      <Card title="حمل الماكينات">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <DataTable rows={data?.load} cols={[{ h: 'الماكينة', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'أيام مجدولة', k: 'scheduled_days' }, { h: 'أيام الفترة', k: 'period_days' },
          { h: 'الحمل', r: (r) => <b className={Number(r.load_percent) >= 90 ? 'text-red-700' : 'text-emerald-700'}>{num(r.load_percent, 1)}%</b> }]} />
      </Card>
      <Card title="الأوامر المجدولة">
        <DataTable rows={data?.orders} empty="لا أوامر مجدولة في الفترة." cols={[{ h: 'الأمر', k: 'document_number' }, { h: 'الماكينة', r: (r) => r.machine_code ?? '—' }, { h: 'الصنف', r: (r) => r.output_item ?? '—' },
          { h: 'من', r: (r) => String(r.planned_start).slice(0, 10) }, { h: 'إلى', r: (r) => String(r.planned_end).slice(0, 10) }, { h: 'الكمية', r: (r) => num(r.planned_output_quantity, 1) }, { h: 'الحالة', k: 'status' }]} />
      </Card>
      {data && data.conflicts.length > 0 && (
        <Card title="⚠️ تعارضات الماكينات">
          <DataTable rows={data.conflicts} cols={[{ h: 'الأمر', k: 'order_no' }, { h: 'يتعارض مع', k: 'other_no' }, { h: 'من', r: (r) => String(r.overlap_from).slice(0, 10) }, { h: 'إلى', r: (r) => String(r.overlap_to).slice(0, 10) }]} />
        </Card>
      )}
    </div>
  );
}
