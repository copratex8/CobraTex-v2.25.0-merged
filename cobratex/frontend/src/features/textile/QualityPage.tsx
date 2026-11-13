import { useState, type FormEvent } from 'react';
import { Card, DataTable, Field, PageHeader, TextileNav, inputCls, num, useAction, useGet, type Row } from '@/features/textile/shared';

/** نتائج الاختبارات المعملية (غزل/قماش/ألياف) مقابل حدود القبول؛ تُربط برقم لوط أو أمر تصنيع. */
export default function QualityPage() {
  const [lot, setLot] = useState('');
  const { data: types } = useGet('/textile/quality/types');
  const { data: results } = useGet('/textile/quality/results', { lot });
  const { busy, post } = useAction();
  const [f, setF] = useState({ testTypeId: '', value: '', lotNumber: '', notes: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await post<Row>('/textile/quality/results', { testTypeId: f.testTypeId, value: f.value, ...(f.lotNumber ? { lotNumber: f.lotNumber } : {}), ...(f.notes ? { notes: f.notes } : {}) },
      'تم تسجيل النتيجة');
    if (r) setF({ ...f, value: '', notes: '' });
  };
  return (
    <div>
      <PageHeader title="الجودة المعملية" sub="النتيجة تُحسب مقابل حدود النوع وقت الإدخال وتُحفظ" />
      <TextileNav />
      <Card title="نتيجة اختبار جديدة">
        <form onSubmit={submit} className="grid gap-3 md:grid-cols-5">
          <Field label="الاختبار"><select required className={inputCls} value={f.testTypeId} onChange={(e) => setF({ ...f, testTypeId: e.target.value })}><option value="">—</option>{types?.filter((t: Row) => t.is_active).map((t: Row) => <option key={t.id} value={t.id}>{t.name_ar}{t.unit ? ` (${t.unit})` : ''}</option>)}</select></Field>
          <Field label="القيمة"><input required className={inputCls} dir="ltr" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          <Field label="رقم اللوط"><input required className={inputCls} dir="ltr" value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value })} /></Field>
          <Field label="ملاحظات"><input className={inputCls} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn btn-gold" disabled={busy}>حفظ</button></div>
        </form>
      </Card>
      <Card title="النتائج">
        <div className="mb-3 max-w-xs"><Field label="تصفية برقم لوط"><input className={inputCls} dir="ltr" value={lot} onChange={(e) => setLot(e.target.value)} /></Field></div>
        <DataTable rows={results} cols={[
          { h: 'التاريخ', r: (r) => String(r.tested_at).slice(0, 10) }, { h: 'الاختبار', k: 'test_name_ar' }, { h: 'اللوط', r: (r) => r.lot_number ?? '—' },
          { h: 'القيمة', r: (r) => `${num(r.value, 3)} ${r.unit ?? ''}` }, { h: 'الحدود', r: (r) => `${r.min_applied ?? '—'} ↔ ${r.max_applied ?? '—'}` },
          { h: 'النتيجة', r: (r) => <b className={r.passed ? 'text-emerald-700' : 'text-red-700'}>{r.passed ? 'مقبول' : 'مرفوض'}</b> },
        ]} />
      </Card>
    </div>
  );
}
