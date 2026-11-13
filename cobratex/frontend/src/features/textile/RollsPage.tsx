import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

/** فحص رولات القماش بنظام 4 نقاط (نقاط لكل 100 ياردة²): الدرجة A حتى 20، B حتى 40، وإلا C. */
export default function RollsPage() {
  const { data } = useGet<{ rolls: Row[]; summary: Row[] }>('/textile/fabric-rolls');
  const { busy, post } = useAction();
  const [f, setF] = useState({ rollNo: '', lengthM: '', widthCm: '150', weightKg: '', defectPoints: '0' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { rollNo: f.rollNo, lengthM: Number(f.lengthM), widthCm: Number(f.widthCm), defectPoints: Number(f.defectPoints), ...(f.weightKg ? { weightKg: Number(f.weightKg) } : {}) };
    if (await post('/textile/fabric-rolls', body, 'تم فحص الرول')) setF({ ...f, rollNo: '', lengthM: '', weightKg: '', defectPoints: '0' });
  };
  return (
    <div>
      <PageHeader title="فحص رولات القماش" sub="نظام 4 نقاط" />
      <TextileNav />
      <div className="mb-4 grid grid-cols-3 gap-3">
        {['A', 'B', 'C'].map((g) => {
          const s = data?.summary.find((x) => x.grade === g);
          return <div key={g} className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><p className="text-xs text-slate-500">درجة {g}</p><p className="text-2xl font-extrabold">{s?.rolls ?? 0}</p><p className="text-xs text-slate-400">{num(s?.length_m ?? 0, 1)} م</p></div>;
        })}
      </div>
      <Card title="رول جديد">
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-6">
          <Field label="رقم الرول"><input required className={inputCls} dir="ltr" value={f.rollNo} onChange={(e) => setF({ ...f, rollNo: e.target.value })} /></Field>
          <Field label="الطول (م)"><input required className={inputCls} dir="ltr" value={f.lengthM} onChange={(e) => setF({ ...f, lengthM: e.target.value })} /></Field>
          <Field label="العرض (سم)"><input required className={inputCls} dir="ltr" value={f.widthCm} onChange={(e) => setF({ ...f, widthCm: e.target.value })} /></Field>
          <Field label="الوزن (كجم)"><input className={inputCls} dir="ltr" value={f.weightKg} onChange={(e) => setF({ ...f, weightKg: e.target.value })} /></Field>
          <Field label="إجمالي نقاط العيوب"><input required className={inputCls} dir="ltr" value={f.defectPoints} onChange={(e) => setF({ ...f, defectPoints: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>فحص وحفظ</button></div>
        </form>
      </Card>
      <Card title="الرولات">
        <DataTable rows={data?.rolls} cols={[
          { h: 'الرول', k: 'roll_no' }, { h: 'الطول م', r: (r) => num(r.length_m, 1) }, { h: 'العرض سم', r: (r) => num(r.width_cm, 0) }, { h: 'نقاط/100 ياردة²', r: (r) => num(r.points_per_100sqyd, 1) },
          { h: 'الدرجة', r: (r) => <b className={r.grade === 'A' ? 'text-emerald-700' : r.grade === 'B' ? 'text-amber-700' : 'text-red-700'}>{r.grade}</b> }, { h: 'التاريخ', r: (r) => String(r.inspected_at).slice(0, 10) },
        ]} />
      </Card>
    </div>
  );
}
