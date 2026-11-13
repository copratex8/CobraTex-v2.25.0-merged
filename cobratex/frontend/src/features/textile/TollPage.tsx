import { useState, type FormEvent } from 'react';
import { useBranches } from '@/features/catalog/api';
import { useCustomers } from '@/features/customers/api';
import { apiClient } from '@/api/client';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const SERVICES: Record<string, string> = { spinning: 'غزل', weaving: 'نسيج', dyeing: 'صباغة', finishing: 'تجهيز', printing: 'طباعة', other: 'أخرى' };
const MOVES: Record<string, string> = { receipt: 'استلام خامة من العميل', output: 'تسليم ناتج للعميل', waste_returned: 'هالك معاد للعميل', waste_retained: 'هالك محتجز بالمصنع', invoice: 'فاتورة أجر' };

/** التشغيل للغير (خامات العميل): رصيد الخامة لدى المصنع، الفاقد المسموح، الأجر، وتعويض الزائد عند الإقفال. */
export default function TollPage() {
  const { data: jobs } = useGet('/textile/toll-jobs');
  const { data: customers } = useCustomers(1, 100);
  const { data: branches } = useBranches();
  const { busy, post, run } = useAction();
  const [sel, setSel] = useState<Row | null>(null);

  const [j, setJ] = useState({ jobNo: '', customerId: '', serviceType: 'spinning', materialDescription: '', unit: 'kg', feePerUnit: '', feeBasis: 'output', allowedLossPercent: '', materialValuePerUnit: '' });
  const addJob = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      branchId: branches?.[0]?.id, jobNo: j.jobNo, customerId: j.customerId, serviceType: j.serviceType, materialDescription: j.materialDescription, unit: j.unit, feePerUnit: j.feePerUnit, feeBasis: j.feeBasis,
      ...(j.allowedLossPercent ? { allowedLossPercent: j.allowedLossPercent } : {}), ...(j.materialValuePerUnit ? { materialValuePerUnit: j.materialValuePerUnit } : {}),
    };
    if (await post('/textile/toll-jobs', body, 'تم فتح العمل')) setJ({ ...j, jobNo: '', materialDescription: '', feePerUnit: '' });
  };
  const open = async (id: string) => setSel(await run(() => apiClient.get(`/textile/toll-jobs/${id}`)));
  const [m, setM] = useState({ movementType: 'receipt', movementDate: today(), quantity: '', amount: '', reference: '' });
  const addMove = async (e: FormEvent) => {
    e.preventDefault();
    if (!sel) return;
    const body = { movementType: m.movementType, movementDate: m.movementDate, ...(m.movementType === 'invoice' ? { amount: m.amount } : { quantity: m.quantity }), ...(m.reference ? { reference: m.reference } : {}) };
    if (await post(`/textile/toll-jobs/${sel.id}/movements`, body, 'تم تسجيل الحركة')) { setM({ ...m, quantity: '', amount: '', reference: '' }); await open(sel.id); }
  };
  const st = sel?.statement;

  return (
    <div>
      <PageHeader title="التشغيل للغير" sub="خامات العميل لا تدخل مخزون الشركة؛ الأجر يُفوتَر بفاتورة بيع عادية ويُسجَّل رقمها هنا" />
      <TextileNav />
      <Card title="أعمال التشغيل">
        <DataTable rows={jobs} cols={[
          { h: 'العمل', k: 'job_no' }, { h: 'العميل', k: 'customer_name' }, { h: 'الخدمة', r: (r) => SERVICES[r.service_type] ?? r.service_type }, { h: 'الخامة', k: 'material_description' },
          { h: 'المستلم', r: (r) => num(r.received, 1) }, { h: 'المسلَّم', r: (r) => num(r.output, 1) }, { h: 'لدى المصنع', r: (r) => num(r.held_at_mill, 1) }, { h: 'الحالة', r: (r) => (r.status === 'closed' ? 'مقفل' : 'مفتوح') },
          { h: '', r: (r) => <button className="btn btn-sm btn-outline" onClick={() => void open(r.id)}>كشف الحساب</button> },
        ]} />
        <form onSubmit={addJob} className="mt-4 grid gap-3 md:grid-cols-5">
          <Field label="رقم العمل"><input required className={inputCls} dir="ltr" value={j.jobNo} onChange={(e) => setJ({ ...j, jobNo: e.target.value })} /></Field>
          <Field label="العميل"><select required className={inputCls} value={j.customerId} onChange={(e) => setJ({ ...j, customerId: e.target.value })}><option value="">—</option>{customers?.data?.map((c: Row) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}</select></Field>
          <Field label="الخدمة"><select className={inputCls} value={j.serviceType} onChange={(e) => setJ({ ...j, serviceType: e.target.value })}>{Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="وصف الخامة"><input required className={inputCls} value={j.materialDescription} onChange={(e) => setJ({ ...j, materialDescription: e.target.value })} /></Field>
          <Field label="أجر الوحدة"><input required className={inputCls} dir="ltr" value={j.feePerUnit} onChange={(e) => setJ({ ...j, feePerUnit: e.target.value })} /></Field>
          <Field label="أساس الأجر"><select className={inputCls} value={j.feeBasis} onChange={(e) => setJ({ ...j, feeBasis: e.target.value })}><option value="output">على الناتج</option><option value="received">على المستلم</option></select></Field>
          <Field label="الفاقد المسموح %"><input className={inputCls} dir="ltr" value={j.allowedLossPercent} onChange={(e) => setJ({ ...j, allowedLossPercent: e.target.value })} /></Field>
          <Field label="قيمة وحدة الخامة (للتعويض)"><input className={inputCls} dir="ltr" value={j.materialValuePerUnit} onChange={(e) => setJ({ ...j, materialValuePerUnit: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>فتح عمل</button></div>
        </form>
      </Card>

      {sel && st && (
        <Card title={`كشف حساب ${sel.job_no} — ${sel.customer_name}`} badge={sel.status === 'closed' ? 'مقفل' : 'مفتوح'}>
          <p className="mb-3 text-xs text-slate-500">{st.note}</p>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="المستلم" value={num(st.received, 1)} /><Kpi label="الناتج المسلَّم" value={num(st.output, 1)} />
            <Kpi label="لدى المصنع" value={num(st.heldAtMill, 1)} /><Kpi label="نسبة الفاقد" value={`${num(st.lossPercent, 2)}%`} tone={Number(st.excessLossQty) > 0 ? 'bad' : 'good'} hint={`المسموح ${num(st.allowedLossQty, 1)} · الزائد ${num(st.excessLossQty, 1)}`} />
            <Kpi label="الأجر المستحق" value={num(st.feeEarned, 2)} /><Kpi label="فُوتر" value={num(st.invoiced, 2)} />
            <Kpi label="تعويض الزائد" value={num(st.compensation, 2)} tone={Number(st.compensation) > 0 ? 'bad' : undefined} /><Kpi label="صافي المستحق" value={num(st.netDue, 2)} hint="الأجر غير المفوتر − التعويض" />
          </div>
          <DataTable rows={sel.movements} cols={[{ h: 'التاريخ', r: (r) => String(r.movement_date).slice(0, 10) }, { h: 'الحركة', r: (r) => MOVES[r.movement_type] ?? r.movement_type }, { h: 'الكمية', r: (r) => (r.quantity ? num(r.quantity, 2) : '—') }, { h: 'المبلغ', r: (r) => (r.amount ? num(r.amount, 2) : '—') }, { h: 'مرجع', r: (r) => r.reference ?? '—' }]} />
          {sel.status !== 'closed' && (
            <>
              <form onSubmit={addMove} className="mt-4 grid gap-3 md:grid-cols-6">
                <Field label="الحركة"><select className={inputCls} value={m.movementType} onChange={(e) => setM({ ...m, movementType: e.target.value })}>{Object.entries(MOVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="التاريخ"><input type="date" className={inputCls} value={m.movementDate} onChange={(e) => setM({ ...m, movementDate: e.target.value })} /></Field>
                {m.movementType === 'invoice'
                  ? <Field label="مبلغ الفاتورة"><input required className={inputCls} dir="ltr" value={m.amount} onChange={(e) => setM({ ...m, amount: e.target.value })} /></Field>
                  : <Field label="الكمية"><input required className={inputCls} dir="ltr" value={m.quantity} onChange={(e) => setM({ ...m, quantity: e.target.value })} /></Field>}
                <Field label="مرجع/رقم فاتورة"><input className={inputCls} dir="ltr" value={m.reference} onChange={(e) => setM({ ...m, reference: e.target.value })} /></Field>
                <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>تسجيل</button></div>
              </form>
              <button className="btn btn-sm btn-danger mt-3" disabled={busy} onClick={async () => { if (window.confirm('إقفال العمل: الرصيد المتبقي يُعدّ فاقدًا ويُحاسَب الزائد عن المسموح. متابعة؟') && (await post(`/textile/toll-jobs/${sel.id}/close`, {}, 'تم الإقفال'))) await open(sel.id); }}>إقفال العمل</button>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
