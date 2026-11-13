/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, useAction, useGet } from '@/features/textile/shared';

/** تتبّع الدفعات ثنائي الاتجاه + تسجيل لوطات الخامات على الأوامر. */
export default function TracePage() {
  const [mode, setMode] = useState<'lot' | 'roll'>('lot');
  const [q, setQ] = useState(''); const [applied, setApplied] = useState('');
  const params = applied ? (mode === 'lot' ? { lotRef: applied } : { rollNo: applied }) : {};
  const { data: t, error } = useGet<any>('/textile/trace', params, !!applied);
  const { data: items } = useQuery({ queryKey: ['items-100'], queryFn: async () => (await apiClient.get('/items', { params: { page: 1, pageSize: 100 } })).data });
  const list: any[] = Array.isArray(items) ? items : items?.data ?? [];
  const { busy, post } = useAction();
  const [f, setF] = useState({ productionOrderId: '', itemId: '', lotRef: '', quantity: '' });
  const addLot = async (e: FormEvent) => { e.preventDefault(); await post('/textile/material-lots', { productionOrderId: f.productionOrderId.trim(), itemId: f.itemId, lotRef: f.lotRef, quantity: Number(f.quantity) }, 'سُجِّل اللوط'); };
  return (
    <div>
      <PageHeader title="تتبّع الدفعات (Traceability)" sub="من لوط الخيط إلى الأوامر والرولات والعملاء (نطاق السحب)، ومن الرول رجوعًا إلى لوطاته وأمره." />
      <TextileNav />
      <Card title="بحث">
        <form onSubmit={(e) => { e.preventDefault(); setApplied(q.trim()); }} className="grid gap-3 md:grid-cols-4">
          <Field label="نوع البحث"><select className={inputCls} value={mode} onChange={(e) => { setMode(e.target.value as any); setApplied(''); }}><option value="lot">لوط خامة (تتبّع أمامي / سحب)</option><option value="roll">رقم رول (تتبّع خلفي)</option></select></Field>
          <Field label={mode === 'lot' ? 'رقم اللوط' : 'رقم الرول'}><input required className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <div className="flex items-end"><button className="btn btn-gold">بحث</button></div>
        </form>
        {error && <p className="mt-2 text-sm text-red-700">{(error as any)?.response?.data?.message ?? 'لا نتيجة'}</p>}
      </Card>
      {t?.kind === 'lot' && (<>
        {!t.found && <p className="mb-3 text-sm text-amber-700">⚠️ لا أوامر مسجَّل عليها هذا اللوط.</p>}
        <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="كمية مصروفة" value={num(t.totalIssuedQty, 1)} /><Kpi label="أوامر" value={t.orders.length} /><Kpi label="رولات بالمخزن" value={t.recall.inStockRolls} /><Kpi label="عملاء متأثرون" value={t.recall.customers.length} tone={t.recall.customers.length ? 'bad' : 'good'} /></div>
        <Card title="نطاق السحب — العملاء">
          <DataTable rows={t.recall.customers} empty="لم يُسلَّم شيء لعملاء." cols={[{ h: 'العميل', k: 'customerName' }, { h: 'رولات', k: 'rolls' }, { h: 'أمتار', r: (r) => num(r.meters, 1) }, { h: 'كجم', r: (r) => num(r.kg, 1) }]} />
        </Card>
        <Card title="الأوامر والرولات">
          <DataTable rows={t.orders} cols={[{ h: 'أمر', k: 'order_no' }, { h: 'الصنف', k: 'item_name' }, { h: 'الكمية', r: (r) => num(r.quantity, 1) }]} />
          <DataTable rows={t.rolls} cols={[{ h: 'رول', k: 'roll_no' }, { h: 'الدرجة', k: 'grade' }, { h: 'م', r: (r) => num(r.length_m, 1) }, { h: 'الحالة', r: (r) => (r.delivered ? 'سُلِّم' : 'بالمخزن') }]} />
        </Card>
      </>)}
      {t?.kind === 'roll' && (
        <Card title={`الرول ${t.roll.roll_no} — الدرجة ${t.roll.grade}`}>
          {!t.traceComplete && <p className="mb-2 text-sm text-amber-700">⚠️ التتبّع غير مكتمل: {t.order ? 'لا لوطات مسجَّلة على الأمر' : 'الرول غير مرتبط بأمر تصنيع'}.</p>}
          <p className="text-sm">الأمر: <b>{t.order?.document_number ?? '—'}</b> {t.order?.machine_code && `— ماكينة ${t.order.machine_code}`} {t.order?.recipe_name && `— وصفة ${t.order.recipe_name} v${t.order.recipe_version}`}</p>
          <DataTable rows={t.materialLots} empty="لا لوطات." cols={[{ h: 'الخامة', k: 'item_name' }, { h: 'اللوط', k: 'lot_ref' }, { h: 'الكمية', r: (r) => num(r.quantity, 1) }]} />
          <DataTable rows={t.dyeBatches} empty="لا دفعات صباغة." cols={[{ h: 'دفعة صباغة', k: 'batch_no' }, { h: 'النتيجة', k: 'shade_result' }, { h: 'ΔE', r: (r) => num(r.delta_e, 2) }]} />
          <DataTable rows={t.delivered} empty="لم يُسلَّم." cols={[{ h: 'إذن', k: 'note_no' }, { h: 'العميل', k: 'customer_name' }, { h: 'التاريخ', r: (r) => String(r.note_date).slice(0, 10) }]} />
          <DataTable rows={t.claims} empty="لا مطالبات." cols={[{ h: 'مطالبة', k: 'claim_no' }, { h: 'التصنيف', k: 'category' }, { h: 'الحالة', k: 'status' }]} />
        </Card>
      )}
      <Card title="تسجيل لوط خامة على أمر تصنيع">
        <form onSubmit={addLot} className="grid gap-3 md:grid-cols-5">
          <Field label="معرّف أمر التصنيع"><input required className={inputCls} value={f.productionOrderId} onChange={(e) => setF({ ...f, productionOrderId: e.target.value })} /></Field>
          <Field label="الخامة/الخيط"><select required className={inputCls} value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value })}><option value="">—</option>{list.map((i) => <option key={i.id} value={i.id}>{i.name_ar}</option>)}</select></Field>
          <Field label="رقم اللوط"><input required className={inputCls} value={f.lotRef} onChange={(e) => setF({ ...f, lotRef: e.target.value })} /></Field>
          <Field label="الكمية (كجم)"><input required inputMode="decimal" className={inputCls} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>تسجيل</button></div>
        </form>
      </Card>
    </div>
  );
}
