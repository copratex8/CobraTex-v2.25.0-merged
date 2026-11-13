/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { Card, Field, PageHeader, TextileNav, inputCls, useAction, useGet } from '@/features/textile/shared';

const NUM = ['yarnCount', 'twistTpi', 'fabricGsm', 'fabricWidthCm', 'epi', 'ppi', 'warpCountNe', 'weftCountNe', 'shrinkagePercent', 'knitGauge', 'machineDiameterIn', 'stitchLengthMm'] as const;
const INT = ['ply', 'needlesCount', 'feedersCount'] as const;
const L: Record<string, string> = { yarnCount: 'نمرة الغزل', twistTpi: 'البرم TPI', fabricGsm: 'جم/م²', fabricWidthCm: 'العرض سم', epi: 'EPI', ppi: 'PPI', warpCountNe: 'نمرة السدى Ne', weftCountNe: 'نمرة اللحمة Ne', shrinkagePercent: 'الانكماش %', knitGauge: 'الجيج (Gauge)', machineDiameterIn: 'قطر الماكينة (بوصة)', stitchLengthMm: 'طول الغرزة (مم)', ply: 'عدد الفتلات', needlesCount: 'عدد الإبر', feedersCount: 'عدد المغذّيات' };
const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

/** مواصفات الغزل/القماش لكل صنف، بما فيها مواصفات الترايكو. */
export default function ItemSpecsPage() {
  const [itemId, setItemId] = useState('');
  const { data: items } = useQuery({ queryKey: ['items-100'], queryFn: async () => (await apiClient.get('/items', { params: { page: 1, pageSize: 100 } })).data });
  const { data: spec } = useGet<any>(`/textile/items/${itemId}/specs`, {}, !!itemId);
  const { busy, put } = useAction();
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    const o: Record<string, string> = {};
    for (const k of [...NUM, ...INT, 'countSystem', 'spinningType', 'weaveType', 'knitStructure', 'fiberComposition', 'notes']) { const v = spec?.[snake(k)]; o[k] = v === null || v === undefined ? '' : String(v); }
    setF(o);
  }, [spec, itemId]);
  const list: any[] = Array.isArray(items) ? items : items?.data ?? [];
  const sel = (k: string, opts: string[]) => <select className={inputCls} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">—</option>{opts.map((o) => <option key={o}>{o}</option>)}</select>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const k of NUM) if (f[k]) body[k] = Number(f[k]);
    for (const k of INT) if (f[k]) body[k] = Number(f[k]);
    for (const k of ['countSystem', 'spinningType', 'weaveType', 'knitStructure', 'fiberComposition', 'notes']) if (f[k]) body[k] = f[k];
    await put(`/textile/items/${itemId}/specs`, body, 'حُفظت المواصفات');
  };

  return (
    <div>
      <PageHeader title="مواصفات الأصناف" sub="غزل / قماش منسوج / ترايكو" />
      <TextileNav />
      <Card>
        <Field label="الصنف"><select className={inputCls} value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">—</option>{list.map((i) => <option key={i.id} value={i.id}>{i.name_ar ?? i.name}</option>)}</select></Field>
      </Card>
      {itemId && (
        <form onSubmit={save}>
          <Card title="الغزل والنسيج">
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="نظام النمرة">{sel('countSystem', ['Ne', 'Nm', 'Tex', 'Denier'])}</Field>
              <Field label="نوع الغزل">{sel('spinningType', ['ring', 'compact', 'open_end', 'air_jet', 'vortex', 'other'])}</Field>
              <Field label="نوع النسيج">{sel('weaveType', ['plain', 'twill', 'satin', 'dobby', 'jacquard', 'knit_single', 'knit_double', 'nonwoven', 'other'])}</Field>
              <Field label="التركيب الليفي"><input className={inputCls} value={f.fiberComposition ?? ''} onChange={(e) => setF({ ...f, fiberComposition: e.target.value })} /></Field>
              {(['yarnCount', 'ply', 'twistTpi', 'fabricGsm', 'fabricWidthCm', 'epi', 'ppi', 'warpCountNe', 'weftCountNe', 'shrinkagePercent'] as const).map((k) => (
                <Field key={k} label={L[k]}><input inputMode="decimal" className={inputCls} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>))}
            </div>
          </Card>
          <Card title="الترايكو (Knitting)">
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="التركيب">{sel('knitStructure', ['single_jersey', 'rib', 'interlock', 'fleece', 'pique', 'jacquard', 'other'])}</Field>
              {(['knitGauge', 'machineDiameterIn', 'stitchLengthMm', 'needlesCount', 'feedersCount'] as const).map((k) => (
                <Field key={k} label={L[k]}><input inputMode="decimal" className={inputCls} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>))}
            </div>
          </Card>
          <button className="btn btn-gold" disabled={busy}>حفظ المواصفات</button>
        </form>
      )}
    </div>
  );
}
