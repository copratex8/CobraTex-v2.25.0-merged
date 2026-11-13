/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, PageHeader, TextileNav, inputCls, num, today, useAction, useGet } from '@/features/textile/shared';

/** العملات وأسعار الصرف: سعر يومي (متوسط/شراء/بيع) يُجلب تلقائيًا للمستندات الأجنبية، محوّل عملات، وتقييم الأرصدة الأجنبية. */
export default function CurrenciesPage() {
  const [cc, setCc] = useState('USD'); const [date, setDate] = useState(today()); const [type, setType] = useState('mid'); const [rate, setRate] = useState('');
  const [nc, setNc] = useState({ code: '', name: '', nameAr: '', symbol: '', decimals: '2' });
  const [cv, setCv] = useState({ amount: '100', from: 'USD', to: 'EGP' }); const [asOf, setAsOf] = useState(today());
  const { data: cur } = useGet<any[]>('/fx/currencies');
  const { data: rates } = useGet<any[]>('/fx/rates', { currency: cc });
  const { data: conv } = useGet<any>('/fx/convert', { amount: cv.amount, from: cv.from, to: cv.to, date });
  const { data: rev } = useGet<any>('/fx/revaluation', { asOf });
  const { data: revs } = useGet<any[]>('/fx/revaluations'); const { data: acc } = useGet<any>('/fx/accounts'); const [rdate, setRdate] = useState('');
  const a = useAction();
  const base = cur?.find((c) => c.isBase)?.code ?? 'EGP';
  return (
    <div>
      <PageHeader title="العملات وأسعار الصرف" sub={`عملة الأساس: ${base}. السعر = وحدات ${base} لكل 1 وحدة أجنبية. المستند الأجنبي بلا سعر يجلب سعر (بيع للمبيعات والمقبوضات، شراء للمشتريات والمدفوعات) بتاريخه؛ وإن لم يوجد سعر يُرفض بدل افتراض 1.`} />
      <TextileNav />
      <Card title="تسجيل سعر">
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="العملة"><select className={inputCls} value={cc} onChange={(e) => setCc(e.target.value)}>{cur?.filter((c) => !c.isBase && c.is_active).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name_ar ?? c.name}</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="النوع"><select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}><option value="mid">متوسط</option><option value="buy">شراء</option><option value="sell">بيع</option></select></Field>
          <Field label="السعر"><input className={inputCls} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <div className="flex items-end"><button className="btn-primary" disabled={a.busy || !(Number(rate) > 0)} onClick={async () => { const r: any = await a.post('/fx/rates', { currencyCode: cc, rateDate: date, rateType: type, rate: Number(rate) }, 'تم حفظ السعر'); if (r) { if (r.warning) alert(r.warning); setRate(''); } }}>حفظ</button></div>
        </div>
      </Card>
      <Card title={`سجل أسعار ${cc}`}>
        <DataTable rows={rates} empty="لا أسعار." cols={[{ h: 'التاريخ', r: (r) => String(r.rate_date).slice(0, 10) }, { h: 'النوع', r: (r) => ({ mid: 'متوسط', buy: 'شراء', sell: 'بيع' } as any)[r.rate_type] }, { h: 'السعر', r: (r) => num(r.rate, 4) }, { h: 'المصدر', k: 'source' }]} />
      </Card>
      <Card title="محوّل العملات (عبر عملة الأساس)">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="المبلغ"><input className={inputCls} value={cv.amount} onChange={(e) => setCv({ ...cv, amount: e.target.value })} /></Field>
          <Field label="من"><select className={inputCls} value={cv.from} onChange={(e) => setCv({ ...cv, from: e.target.value })}>{cur?.map((c) => <option key={c.code}>{c.code}</option>)}</select></Field>
          <Field label="إلى"><select className={inputCls} value={cv.to} onChange={(e) => setCv({ ...cv, to: e.target.value })}>{cur?.map((c) => <option key={c.code}>{c.code}</option>)}</select></Field>
          <Kpi label="الناتج" value={conv ? `${num(conv.result, 2)} ${cv.to}` : '—'} />
        </div>
        {conv?.stale && <p className="text-sm text-amber-700">⚠️ أحد الأسعار قديم (آخر تحديث {conv.ratesDate}).</p>}
      </Card>
      <Card title="تقييم الأرصدة الأجنبية المفتوحة (تحليلي — لا يُرحَّل قيدًا)">
        <div className="mb-3 grid gap-3 md:grid-cols-4"><Field label="حتى تاريخ"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field><Kpi label="صافي فرق التقييم غير المحقَّق" value={rev ? num(rev.netUnrealized, 2) : '—'} /></div>
        {rev?.warnings.map((w: string, i: number) => <p key={i} className="text-sm text-amber-700">⚠️ {w}</p>)}
        <DataTable rows={rev?.documents} empty="لا أرصدة أجنبية مفتوحة." cols={[{ h: 'النوع', r: (r) => (r.kind === 'receivable' ? 'مدين' : 'دائن') }, { h: 'المستند', k: 'documentNumber' }, { h: 'الطرف', k: 'party' }, { h: 'العملة', k: 'currency' }, { h: 'المتبقي', r: (r) => num(r.outstanding, 2) }, { h: 'سعر المستند', r: (r) => num(r.bookRate, 4) }, { h: 'سعر التقييم', r: (r) => num(r.revalRate, 4) }, { h: 'الفرق', r: (r) => <b className={r.unrealizedGainLoss < 0 ? 'text-red-700' : 'text-green-700'}>{num(r.unrealizedGainLoss, 2)}</b> }]} />
      </Card>
      <Card title="ترحيل قيد التقييم (مدين/دائن بحساب فروق التقييم غير المحقَّقة)">
        <p className="mb-2 text-sm text-gray-600">{acc?.fx_unrealized_account_id ? 'حساب فروق التقييم محدَّد.' : '⚠️ حدّد حساب فروق التقييم أولًا (PUT /fx/accounts).'} يُرحَّل بتاريخ «حتى تاريخ» أعلاه، ويُعكس بقيد معاكس بتاريخ لاحق حتى لا يتكرر فرق السداد المحقَّق. تقييم فعّال واحد فقط في آن واحد.</p>
        <div className="grid gap-3 md:grid-cols-4"><Field label="تاريخ العكس (اختياري)"><input type="date" className={inputCls} value={rdate} onChange={(e) => setRdate(e.target.value)} /></Field>
          <div className="flex items-end"><button className="btn-primary" disabled={a.busy} onClick={() => { if (window.confirm(`ترحيل قيد تقييم حتى ${asOf}؟`)) a.post('/fx/revaluations', { asOf, ...(rdate ? { reversalDate: rdate } : {}) }, 'رُحِّل قيد التقييم'); }}>ترحيل التقييم</button></div></div>
        <DataTable rows={revs} empty="لا تقييمات مرحَّلة." cols={[{ h: 'حتى', r: (r) => String(r.as_of).slice(0, 10) }, { h: 'الصافي', r: (r) => num(r.net_amount, 2) }, { h: 'الحالة', r: (r) => (r.status === 'posted' ? 'فعّال' : 'معكوس') }, { h: 'العكس', r: (r) => (r.reversal_date ? String(r.reversal_date).slice(0, 10) : '—') },
          { h: '', r: (r) => (r.status === 'posted' ? <button className="text-sm underline" onClick={() => { const d = window.prompt('تاريخ العكس (YYYY-MM-DD، بعد تاريخ التقييم)'); if (d) a.post(`/fx/revaluations/${r.id}/reverse`, { reversalDate: d }, 'عُكس التقييم'); }}>عكس</button> : null) }]} />
      </Card>
      <Card title="إدارة العملات">
        <DataTable rows={cur} empty="—" cols={[{ h: 'الرمز', k: 'code' }, { h: 'الاسم', r: (r) => r.name_ar ?? r.name }, { h: 'الرمز المختصر', k: 'symbol' }, { h: 'خانات', k: 'decimals' }, { h: 'الحالة', r: (r) => (r.isBase ? 'عملة الأساس' : r.is_active ? 'نشطة' : 'معطَّلة') }, { h: '', r: (r) => (r.isBase ? null : <button className="text-sm underline" onClick={() => a.post('/fx/currencies', { code: r.code, name: r.name, isActive: !r.is_active })}>{r.is_active ? 'تعطيل' : 'تفعيل'}</button>) }]} />
        <div className="mt-3 grid gap-3 md:grid-cols-6">
          <Field label="الرمز (3 أحرف)"><input className={inputCls} value={nc.code} maxLength={3} onChange={(e) => setNc({ ...nc, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="الاسم"><input className={inputCls} value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></Field>
          <Field label="الاسم بالعربية"><input className={inputCls} value={nc.nameAr} onChange={(e) => setNc({ ...nc, nameAr: e.target.value })} /></Field>
          <Field label="الرمز المختصر"><input className={inputCls} value={nc.symbol} onChange={(e) => setNc({ ...nc, symbol: e.target.value })} /></Field>
          <Field label="خانات عشرية"><input className={inputCls} value={nc.decimals} onChange={(e) => setNc({ ...nc, decimals: e.target.value })} /></Field>
          <div className="flex items-end"><button className="btn-primary" disabled={a.busy || nc.code.length !== 3 || nc.name.length < 2} onClick={async () => { const r = await a.post('/fx/currencies', { code: nc.code, name: nc.name, nameAr: nc.nameAr || undefined, symbol: nc.symbol || undefined, decimals: Number(nc.decimals) }, 'تمت الإضافة'); if (r) setNc({ code: '', name: '', nameAr: '', symbol: '', decimals: '2' }); }}>إضافة عملة</button></div>
        </div>
      </Card>
    </div>
  );
}
