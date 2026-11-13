/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { Card, DataTable, Field, Kpi, inputCls, num, today, useAction, useGet } from '@/features/textile/shared';

/** ضريبة الخصم والإضافة (٢.١٧.٠): إعدادات + تطبيق على فاتورة + كشف الفترة + سداد للمصلحة. */
const rows = (x: any): any[] => (Array.isArray(x) ? x : x?.data ?? x?.items ?? []);
export default function WithholdingTaxPage() {
  const [tab, setTab] = useState<'apply' | 'report' | 'settings'>('apply'); const a = useAction();
  const { data: st } = useGet<any>('/accounting/wht/settings', {}); const { data: cats } = useGet<any[]>('/accounting/wht/categories', {}); const { data: accounts } = useGet<any>('/accounting/accounts', {});
  const accs = rows(accounts);
  const [dir, setDir] = useState<'payable' | 'receivable'>('payable'); const [inv, setInv] = useState(''); const [cat, setCat] = useState(''); const [date, setDate] = useState(today()); const [cert, setCert] = useState('');
  const { data: invs } = useGet<any>(dir === 'payable' ? '/purchasing/invoices' : '/sales/invoices', { status: 'posted', pageSize: 100 });
  const { data: pv } = useGet<any>('/accounting/wht/preview', { direction: dir, invoiceId: inv, categoryId: cat }, !!inv && !!cat);
  const y = today().slice(0, 7); const [rp, setRp] = useState<any>({ from: `${y}-01`, to: today(), direction: 'payable' });
  const { data: rep } = useGet<any>('/accounting/wht/report', rp);
  const [bank, setBank] = useState(''); const [form, setForm] = useState<any>(null);
  const s = form ?? { isEnabled: !!st?.is_enabled, payableAccountId: st?.payable_account_id ?? '', receivableAccountId: st?.receivable_account_id ?? '', exemptThreshold: String(st?.exempt_threshold ?? 0), baseIncludesVat: !!st?.base_includes_vat };
  const tabBtn = (k: typeof tab, l: string) => <button key={k} className={`rounded px-4 py-2 text-sm ${tab === k ? 'bg-slate-900 text-white' : 'bg-slate-200'}`} onClick={() => setTab(k)}>{l}</button>;
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold text-slate-900">ضريبة الخصم والإضافة</h1>
      <p className="mb-3 text-xs text-amber-700">النسب الافتراضية شائعة التداول وقابلة للتعديل لكل شركة — راجع محاسبك/مصلحة الضرائب قبل الاعتماد. هذه الشاشة لا تُصدر النموذج الرسمي.</p>
      <div className="mb-4 flex gap-2">{tabBtn('apply', 'تطبيق خصم')}{tabBtn('report', 'كشف الخصم والسداد')}{tabBtn('settings', 'الإعدادات والفئات')}</div>
      {tab === 'apply' && <Card title="خصم على فاتورة">
        {!st?.is_enabled && <p className="mb-2 text-sm text-red-700">الخصم غير مفعّل — فعّله من الإعدادات.</p>}
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="الاتجاه"><select className={inputCls} value={dir} onChange={(e) => { setDir(e.target.value as any); setInv(''); }}><option value="payable">نخصم من مورد</option><option value="receivable">عميل يخصم منا</option></select></Field>
          <Field label="الفاتورة"><select className={inputCls} value={inv} onChange={(e) => setInv(e.target.value)}><option value="">— اختر —</option>{rows(invs).map((i: any) => <option key={i.id} value={i.id}>{i.document_number}</option>)}</select></Field>
          <Field label="الفئة"><select className={inputCls} value={cat} onChange={(e) => setCat(e.target.value)}><option value="">— اختر —</option>{(cats ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name_ar} ({Number(c.rate_percent)}%)</option>)}</select></Field>
          <Field label="التاريخ"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="رقم الشهادة"><input className={inputCls} value={cert} onChange={(e) => setCert(e.target.value)} /></Field>
        </div>
        {pv && <div className="mt-3 grid gap-3 md:grid-cols-5"><Kpi label="الوعاء" value={num(pv.base, 2)} /><Kpi label="النسبة" value={`${pv.ratePercent}%`} /><Kpi label="مبلغ الخصم" value={num(pv.wht, 2)} tone={pv.exempt ? 'bad' : 'good'} /><Kpi label="المتبقي" value={num(pv.remaining, 2)} /><Kpi label="الصافي للسداد/التحصيل" value={num(pv.netToSettle, 2)} /></div>}
        {pv?.exempt && <p className="mt-2 text-sm text-amber-700">الوعاء أقل من حد الإعفاء ({pv.threshold}) — لا خصم.</p>}
        <button className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={a.busy || !inv || !cat || !pv || pv.exempt} onClick={async () => { if (confirm('تطبيق الخصم؟ يُنشأ سند دفع/قبض نظامي بمبلغ الخصم.') && (await a.post('/accounting/wht/apply', { direction: dir, invoiceId: inv, categoryId: cat, deductionDate: date, ...(cert ? { certificateNo: cert } : {}) }, 'طُبِّق الخصم'))) { setInv(''); setCert(''); } }}>تطبيق الخصم</button>
      </Card>}
      {tab === 'report' && <>
        <Card title="الفترة">
          <div className="grid gap-3 md:grid-cols-4"><Field label="من"><input type="date" className={inputCls} value={rp.from} onChange={(e) => setRp({ ...rp, from: e.target.value })} /></Field><Field label="إلى"><input type="date" className={inputCls} value={rp.to} onChange={(e) => setRp({ ...rp, to: e.target.value })} /></Field>
            <Field label="النوع"><select className={inputCls} value={rp.direction} onChange={(e) => setRp({ ...rp, direction: e.target.value })}><option value="payable">مخصوم من الموردين (مستحق للمصلحة)</option><option value="receivable">مخصوم منا (ضريبة مدينة)</option></select></Field></div>
        </Card>
        {rep && <><div className="my-3 grid gap-3 md:grid-cols-4"><Kpi label="عدد العمليات" value={String(rep.totals.count)} /><Kpi label="إجمالي الوعاء" value={num(rep.totals.base, 2)} /><Kpi label="إجمالي الخصم" value={num(rep.totals.wht, 2)} /><Kpi label="غير مسدَّد" value={num(rep.totals.unremitted, 2)} tone={rep.totals.unremitted ? 'bad' : 'good'} /></div>
          {rep.missingCertificates > 0 && <p className="mb-2 text-sm text-amber-700">⚠️ {rep.missingCertificates} عملية بلا رقم شهادة.</p>}
          <Card title="التفاصيل"><DataTable rows={rep.items} empty="لا خصومات." cols={[{ h: 'التاريخ', k: 'date' }, { h: 'الطرف', k: 'party' }, { h: 'الرقم الضريبي', r: (x: any) => x.taxNumber ?? '—' }, { h: 'الفاتورة', k: 'invoiceNo' }, { h: 'الفئة', k: 'category' }, { h: '%', r: (x: any) => x.ratePercent }, { h: 'الوعاء', r: (x: any) => num(x.base, 2) }, { h: 'الخصم', r: (x: any) => num(x.wht, 2) }, { h: 'الشهادة', r: (x: any) => x.certificateNo ?? '—' }, { h: 'السداد', r: (x: any) => (rp.direction === 'payable' ? (x.remitted ? 'مسدَّد' : 'قائم') : '—') },
              { h: '', r: (x: any) => !x.remitted && <button className="text-red-700 underline" onClick={() => { const reason = prompt('سبب العكس؟'); if (reason) void a.post(`/accounting/wht/${x.id}/reverse`, { reason }, 'عُكس الخصم'); }}>عكس</button> }]} /></Card>
          <Card title="حسب الفئة"><DataTable rows={rep.byCategory} empty="—" cols={[{ h: 'الفئة', k: 'name' }, { h: 'عدد', k: 'count' }, { h: 'الوعاء', r: (x: any) => num(x.base, 2) }, { h: 'الخصم', r: (x: any) => num(x.wht, 2) }]} /></Card>
          <Card title="حسب الطرف"><DataTable rows={rep.byParty} empty="—" cols={[{ h: 'الطرف', k: 'name' }, { h: 'عدد', k: 'count' }, { h: 'الوعاء', r: (x: any) => num(x.base, 2) }, { h: 'الخصم', r: (x: any) => num(x.wht, 2) }]} /></Card>
          {rp.direction === 'payable' && <Card title="سداد للمصلحة"><p className="mb-2 text-xs text-slate-500">يُرحِّل Dr ضريبة خصم مستحقة / Cr البنك لكل غير المسدَّد في الفترة (عملة الأساس فقط).</p>
            <div className="flex gap-2"><select className={inputCls} value={bank} onChange={(e) => setBank(e.target.value)}><option value="">— حساب البنك/الخزينة —</option>{accs.filter((x: any) => x.account_type === 'asset').map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select>
              <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40" disabled={a.busy || !bank || !rep.totals.unremitted} onClick={async () => { if (confirm(`سداد ${num(rep.totals.unremitted, 2)} للمصلحة؟`)) await a.post('/accounting/wht/remit', { from: rp.from, to: rp.to, bankAccountId: bank, remitDate: rp.to }, 'رُحِّل السداد'); }}>سداد للمصلحة</button></div></Card>}
        </>}
      </>}
      {tab === 'settings' && <><Card title="الإعدادات">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="مفعّل"><input type="checkbox" checked={s.isEnabled} onChange={(e) => setForm({ ...s, isEnabled: e.target.checked })} /></Field>
          <Field label="حساب ضريبة الخصم المستحقة (التزام)"><select className={inputCls} value={s.payableAccountId} onChange={(e) => setForm({ ...s, payableAccountId: e.target.value })}><option value="">—</option>{accs.filter((x: any) => x.account_type === 'liability').map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field>
          <Field label="حساب ضريبة الخصم المدينة (أصل)"><select className={inputCls} value={s.receivableAccountId} onChange={(e) => setForm({ ...s, receivableAccountId: e.target.value })}><option value="">—</option>{accs.filter((x: any) => x.account_type === 'asset').map((x: any) => <option key={x.id} value={x.id}>{x.code} — {x.name_ar}</option>)}</select></Field>
          <Field label="حد الإعفاء (لا خصم تحته)"><input className={inputCls} value={s.exemptThreshold} onChange={(e) => setForm({ ...s, exemptThreshold: e.target.value })} /></Field>
          <Field label="الوعاء شامل القيمة المضافة"><input type="checkbox" checked={s.baseIncludesVat} onChange={(e) => setForm({ ...s, baseIncludesVat: e.target.checked })} /></Field>
        </div>
        <button className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white" disabled={a.busy} onClick={async () => { const b: any = { ...s, payableAccountId: s.payableAccountId || null, receivableAccountId: s.receivableAccountId || null }; if (await a.put('/accounting/wht/settings', b, 'حُفظت الإعدادات')) setForm(null); }}>حفظ</button>
      </Card>
      <Card title="الفئات والنسب"><DataTable rows={cats} empty="—" cols={[{ h: 'الكود', k: 'code' }, { h: 'الاسم', k: 'name_ar' }, { h: 'النسبة %', r: (x: any) => <input className="w-20 rounded border px-1" defaultValue={Number(x.rate_percent)} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== Number(x.rate_percent)) void a.put('/accounting/wht/categories', { code: x.code, nameAr: x.name_ar, ratePercent: v, isActive: x.is_active }, 'عُدِّلت النسبة'); }} /> },
        { h: 'مفعّلة', r: (x: any) => <input type="checkbox" checked={x.is_active} onChange={(e) => void a.put('/accounting/wht/categories', { code: x.code, nameAr: x.name_ar, ratePercent: Number(x.rate_percent), isActive: e.target.checked }, 'حُدِّثت الفئة')} /> }]} /></Card></>}
    </div>
  );
}
