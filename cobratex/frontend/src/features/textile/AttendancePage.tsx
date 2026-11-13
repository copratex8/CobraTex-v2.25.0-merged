/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type FormEvent } from 'react';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const ST: Record<string, string> = { present: 'حاضر', absent: 'غائب', leave_paid: 'إجازة مدفوعة', leave_unpaid: 'إجازة بدون أجر', sick: 'مرضي', holiday: 'عطلة رسمية', weekly_off: 'راحة أسبوعية' };
const KIND: Record<string, string> = { advance: 'سلفة', penalty: 'جزاء', deduction: 'خصم', bonus: 'مكافأة', allowance: 'بدل' };
const PT: Record<string, string> = { monthly: 'شهري', daily: 'يومية', hourly: 'بالساعة' };

/** الحضور اليومي، أجور العمال، السلف والجزاءات والبدلات. */
export default function AttendancePage() {
  const [date, setDate] = useState(today());
  const month = date.slice(0, 7);
  const { data: workers } = useGet('/textile/workers');
  const { data: att } = useGet('/textile/attendance', { date });
  const { data: adjs } = useGet('/textile/adjustments', { month });
  const { busy, post, put, run } = useAction();
  const [sheet, setSheet] = useState<Record<string, { status: string; ot: string; late: string }>>({});
  const active: Row[] = (workers ?? []).filter((w: Row) => w.is_active);

  useEffect(() => {
    const m: Record<string, { status: string; ot: string; late: string }> = {};
    for (const w of active) { const a = (att ?? []).find((x: Row) => x.worker_id === w.id); m[w.id] = { status: a?.status ?? 'present', ot: a ? String(a.overtime_hours) : '', late: a ? String(a.late_minutes) : '' }; }
    setSheet(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att, workers, date]);

  const saveSheet = async () => {
    const records = active.map((w) => { const s = sheet[w.id]; return { workerId: w.id, status: s.status, ...(s.ot ? { overtimeHours: Number(s.ot) } : {}), ...(s.late ? { lateMinutes: Number(s.late) } : {}) }; });
    if (records.length) await post('/textile/attendance', { workDate: date, records }, 'حُفظ حضور اليوم');
  };

  const [pay, setPay] = useState<{ id: string; payType: string; baseRate: string; insurancePercent: string; employerInsurancePercent: string; overtimeMultiplier: string; stdHoursPerDay: string } | null>(null);
  const savePay = async (e: FormEvent) => {
    e.preventDefault(); if (!pay) return;
    await put(`/textile/workers/${pay.id}/pay`, { payType: pay.payType, baseRate: Number(pay.baseRate), ...(pay.insurancePercent ? { insurancePercent: Number(pay.insurancePercent) } : {}), ...(pay.employerInsurancePercent ? { employerInsurancePercent: Number(pay.employerInsurancePercent) } : {}), ...(pay.overtimeMultiplier ? { overtimeMultiplier: Number(pay.overtimeMultiplier) } : {}), ...(pay.stdHoursPerDay ? { stdHoursPerDay: Number(pay.stdHoursPerDay) } : {}) }, 'حُفظ أجر العامل');
    setPay(null);
  };
  const year = Number(date.slice(0, 4));
  const { data: leave } = useGet<any>('/textile/leave-balance', { year });
  const [csv, setCsv] = useState('');
  const [imp, setImp] = useState({ shiftStart: '', graceMinutes: '' });
  const [impRes, setImpRes] = useState<any>(null);
  const parseCsv = () => csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [workerCode, ...rest] = l.split(','); return { workerCode: workerCode.trim(), timestamp: rest.join(',').trim() }; }).filter((p) => /^\d{4}-/.test(p.timestamp));
  const runImport = async (dryRun: boolean) => {
    const punches = parseCsv(); if (!punches.length) return;
    const r = await post<any>('/textile/attendance/import', { punches, dryRun, ...(imp.shiftStart ? { shiftStart: imp.shiftStart } : {}), ...(imp.graceMinutes ? { graceMinutes: Number(imp.graceMinutes) } : {}) }, dryRun ? 'معاينة الاستيراد' : 'تم الاستيراد');
    if (r) setImpRes(r);
  };
  const [adj, setAdj] = useState({ workerId: '', adjDate: today(), kind: 'advance', amount: '', reason: '' });
  const addAdj = async (e: FormEvent) => { e.preventDefault(); await post('/textile/adjustments', { ...adj, amount: Number(adj.amount), ...(adj.reason ? {} : { reason: undefined }) }, 'سُجِّل البند'); };

  return (
    <div>
      <PageHeader title="الحضور والأجور" sub="سجل حضور يومي + أجر كل عامل + سلف وجزاءات وبدلات — تغذّي كشف الرواتب" />
      <TextileNav />
      <Card title="حضور اليوم">
        <div className="mb-3 flex items-end gap-3"><Field label="اليوم"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field><button className="btn btn-gold" disabled={busy || !active.length} onClick={saveSheet}>حفظ الحضور</button></div>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>العامل</th><th>الحالة</th><th>إضافي (ساعة)</th><th>تأخير (دقيقة)</th></tr></thead><tbody>
          {active.map((w) => (
            <tr key={w.id}><td>{w.code} — {w.name_ar}</td>
              <td><select className={inputCls} value={sheet[w.id]?.status ?? 'present'} onChange={(e) => setSheet({ ...sheet, [w.id]: { ...sheet[w.id], status: e.target.value } })}>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
              <td><input className={inputCls} inputMode="decimal" disabled={sheet[w.id]?.status !== 'present'} value={sheet[w.id]?.ot ?? ''} onChange={(e) => setSheet({ ...sheet, [w.id]: { ...sheet[w.id], ot: e.target.value } })} /></td>
              <td><input className={inputCls} inputMode="numeric" disabled={sheet[w.id]?.status !== 'present'} value={sheet[w.id]?.late ?? ''} onChange={(e) => setSheet({ ...sheet, [w.id]: { ...sheet[w.id], late: e.target.value } })} /></td></tr>))}
        </tbody></table></div>
        <p className="mt-2 text-xs text-slate-500">الحاضر بلا ساعات إضافية يُحتسب بساعات اليوم القياسية للعامل. للتسجيل بتوقيت الدخول والخروج استخدم الـAPI (checkIn/checkOut).</p>
      </Card>
      <Card title="أجور العمال">
        <DataTable rows={workers} cols={[{ h: 'العامل', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'النوع', r: (r) => PT[r.pay_type] }, { h: 'الأجر', r: (r) => (Number(r.base_rate) ? num(r.base_rate, 2) : <b className="text-red-700">غير محدد</b>) }, { h: 'تأمين %', r: (r) => num(r.insurance_percent, 1) }, { h: 'معامل الإضافي', r: (r) => num(r.overtime_multiplier, 2) },
          { h: '', r: (r) => <button className="btn" onClick={() => setPay({ id: r.id, payType: r.pay_type, baseRate: String(r.base_rate), insurancePercent: String(r.insurance_percent), employerInsurancePercent: String(r.employer_insurance_percent ?? 0), overtimeMultiplier: String(r.overtime_multiplier), stdHoursPerDay: String(r.std_hours_per_day) })}>تعديل</button> }]} />
        {pay && (
          <form onSubmit={savePay} className="mt-3 grid gap-3 md:grid-cols-7">
            <Field label="النوع"><select className={inputCls} value={pay.payType} onChange={(e) => setPay({ ...pay, payType: e.target.value })}>{Object.entries(PT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label={pay.payType === 'monthly' ? 'الراتب الشهري' : pay.payType === 'daily' ? 'اليومية' : 'أجر الساعة'}><input required className={inputCls} inputMode="decimal" value={pay.baseRate} onChange={(e) => setPay({ ...pay, baseRate: e.target.value })} /></Field>
            <Field label="ساعات اليوم"><input className={inputCls} inputMode="decimal" value={pay.stdHoursPerDay} onChange={(e) => setPay({ ...pay, stdHoursPerDay: e.target.value })} /></Field>
            <Field label="معامل الإضافي"><input className={inputCls} inputMode="decimal" value={pay.overtimeMultiplier} onChange={(e) => setPay({ ...pay, overtimeMultiplier: e.target.value })} /></Field>
            <Field label="تأمين %"><input className={inputCls} inputMode="decimal" value={pay.insurancePercent} onChange={(e) => setPay({ ...pay, insurancePercent: e.target.value })} /></Field>
            <Field label="تأمين صاحب العمل %"><input className={inputCls} inputMode="decimal" value={pay.employerInsurancePercent} onChange={(e) => setPay({ ...pay, employerInsurancePercent: e.target.value })} /></Field>
            <div className="flex items-end gap-2"><button className="btn btn-gold" disabled={busy}>حفظ</button><button type="button" className="btn" onClick={() => setPay(null)}>إلغاء</button></div>
          </form>)}
      </Card>
      <Card title="استيراد بصمات من الجهاز (CSV)">
        <p className="mb-2 text-xs text-slate-500">كل سطر: <code>كود العامل,YYYY-MM-DD HH:MM</code>. أول بصمة في اليوم دخول وآخر بصمة خروج؛ بصمة واحدة = دخول فقط (تُحتسب ساعات اليوم القياسية). لا يُسجَّل الغياب آليًا.</p>
        <textarea className={inputCls + ' h-28 font-mono'} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'W1,2026-11-02 08:03\nW1,2026-11-02 16:35'} />
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <Field label="بداية الوردية (لحساب التأخير)"><input type="time" className={inputCls} value={imp.shiftStart} onChange={(e) => setImp({ ...imp, shiftStart: e.target.value })} /></Field>
          <Field label="سماح (دقيقة)"><input className={inputCls} inputMode="numeric" value={imp.graceMinutes} onChange={(e) => setImp({ ...imp, graceMinutes: e.target.value })} /></Field>
          <button className="btn" disabled={busy} onClick={() => runImport(true)}>معاينة</button><button className="btn btn-gold" disabled={busy} onClick={() => runImport(false)}>استيراد</button>
        </div>
        {impRes && <p className="mt-2 text-sm">{impRes.dryRun ? 'معاينة: ' : 'تم: '}{impRes.daysParsed} يوم عمل — محفوظ {impRes.saved}{impRes.unknownWorkers.length > 0 && <span className="text-red-700"> — أكواد غير معروفة: {impRes.unknownWorkers.join('، ')}</span>}{impRes.singlePunchDays.length > 0 && <span className="text-amber-700"> — بصمة واحدة: {impRes.singlePunchDays.length}</span>}{impRes.invalidPunches.length > 0 && <span className="text-red-700"> — سطور غير صالحة: {impRes.invalidPunches.length}</span>}</p>}
      </Card>
      <Card title={`رصيد الإجازات ${year}`}>
        <DataTable rows={leave?.workers} cols={[{ h: 'العامل', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'الاستحقاق', k: 'entitlement' }, { h: 'المستخدم (مدفوعة)', k: 'used' }, { h: 'المتبقي', r: (r) => <b className={r.overdrawn ? 'text-red-700' : ''}>{r.remaining}</b> }, { h: 'مرضي', k: 'sick' }, { h: 'بدون أجر', k: 'unpaid' }]} />
      </Card>
      <Card title={`سلف وجزاءات وبدلات — ${month}`}>
        <form onSubmit={addAdj} className="mb-3 grid gap-3 md:grid-cols-6">
          <Field label="العامل"><select required className={inputCls} value={adj.workerId} onChange={(e) => setAdj({ ...adj, workerId: e.target.value })}><option value="">—</option>{active.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name_ar}</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" required className={inputCls} value={adj.adjDate} onChange={(e) => setAdj({ ...adj, adjDate: e.target.value })} /></Field>
          <Field label="النوع"><select className={inputCls} value={adj.kind} onChange={(e) => setAdj({ ...adj, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="المبلغ"><input required className={inputCls} inputMode="decimal" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></Field>
          <Field label="السبب"><input className={inputCls} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
        </form>
        <DataTable rows={adjs} empty="لا بنود في الشهر." cols={[{ h: 'التاريخ', r: (r) => String(r.adj_date).slice(0, 10) }, { h: 'العامل', r: (r) => `${r.code} — ${r.name_ar}` }, { h: 'النوع', r: (r) => KIND[r.kind] }, { h: 'المبلغ', r: (r) => num(r.amount, 2) }, { h: 'السبب', r: (r) => r.reason ?? '—' },
          { h: '', r: (r) => <button className="btn" disabled={busy} onClick={() => run(async () => (await import('@/api/client')).apiClient.delete(`/textile/adjustments/${r.id}`), 'حُذف')}>حذف</button> }]} />
      </Card>
    </div>
  );
}
