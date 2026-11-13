import { useState, type FormEvent } from 'react';
import { useBranches } from '@/features/catalog/api';
import { useSuppliers } from '@/features/suppliers/api';
import { apiClient } from '@/api/client';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const SERVICES: Record<string, string> = { spinning: 'غزل', weaving: 'نسيج', dyeing: 'صباغة', finishing: 'تجهيز', printing: 'طباعة', other: 'أخرى' };
const MOVES: Record<string, string> = { sent: 'إرسال خامة للمقاول', received: 'استلام ناتج معالج', waste_returned: 'هالك معاد إلينا', waste_retained: 'هالك احتفظ به المقاول', invoice: 'فاتورة المقاول' };

/** التصنيع لدى الغير (مصبغة/مصنع خارجي): رصيد خامتنا عند المقاول، الفاقد المسموح، الأجر، وتحميل الزائد عند الإقفال. */
export default function SubcontractPage() {
  const { data: jobs } = useGet('/textile/subcontract-jobs');
  const { data: suppliers } = useSuppliers(1, 100);
  const { data: branches } = useBranches();
  const { busy, post, run } = useAction();
  const [sel, setSel] = useState<Row | null>(null);

  const [j, setJ] = useState({ jobNo: '', supplierId: '', serviceType: 'dyeing', materialDescription: '', feePerUnit: '', feeBasis: 'received', allowedLossPercent: '', materialValuePerUnit: '' });
  const addJob = async (e: FormEvent) => {
    e.preventDefault();
    const body = { branchId: branches?.[0]?.id, jobNo: j.jobNo, supplierId: j.supplierId, serviceType: j.serviceType, materialDescription: j.materialDescription, feePerUnit: j.feePerUnit, feeBasis: j.feeBasis,
      ...(j.allowedLossPercent ? { allowedLossPercent: j.allowedLossPercent } : {}), ...(j.materialValuePerUnit ? { materialValuePerUnit: j.materialValuePerUnit } : {}) };
    if (await post('/textile/subcontract-jobs', body, 'تم فتح العمل')) setJ({ ...j, jobNo: '', materialDescription: '', feePerUnit: '' });
  };
  const open = async (id: string) => setSel(await run(() => apiClient.get(`/textile/subcontract-jobs/${id}`)));
  const [m, setM] = useState({ movementType: 'sent', movementDate: today(), quantity: '', amount: '', reference: '' });
  const addMove = async (e: FormEvent) => {
    e.preventDefault();
    if (!sel) return;
    const body = { movementType: m.movementType, movementDate: m.movementDate, ...(m.movementType === 'invoice' ? { amount: m.amount } : { quantity: m.quantity }), ...(m.reference ? { reference: m.reference } : {}) };
    if (await post(`/textile/subcontract-jobs/${sel.id}/movements`, body, 'تم تسجيل الحركة')) { setM({ ...m, quantity: '', amount: '', reference: '' }); await open(sel.id); }
  };
  const close = async () => {
    if (!sel || !window.confirm('إقفال العمل؟ الرصيد المتبقي لدى المقاول يُعدّ فاقدًا ويُحاسَب عليه.')) return;
    if (await post(`/textile/subcontract-jobs/${sel.id}/close`, {}, 'تم الإقفال')) await open(sel.id);
  };
  const st = sel?.statement;

  return (
    <div>
      <PageHeader title="التصنيع لدى الغير" sub="دفتر تشغيلي: فاتورة المقاول تُسجَّل كفاتورة شراء عادية ثم يُدخَل مبلغها هنا" />
      <TextileNav />
      <Card title="الأعمال">
        <DataTable rows={jobs} empty="لا أعمال بعد." cols={[{ h: 'العمل', k: 'job_no' }, { h: 'المقاول', k: 'supplier_name' }, { h: 'الخدمة', r: (r) => SERVICES[r.service_type] }, { h: 'الخامة', k: 'material_description' },
          { h: 'المرسَل', r: (r) => num(r.sent, 1) }, { h: 'المستلَم', r: (r) => num(r.received, 1) }, { h: 'لدى المقاول', r: (r) => num(r.held_at_vendor, 1) }, { h: 'الحالة', r: (r) => (r.status === 'closed' ? 'مقفل' : 'مفتوح') },
          { h: '', r: (r) => <button className="btn btn-sm btn-outline" onClick={() => void open(r.id)}>كشف الحساب</button> }]} />
        <form onSubmit={addJob} className="mt-4 grid gap-3 md:grid-cols-5">
          <Field label="رقم العمل"><input required className={inputCls} dir="ltr" value={j.jobNo} onChange={(e) => setJ({ ...j, jobNo: e.target.value })} /></Field>
          <Field label="المقاول (المورد)"><select required className={inputCls} value={j.supplierId} onChange={(e) => setJ({ ...j, supplierId: e.target.value })}><option value="">—</option>{suppliers?.data?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
          <Field label="الخدمة"><select className={inputCls} value={j.serviceType} onChange={(e) => setJ({ ...j, serviceType: e.target.value })}>{Object.entries(SERVICES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="وصف الخامة"><input required className={inputCls} value={j.materialDescription} onChange={(e) => setJ({ ...j, materialDescription: e.target.value })} /></Field>
          <Field label="الأجر / كجم"><input required className={inputCls} dir="ltr" value={j.feePerUnit} onChange={(e) => setJ({ ...j, feePerUnit: e.target.value })} /></Field>
          <Field label="الأجر على"><select className={inputCls} value={j.feeBasis} onChange={(e) => setJ({ ...j, feeBasis: e.target.value })}><option value="received">المستلَم المعالج</option><option value="sent">المرسَل</option></select></Field>
          <Field label="فاقد مسموح %"><input className={inputCls} dir="ltr" value={j.allowedLossPercent} onChange={(e) => setJ({ ...j, allowedLossPercent: e.target.value })} /></Field>
          <Field label="قيمة الخامة / كجم"><input className={inputCls} dir="ltr" value={j.materialValuePerUnit} onChange={(e) => setJ({ ...j, materialValuePerUnit: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>فتح عمل</button></div>
        </form>
      </Card>
      {sel && st && (
        <Card title={`كشف الحساب — ${sel.job_no} (${sel.supplier_name})`} badge={sel.status === 'closed' ? 'مقفل' : 'مفتوح'}>
          <div className="mb-3 grid gap-3 md:grid-cols-4">
            <Kpi label="لدى المقاول" value={num(st.heldAtVendor, 1)} /><Kpi label="فاقد فعلي %" value={num(st.lossPercent, 2)} tone={Number(st.excessLossQty) > 0 ? 'bad' : 'good'} hint={`المسموح ${num(st.allowedLossQty, 1)}`} />
            <Kpi label="تحميل الزائد على المقاول" value={num(st.chargeToVendor)} /><Kpi label="صافي المستحق له" value={num(st.netPayable)} hint={`أجر ${num(st.feeEarned)} − مفوتَر ${num(st.invoiced)}`} />
          </div>
          <p className="mb-3 text-xs text-slate-500">{st.note}</p>
          <DataTable rows={sel.movements} empty="لا حركات." cols={[{ h: 'التاريخ', r: (r) => String(r.movement_date).slice(0, 10) }, { h: 'الحركة', r: (r) => MOVES[r.movement_type] }, { h: 'الكمية', r: (r) => num(r.quantity, 2) }, { h: 'المبلغ', r: (r) => num(r.amount) }, { h: 'المرجع', r: (r) => r.reference ?? '—' }]} />
          {sel.status !== 'closed' && (
            <form onSubmit={addMove} className="mt-3 grid gap-3 md:grid-cols-6">
              <Field label="الحركة"><select className={inputCls} value={m.movementType} onChange={(e) => setM({ ...m, movementType: e.target.value })}>{Object.entries(MOVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="التاريخ"><input type="date" required className={inputCls} value={m.movementDate} onChange={(e) => setM({ ...m, movementDate: e.target.value })} /></Field>
              {m.movementType === 'invoice' ? <Field label="المبلغ"><input required className={inputCls} dir="ltr" value={m.amount} onChange={(e) => setM({ ...m, amount: e.target.value })} /></Field>
                : <Field label="الكمية"><input required className={inputCls} dir="ltr" value={m.quantity} onChange={(e) => setM({ ...m, quantity: e.target.value })} /></Field>}
              <Field label="المرجع"><input className={inputCls} value={m.reference} onChange={(e) => setM({ ...m, reference: e.target.value })} /></Field>
              <div className="flex items-end gap-2"><button className="btn btn-gold" disabled={busy}>تسجيل</button><button type="button" className="btn btn-danger" onClick={() => void close()}>إقفال</button></div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
