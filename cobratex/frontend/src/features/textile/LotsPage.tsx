/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, num, useGet } from '@/features/textile/shared';

/** أرصدة اللوتات وكارت اللوط: كل حركة بالرصيد الجاري والتكلفة والقيمة. */
export default function LotsPage() {
  const [sel, setSel] = useState<{ itemId: string; batchNo: string } | null>(null); const [zero, setZero] = useState(false);
  const { data: lots } = useGet<any>('/textile/lots', { includeZero: zero ? 'true' : '' });
  const { data: card } = useGet<any>('/textile/lots/card', { itemId: sel?.itemId, batchNo: sel?.batchNo }, !!sel);
  return (
    <div>
      <PageHeader title="اللوتات وكارت اللوط" sub="رصيد وقيمة كل لوط (دفعة) بتكلفة الحركات المسجَّلة. اضغط «كارت» لرؤية تاريخ اللوط حركةً حركة." />
      <TextileNav />
      <Card title="أرصدة اللوتات">
        <div className="mb-3 grid gap-3 md:grid-cols-4"><Kpi label="عدد اللوتات" value={lots ? String(lots.totals.lots) : '—'} /><Kpi label="الكمية" value={lots ? num(lots.totals.quantity, 2) : '—'} /><Kpi label="القيمة" value={lots ? num(lots.totals.value, 2) : '—'} />
          <Field label="إظهار الأرصدة الصفرية"><input type="checkbox" checked={zero} onChange={(e) => setZero(e.target.checked)} /></Field></div>
        <DataTable rows={lots?.lots} empty="لا لوتات." cols={[{ h: 'اللوط', k: 'batchNo' }, { h: 'الصنف', r: (r) => `${r.itemCode} — ${r.itemName}` }, { h: 'المورد', r: (r) => r.supplier ?? '—' }, { h: 'المخزن', k: 'warehouse' }, { h: 'الرصيد', r: (r) => num(r.balance, 2) }, { h: 'متوسط التكلفة', r: (r) => num(r.avgCost, 4) }, { h: 'القيمة', r: (r) => num(r.value, 2) }, { h: 'آخر حركة', k: 'lastMove' },
          { h: '', r: (r) => <button className="btn" onClick={() => setSel({ itemId: r.itemId, batchNo: r.batchNo })}>كارت</button> }]} />
      </Card>
      {card && (
        <Card title={`كارت اللوط ${card.lot.batchNo} — ${card.lot.itemName}`}>
          <div className="mb-3 grid gap-3 md:grid-cols-5"><Kpi label="وارد" value={num(card.totals.received, 2)} /><Kpi label="صادر" value={num(card.totals.issued, 2)} /><Kpi label="الرصيد" value={num(card.totals.balance, 2)} /><Kpi label="متوسط التكلفة" value={num(card.totals.avgCost, 4)} /><Kpi label="القيمة" value={num(card.totals.value, 2)} /></div>
          <DataTable rows={card.movements} empty="لا حركات." cols={[{ h: 'التاريخ', k: 'date' }, { h: 'الحركة', k: 'label' }, { h: 'المخزن', k: 'warehouse' }, { h: 'الكمية', r: (r) => <b className={r.sign < 0 ? 'text-red-700' : 'text-green-700'}>{r.sign < 0 ? '−' : '+'}{num(r.quantity, 2)}</b> }, { h: 'تكلفة الوحدة', r: (r) => num(r.unitCost, 4) }, { h: 'الرصيد', r: (r) => num(r.balance, 2) }, { h: 'القيمة', r: (r) => num(r.value, 2) }, { h: 'المصدر', k: 'source' }]} />
        </Card>
      )}
    </div>
  );
}
