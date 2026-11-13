/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { Card, DataTable, DateRange, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const KIND: Record<string, string> = { electricity: 'كهرباء', steam: 'بخار', water: 'ماء', gas: 'غاز', compressed_air: 'هواء مضغوط', other: 'أخرى' };
const DRV: Record<string, string> = { energy_kwh: 'kWh الفعلي', run_hours: 'ساعات التشغيل', output: 'كمية الإنتاج' };
const first = () => today().slice(0, 8) + '01';

/** فواتير المرافق وتوزيعها على المراحل (تقرير تحليلي بلا قيود). */
export default function UtilitiesPage() {
  const [from, setFrom] = useState(first());
  const [to, setTo] = useState(today());
  const { data: rep } = useGet<any>('/textile/reports/utility-allocation', { from, to });
  const { data: bills } = useGet('/textile/utility-bills', { from, to });
  const { data: branches } = useGet('/branches');
  const { busy, post, run } = useAction();
  const [f, setF] = useState({ branchId: '', kind: 'electricity', periodFrom: first(), periodTo: today(), totalCost: '', quantity: '', unit: '', driver: '' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await post('/textile/utility-bills', { branchId: f.branchId, kind: f.kind, periodFrom: f.periodFrom, periodTo: f.periodTo, totalCost: Number(f.totalCost),
      ...(f.quantity ? { quantity: Number(f.quantity) } : {}), ...(f.unit ? { unit: f.unit } : {}), ...(f.driver ? { driver: f.driver } : {}) }, 'سُجِّلت الفاتورة');
  };
  const del = (id: string) => run(async () => (await import('@/api/client')).apiClient.delete(`/textile/utility-bills/${id}`), 'حُذفت');

  return (
    <div>
      <PageHeader title="المرافق وتوزيعها على المراحل" sub="الكهرباء تُوزَّع بالـkWh الفعلي (أو ساعات التشغيل إن لم يُسجَّل)، والباقي بساعات التشغيل — تقرير تحليلي بلا قيود" />
      <TextileNav />
      <Card title="فاتورة مرافق جديدة">
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-4">
          <Field label="الفرع"><select required className={inputCls} value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">—</option>{branches?.map((b: Row) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
          <Field label="النوع"><select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="من"><input type="date" required className={inputCls} value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} /></Field>
          <Field label="إلى"><input type="date" required className={inputCls} value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} /></Field>
          <Field label="إجمالي التكلفة"><input required inputMode="decimal" className={inputCls} value={f.totalCost} onChange={(e) => setF({ ...f, totalCost: e.target.value })} /></Field>
          <Field label="الكمية (اختياري)"><input inputMode="decimal" className={inputCls} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
          <Field label="محرّك التوزيع"><select className={inputCls} value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })}><option value="">(تلقائي)</option>{Object.entries(DRV).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>حفظ</button></div>
        </form>
      </Card>
      <Card title="التوزيع على المراحل">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <div className="mb-3 grid gap-3 md:grid-cols-3"><Kpi label="عدد الفواتير" value={rep?.billsCount ?? '—'} /><Kpi label="إجمالي الموزَّع" value={rep ? num(rep.grandTotal, 2) : '—'} /></div>
        {rep?.warnings?.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
        <DataTable rows={rep?.stages} empty="لا توزيع في الفترة." cols={[{ h: 'المرحلة', k: 'stageName' },
          { h: 'التفصيل', r: (r) => Object.entries(r.byKind).map(([k, v]) => `${KIND[k] ?? k}: ${num(v as number, 2)}`).join(' — ') },
          { h: 'الإجمالي', r: (r) => <b>{num(r.total, 2)}</b> }, { h: 'الإنتاج', r: (r) => num(r.output, 1) }, { h: 'مرافق/وحدة', r: (r) => (r.costPerUnit == null ? '—' : num(r.costPerUnit, 4)) }]} />
      </Card>
      <Card title="الفواتير">
        <DataTable rows={bills} cols={[{ h: 'النوع', r: (r) => KIND[r.kind] }, { h: 'الفترة', r: (r) => `${String(r.period_from).slice(0, 10)} → ${String(r.period_to).slice(0, 10)}` }, { h: 'التكلفة', r: (r) => num(r.total_cost, 2) }, { h: 'المحرّك', r: (r) => DRV[r.driver] },
          { h: '', r: (r) => <button className="btn" disabled={busy} onClick={() => window.confirm('حذف الفاتورة؟') && del(r.id)}>حذف</button> }]} />
      </Card>
    </div>
  );
}
