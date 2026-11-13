/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient, extractErrorMessage } from '@/api/client';
import { toast } from '@/ui/toast';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, today, useAction, useGet, type Row } from '@/features/textile/shared';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** إذن التسليم / بوليصة التعبئة: اختيار وحدات التعبئة والرولات لعميل وطباعة المستند. */
export default function DeliveryPage() {
  const { data: notes } = useGet('/textile/delivery-notes');
  const { data: ship } = useGet<{ units: Row[]; rolls: Row[] }>('/textile/shippable');
  const { data: branches } = useGet('/branches');
  const { data: customers } = useQuery({ queryKey: ['cust-100'], queryFn: async () => (await apiClient.get('/customers', { params: { page: 1, pageSize: 100 } })).data });
  const { busy, post, put } = useAction();
  const [f, setF] = useState({ branchId: '', customerId: '', noteDate: today(), vehicleNo: '', driverName: '', notes: '' });
  const [units, setUnits] = useState<string[]>([]);
  const [rolls, setRolls] = useState<string[]>([]);
  const [linkFor, setLinkFor] = useState<Row | null>(null);
  const [invId, setInvId] = useState('');
  const { data: cands } = useGet(`/textile/delivery-notes/${linkFor?.id ?? '_'}/invoice-candidates`, {}, !!linkFor);
  const { data: recon } = useGet<any>(`/textile/reports/invoice-delivery/${linkFor?.sales_invoice_id ?? '_'}`, {}, !!linkFor?.sales_invoice_id);
  const custs: any[] = Array.isArray(customers) ? customers : customers?.data ?? [];
  const tog = (arr: string[], set: (v: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await post('/textile/delivery-notes', { ...f, ...(f.vehicleNo ? {} : { vehicleNo: undefined }), packingUnitIds: units, fabricRollIds: rolls }, 'صدر إذن التسليم');
    if (r) { setUnits([]); setRolls([]); }
  };

  const print = async (id: string) => {
    try {
      const d: any = (await apiClient.get(`/textile/delivery-notes/${id}/doc`)).data;
      const w = window.open('', '_blank');
      if (!w) return;
      const rows = (xs: Row[], cols: Array<(r: Row) => unknown>) => xs.map((r) => `<tr>${cols.map((c) => `<td>${esc(c(r))}</td>`).join('')}</tr>`).join('');
      w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>${esc(d.note.note_no)}</title><style>body{font-family:Tahoma,Arial;padding:24px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #444;padding:4px 8px;font-size:13px}h2{margin:0}</style></head><body>
        <h2>إذن تسليم ${esc(d.note.note_no)}</h2><p>العميل: <b>${esc(d.note.customer_name)}</b> — التاريخ: ${esc(String(d.note.note_date).slice(0, 10))} ${d.note.sales_order_no ? `— أمر البيع: ${esc(d.note.sales_order_no)}` : ''}<br>السيارة: ${esc(d.note.vehicle_no ?? '—')} — السائق: ${esc(d.note.driver_name ?? '—')}</p>
        ${d.units.length ? `<h3>وحدات التعبئة</h3><table><tr><th>الرقم</th><th>النوع</th><th>الصنف</th><th>اللوط</th><th>العدد</th><th>القائم كجم</th><th>الصافي كجم</th></tr>${rows(d.units, [(r) => r.packing_no, (r) => r.unit_type, (r) => r.item_name, (r) => r.lot_number, (r) => r.packages_count, (r) => r.gross_kg, (r) => r.net_kg])}</table>` : ''}
        ${d.rolls.length ? `<h3>رولات القماش</h3><table><tr><th>الرول</th><th>الصنف</th><th>الطول م</th><th>العرض سم</th><th>الوزن كجم</th><th>الدرجة</th></tr>${rows(d.rolls, [(r) => r.roll_no, (r) => r.item_name, (r) => r.length_m, (r) => r.width_cm, (r) => r.weight_kg, (r) => r.grade])}</table>` : ''}
        <p><b>الإجمالي:</b> وحدات ${d.totals.unitsCount} (صافي ${d.totals.netKg} كجم) — رولات ${d.totals.rollsCount} (${d.totals.rollsMeters} م / ${d.totals.rollsKg} كجم)</p>
        <p style="margin-top:48px">توقيع المستلم: ____________ &nbsp;&nbsp;&nbsp; توقيع أمين المخزن: ____________</p>
        <script>window.onload=()=>window.print()</script></body></html>`);
      w.document.close();
    } catch (e) { toast(extractErrorMessage(e), 'error'); }
  };

  return (
    <div>
      <PageHeader title="إذن التسليم / بوليصة التعبئة" sub="يُخرج وحدات التعبئة المختارة للعميل (تصبح «مشحونة») ولا يُنشئ قيودًا — الفوترة عبر فاتورة البيع" />
      <TextileNav />
      <form onSubmit={submit}>
        <Card title="إذن جديد">
          <div className="grid gap-3 md:grid-cols-6">
            <Field label="الفرع"><select required className={inputCls} value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">—</option>{branches?.map((b: Row) => <option key={b.id} value={b.id}>{b.name_ar ?? b.name}</option>)}</select></Field>
            <Field label="العميل"><select required className={inputCls} value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">—</option>{custs.map((c) => <option key={c.id} value={c.id}>{c.name_ar ?? c.name}</option>)}</select></Field>
            <Field label="التاريخ"><input type="date" required className={inputCls} value={f.noteDate} onChange={(e) => setF({ ...f, noteDate: e.target.value })} /></Field>
            <Field label="السيارة"><input className={inputCls} value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value })} /></Field>
            <Field label="السائق"><input className={inputCls} value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} /></Field>
            <div className="flex items-end"><button className="btn btn-gold" disabled={busy || units.length + rolls.length === 0}>إصدار ({units.length + rolls.length})</button></div>
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div><b className="text-sm">وحدات التعبئة المتاحة</b>
              <div className="max-h-56 overflow-auto">{ship?.units.map((u) => <label key={u.id} className="flex gap-2 py-0.5 text-sm"><input type="checkbox" checked={units.includes(u.id)} onChange={() => tog(units, setUnits, u.id)} />{u.packing_no} — {u.item_name} — {num(u.net_kg, 1)} كجم</label>)}{ship && ship.units.length === 0 && <p className="text-sm text-slate-500">لا وحدات متاحة.</p>}</div></div>
            <div><b className="text-sm">رولات القماش المتاحة</b>
              <div className="max-h-56 overflow-auto">{ship?.rolls.map((r) => <label key={r.id} className="flex gap-2 py-0.5 text-sm"><input type="checkbox" checked={rolls.includes(r.id)} onChange={() => tog(rolls, setRolls, r.id)} />{r.roll_no} — {num(r.length_m, 1)} م — درجة {r.grade}</label>)}{ship && ship.rolls.length === 0 && <p className="text-sm text-slate-500">لا رولات متاحة.</p>}</div></div>
          </div>
        </Card>
      </form>
      <Card title="الأذون الصادرة">
        <DataTable rows={notes} empty="لا أذون بعد." cols={[{ h: 'الرقم', k: 'note_no' }, { h: 'العميل', k: 'customer_name' }, { h: 'التاريخ', r: (r) => String(r.note_date).slice(0, 10) }, { h: 'البنود', k: 'lines_count' }, { h: 'الفاتورة', r: (r) => (r.sales_invoice_id ? 'مرتبط' : '—') }, { h: 'الحالة', r: (r) => (r.status === 'issued' ? 'صادر' : 'ملغى') },
          { h: '', r: (r) => <span className="flex gap-2"><button className="btn" onClick={() => print(r.id)}>طباعة</button>{r.status === 'issued' && <button className="btn" onClick={() => { setLinkFor(r); setInvId(r.sales_invoice_id ?? ''); }}>فاتورة</button>}{r.status === 'issued' && <button className="btn" disabled={busy} onClick={() => { const reason = window.prompt('سبب الإلغاء؟'); if (reason && reason.length >= 3) post(`/textile/delivery-notes/${r.id}/cancel`, { reason }, 'أُلغي الإذن'); }}>إلغاء</button>}</span> }]} />
      </Card>
      {linkFor && (
        <Card title={`ربط الإذن ${linkFor.note_no} بفاتورة بيع`}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="الفاتورة"><select className={inputCls} value={invId} onChange={(e) => setInvId(e.target.value)}><option value="">(بدون)</option>{cands?.map((c: Row) => <option key={c.id} value={c.id}>{c.document_number} — {String(c.invoice_date).slice(0, 10)}{c.same_order ? ' ★ نفس أمر البيع' : ''}</option>)}</select></Field>
            <button className="btn btn-gold" disabled={busy} onClick={async () => { const r = await put(`/textile/delivery-notes/${linkFor.id}/invoice`, { invoiceId: invId || null }, 'تم الحفظ'); if (r) setLinkFor({ ...linkFor, sales_invoice_id: invId || null }); }}>حفظ الربط</button>
            <button className="btn" onClick={() => setLinkFor(null)}>إغلاق</button>
          </div>
          {recon && (
            <DataTable rows={recon.items} cols={[{ h: 'الصنف', r: (r) => r.itemName ?? '(ليس في الفاتورة)' }, { h: 'مفوتر', r: (r) => (r.notInvoice ? '—' : `${num(r.invoicedQty, 2)} ${r.uom ?? ''}`) }, { h: 'مُسلَّم كجم', r: (r) => num(r.deliveredKg, 2) }, { h: 'مُسلَّم متر', r: (r) => num(r.deliveredMeters, 2) }, { h: 'وحدات/رولات', r: (r) => `${r.units}/${r.rolls}` }]} />
          )}
          <p className="mt-2 text-xs text-slate-500">المقارنة إرشادية: وحدة الفاتورة قد تختلف عن كجم/متر التسليم، فتُعرض الأرقام دون حكم تلقائي.</p>
        </Card>
      )}
    </div>
  );
}
