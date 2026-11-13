/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet } from '@/features/textile/shared';

const CAT: Record<string, string> = { shade: 'درجة لون', defect: 'عيوب', count: 'نمرة', strength: 'متانة', shrinkage: 'انكماش', width: 'عرض', gsm: 'وزن/م²', contamination: 'تلوث', packing: 'تغليف', delay: 'تأخير', other: 'أخرى' };
const ST: Record<string, string> = { open: 'مفتوحة', investigating: 'قيد الفحص', accepted: 'مقبولة', rejected: 'مرفوضة', settled: 'مُسوّاة' };
const NEXT: Record<string, string[]> = { open: ['investigating', 'accepted', 'rejected'], investigating: ['accepted', 'rejected'], accepted: ['settled'], settled: [], rejected: [] };

/** مطالبات العملاء الجودية: تسجيل ← فحص ← قبول بسبب جذري/رفض ← تسوية. */
export default function ClaimsPage() {
  const { data: claims } = useGet<any[]>('/textile/claims');
  const { data: rep } = useGet<any>('/textile/claims/report');
  const { data: customers } = useGet('/customers');
  const { data: branches } = useGet('/branches');
  const { busy, post } = useAction();
  const [f, setF] = useState({ branchId: '', customerId: '', claimDate: today(), category: 'shade', severity: 'minor', rollNo: '', claimedValue: '', description: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let fabricRollId: string | undefined;
    if (f.rollNo) { const t: any = await (await import('@/api/client')).apiClient.get('/textile/trace', { params: { rollNo: f.rollNo.trim() } }); fabricRollId = t.data.roll.id; }
    await post('/textile/claims', { branchId: f.branchId, customerId: f.customerId, claimDate: f.claimDate, category: f.category, severity: f.severity, ...(fabricRollId ? { fabricRollId } : {}), ...(f.claimedValue ? { claimedValue: Number(f.claimedValue) } : {}), description: f.description }, 'سُجِّلت المطالبة');
  };
  const move = (c: any, status: string) => {
    const body: any = { status };
    if (status === 'accepted') { const rc = window.prompt('السبب الجذري؟'); if (!rc) return; body.rootCause = rc; }
    if (status === 'rejected') { const n = window.prompt('سبب الرفض؟'); if (!n) return; body.note = n; }
    if (status === 'settled') { const res = window.prompt('نوع الحل: credit_note / replacement / discount / return / none'); const v = window.prompt('قيمة التسوية؟'); if (!res || v === null) return; body.resolution = res; body.settledValue = Number(v); }
    post(`/textile/claims/${c.id}/status`, body, 'حُدِّثت الحالة');
  };
  return (
    <div>
      <PageHeader title="مطالبات العملاء الجودية" sub="ربط المطالبة بالرول يفتح تتبّعه تلقائيًا (الأمر، لوطات الخيوط، الصباغة)." />
      <TextileNav />
      <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="إجمالي" value={rep?.total ?? '—'} /><Kpi label="مفتوحة" value={rep?.open ?? '—'} tone={rep?.open ? 'bad' : 'good'} /><Kpi label="قيمة المسوّى" value={rep ? num(rep.settledValue, 2) : '—'} /><Kpi label="متوسط أيام الإغلاق" value={rep?.avgDaysToClose ?? '—'} /></div>
      <Card title="مطالبة جديدة">
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-4">
          <Field label="الفرع"><select required className={inputCls} value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">—</option>{(branches as any[] | undefined)?.map((b) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
          <Field label="العميل"><select required className={inputCls} value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">—</option>{((customers as any)?.data ?? customers as any[] | undefined)?.map?.((c: any) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" required className={inputCls} value={f.claimDate} onChange={(e) => setF({ ...f, claimDate: e.target.value })} /></Field>
          <Field label="التصنيف"><select className={inputCls} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="الخطورة"><select className={inputCls} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="minor">بسيطة</option><option value="major">كبيرة</option><option value="critical">حرجة</option></select></Field>
          <Field label="رقم الرول (اختياري)"><input className={inputCls} value={f.rollNo} onChange={(e) => setF({ ...f, rollNo: e.target.value })} /></Field>
          <Field label="القيمة المطالَب بها"><input inputMode="decimal" className={inputCls} value={f.claimedValue} onChange={(e) => setF({ ...f, claimedValue: e.target.value })} /></Field>
          <Field label="الوصف"><input required className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>تسجيل</button></div>
        </form>
      </Card>
      <Card title="المطالبات">
        <DataTable rows={claims} empty="لا مطالبات." cols={[{ h: 'الرقم', k: 'claim_no' }, { h: 'العميل', k: 'customer_name' }, { h: 'التصنيف', r: (r) => CAT[r.category] }, { h: 'الرول', r: (r) => r.roll_no ?? '—' }, { h: 'الحالة', r: (r) => ST[r.status] },
          { h: 'السبب الجذري', r: (r) => r.root_cause ?? '—' }, { h: 'مطالَب/مُسوّى', r: (r) => `${num(r.claimed_value, 2)} / ${num(r.settled_value, 2)}` },
          { h: '', r: (r) => <div className="flex gap-1">{NEXT[r.status].map((s) => <button key={s} className="btn" disabled={busy} onClick={() => move(r, s)}>{ST[s]}</button>)}{r.status === 'settled' && r.resolution === 'credit_note' && Number(r.settled_value) > 0 && <button className="btn" disabled={busy} onClick={() => { if (window.confirm(`إصدار إشعار دائن بقيمة ${num(r.settled_value, 2)} للعميل وترحيل قيده؟`)) post(`/textile/claims/${r.id}/credit-note`, {}, 'صدر الإشعار الدائن'); }}>إشعار دائن</button>}</div> }]} />
      </Card>
      <Card title="تحليل الأسباب">
        <DataTable rows={rep?.byCategory} cols={[{ h: 'التصنيف', r: (r) => CAT[r.key] ?? r.key }, { h: 'عدد', k: 'count' }, { h: 'مطالَب', r: (r) => num(r.claimedValue, 2) }, { h: 'مُسوّى', r: (r) => num(r.settledValue, 2) }]} />
        <DataTable rows={rep?.byStage} empty="لا مراحل مسبِّبة مسجَّلة." cols={[{ h: 'المرحلة المسبِّبة', k: 'label' }, { h: 'عدد', k: 'count' }, { h: 'مُسوّى', r: (r) => num(r.settledValue, 2) }]} />
      </Card>
    </div>
  );
}
