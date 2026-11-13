import { useState, type FormEvent } from 'react';
import { useBranches, useItems } from '@/features/catalog/api';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

const BEAM_STATUS: Record<string, string> = { prepared: 'مجهَّز', on_loom: 'على النول', finished: 'منتهٍ', scrapped: 'مشطوب' };
const UNIT_TYPES: Record<string, string> = { bale: 'بالة', pallet: 'باليت', carton: 'كرتونة', bag: 'شوال', roll_pack: 'رولات' };

/** بيمات السدى (تسدية/نشا → تركيب على النول → متابعة الأمتار) + وحدات التعبئة والشحن. */
export default function WeavingPage() {
  const { data: beams } = useGet('/textile/beams');
  const { data: machines } = useGet('/textile/machines');
  const { data: packing } = useGet<{ units: Row[]; summary: Row[] }>('/textile/packing');
  const { data: branches } = useBranches();
  const { data: items } = useItems();
  const { busy, post } = useAction();

  const [b, setB] = useState({ beamNo: '', lotNumber: '', yarnCountNe: '', totalEnds: '', lengthM: '', weightKg: '', sizingPickupPercent: '' });
  const addBeam = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      branchId: branches?.[0]?.id, beamNo: b.beamNo, totalEnds: Number(b.totalEnds), lengthM: b.lengthM,
      ...(b.lotNumber ? { lotNumber: b.lotNumber } : {}), ...(b.yarnCountNe ? { yarnCountNe: Number(b.yarnCountNe) } : {}),
      ...(b.weightKg ? { weightKg: b.weightKg } : {}), ...(b.sizingPickupPercent ? { sizingPickupPercent: b.sizingPickupPercent } : {}),
    };
    if (await post('/textile/beams', body, 'تم تسجيل البيم')) setB({ beamNo: '', lotNumber: '', yarnCountNe: '', totalEnds: '', lengthM: '', weightKg: '', sizingPickupPercent: '' });
  };
  const [mount, setMount] = useState<Record<string, string>>({});
  const [prog, setProg] = useState<Record<string, string>>({});

  const [p, setP] = useState({ packingNo: '', unitType: 'bale', itemId: '', lotNumber: '', packagesCount: '', grossKg: '', tareKg: '' });
  const addPack = async (e: FormEvent) => {
    e.preventDefault();
    const unit = {
      packingNo: p.packingNo, unitType: p.unitType, itemId: p.itemId, grossKg: p.grossKg,
      ...(p.lotNumber ? { lotNumber: p.lotNumber } : {}), ...(p.packagesCount ? { packagesCount: Number(p.packagesCount) } : {}), ...(p.tareKg ? { tareKg: p.tareKg } : {}),
    };
    if (await post('/textile/packing', { branchId: branches?.[0]?.id, units: [unit] }, 'تمت إضافة وحدة التعبئة')) setP({ ...p, packingNo: '', grossKg: '', packagesCount: '' });
  };
  const [sel, setSel] = useState<string[]>([]);

  return (
    <div>
      <PageHeader title="السدى والتعبئة" sub="متابعة البيمات على الأنوال، وبالات وباليتات المنتج النهائي" />
      <TextileNav />
      <Card title="بيمات السدى">
        <DataTable rows={beams} cols={[
          { h: 'البيم', k: 'beam_no' }, { h: 'اللوط', r: (r) => r.lot_number ?? '—' }, { h: 'Ne', r: (r) => num(r.yarn_count_ne, 1) }, { h: 'الخيوط', k: 'total_ends' },
          { h: 'الطول م', r: (r) => num(r.length_m, 1) }, { h: 'المنسوج م', r: (r) => num(r.meters_woven, 1) }, { h: 'المتبقي م', r: (r) => num(r.remaining_m, 1) },
          { h: 'النول', r: (r) => r.machine_code ?? '—' }, { h: 'الحالة', r: (r) => BEAM_STATUS[r.status] ?? r.status },
          {
            h: 'إجراء', r: (r) => (
              <span className="flex flex-wrap items-center gap-1">
                {r.status === 'prepared' && (<>
                  <select className={inputCls + ' !w-32'} value={mount[r.id] ?? ''} onChange={(e) => setMount({ ...mount, [r.id]: e.target.value })}><option value="">اختر النول</option>{machines?.map((m: Row) => <option key={m.id} value={m.id}>{m.code}</option>)}</select>
                  <button className="btn btn-sm btn-info" disabled={busy || !mount[r.id]} onClick={() => post(`/textile/beams/${r.id}/mount`, { machineId: mount[r.id] }, 'تم التركيب')}>تركيب</button>
                </>)}
                {r.status === 'on_loom' && (<>
                  <input className={inputCls + ' !w-20'} dir="ltr" placeholder="أمتار" value={prog[r.id] ?? ''} onChange={(e) => setProg({ ...prog, [r.id]: e.target.value })} />
                  <button className="btn btn-sm btn-gold" disabled={busy || !prog[r.id]} onClick={async () => { if (await post(`/textile/beams/${r.id}/progress`, { meters: prog[r.id] }, 'تم تسجيل الأمتار')) setProg({ ...prog, [r.id]: '' }); }}>+ أمتار</button>
                </>)}
                {(r.status === 'prepared' || r.status === 'on_loom') && (
                  <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => { const reason = window.prompt('سبب الشطب:'); if (reason) void post(`/textile/beams/${r.id}/scrap`, { reason }, 'تم الشطب'); }}>شطب</button>
                )}
              </span>
            ),
          },
        ]} />
        <form onSubmit={addBeam} className="mt-4 grid gap-3 md:grid-cols-8">
          <Field label="رقم البيم"><input required className={inputCls} dir="ltr" value={b.beamNo} onChange={(e) => setB({ ...b, beamNo: e.target.value })} /></Field>
          <Field label="لوط الغزل"><input className={inputCls} dir="ltr" value={b.lotNumber} onChange={(e) => setB({ ...b, lotNumber: e.target.value })} /></Field>
          <Field label="نمرة Ne"><input className={inputCls} dir="ltr" value={b.yarnCountNe} onChange={(e) => setB({ ...b, yarnCountNe: e.target.value })} /></Field>
          <Field label="عدد الخيوط"><input required className={inputCls} dir="ltr" value={b.totalEnds} onChange={(e) => setB({ ...b, totalEnds: e.target.value })} /></Field>
          <Field label="الطول (م)"><input required className={inputCls} dir="ltr" value={b.lengthM} onChange={(e) => setB({ ...b, lengthM: e.target.value })} /></Field>
          <Field label="الوزن كجم"><input className={inputCls} dir="ltr" value={b.weightKg} onChange={(e) => setB({ ...b, weightKg: e.target.value })} /></Field>
          <Field label="نسبة النشا %"><input className={inputCls} dir="ltr" value={b.sizingPickupPercent} onChange={(e) => setB({ ...b, sizingPickupPercent: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة بيم</button></div>
        </form>
      </Card>

      <Card title="وحدات التعبئة" badge="بالات / باليتات / كراتين">
        <DataTable rows={packing?.units} cols={[
          { h: '', r: (r) => r.status === 'in_stock' ? <input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /> : null },
          { h: 'الرقم', k: 'packing_no' }, { h: 'النوع', r: (r) => UNIT_TYPES[r.unit_type] ?? r.unit_type }, { h: 'الصنف', r: (r) => `${r.item_code} — ${r.item_name_ar}` },
          { h: 'اللوط', r: (r) => r.lot_number ?? '—' }, { h: 'عبوات', r: (r) => r.packages_count ?? '—' }, { h: 'قائم كجم', r: (r) => num(r.gross_kg, 2) },
          { h: 'صافي كجم', r: (r) => num(r.net_kg, 2) }, { h: 'الحالة', r: (r) => (r.status === 'shipped' ? 'مشحونة' : 'بالمخزن') },
        ]} />
        <div className="mt-3 flex items-center gap-2">
          <button className="btn btn-sm btn-primary" disabled={busy || sel.length === 0} onClick={async () => { if (await post('/textile/packing/ship', { ids: sel }, 'تم تسجيل الشحن')) setSel([]); }}>شحن المحدد ({sel.length})</button>
        </div>
        {packing && packing.summary.length > 0 && (
          <div className="mt-4"><p className="mb-2 text-xs font-bold text-slate-500">ملخص اللوطات بالمخزن</p>
            <DataTable rows={packing.summary} cols={[{ h: 'اللوط', r: (r) => r.lot_number ?? '—' }, { h: 'الصنف', k: 'item_code' }, { h: 'وحدات', k: 'units' }, { h: 'عبوات', k: 'packages' }, { h: 'صافي كجم', r: (r) => num(r.net_kg, 2) }]} />
          </div>
        )}
        <form onSubmit={addPack} className="mt-4 grid gap-3 md:grid-cols-8">
          <Field label="رقم الوحدة"><input required className={inputCls} dir="ltr" value={p.packingNo} onChange={(e) => setP({ ...p, packingNo: e.target.value })} /></Field>
          <Field label="النوع"><select className={inputCls} value={p.unitType} onChange={(e) => setP({ ...p, unitType: e.target.value })}>{Object.entries(UNIT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="الصنف"><select required className={inputCls} value={p.itemId} onChange={(e) => setP({ ...p, itemId: e.target.value })}><option value="">—</option>{items?.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name_ar}</option>)}</select></Field>
          <Field label="اللوط"><input className={inputCls} dir="ltr" value={p.lotNumber} onChange={(e) => setP({ ...p, lotNumber: e.target.value })} /></Field>
          <Field label="عدد العبوات (كونات…)"><input className={inputCls} dir="ltr" value={p.packagesCount} onChange={(e) => setP({ ...p, packagesCount: e.target.value })} /></Field>
          <Field label="قائم كجم"><input required className={inputCls} dir="ltr" value={p.grossKg} onChange={(e) => setP({ ...p, grossKg: e.target.value })} /></Field>
          <Field label="تارة كجم"><input className={inputCls} dir="ltr" value={p.tareKg} onChange={(e) => setP({ ...p, tareKg: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>إضافة</button></div>
        </form>
      </Card>
    </div>
  );
}
