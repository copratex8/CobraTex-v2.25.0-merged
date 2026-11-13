import { z } from 'zod';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';
import { agedBalances } from '@/modules/accounting/financialReports';
import { findRate } from '@/modules/accounting/fxRatesService';

/**
 * تقارير إدارية (2.15.0) — قراءة فقط: المخزون الراكد، جدول الشيكات المستحقة، وتوقّع السيولة الأسبوعي.
 */
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD');
const r2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export const slowSchema = z.object({ asOf: D, thresholdDays: z.coerce.number().int().min(1).max(3650).default(90), warehouseId: z.uuid().optional() });
export const chequeSchema = z.object({ asOf: D });
export const forecastSchema = z.object({ asOf: D, weeks: z.coerce.number().int().min(1).max(26).default(13) });

export const AGE_BUCKETS = [{ key: 'd0_90', label: 'حتى ٩٠ يومًا', max: 90 }, { key: 'd91_180', label: '٩١–١٨٠', max: 180 }, { key: 'd181_365', label: '١٨١–٣٦٥', max: 365 }, { key: 'd365p', label: 'أكثر من سنة', max: Infinity }] as const;
export const ageBucket = (days: number) => (AGE_BUCKETS.find((b) => days <= b.max) ?? AGE_BUCKETS[3]).key;

/** المخزون الراكد: العمر = أيام منذ آخر صرف (بيع/إنتاج/هالك/تسوية) حتى asOf، وإن لم يُصرف قط فمنذ أول استلام. الكميات والقيم حالية (من stock_balances). */
export async function slowMoving(ctx: RequestContext, raw: z.input<typeof slowSchema>) {
  ctx.assertPermission('inventory.balance.view'); const q = slowSchema.parse(raw);
  const p: unknown[] = [ctx.companyId, q.asOf]; let wh = '';
  if (q.warehouseId) { p.push(q.warehouseId); wh = ` AND sb.warehouse_id=$${p.length}`; }
  const rows = (await pool.query(
    `SELECT i.id, i.code, i.name_ar, SUM(sb.quantity_on_hand) AS qty, SUM(sb.quantity_on_hand * sb.weighted_average_cost) AS value,
            (SELECT MAX(m.effective_date)::text FROM stock_movements m WHERE m.company_id=i.company_id AND m.item_id=i.id AND m.status='posted' AND m.effective_date<=$2 AND m.movement_type IN ('out','loss','adjustment_out','production_consume')) AS last_issue,
            (SELECT MIN(m.effective_date)::text FROM stock_movements m WHERE m.company_id=i.company_id AND m.item_id=i.id AND m.status='posted' AND m.effective_date<=$2 AND m.movement_type IN ('opening','in','adjustment_in','production_output')) AS first_receipt
     FROM stock_balances sb JOIN items i ON i.id=sb.item_id WHERE sb.company_id=$1 AND sb.quantity_on_hand > 0${wh} GROUP BY i.id, i.code, i.name_ar, i.company_id`, p)).rows;
  const items = rows.map((r) => {
    const ref = r.last_issue ?? r.first_receipt; const days = ref ? Math.max(0, daysBetween(ref, q.asOf)) : null;
    return { itemId: r.id, code: r.code, name: r.name_ar, quantity: Number(r.qty), value: r2(Number(r.value)), lastIssueDate: r.last_issue, neverIssued: !r.last_issue, referenceDate: ref, daysIdle: days, bucket: days === null ? null : ageBucket(days) };
  }).filter((x) => x.daysIdle !== null && x.daysIdle >= q.thresholdDays).sort((a, b) => b.value - a.value);
  const totals: Record<string, number> = Object.fromEntries([...AGE_BUCKETS.map((b) => [b.key, 0]), ['total', 0]]);
  for (const x of items) { totals[x.bucket as string] = r2(totals[x.bucket as string] + x.value); totals.total = r2(totals.total + x.value); }
  const stockTotal = r2(rows.reduce((s, r) => s + Number(r.value), 0));
  return { asOf: q.asOf, thresholdDays: q.thresholdDays, buckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label })), items, totals, stockValue: stockTotal, idleShare: stockTotal > 0 ? Math.round((totals.total / stockTotal) * 1e4) / 100 : 0, note: 'الكميات والقيم حالية؛ asOf يحدد حساب العمر فقط.' };
}

async function chequeItems(ctx: RequestContext, asOf: string) {
  const rows = (await pool.query(
    `SELECT c.id, c.check_type, c.check_number, c.due_date::text AS due, c.amount, c.currency_code, c.status, c.counterparty_customer_id AS cust, c.counterparty_supplier_id AS supp,
            COALESCE(cu.name_ar, su.name_ar) AS party
     FROM checks c LEFT JOIN customers cu ON cu.id=c.counterparty_customer_id LEFT JOIN suppliers su ON su.id=c.counterparty_supplier_id
     WHERE c.company_id=$1 AND c.status IN ('pending','deposited')`, [ctx.companyId])).rows;
  const warnings: string[] = []; const out: Array<{ id: string; type: 'incoming' | 'outgoing'; number: string; due: string; status: string; partyId: string; party: string; base: number; currency: string; amount: number }> = [];
  for (const r of rows) {
    const f = await findRate(pool as never, ctx.companyId, r.currency_code, asOf, 'mid');
    if (!f) { warnings.push(`شيك ${r.check_number}: لا سعر صرف لـ ${r.currency_code} فاستُبعد`); continue; }
    out.push({ id: r.id, type: r.check_type, number: r.check_number, due: r.due, status: r.status, partyId: r.cust ?? r.supp, party: r.party, base: r2(Number(r.amount) * f.rate), currency: r.currency_code, amount: Number(r.amount) });
  }
  return { items: out, warnings };
}

const CH_BUCKETS = [{ key: 'overdue', label: 'متأخر', test: (d: number) => d < 0 }, { key: 'w1', label: 'خلال ٧ أيام', test: (d: number) => d <= 7 }, { key: 'w2', label: '٨–١٤ يومًا', test: (d: number) => d <= 14 }, { key: 'd30', label: '١٥–٣٠', test: (d: number) => d <= 30 }, { key: 'd60', label: '٣١–٦٠', test: (d: number) => d <= 60 }, { key: 'd90', label: '٦١–٩٠', test: (d: number) => d <= 90 }, { key: 'later', label: 'بعد ٩٠', test: () => true }];

/** جدول الشيكات تحت التحصيل/الصرف (pending/deposited) حسب تاريخ الاستحقاق، بعملة الأساس. */
export async function chequeSchedule(ctx: RequestContext, raw: z.input<typeof chequeSchema>) {
  ctx.assertPermission('treasury.check.view'); const q = chequeSchema.parse(raw);
  const { items, warnings } = await chequeItems(ctx, q.asOf);
  const mk = () => Object.fromEntries(CH_BUCKETS.map((b) => [b.key, 0])) as Record<string, number>;
  const inc = mk(), outg = mk();
  const detailed = items.map((x) => { const d = daysBetween(q.asOf, x.due); const b = CH_BUCKETS.find((k) => k.test(d))!.key; (x.type === 'incoming' ? inc : outg)[b] = r2((x.type === 'incoming' ? inc : outg)[b] + x.base); return { ...x, daysToDue: d, bucket: b }; }).sort((a, b) => a.due.localeCompare(b.due));
  const sum = (o: Record<string, number>) => r2(Object.values(o).reduce((s, v) => s + v, 0));
  return { asOf: q.asOf, buckets: CH_BUCKETS.map((b) => ({ key: b.key, label: b.label })), incoming: { ...inc, total: sum(inc) }, outgoing: { ...outg, total: sum(outg) }, net: r2(sum(inc) - sum(outg)), cheques: detailed, warnings };
}

/**
 * توقّع السيولة الأسبوعي: الرصيد الافتتاحي = أرصدة حسابات الخزائن/البنوك النشطة في القيود المرحَّلة؛ المقبوضات = فواتير عملاء
 * مفتوحة عند استحقاقها + شيكات واردة عند استحقاقها؛ المدفوعات = فواتير موردين + شيكات صادرة. يُخصم من فواتير كل طرف قيمة شيكاته
 * المعلّقة (الأقدم أولًا) حتى لا تُحسب مرتين. المتأخر يدخل الأسبوع الأول.
 */
export async function cashForecast(ctx: RequestContext, raw: z.input<typeof forecastSchema>) {
  ctx.assertPermission('accounting.journal.view'); const q = forecastSchema.parse(raw);
  const warnings: string[] = [];
  const open = async (kind: 'receivable' | 'payable') => (await agedBalances(ctx, { kind, asOf: q.asOf, detail: true })).parties.flatMap((p: any) => p.invoices as Array<{ partyId: string; dueDate: string; invoiceDate: string; outstandingBase: number }>); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [recv, pay, ch] = [await open('receivable'), await open('payable'), await chequeItems(ctx, q.asOf)];
  warnings.push(...ch.warnings);
  const net = (invoices: typeof recv, cheques: typeof ch.items) => {
    const byParty = new Map<string, number>(); for (const c of cheques) byParty.set(c.partyId, (byParty.get(c.partyId) ?? 0) + c.base);
    return [...invoices].sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate)).map((i) => { const left = byParty.get(i.partyId) ?? 0; const cut = Math.min(left, i.outstandingBase); byParty.set(i.partyId, left - cut); return { date: i.dueDate, amount: r2(i.outstandingBase - cut) }; }).filter((x) => x.amount > 0);
  };
  const inflows = [...net(recv, ch.items.filter((c) => c.type === 'incoming')), ...ch.items.filter((c) => c.type === 'incoming').map((c) => ({ date: c.due, amount: c.base }))];
  const outflows = [...net(pay, ch.items.filter((c) => c.type === 'outgoing')), ...ch.items.filter((c) => c.type === 'outgoing').map((c) => ({ date: c.due, amount: c.base }))];
  const acc = (await pool.query(`SELECT linked_account_id FROM safe_or_banks WHERE company_id=$1 AND is_active`, [ctx.companyId])).rows.map((r) => r.linked_account_id);
  let opening = 0;
  if (acc.length) opening = r2(Number((await pool.query(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.status='posted' AND je.company_id=$1 AND je.entry_date<=$2 AND jl.account_id = ANY($3::uuid[])`, [ctx.companyId, q.asOf, acc])).rows[0].b));
  else warnings.push('لا خزائن/بنوك نشطة — الرصيد الافتتاحي صفر');
  const weeks = Array.from({ length: q.weeks }, (_, i) => ({ n: i + 1, from: addDays(q.asOf, i * 7), to: addDays(q.asOf, i * 7 + 6), inflow: 0, overdueInflow: 0, outflow: 0, overdueOutflow: 0 }));
  let beyondIn = 0, beyondOut = 0;
  const place = (items: Array<{ date: string; amount: number }>, side: 'in' | 'out') => {
    for (const it of items) {
      const d = daysBetween(q.asOf, it.date); const idx = d < 7 ? 0 : Math.floor(d / 7);
      if (idx >= q.weeks) { if (side === 'in') beyondIn = r2(beyondIn + it.amount); else beyondOut = r2(beyondOut + it.amount); continue; }
      const w = weeks[idx]; if (side === 'in') { w.inflow = r2(w.inflow + it.amount); if (d < 0) w.overdueInflow = r2(w.overdueInflow + it.amount); } else { w.outflow = r2(w.outflow + it.amount); if (d < 0) w.overdueOutflow = r2(w.overdueOutflow + it.amount); }
    }
  };
  place(inflows, 'in'); place(outflows, 'out');
  let run = opening; let lowest = { closing: opening, week: 0 };
  const rows = weeks.map((w) => { run = r2(run + w.inflow - w.outflow); if (run < lowest.closing) lowest = { closing: run, week: w.n }; return { ...w, net: r2(w.inflow - w.outflow), closing: run }; });
  if (lowest.closing < 0) warnings.push(`عجز سيولة متوقَّع: أدنى رصيد ${lowest.closing} في الأسبوع ${lowest.week}`);
  const tot = (k: 'inflow' | 'outflow') => r2(rows.reduce((s, w) => s + w[k], 0));
  return { asOf: q.asOf, opening, weeks: rows, totals: { inflow: tot('inflow'), outflow: tot('outflow'), beyondHorizonInflow: beyondIn, beyondHorizonOutflow: beyondOut }, closing: run, lowest, warnings, note: 'المقبوضات/المدفوعات تُقدَّر من تواريخ الاستحقاق (تاريخ الفاتورة + مهلة السداد) وتواريخ الشيكات؛ ليست التزامًا.' };
}
