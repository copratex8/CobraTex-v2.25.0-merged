import { useState } from 'react';
import { apiClient, extractErrorMessage } from '@/api/client';
import { toast } from '@/ui/toast';
import { Card, Field, PageHeader, TextileNav, inputCls, num, useGet, type Row } from '@/features/textile/shared';

/** حاسبات مرجعية: تحويل أنظمة رقم الغزل، تقدير القماش، إنتاج المغزل، وسعة الماكينة. بلا حفظ بيانات. */
export default function TextileToolsPage() {
  return (
    <div>
      <PageHeader title="حاسبات الغزل والنسيج" sub="معادلات مرجعية قياسية؛ راجع النتائج على ماكيناتك" />
      <TextileNav />
      <div className="grid gap-4 lg:grid-cols-2"><CountTool /><SpindleTool /><FabricTool /><CapacityTool /></div>
    </div>
  );
}

function useCalc() {
  const [out, setOut] = useState<Row | null>(null);
  const call = async (fn: () => Promise<{ data: Row }>) => { try { setOut((await fn()).data); } catch (e) { toast(extractErrorMessage(e), 'error'); } };
  return { out, call };
}
const KV = ({ o, labels }: { o: Row | null; labels: Record<string, string> }) => (o ? (
  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">{Object.entries(labels).map(([k, l]) => (<div key={k} className="contents"><dt className="text-slate-500">{l}</dt><dd className="font-bold" dir="ltr">{num(o[k], 3)}</dd></div>))}</dl>
) : null);

function CountTool() {
  const [v, setV] = useState('30'); const [sys, setSys] = useState('Ne'); const { out, call } = useCalc();
  return (
    <Card title="تحويل رقم الغزل">
      <div className="flex items-end gap-2">
        <Field label="القيمة"><input className={inputCls} dir="ltr" value={v} onChange={(e) => setV(e.target.value)} /></Field>
        <Field label="النظام"><select className={inputCls} value={sys} onChange={(e) => setSys(e.target.value)}>{['Ne', 'Nm', 'Tex', 'Denier'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <button className="btn btn-gold" onClick={() => call(() => apiClient.get('/textile/tools/count-convert', { params: { value: v, system: sys } }))}>تحويل</button>
      </div>
      <KV o={out} labels={{ Ne: 'Ne (إنجليزي)', Nm: 'Nm (مترية)', Tex: 'Tex', Denier: 'Denier' }} />
    </Card>
  );
}

function SpindleTool() {
  const [f, setF] = useState({ rpm: '16000', tpi: '18', ne: '30', eff: '95' }); const { out, call } = useCalc();
  return (
    <Card title="إنتاج المغزل (رينج)">
      <div className="grid grid-cols-2 gap-2">
        {([['rpm', 'سرعة المغزل (لفة/د)'], ['tpi', 'اللفات TPI'], ['ne', 'رقم الغزل Ne'], ['eff', 'الكفاءة %']] as Array<[keyof typeof f, string]>).map(([k, l]) => (
          <Field key={k} label={l}><input className={inputCls} dir="ltr" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>))}
      </div>
      <button className="btn btn-gold mt-3" onClick={() => call(() => apiClient.post('/textile/tools/spindle-output', { rpm: Number(f.rpm), tpi: Number(f.tpi), ne: Number(f.ne), efficiencyPercent: Number(f.eff) }))}>احسب</button>
      <KV o={out} labels={{ kgPerSpindleHour: 'كجم / مغزل / ساعة' }} />
    </Card>
  );
}

function FabricTool() {
  const [f, setF] = useState({ epi: '60', ppi: '56', widthCm: '150', warpCountNe: '30', weftCountNe: '30', warpCrimpPercent: '8', weftCrimpPercent: '5', sizePickupPercent: '10' }); const { out, call } = useCalc();
  const labels: Record<string, string> = { epi: 'خيوط سداء/بوصة EPI', ppi: 'لحمات/بوصة PPI', widthCm: 'العرض (سم)', warpCountNe: 'رقم السداء Ne', weftCountNe: 'رقم اللحمة Ne', warpCrimpPercent: 'تشرّب سداء %', weftCrimpPercent: 'تشرّب لحمة %', sizePickupPercent: 'نشا %' };
  return (
    <Card title="تقدير وزن القماش المنسوج">
      <div className="grid grid-cols-2 gap-2">{Object.entries(labels).map(([k, l]) => (<Field key={k} label={l}><input className={inputCls} dir="ltr" value={f[k as keyof typeof f]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>))}</div>
      <button className="btn btn-gold mt-3" onClick={() => call(() => apiClient.post('/textile/tools/fabric-estimate', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)]))))}>احسب</button>
      <KV o={out} labels={{ totalEnds: 'إجمالي خيوط السدى', warpGramsPerMeter: 'غرام سدى / متر', weftGramsPerMeter: 'غرام لحمة / متر', greyGramsPerMeter: 'غرام خام / متر', greyGsm: 'GSM خام', sizedGsm: 'GSM بعد النشا', warpSharePercent: 'نسبة السدى %' }} />
    </Card>
  );
}

function CapacityTool() {
  const { data: machines } = useGet('/textile/machines');
  const [machineId, setMachineId] = useState(''); const [q, setQ] = useState('1000'); const { out, call } = useCalc();
  return (
    <Card title="سعة الماكينة (كم ساعة لإنتاج كمية)">
      <div className="grid grid-cols-2 gap-2">
        <Field label="الماكينة"><select className={inputCls} value={machineId} onChange={(e) => setMachineId(e.target.value)}><option value="">—</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code} — {m.name_ar}</option>)}</select></Field>
        <Field label="الكمية"><input className={inputCls} dir="ltr" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      </div>
      <button className="btn btn-gold mt-3" disabled={!machineId} onClick={() => call(() => apiClient.get('/textile/tools/capacity', { params: { machineId, quantity: q } }))}>احسب</button>
      <KV o={out} labels={{ ratedOutputPerHour: 'الطاقة/ساعة', hoursAt100: 'ساعات بكفاءة 100%', hoursAt85: 'ساعات بكفاءة 85%', shiftsAt85_8h: 'ورديات (8س) بكفاءة 85%' }} />
    </Card>
  );
}
