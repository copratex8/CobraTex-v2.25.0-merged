/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useGet } from '@/features/textile/shared';

const tone: Record<string, string> = { critical: 'bg-red-100 text-red-800', warning: 'bg-amber-100 text-amber-800', ok: 'bg-green-100 text-green-800' };
const label: Record<string, string> = { critical: 'حرج', warning: 'تحذير', ok: 'سليم' };

/** الأوامر الحرجة: ترتيب الأوامر المفتوحة بخطر التأخّر عن وعد العميل، مع الأسباب والإجراء المقترح وأقرب فترة خالية على الماكينة. */
export default function CriticalPage() {
  const [asOf, setAsOf] = useState(today()); const [level, setLevel] = useState('');
  const { data: r } = useGet<any>('/textile/reports/critical-orders', { asOf, level });
  return (
    <div>
      <PageHeader title="الأوامر الحرجة" sub="مرتَّبة بالخطر: تأخّر الوعد، الفسحة بين الوعد والانتهاء المجدول، عجز الخيوط، تعارض الماكينة، تأخّر البدء، وغياب الجدولة." />
      <TextileNav />
      <Card>
        <div className="mb-3 grid gap-3 md:grid-cols-5">
          <Field label="كما في"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
          <Field label="المستوى"><select className={inputCls} value={level} onChange={(e) => setLevel(e.target.value)}><option value="">الكل</option><option value="critical">حرج</option><option value="warning">تحذير</option><option value="ok">سليم</option></select></Field>
          <Kpi label="حرجة" value={r ? String(r.summary.critical) : '—'} /><Kpi label="تحذير" value={r ? String(r.summary.warning) : '—'} /><Kpi label="سليمة" value={r ? String(r.summary.ok) : '—'} />
        </div>
        {r?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
        <DataTable rows={r?.orders} empty="لا أوامر مفتوحة." cols={[
          { h: 'الحالة', r: (o) => <span className={`rounded px-2 py-0.5 text-xs ${tone[o.level]}`}>{label[o.level]} ({o.score})</span> },
          { h: 'الأمر', r: (o) => <b>{o.orderNo}</b> }, { h: 'الصنف', k: 'itemName' }, { h: 'العميل', r: (o) => o.customerName ?? '—' }, { h: 'الكمية', r: (o) => num(o.quantity, 1) }, { h: 'الماكينة', r: (o) => o.machineCode ?? '—' },
          { h: 'الوعد', r: (o) => o.dueDate ?? '—' }, { h: 'الجدولة', r: (o) => (o.plannedStart ? `${o.plannedStart} → ${o.plannedEnd}` : '—') },
          { h: 'الفسحة (يوم)', r: (o) => (o.slackDays === null ? '—' : <b className={o.slackDays < 0 ? 'text-red-700' : ''}>{o.slackDays}</b>) },
          { h: 'الأسباب', r: (o) => <ul className="list-disc pr-4 text-xs">{o.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul> },
          { h: 'الإجراء المقترح', r: (o) => <div className="text-xs">{o.actions.join(' • ')}{o.suggestedSlot && <div className="text-blue-700">فترة خالية: {o.suggestedSlot.start} → {o.suggestedSlot.end}</div>}</div> },
        ]} />
      </Card>
    </div>
  );
}
