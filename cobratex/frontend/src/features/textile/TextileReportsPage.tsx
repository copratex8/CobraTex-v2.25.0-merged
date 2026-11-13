import { useState } from 'react';
import { Card, DataTable, DateRange, Field, PageHeader, TextileNav, inputCls, num, useGet, type Row } from '@/features/textile/shared';

/** تقارير الغزل والنسيج: تحليل الهوالك حسب المرحلة والنوع، وتتبّع اللوط (من أين جاء وإلى أين ذهب). */
export default function TextileReportsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lotInput, setLotInput] = useState('');
  const [lot, setLot] = useState('');
  const { data: w } = useGet<{ byStage: Row[]; byType: Row[] }>('/textile/reports/waste', { from, to });
  const { data: t } = useGet<Row>('/textile/reports/lot-trace', { lot }, !!lot);
  const { data: ws } = useGet<{ items: Row[]; note: string }>('/textile/reports/waste-stock', { from, to });

  return (
    <div>
      <PageHeader title="تقارير الغزل والنسيج" />
      <TextileNav />
      <Card title="تحليل الهوالك" badge="أوامر منفَّذة فقط">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <p className="mb-2 text-sm font-bold">حسب المرحلة</p>
        <DataTable rows={w?.byStage} empty="لا توجد أوامر منفَّذة بهالك مسجَّل في الفترة." cols={[
          { h: 'المرحلة', r: (r) => r.name_ar ?? 'بلا مرحلة' }, { h: 'أوامر', k: 'orders' }, { h: 'خامة رئيسية', r: (r) => num(r.main_consumed, 1) }, { h: 'هالك', r: (r) => num(r.waste_qty, 1) },
          { h: 'قياسي %', r: (r) => num(r.standard_waste_percent, 2) },
          { h: 'فعلي %', r: (r) => <b className={Number(r.actual_waste_percent) > Number(r.standard_waste_percent) ? 'text-red-700' : 'text-emerald-700'}>{num(r.actual_waste_percent, 2)}</b> },
          { h: 'مسترد', r: (r) => num(r.recovered_value) }, { h: 'خسارة غير عادية', r: (r) => num(r.abnormal_loss) },
        ]} />
        <p className="mb-2 mt-4 text-sm font-bold">حسب نوع الهالك</p>
        <DataTable rows={w?.byType} cols={[{ h: 'النوع', k: 'name_ar' }, { h: 'بنود', k: 'entries' }, { h: 'الكمية', r: (r) => num(r.qty, 1) }, { h: 'غير عادي', r: (r) => num(r.abnormal_qty, 1) }, { h: 'مسترد', r: (r) => num(r.recovered_value) }, { h: 'خسارة', r: (r) => num(r.abnormal_loss) }]} />
      </Card>

      <Card title="رصيد وبيع الهوالك" badge="القابلة للاسترداد">
        <DataTable rows={ws?.items} empty="لا هوالك قابلة للاسترداد في الفترة." cols={[
          { h: 'صنف الهالك', k: 'item_name' }, { h: 'المُنتَج', r: (r) => num(r.produced_qty, 1) }, { h: 'قيمة الاسترداد', r: (r) => num(r.produced_value) }, { h: 'المباع', r: (r) => num(r.sold_qty, 1) },
          { h: 'إيراد البيع', r: (r) => num(r.sold_revenue) }, { h: 'متوسط سعر البيع', r: (r) => num(r.avg_sale_price, 3) }, { h: 'المتوقع', r: (r) => num(r.expected_qty, 1) },
          { h: 'الرصيد الفعلي', r: (r) => <b className={Math.abs(Number(r.on_hand_qty) - Number(r.expected_qty)) > 0.0001 ? 'text-amber-700' : 'text-emerald-700'}>{num(r.on_hand_qty, 1)}</b> },
        ]} />
        {ws && <p className="mt-2 text-xs text-slate-500">{ws.note}</p>}
      </Card>

      <Card title="تتبّع لوط">
        <form className="mb-3 flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); setLot(lotInput.trim()); }}>
          <Field label="رقم اللوط"><input className={inputCls} dir="ltr" value={lotInput} onChange={(e) => setLotInput(e.target.value)} placeholder="YL-100 أو BALE-7" /></Field>
          <button className="btn btn-gold">بحث</button>
        </form>
        {t && (
          <>
            <p className="mb-1 text-sm font-bold">أُنتِج في (لوط منتَج)</p>
            <DataTable rows={t.produced} empty="لم يُنتَج لوط بهذا الرقم." cols={[{ h: 'الأمر', k: 'document_number' }, { h: 'التاريخ', r: (r) => String(r.order_date).slice(0, 10) }, { h: 'الصنف', k: 'item_name_ar' }, { h: 'الدرجة', k: 'grade' }, { h: 'الكمية', r: (r) => num(r.quantity, 2) }, { h: 'الحالة', k: 'status' }]} />
            {t.inputsOfProduced.length > 0 && (<><p className="mb-1 mt-3 text-sm font-bold">الخامات التي دخلت في إنتاجه</p>
              <DataTable rows={t.inputsOfProduced} cols={[{ h: 'الأمر', k: 'document_number' }, { h: 'الخامة', k: 'item_name_ar' }, { h: 'لوطات الخامة', r: (r) => r.input_lot_numbers ?? '—' }, { h: 'الكمية', r: (r) => num(r.quantity, 2) }]} /></>)}
            <p className="mb-1 mt-3 text-sm font-bold">استُهلك في (لوط خامة)</p>
            <DataTable rows={t.consumed} empty="لم يُستهلك كخامة." cols={[{ h: 'الأمر', k: 'document_number' }, { h: 'التاريخ', r: (r) => String(r.order_date).slice(0, 10) }, { h: 'الخامة', k: 'item_name_ar' }, { h: 'الكمية', r: (r) => num(r.quantity, 2) }, { h: 'الحالة', k: 'status' }]} />
            <p className="mb-1 mt-3 text-sm font-bold">نتائج الجودة</p>
            <DataTable rows={t.quality} empty="لا توجد نتائج جودة." cols={[{ h: 'الاختبار', k: 'test_name_ar' }, { h: 'القيمة', r: (r) => num(r.value, 3) }, { h: 'النتيجة', r: (r) => <b className={r.passed ? 'text-emerald-700' : 'text-red-700'}>{r.passed ? 'مقبول' : 'مرفوض'}</b> }]} />
          </>
        )}
      </Card>
    </div>
  );
}
