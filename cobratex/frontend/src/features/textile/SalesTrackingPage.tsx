/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const STATUS: Record<string, { t: string; cls: string }> = {
  delivered: { t: 'مُسلَّم', cls: 'text-slate-500' }, late: { t: 'متأخر', cls: 'text-red-700' }, ready: { t: 'جاهز للتسليم', cls: 'text-emerald-700' },
  short: { t: 'إنتاج منتهٍ بعجز', cls: 'text-red-700' }, at_risk: { t: 'معرَّض للتأخير', cls: 'text-amber-700' }, unplanned: { t: 'غير مخطَّط بالكامل', cls: 'text-orange-700' }, on_track: { t: 'على المسار', cls: 'text-emerald-700' },
};
const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : '—');

/** متابعة أوامر البيع: مطلوب ↔ مخطَّط ↔ مُنتَج ↔ مُسلَّم، ووعد التسليم وإنشاء/ربط أوامر التصنيع. */
export default function SalesTrackingPage() {
  const [status, setStatus] = useState('');
  const { data } = useGet<{ today: string; summary: Record<string, number>; lines: Row[] }>('/textile/sales-tracking', { status });
  const { busy, post, put } = useAction();
  const { data: boms } = useGet('/manufacturing/boms');
  const { data: warehouses } = useGet('/warehouses');
  const { data: branches } = useGet('/branches');
  const { data: periods } = useGet('/accounting/fiscal-periods');
  const { data: orders } = useGet<any>('/manufacturing/orders', { page: 1, pageSize: 100 });
  const [sel, setSel] = useState<Row | null>(null);
  const [promise, setPromise] = useState({ promisedDate: today(), reason: '' });
  const [mk, setMk] = useState({ branchId: '', warehouseId: '', bomId: '', fiscalPeriodId: '', orderDate: today(), qty: '' });
  const [linkId, setLinkId] = useState('');
  const { data: hist } = useGet('/textile/sales-lines/' + (sel?.lineId ?? '_') + '/promise-history', {}, !!sel);

  const candidates: Row[] = ((Array.isArray(orders) ? orders : orders?.data ?? []) as Row[]).filter((o) => o.status !== 'reversed' && (!sel || o.output_item_id === sel.itemId));
  const itemBoms: Row[] = (boms ?? []).filter((b: Row) => !sel || b.output_item_id === sel.itemId);

  const savePromise = async (e: FormEvent) => {
    e.preventDefault();
    if (sel) await put(`/textile/sales-lines/${sel.lineId}/promise`, { promisedDate: promise.promisedDate, ...(promise.reason ? { reason: promise.reason } : {}) }, 'تم حفظ وعد التسليم');
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (sel) await post(`/textile/sales-lines/${sel.lineId}/create-order`, { branchId: mk.branchId, warehouseId: mk.warehouseId, bomId: mk.bomId, fiscalPeriodId: mk.fiscalPeriodId, orderDate: mk.orderDate, ...(mk.qty ? { plannedOutputQuantity: mk.qty } : {}) }, 'أُنشئ أمر التصنيع وربط بالسطر');
  };
  const link = async () => { if (sel && linkId) await post(`/textile/sales-lines/${sel.lineId}/link-order`, { productionOrderId: linkId }, 'تم الربط'); };

  return (
    <div>
      <PageHeader title="متابعة أوامر البيع والتصنيع" sub="لكل سطر بيع: المطلوب والمخطَّط والمُنتَج والمُسلَّم ووعد التسليم" />
      <TextileNav />
      <div className="mb-4 grid gap-3 md:grid-cols-7">
        {Object.entries(STATUS).map(([k, v]) => <Kpi key={k} label={v.t} value={data?.summary?.[k] ?? '—'} tone={k === 'late' && (data?.summary?.[k] ?? 0) > 0 ? 'bad' : undefined} />)}
      </div>
      <Card title="الأسطر">
        <div className="mb-2 max-w-xs"><Field label="الحالة"><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">الكل</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.t}</option>)}</select></Field></div>
        <DataTable rows={data?.lines} empty="لا أسطر بيع مؤكَّدة." cols={[
          { h: 'أمر البيع', k: 'salesOrderNo' }, { h: 'العميل', k: 'customerName' }, { h: 'الصنف', k: 'itemName' },
          { h: 'مطلوب', r: (r) => num(r.orderedQty, 1) }, { h: 'مخطَّط', r: (r) => num(r.plannedQty, 1) }, { h: 'مُنتَج', r: (r) => num(r.producedQty, 1) }, { h: 'مُسلَّم', r: (r) => num(r.deliveredQty, 1) },
          { h: 'الوعد', r: (r) => d10(r.promisedDate) }, { h: 'نهاية الجدولة', r: (r) => d10(r.scheduledEnd) },
          { h: 'الحالة', r: (r) => <b className={STATUS[r.status]?.cls}>{STATUS[r.status]?.t ?? r.status}</b> },
          { h: '', r: (r) => <button className="btn" onClick={() => { setSel(r); setPromise({ promisedDate: r.promisedDate ?? r.suggestedPromise ?? today(), reason: '' }); }}>إدارة</button> },
        ]} />
      </Card>
      {sel && (
        <Card title={`السطر: ${sel.salesOrderNo} — ${sel.itemName} (المتبقي غير المخطَّط ${num(sel.unplannedQty, 1)})`}>
          <form onSubmit={savePromise} className="mb-4 grid gap-3 md:grid-cols-4">
            <Field label="وعد التسليم"><input type="date" required className={inputCls} value={promise.promisedDate} onChange={(e) => setPromise({ ...promise, promisedDate: e.target.value })} /></Field>
            <Field label={sel.promisedDate ? 'سبب التعديل (مطلوب)' : 'ملاحظة'}><input className={inputCls} value={promise.reason} onChange={(e) => setPromise({ ...promise, reason: e.target.value })} /></Field>
            <div className="flex items-end gap-2"><button className="btn btn-gold" disabled={busy}>حفظ الوعد</button>{sel.suggestedPromise && <button type="button" className="btn" onClick={() => setPromise({ ...promise, promisedDate: sel.suggestedPromise })}>اقتراح: {d10(sel.suggestedPromise)}</button>}</div>
          </form>
          <form onSubmit={create} className="mb-4 grid gap-3 md:grid-cols-6">
            <Field label="الفرع"><select required className={inputCls} value={mk.branchId} onChange={(e) => setMk({ ...mk, branchId: e.target.value })}><option value="">—</option>{branches?.map((b: Row) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
            <Field label="المخزن"><select required className={inputCls} value={mk.warehouseId} onChange={(e) => setMk({ ...mk, warehouseId: e.target.value })}><option value="">—</option>{warehouses?.map((w: Row) => <option key={w.id} value={w.id}>{w.name_ar ?? w.name}</option>)}</select></Field>
            <Field label="قائمة المواد"><select required className={inputCls} value={mk.bomId} onChange={(e) => setMk({ ...mk, bomId: e.target.value })}><option value="">—</option>{itemBoms.map((b) => <option key={b.id} value={b.id}>{b.name_ar ?? b.code ?? b.id.slice(0, 8)}</option>)}</select></Field>
            <Field label="الفترة المالية"><select required className={inputCls} value={mk.fiscalPeriodId} onChange={(e) => setMk({ ...mk, fiscalPeriodId: e.target.value })}><option value="">—</option>{periods?.map((p: Row) => <option key={p.id} value={p.id}>{d10(p.start_date)} → {d10(p.end_date)}</option>)}</select></Field>
            <Field label="الكمية (افتراضي المتبقي)"><input className={inputCls} inputMode="decimal" value={mk.qty} onChange={(e) => setMk({ ...mk, qty: e.target.value })} /></Field>
            <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إنشاء أمر تصنيع</button></div>
          </form>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="أو ربط أمر تصنيع قائم"><select className={inputCls} value={linkId} onChange={(e) => setLinkId(e.target.value)}><option value="">—</option>{candidates.map((o) => <option key={o.id} value={o.id}>{o.document_number}</option>)}</select></Field>
            <button className="btn" disabled={busy || !linkId} onClick={link}>ربط</button>
          </div>
          <DataTable rows={hist} empty="لا تعديلات على الوعد." cols={[{ h: 'التاريخ', r: (r) => d10(r.changed_at) }, { h: 'من', r: (r) => d10(r.old_date) }, { h: 'إلى', r: (r) => d10(r.new_date) }, { h: 'السبب', r: (r) => r.reason ?? '—' }]} />
        </Card>
      )}
    </div>
  );
}
