/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, useAction, useGet } from '@/features/textile/shared';

const STRAT: Record<string, string> = { fifo: 'الأقدم أولًا', cheapest: 'الأرخص أولًا', largest: 'الأكبر رصيدًا (أقل لوطات)' };

/** صرف خامات أمر التصنيع بالدفعة: لكل نوع غزل داخل الأمر تُحدَّد اللوطات وكمية كل لوط، وتُصرف كل لوط منفصلة بتكلفتها. */
export default function LotIssuePage() {
  const [orderId, setOrderId] = useState(''); const [strategy, setStrategy] = useState('fifo');
  const [edit, setEdit] = useState<Record<string, Record<string, string>>>({});
  const { data: orders } = useQuery({ queryKey: ['mfg-orders-lots'], queryFn: async () => (await apiClient.get<{ data: any[] }>('/manufacturing/orders', { params: { page: 1, pageSize: 100 } })).data.data, retry: false });
  const { data: ol } = useGet<any>(`/textile/production-orders/${orderId}/lots`, {}, !!orderId);
  const { data: run } = useGet<any>(`/textile/production-orders/${orderId}/lot-run`, {}, !!orderId);
  const { busy, post, put } = useAction();
  useEffect(() => { setEdit({}); }, [orderId]);
  const draft = ol?.status === 'draft';
  const cur = (l: any) => edit[l.lineId] ?? Object.fromEntries(l.allocations.map((a: any) => [a.batchId, String(a.quantity)]));
  const setQty = (l: any, batchId: string, v: string) => setEdit({ ...edit, [l.lineId]: { ...cur(l), [batchId]: v } });
  const sum = (l: any) => Object.values(cur(l)).reduce((s, v) => s + (Number(v) || 0), 0);
  const save = (l: any) => put(`/textile/production-orders/${orderId}/lines/${l.lineId}/lots`, { lots: Object.entries(cur(l)).filter(([, v]) => Number(v) > 0).map(([batchId, v]) => ({ batchId, quantity: Number(v) })) }, 'حُفظ تخصيص اللوطات').then(() => setEdit((e) => { const n = { ...e }; delete n[l.lineId]; return n; }));
  return (
    <div>
      <PageHeader title="صرف الخامات بالدفعة (اللوط)" sub="لكل نوع غزل في الأمر اختر اللوط وكمية كل لوط؛ تُصرف كل لوط بحركة مستقلة بتكلفتها فتبقى منفصلة. مكوّن بلا تخصيص يُصرف كالمعتاد." />
      <TextileNav />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="أمر التصنيع"><select className={inputCls} value={orderId} onChange={(e) => setOrderId(e.target.value)}><option value="">— اختر —</option>{orders?.map((o: any) => <option key={o.id} value={o.id}>{o.document_number} ({o.status})</option>)}</select></Field>
          <Field label="استراتيجية الاقتراح"><select className={inputCls} value={strategy} onChange={(e) => setStrategy(e.target.value)}>{Object.entries(STRAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <div className="flex items-end"><button className="btn-primary" disabled={busy || !draft} onClick={() => post(`/textile/production-orders/${orderId}/lots/auto`, { strategy }, 'طُبِّق الاقتراح على المكوّنات غير المخصَّصة')}>تخصيص تلقائي للكل</button></div>
          <Kpi label="الحالة" value={ol ? (draft ? 'مسودة' : ol.status === 'posted' ? 'مُرحَّل' : ol.status) : '—'} />
        </div>
      </Card>
      {ol?.lines.map((l: any) => {
        const c = cur(l); const s = sum(l); const diff = Math.round((l.required - s) * 1e4) / 1e4;
        return (
          <Card key={l.lineId} title={`${l.itemCode} — ${l.itemName}${l.isMain ? ' (رئيسي)' : ''} · المطلوب ${num(l.required, 3)}`}>
            <div className="mb-2 text-sm">المخصَّص: <b>{num(s, 3)}</b> · المتبقي: <b className={Math.abs(diff) > 0.00005 && s > 0 ? 'text-red-700' : ''}>{num(diff, 3)}</b> {s === 0 && <span className="text-gray-500">— بلا تخصيص: يُصرف من رصيد المكوّن العام</span>}</div>
            {draft ? (
              <DataTable rows={l.availableLots} empty="لا لوطات برصيد لهذا المكوّن في مخزن الأمر." cols={[{ h: 'اللوط', k: 'batchNo' }, { h: 'المورد', r: (x) => x.supplier ?? '—' }, { h: 'إنتاج/توريد', r: (x) => x.productionDate ?? '—' }, { h: 'المتاح', r: (x) => num(x.available, 3) }, { h: 'متوسط التكلفة', r: (x) => num(x.avgCost, 4) },
                { h: 'الكمية المصروفة', r: (x) => <input className={inputCls} style={{ width: 110 }} inputMode="decimal" value={c[x.batchId] ?? ''} onChange={(e) => setQty(l, x.batchId, e.target.value)} /> }]} />
            ) : (
              <DataTable rows={l.allocations} empty="بلا لوطات (صُرف من الرصيد العام)." cols={[{ h: 'اللوط', k: 'batchNo' }, { h: 'الكمية', r: (x) => num(x.quantity, 3) }, { h: 'تكلفة الوحدة', r: (x) => (x.unitCost === null ? '—' : num(x.unitCost, 4)) }, { h: 'التكلفة', r: (x) => (x.lineCost === null ? '—' : num(x.lineCost, 2)) }]} />
            )}
            {draft && <div className="mt-2"><button className="btn-primary" disabled={busy} onClick={() => save(l)}>حفظ لوطات هذا المكوّن</button></div>}
          </Card>
        );
      })}
      {run && run.lots.length > 0 && (
        <Card title="فصل اللوتات: حصة كل لوط وتكلفته">
          {run.note && <p className="text-sm text-amber-700">⚠️ {run.note}</p>}
          <DataTable rows={run.lots} empty="—" cols={[{ h: 'المكوّن', r: (x) => `${x.itemCode} — ${x.itemName}` }, { h: 'اللوط', k: 'batchNo' }, { h: 'المورد', r: (x) => x.supplier ?? '—' }, { h: 'الكمية', r: (x) => num(x.quantity, 3) }, { h: 'الحصة', r: (x) => `${num(x.sharePercent, 1)}%` }, { h: 'التكلفة', r: (x) => (x.cost === null ? '—' : num(x.cost, 2)) }, { h: 'الناتج المنسوب', r: (x) => (x.attributedOutput === null ? '—' : num(x.attributedOutput, 2)) }, { h: 'الحالة', r: (x) => (x.posted ? 'مصروف' : 'مخطَّط') }]} />
          <div className="mt-2 text-sm">إجمالي تكلفة اللوطات المصروفة: <b>{num(run.totalCost, 2)}</b></div>
        </Card>
      )}
    </div>
  );
}
