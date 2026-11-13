import { useMemo, useState } from 'react';
import { apiClient } from '@/api/client';
import { Card, DataTable, PageHeader, TextileNav, useAction, useGet, type Row } from '@/features/textile/shared';
import { code39Bars, code39Text } from '@/features/textile/barcode39';

const KINDS: Record<string, { label: string; list: string; code: string; pick: (d: any) => Row[] }> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  roll: { label: 'رولات القماش', list: '/textile/fabric-rolls', code: 'roll_no', pick: (d) => d?.rolls ?? [] },
  packing: { label: 'وحدات التعبئة (بالات/باليتات)', list: '/textile/packing', code: 'packing_no', pick: (d) => (Array.isArray(d) ? d : d?.units ?? d?.data ?? d?.rows ?? []) },
  'fiber-lot': { label: 'لوطات الألياف', list: '/textile/fiber-lots', code: 'lot_code', pick: (d) => (Array.isArray(d) ? d : d?.data ?? []) },
  'dye-batch': { label: 'دفعات الصباغة', list: '/textile/dyeing/batches', code: 'batch_no', pick: (d) => (Array.isArray(d) ? d : d?.data ?? []) },
};

interface Label { id: string; code: string; title: string; lines: Array<{ label: string; value: string }> }

function Barcode({ value }: { value: string }) {
  const { bars, width } = useMemo(() => code39Bars(value), [value]);
  return (
    <svg viewBox={`-10 0 ${width + 20} 40`} preserveAspectRatio="none" className="h-12 w-full" role="img" aria-label={value}>
      {bars.map(([x, w], i) => <rect key={i} x={x} y={0} width={w} height={40} fill="#000" />)}
    </svg>
  );
}

/** طباعة ملصقات باركود (Code 39) للرولات والتعبئة واللوطات ودفعات الصباغة. اختر السجلات ثم «طباعة». */
export default function LabelsPage() {
  const [kind, setKind] = useState('roll');
  const k = KINDS[kind];
  const { data } = useGet<any>(k.list); // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows = k.pick(data);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<{ company: string; labels: Label[] } | null>(null);
  const { busy, run } = useAction();

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const make = async () => {
    const ids = [...sel].slice(0, 100);
    const r = await run(() => apiClient.get('/textile/labels', { params: { kind, ids: ids.join(',') } }));
    if (r) setSheet(r as { company: string; labels: Label[] });
  };

  return (
    <div>
      <style>{`@media print { body * { visibility: hidden } .label-sheet, .label-sheet * { visibility: visible } .label-sheet { position: absolute; inset: 0; padding: 0 } .no-print { display: none } }`}</style>
      <div className="no-print">
        <PageHeader title="ملصقات الباركود" sub="Code 39 — يُقرأ بأي قارئ باركود">
          {sheet && <button className="btn btn-gold" onClick={() => window.print()}>🖨️ طباعة</button>}
        </PageHeader>
        <TextileNav />
        <Card title="اختيار السجلات">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {Object.entries(KINDS).map(([key, v]) => (
              <button key={key} className={`btn btn-sm ${kind === key ? 'btn-primary' : 'btn-outline'}`} onClick={() => { setKind(key); setSel(new Set()); setSheet(null); }}>{v.label}</button>
            ))}
            <button className="btn btn-sm btn-outline" onClick={() => setSel(new Set(rows.map((r) => String(r.id))))}>تحديد الكل</button>
            <button className="btn btn-sm btn-gold" disabled={busy || sel.size === 0} onClick={() => void make()}>إنشاء الملصقات ({Math.min(sel.size, 100)})</button>
          </div>
          <DataTable rows={rows} empty="لا توجد سجلات." cols={[
            { h: '', r: (r) => <input type="checkbox" checked={sel.has(String(r.id))} onChange={() => toggle(String(r.id))} /> },
            { h: 'الرقم', r: (r) => <span dir="ltr">{String(r[k.code] ?? '—')}</span> },
          ]} />
        </Card>
      </div>
      {sheet && (
        <div className="label-sheet mt-4 grid gap-3 md:grid-cols-3" dir="rtl">
          {sheet.labels.map((l) => (
            <div key={l.id} className="break-inside-avoid rounded border-2 border-black bg-white p-3 text-black">
              <p className="text-xs">{sheet.company}</p>
              <p className="mb-1 text-sm font-extrabold">{l.title}</p>
              <Barcode value={l.code} />
              <p className="mb-1 text-center font-mono text-xs" dir="ltr">{code39Text(l.code)}</p>
              <table className="w-full text-xs"><tbody>{l.lines.map((ln) => <tr key={ln.label}><td className="pe-2 text-slate-600">{ln.label}</td><td className="font-bold">{ln.value}</td></tr>)}</tbody></table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
