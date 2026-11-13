/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ST: Record<string, string> = { draft: 'مسودة', approved: 'معتمد', cancelled: 'ملغى' };
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** كشف الرواتب الشهري (تشغيلي بلا قيود) + قسيمة راتب قابلة للطباعة. */
export default function PayrollPage() {
  const { data: runs } = useGet('/textile/payroll');
  const { data: branches } = useGet('/branches');
  const { busy, post } = useAction();
  const [f, setF] = useState({ branchId: '', month: thisMonth(), workingDays: '26' });
  const [open, setOpen] = useState<string>('');
  const { data: det } = useGet<{ run: Row; lines: Row[] }>(`/textile/payroll/${open || '_'}`, {}, !!open);
  const [warn, setWarn] = useState<string[]>([]);
  const { data: periods } = useGet('/accounting/fiscal-periods');
  const { data: safesRaw } = useGet<any>('/treasury/safes', { page: 1, pageSize: 100 });
  const safes: Row[] = Array.isArray(safesRaw) ? safesRaw : safesRaw?.data ?? [];
  const [pay, setPay] = useState({ branchId: '', safeOrBankId: '', fiscalPeriodId: '', transactionDate: new Date().toISOString().slice(0, 10), amount: '' });
  const [pj, setPj] = useState({ branchId: '', fiscalPeriodId: '', entryDate: new Date().toISOString().slice(0, 10) });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await post<any>('/textile/payroll', { month: f.month, workingDays: Number(f.workingDays), ...(f.branchId ? { branchId: f.branchId } : {}) }, 'أُنشئ الكشف');
    if (r) { setWarn(r.noAttendance ?? []); setOpen(r.id); }
  };
  const total = (k: string) => (det?.lines ?? []).reduce((s, l) => s + Number(l[k] ?? 0), 0);

  const slip = (l: Row) => {
    const w = window.open('', '_blank'); if (!w || !det) return;
    const row = (a: string, b: unknown) => `<tr><td>${a}</td><td>${num(b as number, 2)}</td></tr>`;
    w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>قسيمة ${esc(l.code)}</title><style>body{font-family:Tahoma,Arial;padding:24px;max-width:520px}table{border-collapse:collapse;width:100%}td{border:1px solid #444;padding:4px 8px}</style></head><body>
      <h3>قسيمة راتب — ${esc(det.run.month)}</h3><p>${esc(l.code)} — <b>${esc(l.name_ar)}</b> ${l.job_title ? '(' + esc(l.job_title) + ')' : ''}<br>أيام مدفوعة: ${l.days_paid} — غياب: ${l.days_absent} — إضافي: ${l.overtime_hours} ساعة</p>
      <table>${row('الأساسي', l.base_pay)}${row('الإضافي', l.overtime_pay)}${row('الحوافز', l.incentive)}${row('بدلات ومكافآت', l.allowances)}${row('<b>الإجمالي</b>', l.gross)}${row('التأمينات', -l.insurance)}${row('خصم التأخير', -l.late_deduction)}${row('السلف', -l.advances)}${row('الجزاءات', -l.penalties)}${row('خصومات أخرى', -l.other_deductions)}${row('<b>الصافي</b>', l.net)}</table>
      <p style="margin-top:36px">توقيع المستلم: ____________</p><script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div>
      <PageHeader title="كشف الرواتب" sub="يحسب الأساسي والإضافي والحوافز والتأمينات والسلف والجزاءات — بعد الاعتماد يمكن ترحيله اختياريًا كقيد محاسبي (أجور ↔ رواتب مستحقة/تأمينات/سلف)" />
      <TextileNav />
      <Card title="كشف جديد">
        <form onSubmit={create} className="grid gap-3 md:grid-cols-5">
          <Field label="الشهر"><input type="month" required className={inputCls} value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></Field>
          <Field label="أيام العمل بالشهر"><input required inputMode="numeric" className={inputCls} value={f.workingDays} onChange={(e) => setF({ ...f, workingDays: e.target.value })} /></Field>
          <Field label="الفرع (اختياري)"><select className={inputCls} value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">كل الفروع</option>{branches?.map((b: Row) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>احسب</button></div>
        </form>
        {warn.length > 0 && <p className="mt-2 text-sm text-amber-700">⚠️ بلا سجل حضور في الشهر: {warn.join('، ')}</p>}
      </Card>
      <Card title="الكشوف">
        <DataTable rows={runs} empty="لا كشوف بعد." cols={[{ h: 'الشهر', k: 'month' }, { h: 'العمال', k: 'workers' }, { h: 'الصافي', r: (r) => num(r.total_net, 2) }, { h: 'الحالة', r: (r) => ST[r.status] }, { h: '', r: (r) => <button className="btn" onClick={() => setOpen(r.id)}>فتح</button> }]} />
      </Card>
      {det && (
        <Card title={`كشف ${det.run.month} — ${ST[det.run.status]}`}>
          <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="إجمالي الصافي" value={num(total('net'), 2)} tone="good" /><Kpi label="إجمالي الإجمالي" value={num(total('gross'), 2)} /><Kpi label="التأمينات" value={num(total('insurance'), 2)} /><Kpi label="سلف+جزاءات" value={num(total('advances') + total('penalties') + total('other_deductions'), 2)} /></div>
          <div className="mb-3 flex gap-2">
            {det.run.status === 'draft' && <><button className="btn" disabled={busy} onClick={() => post(`/textile/payroll/${det.run.id}/recalculate`, {}, 'أُعيد الحساب')}>إعادة الحساب</button><button className="btn btn-gold" disabled={busy} onClick={() => window.confirm('اعتماد الكشف يقفله. متابعة؟') && post(`/textile/payroll/${det.run.id}/approve`, {}, 'اعتُمد')}>اعتماد</button></>}
            {det.run.status !== 'cancelled' && <button className="btn" disabled={busy} onClick={() => { const reason = window.prompt('سبب الإلغاء؟'); if (reason && reason.length >= 3) post(`/textile/payroll/${det.run.id}/cancel`, { reason }, 'أُلغي'); }}>إلغاء</button>}
          </div>
          {det.run.status === 'approved' && !det.run.journal_entry_id && (
            <div className="mb-3 grid gap-3 md:grid-cols-4">
              <Field label="فرع القيد"><select className={inputCls} value={pj.branchId} onChange={(e) => setPj({ ...pj, branchId: e.target.value })}><option value="">—</option>{branches?.map((b: Row) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
              <Field label="الفترة المالية"><select className={inputCls} value={pj.fiscalPeriodId} onChange={(e) => setPj({ ...pj, fiscalPeriodId: e.target.value })}><option value="">—</option>{periods?.map((p: Row) => <option key={p.id} value={p.id}>{String(p.start_date).slice(0, 10)} → {String(p.end_date).slice(0, 10)}</option>)}</select></Field>
              <Field label="تاريخ القيد"><input type="date" className={inputCls} value={pj.entryDate} onChange={(e) => setPj({ ...pj, entryDate: e.target.value })} /></Field>
              <div className="flex items-end"><button className="btn btn-gold" disabled={busy || !pj.branchId || !pj.fiscalPeriodId} onClick={() => window.confirm('سيُنشأ قيد محاسبي مرحَّل: مدين أجور — دائن رواتب مستحقة/تأمينات/سلف. متابعة؟') && post(`/textile/payroll/${det.run.id}/post`, pj, 'رُحِّل القيد')}>ترحيل للقيود</button></div>
            </div>
          )}
          {det.run.journal_entry_id && Number(det.run.total_net) > 0 && (det as any).remaining > 0 && (
            <div className="mb-3 grid gap-3 md:grid-cols-5">
              <Field label="فرع السند"><select className={inputCls} value={pay.branchId} onChange={(e) => setPay({ ...pay, branchId: e.target.value })}><option value="">—</option>{branches?.map((b: Row) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
              <Field label="الخزينة/البنك"><select className={inputCls} value={pay.safeOrBankId} onChange={(e) => setPay({ ...pay, safeOrBankId: e.target.value })}><option value="">—</option>{safes.map((x) => <option key={x.id} value={x.id}>{x.name_ar ?? x.name}</option>)}</select></Field>
              <Field label="الفترة المالية"><select className={inputCls} value={pay.fiscalPeriodId} onChange={(e) => setPay({ ...pay, fiscalPeriodId: e.target.value })}><option value="">—</option>{periods?.map((p: Row) => <option key={p.id} value={p.id}>{String(p.start_date).slice(0, 10)} → {String(p.end_date).slice(0, 10)}</option>)}</select></Field>
              <Field label="تاريخ الصرف"><input type="date" className={inputCls} value={pay.transactionDate} onChange={(e) => setPay({ ...pay, transactionDate: e.target.value })} /></Field>
              <Field label={`المبلغ (المتبقي ${num((det as any).remaining, 2)})`}><input className={inputCls} inputMode="decimal" placeholder="كامل المتبقي" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
              <div className="flex items-end"><button className="btn btn-gold" disabled={busy || !pay.branchId || !pay.safeOrBankId || !pay.fiscalPeriodId} onClick={() => window.confirm(`إنشاء وترحيل سند صرف بمبلغ ${pay.amount || num((det as any).remaining, 2)}؟`) && post(`/textile/payroll/${det.run.id}/pay`, { branchId: pay.branchId, safeOrBankId: pay.safeOrBankId, fiscalPeriodId: pay.fiscalPeriodId, transactionDate: pay.transactionDate, ...(pay.amount ? { amount: Number(pay.amount) } : {}) }, 'سُجِّلت دفعة الصرف')}>صرف الرواتب</button></div>
            </div>
          )}
          {(det as any).payments?.length > 0 && (
            <div className="mb-3 text-sm">
              <b>دفعات الصرف (مصروف {num((det as any).paid, 2)} من {num(det.run.total_net, 2)}):</b>
              {(det as any).payments.map((p: Row) => (
                <div key={p.id} className="flex items-center gap-2 py-0.5">{String(p.paid_at).slice(0, 10)} — {num(p.amount, 2)}
                  <button className="btn" disabled={busy} onClick={() => { const reason = window.prompt('سبب إلغاء هذه الدفعة (يُعكس السند)؟'); if (reason && reason.length >= 3) post(`/textile/payroll/${det.run.id}/unpay`, { reason, paymentId: p.id }, 'عُكست الدفعة'); }}>إلغاء</button></div>))}
            </div>
          )}
          {det.run.journal_entry_id && !((det as any).payments?.length > 0) && (
            <p className="mb-3 text-sm text-emerald-700">✔ مُرحَّل بقيد محاسبي. <button className="btn" disabled={busy} onClick={() => { const reason = window.prompt('سبب إلغاء الترحيل (يُنشأ قيد عكسي)؟'); if (reason && reason.length >= 3) post(`/textile/payroll/${det.run.id}/unpost`, { reason }, 'عُكس القيد'); }}>إلغاء الترحيل</button></p>
          )}
          <DataTable rows={det.lines} cols={[{ h: 'العامل', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'أيام', k: 'days_paid' }, { h: 'غياب', k: 'days_absent' }, { h: 'أساسي', r: (r) => num(r.base_pay, 2) }, { h: 'إضافي', r: (r) => num(r.overtime_pay, 2) }, { h: 'حوافز', r: (r) => num(r.incentive, 2) }, { h: 'بدلات', r: (r) => num(r.allowances, 2) },
            { h: 'تأمين', r: (r) => num(r.insurance, 2) }, { h: 'سلف', r: (r) => num(r.advances, 2) }, { h: 'جزاءات', r: (r) => num(Number(r.penalties) + Number(r.other_deductions) + Number(r.late_deduction), 2) },
            { h: 'الصافي', r: (r) => <b className={Number(r.net) < 0 ? 'text-red-700' : ''}>{num(r.net, 2)}</b> }, { h: '', r: (r) => <button className="btn" onClick={() => slip(r)}>قسيمة</button> }]} />
        </Card>
      )}
    </div>
  );
}
