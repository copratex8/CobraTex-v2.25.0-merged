import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

const TYPES: Record<string, string> = { labor_per_run_hour: 'عمالة لكل ساعة تشغيل', energy_per_kwh: 'طاقة لكل kWh', overhead_per_run_hour: 'مصاريف صناعية لكل ساعة تشغيل' };

/** معدّلات تكلفة التحويل (عمالة/كهرباء/مصاريف): الأخصّ يغلب (ماكينة ثم مرحلة ثم عام)؛ تُطبَّق على أمر التصنيع من سجل ساعات الماكينات. */
export default function CostRatesPage() {
  const { data: rates } = useGet('/textile/cost-rates');
  const { data: stages } = useGet('/textile/stages');
  const { data: machines } = useGet('/textile/machines');
  const { busy, post, run } = useAction();
  const [f, setF] = useState({ rateType: 'labor_per_run_hour', rate: '', stageId: '', machineId: '' });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const body = { rateType: f.rateType, rate: f.rate, ...(f.stageId ? { stageId: f.stageId } : {}), ...(f.machineId ? { machineId: f.machineId } : {}) };
    if (await post('/textile/cost-rates', body, 'تم حفظ المعدّل')) setF({ ...f, rate: '' });
  };
  const del = async (id: string) => { const { apiClient } = await import('@/api/client'); await run(() => apiClient.delete(`/textile/cost-rates/${id}`), 'تم إيقاف المعدّل'); };
  return (
    <div>
      <PageHeader title="معدّلات تكلفة التحويل" sub="تُستخدم لاقتراح تكلفة التحويل الفعلية لكل أمر تصنيع (من أوامر التصنيع ← الغزل والنسيج)" />
      <TextileNav />
      <Card title="المعدّلات النشطة">
        <DataTable rows={rates} cols={[
          { h: 'النوع', r: (r: Row) => TYPES[r.rate_type] ?? r.rate_type }, { h: 'المعدّل', r: (r) => num(r.rate, 4) }, { h: 'المرحلة', r: (r) => r.stage_name_ar ?? 'كل المراحل' }, { h: 'الماكينة', r: (r) => r.machine_name_ar ?? 'كل الماكينات' },
          { h: '', r: (r) => <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void del(r.id)}>إيقاف</button> },
        ]} />
        <form onSubmit={add} className="mt-4 grid gap-3 md:grid-cols-5">
          <Field label="النوع"><select className={inputCls} value={f.rateType} onChange={(e) => setF({ ...f, rateType: e.target.value })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="المعدّل"><input required className={inputCls} dir="ltr" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
          <Field label="المرحلة (اختياري)"><select className={inputCls} value={f.stageId} onChange={(e) => setF({ ...f, stageId: e.target.value })}><option value="">كل المراحل</option>{stages?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
          <Field label="الماكينة (اختياري)"><select className={inputCls} value={f.machineId} onChange={(e) => setF({ ...f, machineId: e.target.value })}><option value="">كل الماكينات</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code}</option>)}</select></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>حفظ</button></div>
        </form>
      </Card>
    </div>
  );
}
