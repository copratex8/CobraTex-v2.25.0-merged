import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiClient } from '@/api/client';
import { useItems } from '@/features/catalog/api';
import { Card, DataTable, Field, Kpi, PageHeader, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

interface LineState { id: string; name: string; planned: string; actual: string; main: boolean; lots: string }
interface OutState { itemId: string; grade: string; quantity: string; weight: string; lot: string }
interface WasteState { typeId: string; quantity: string; recoveryItemId: string; value: string }

/** الإنتاج الفعلي والهالك لأمر تصنيع (مسودة): الاستهلاك الفعلي، المخرجات بدرجاتها ولوطاتها، أنواع الهالك — مع معاينة التكلفة قبل التنفيذ. */
export default function OrderTextilePage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data: order } = useGet<Row>(`/manufacturing/orders/${id}`, undefined, !!id);
  const { data: stages } = useGet('/textile/stages');
  const { data: machines } = useGet('/textile/machines');
  const { data: wasteTypes } = useGet('/textile/waste-types');
  const { data: items } = useItems();
  const { busy, put, run } = useAction();
  const [preview, setPreview] = useState<Row | null>(null);
  const [yieldRep, setYieldRep] = useState<Row | null>(null);
  const [conv, setConv] = useState<Row | null>(null);

  const [stageId, setStageId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [stdWaste, setStdWaste] = useState('');
  const [lines, setLines] = useState<LineState[]>([]);
  const [outs, setOuts] = useState<OutState[]>([]);
  const [wastes, setWastes] = useState<WasteState[]>([]);
  const inited = useRef(false);

  const itemName = (i: string) => items?.find((x) => x.id === i)?.name_ar ?? i;

  useEffect(() => {
    if (!order || !items || inited.current) return;
    inited.current = true;
    setStageId(order.stage_id ?? ''); setMachineId(order.machine_id ?? ''); setStdWaste(order.standard_waste_percent ?? '');
    const ls: Row[] = order.lines ?? [];
    const hasMain = ls.some((l) => l.is_main_material);
    const biggest = ls.reduce((a: Row | undefined, l) => (!a || Number(l.planned_quantity) > Number(a.planned_quantity) ? l : a), undefined);
    setLines(ls.map((l) => ({ id: l.id, name: items.find((x) => x.id === l.component_item_id)?.name_ar ?? l.component_item_id, planned: l.planned_quantity, actual: l.actual_quantity ?? l.planned_quantity, main: hasMain ? !!l.is_main_material : l.id === biggest?.id, lots: l.input_lot_numbers ?? '' })));
    const os: Row[] = order.outputs ?? [];
    setOuts(os.length ? os.map((o) => ({ itemId: o.output_item_id, grade: o.grade, quantity: o.quantity, weight: o.cost_weight, lot: o.lot_number ?? '' })) : [{ itemId: order.output_item_id, grade: 'A', quantity: order.planned_output_quantity, weight: '1', lot: '' }]);
    setWastes((order.waste ?? []).map((w: Row) => ({ typeId: w.waste_type_id, quantity: w.quantity, recoveryItemId: w.recovery_item_id ?? '', value: w.recovery_unit_value })));
  }, [order, items]);

  if (!order) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;
  const draft = order.status === 'draft';

  const body = () => ({
    ...(stageId ? { stageId } : {}), ...(machineId ? { machineId } : {}), ...(stdWaste !== '' ? { standardWastePercent: String(stdWaste) } : {}),
    lines: lines.map((l) => ({ lineId: l.id, actualQuantity: l.actual, isMainMaterial: l.main, ...(l.lots.trim() ? { inputLotNumbers: l.lots.trim() } : {}) })),
    outputs: outs.map((o) => ({ outputItemId: o.itemId, grade: o.grade, quantity: o.quantity, ...(o.weight ? { costWeight: o.weight } : {}), ...(o.lot.trim() ? { lotNumber: o.lot.trim() } : {}) })),
    wastes: wastes.map((w) => ({ wasteTypeId: w.typeId, quantity: w.quantity, ...(w.recoveryItemId ? { recoveryItemId: w.recoveryItemId } : {}), ...(w.value !== '' ? { recoveryUnitValue: w.value } : {}) })),
  });

  const save = async () => { setPreview(null); await put(`/textile/orders/${id}/completion`, body(), 'تم حفظ الإنتاج الفعلي والهالك'); };
  const doPreview = async () => {
    // المعاينة تحسب من المحفوظ على الخادم: نحفظ أولًا ثم نعاين.
    const saved = await put(`/textile/orders/${id}/completion`, body());
    if (!saved) return;
    const r = await run<Row>(() => apiClient.get<Row>(`/textile/orders/${id}/completion/preview`));
    if (r) setPreview(r);
  };
  const loadYield = async () => {
    const r = await run<Row>(() => apiClient.get<Row>(`/textile/reports/orders/${id}/yield`));
    if (r) setYieldRep(r);
  };

  const upd = <T,>(arr: T[], i: number, patch: Partial<T>) => arr.map((x, k) => (k === i ? { ...x, ...patch } : x));

  return (
    <div>
      <Link to={`/manufacturing/orders/${id}`} className="text-sm text-slate-500 hover:underline">→ العودة لأمر التصنيع</Link>
      <PageHeader title={`الإنتاج الفعلي والهالك — ${order.document_number}`} sub={`الحالة: ${({ draft: 'مسودة', posted: 'منفَّذ', reversed: 'معكوس' } as Record<string, string>)[order.status]} · المنتَج المخطَّط: ${itemName(order.output_item_id)} × ${order.planned_output_quantity}`}>
        <button className="btn btn-outline" onClick={loadYield}>تقرير العائد</button>
      </PageHeader>
      {!draft && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">الأمر غير مسودة: العرض للقراءة فقط. لتعديل الإنتاج الفعلي اعكس الأمر أولًا.</p>}

      <Card title="المرحلة والماكينة">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="المرحلة"><select disabled={!draft} className={inputCls} value={stageId} onChange={(e) => { setStageId(e.target.value); const s = stages?.find((x: Row) => x.id === e.target.value); if (s) setStdWaste(String(s.standard_waste_percent)); }}><option value="">—</option>{stages?.map((s: Row) => <option key={s.id} value={s.id}>{s.name_ar}</option>)}</select></Field>
          <Field label="الماكينة"><select disabled={!draft} className={inputCls} value={machineId} onChange={(e) => setMachineId(e.target.value)}><option value="">—</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code} — {m.name_ar}</option>)}</select></Field>
          <Field label="هالك قياسي % (من الخامة الرئيسية)"><input disabled={!draft} className={inputCls} dir="ltr" value={stdWaste} onChange={(e) => setStdWaste(e.target.value)} /></Field>
        </div>
      </Card>

      <Card title="الاستهلاك الفعلي للخامات" badge="الخامة الرئيسية = أساس نسبة الهالك">
        <div className="tbl-wrap"><table className="w-full text-start text-sm">
          <thead><tr><th className="px-3 py-2 text-start">الخامة</th><th className="px-3 py-2 text-start">المخطَّط</th><th className="px-3 py-2 text-start">الفعلي</th><th className="px-3 py-2 text-start">رئيسية</th><th className="px-3 py-2 text-start">لوطات الخامة</th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={l.id}>
              <td className="px-3 py-1.5">{l.name}</td><td className="px-3 py-1.5">{num(l.planned, 3)}</td>
              <td className="px-3 py-1.5"><input disabled={!draft} className="w-28 rounded border border-slate-300 px-2 py-1" dir="ltr" value={l.actual} onChange={(e) => setLines(upd(lines, i, { actual: e.target.value }))} /></td>
              <td className="px-3 py-1.5"><input type="radio" name="main" disabled={!draft} checked={l.main} onChange={() => setLines(lines.map((x, k) => ({ ...x, main: k === i })))} /></td>
              <td className="px-3 py-1.5"><input disabled={!draft} className="w-48 rounded border border-slate-300 px-2 py-1" dir="ltr" placeholder="BALE-7, BALE-9" value={l.lots} onChange={(e) => setLines(upd(lines, i, { lots: e.target.value }))} /></td>
            </tr>))}</tbody>
        </table></div>
      </Card>

      <Card title="المخرجات (درجات وأرقام اللوط)" badge="وزن التكلفة: الدرجة الأدنى أقل من 1">
        {outs.map((o, i) => (
          <div key={i} className="mb-2 grid gap-2 md:grid-cols-6">
            <select disabled={!draft} className={`${inputCls} md:col-span-2`} value={o.itemId} onChange={(e) => setOuts(upd(outs, i, { itemId: e.target.value }))}>{items?.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name_ar}</option>)}</select>
            <input disabled={!draft} className={inputCls} placeholder="الدرجة" value={o.grade} onChange={(e) => setOuts(upd(outs, i, { grade: e.target.value }))} />
            <input disabled={!draft} className={inputCls} dir="ltr" placeholder="الكمية" value={o.quantity} onChange={(e) => setOuts(upd(outs, i, { quantity: e.target.value }))} />
            <input disabled={!draft} className={inputCls} dir="ltr" placeholder="وزن التكلفة" value={o.weight} onChange={(e) => setOuts(upd(outs, i, { weight: e.target.value }))} />
            <div className="flex gap-1"><input disabled={!draft} className={inputCls} dir="ltr" placeholder="رقم اللوط" value={o.lot} onChange={(e) => setOuts(upd(outs, i, { lot: e.target.value }))} />{draft && outs.length > 1 && <button className="btn btn-sm btn-danger" onClick={() => setOuts(outs.filter((_, k) => k !== i))}>×</button>}</div>
          </div>
        ))}
        {draft && <button className="btn btn-sm btn-outline" onClick={() => setOuts([...outs, { itemId: order.output_item_id, grade: 'B', quantity: '', weight: '0.7', lot: '' }])}>+ درجة أخرى</button>}
      </Card>

      <Card title="الهالك">
        {wastes.map((w, i) => (
          <div key={i} className="mb-2 grid gap-2 md:grid-cols-5">
            <select disabled={!draft} className={`${inputCls} md:col-span-2`} value={w.typeId} onChange={(e) => { const t = wasteTypes?.find((x: Row) => x.id === e.target.value); setWastes(upd(wastes, i, { typeId: e.target.value, value: t ? String(t.recovery_unit_value) : w.value })); }}><option value="">نوع الهالك…</option>{wasteTypes?.filter((t: Row) => t.is_active).map((t: Row) => <option key={t.id} value={t.id}>{t.name_ar}</option>)}</select>
            <input disabled={!draft} className={inputCls} dir="ltr" placeholder="الكمية" value={w.quantity} onChange={(e) => setWastes(upd(wastes, i, { quantity: e.target.value }))} />
            <input disabled={!draft} className={inputCls} dir="ltr" placeholder="قيمة استرداد الوحدة" value={w.value} onChange={(e) => setWastes(upd(wastes, i, { value: e.target.value }))} />
            <div className="flex gap-1"><select disabled={!draft} className={inputCls} value={w.recoveryItemId} onChange={(e) => setWastes(upd(wastes, i, { recoveryItemId: e.target.value }))}><option value="">صنف الهالك (من النوع)</option>{items?.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name_ar}</option>)}</select>{draft && <button className="btn btn-sm btn-danger" onClick={() => setWastes(wastes.filter((_, k) => k !== i))}>×</button>}</div>
          </div>
        ))}
        {draft && <button className="btn btn-sm btn-outline" onClick={() => setWastes([...wastes, { typeId: '', quantity: '', recoveryItemId: '', value: '0' }])}>+ بند هالك</button>}
      </Card>

      {draft && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={busy} onClick={save}>حفظ</button>
          <button className="btn btn-gold" disabled={busy} onClick={doPreview}>حفظ ومعاينة التكلفة</button>
          <Link className="btn btn-success" to={`/manufacturing/orders/${id}`}>التنفيذ من شاشة الأمر ←</Link>
        </div>
      )}

      {preview && (
        <Card title="معاينة التكلفة قبل التنفيذ" badge="بمتوسط تكلفة المخزون الحالي">
          <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="هالك فعلي %" value={`${num(preview.actualWastePercent, 2)}%`} hint={`مسموح ${num(preview.allowedWasteQty, 2)} · غير عادي ${num(preview.abnormalWasteQty, 2)}`} tone={Number(preview.abnormalWasteQty) > 0 ? 'bad' : 'good'} />
            <Kpi label="العائد (Yield)" value={`${num(preview.yieldPercent, 2)}%`} />
            <Kpi label="قيمة الهوالك المستردة" value={num(preview.recoveredValueTotal)} />
            <Kpi label="خسارة هالك غير عادي" value={num(preview.abnormalLossTotal)} tone={Number(preview.abnormalLossTotal) > 0 ? 'bad' : 'good'} hint="تُقيَّد في 5040" />
          </div>
          <DataTable rows={preview.outputLines.map((l: Row, i: number) => ({ ...l, ...outs[i], idx: i }))} cols={[
            { h: 'المخرَج', r: (r) => `${itemName(r.itemId)} (${r.grade})` }, { h: 'الكمية', r: (r) => r.quantity }, { h: 'التكلفة', r: (r) => num(r.cost, 4) }, { h: 'تكلفة الوحدة', r: (r) => <b>{num(r.unitCost, 4)}</b> },
          ]} />
          <p className="mt-2 text-xs text-slate-500">تكلفة المواد {num(preview.materialsCost, 2)} + تحويل {num(preview.conversionCost, 2)} = تكلفة المخرجات {num(preview.outputsCost, 2)} بعد الاسترداد والخسارة.</p>
        </Card>
      )}

      {yieldRep && (
        <Card title="تقرير العائد">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="مُدخَل رئيسي" value={num(yieldRep.mainInputQty, 2)} /><Kpi label="مُخرَج" value={num(yieldRep.outputQty, 2)} />
            <Kpi label="هالك" value={num(yieldRep.wasteQty, 2)} hint={`${num(yieldRep.actualWastePercent, 2)}%`} /><Kpi label="العائد" value={`${num(yieldRep.yieldPercent, 2)}%`} />
          </div>
        </Card>
      )}

      <Card title="تكلفة التحويل من ساعات الماكينات" badge="عمالة + طاقة + مصاريف">
        <p className="mb-3 text-xs text-slate-500">تُحسب من سجلات الورديات المربوطة بهذا الأمر × معدّلات التكلفة (<Link className="underline" to="/textile/cost-rates">المعدّلات</Link>). التطبيق يضيف مراحل «[تلقائي]» على مسودة الأمر ويستبدل السابق منها.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-sm btn-outline" disabled={busy} onClick={async () => setConv(await run(() => apiClient.get(`/textile/orders/${id}/conversion-suggestion`)))}>اقتراح التكلفة</button>
          <button className="btn btn-sm btn-gold" disabled={busy || !conv} onClick={async () => { const r = await run(() => apiClient.post(`/textile/orders/${id}/apply-conversion-rates`, {}), 'تم تطبيق تكلفة التحويل على الأمر'); if (r) setConv(r); }}>تطبيق على الأمر</button>
        </div>
        {conv && (
          <div className="mt-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Kpi label="ساعات التشغيل" value={num(conv.runHours, 1)} hint={`${conv.logsCount} وردية`} /><Kpi label="عمالة" value={num(conv.labor, 2)} />
              <Kpi label="طاقة" value={num(conv.energy, 2)} hint={`${num(conv.energyKwh, 1)} kWh`} /><Kpi label="مصاريف" value={num(conv.overhead, 2)} /><Kpi label="الإجمالي" value={num(conv.total, 2)} />
            </div>
            {conv.missingRates?.length > 0 && <p className="mt-2 text-xs text-amber-700">⚠ معدّلات غير مُعرَّفة: {conv.missingRates.join('، ')} — تُحسب صفرًا.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
