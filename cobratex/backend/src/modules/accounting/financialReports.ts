import { z } from 'zod';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';

/**
 * تقارير مالية تحليلية (٢.١١.٠) — قراءة فقط، لا ترحيل قيود:
 *  - أعمار الديون (مدينون/دائنون) بتاريخ الفاتورة
 *  - قائمة الدخل والمركز المالي من القيود المرحَّلة (journal_lines)
 *  - اقتراحات إعادة الطلب من نقطة الطلب (items.reorder_point)
 */
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');
const r2 = (n: number) => Math.round(n * 100) / 100;

export const agingSchema = z.object({ kind: z.enum(['receivable', 'payable']).default('receivable'), asOf: D, partyId: z.string().uuid().optional(), detail: z.coerce.boolean().optional().default(false) });
export const periodSchema = z.object({ from: D, to: D });
export const asOfSchema = z.object({ asOf: D });
export const reorderSchema = z.object({ warehouseId: z.string().uuid().optional() });

export const BUCKETS = [
  { key: 'd0_30', label: '٠–٣٠ يومًا', min: 0, max: 30 },
  { key: 'd31_60', label: '٣١–٦٠ يومًا', min: 31, max: 60 },
  { key: 'd61_90', label: '٦١–٩٠ يومًا', min: 61, max: 90 },
  { key: 'd91_120', label: '٩١–١٢٠ يومًا', min: 91, max: 120 },
  { key: 'd120p', label: 'أكثر من ١٢٠', min: 121, max: Infinity },
] as const;
export const bucketOf = (days: number) => (BUCKETS.find((b) => days >= b.min && days <= b.max) ?? BUCKETS[0]).key;

/** أعمار الديون: المتبقي = صافي الفاتورة (أسطر − مرتجعات مرحَّلة) − تخصيصات دفعات مرحَّلة حتى تاريخ التقرير، بعملة الأساس بسعر الفاتورة. الدفعات المقدمة غير المخصَّصة تظهر رصيدًا دائنًا منفصلًا. */
export async function agedBalances(ctx: RequestContext, raw: z.input<typeof agingSchema>) {
  const q = agingSchema.parse(raw);
  const rec = q.kind === 'receivable';
  ctx.assertPermission(rec ? 'sales.invoice.view' : 'purchasing.invoice.view');
  const vis = ctx.visibleBranchIds();
  const p: unknown[] = [ctx.companyId, q.asOf];
  let w = `i.company_id=$1 AND i.status='posted' AND i.invoice_date<=$2`;
  if (q.partyId) { p.push(q.partyId); w += ` AND i.${rec ? 'customer_id' : 'supplier_id'}=$${p.length}`; }
  if (vis !== null) { p.push(vis); w += ` AND i.branch_id = ANY($${p.length})`; }
  const T = rec
    ? { inv: 'sales_invoices', ln: 'sales_invoice_lines', fk: 'sales_invoice_id', party: 'customers', pid: 'customer_id', al: 'customer_payment_allocations', pay: 'customer_payments', payfk: 'customer_payment_id', ret: `SELECT COALESCE(SUM(l.line_total),0) FROM sales_return_lines l JOIN sales_returns r ON r.id=l.sales_return_id WHERE r.sales_invoice_id=i.id AND r.status='posted' AND r.return_date<=$2` }
    : { inv: 'supplier_invoices', ln: 'supplier_invoice_lines', fk: 'supplier_invoice_id', party: 'suppliers', pid: 'supplier_id', al: 'supplier_payment_allocations', pay: 'supplier_payments', payfk: 'supplier_payment_id', ret: `SELECT COALESCE(SUM(l.line_total),0) FROM purchase_return_lines l JOIN purchase_returns r ON r.id=l.purchase_return_id WHERE r.supplier_invoice_id=i.id AND r.status='posted' AND r.return_date<=$2` };
  const { rows } = await pool.query(
    `SELECT i.id, i.document_number, i.invoice_date::text AS invoice_date, i.currency_code, i.exchange_rate, i.${T.pid} AS party_id, c.code AS party_code, c.name_ar AS party_name, c.payment_term_days AS term,
            (SELECT COALESCE(SUM(line_total),0) FROM ${T.ln} WHERE ${T.fk}=i.id) AS gross,
            (${T.ret}) AS returned,
            (SELECT COALESCE(SUM(a.allocated_amount),0) FROM ${T.al} a JOIN ${T.pay} pm ON pm.id=a.${T.payfk} WHERE a.${T.fk}=i.id AND pm.status='posted' AND pm.${'payment_date'}<=$2) AS paid
     FROM ${T.inv} i JOIN ${T.party} c ON c.id=i.${T.pid} WHERE ${w} ORDER BY c.code, i.invoice_date`, p);
  const asOfMs = Date.parse(q.asOf);
  const parties = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const grand: Record<string, number> = Object.fromEntries([...BUCKETS.map((b) => [b.key, 0]), ['total', 0], ['overdue', 0]]);
  for (const r of rows) {
    const out = (Number(r.gross) - Number(r.returned) - Number(r.paid)) * Number(r.exchange_rate);
    if (Math.abs(out) < 0.005) continue;
    const days = Math.max(0, Math.round((asOfMs - Date.parse(r.invoice_date)) / 86400000));
    const k = bucketOf(days);
    const pt = parties.get(r.party_id) ?? { partyId: r.party_id, code: r.party_code, name: r.party_name, ...Object.fromEntries([...BUCKETS.map((b) => [b.key, 0]), ['total', 0], ['overdue', 0]]), invoices: [] as unknown[] };
    pt[k] += out; pt.total += out; grand[k] += out; grand.total += out;
    const overdueDays = days - Number(r.term ?? 0);
    if (overdueDays > 0) { pt.overdue += out; grand.overdue += out; }
    const dueMs = Date.parse(r.invoice_date) + Number(r.term ?? 0) * 86400000;
    if (q.detail) pt.invoices.push({ partyId: r.party_id, dueDate: new Date(dueMs).toISOString().slice(0, 10), invoiceId: r.id, documentNumber: r.document_number, invoiceDate: r.invoice_date, days, daysOverdue: Math.max(0, overdueDays), bucket: k, currency: r.currency_code, outstandingBase: r2(out) });
    parties.set(r.party_id, pt);
  }
  // دفعات مقدمة غير مخصَّصة
  const advP: unknown[] = [ctx.companyId, q.asOf]; let advW = `pm.company_id=$1 AND pm.status='posted' AND pm.payment_date<=$2`;
  if (q.partyId) { advP.push(q.partyId); advW += ` AND pm.${T.pid}=$${advP.length}`; }
  if (vis !== null) { advP.push(vis); advW += ` AND pm.branch_id = ANY($${advP.length})`; }
  const adv = await pool.query(`SELECT pm.${T.pid} AS party_id, SUM((pm.amount - COALESCE((SELECT SUM(a.allocated_amount) FROM ${T.al} a WHERE a.${T.payfk}=pm.id),0)) * pm.exchange_rate) AS unallocated FROM ${T.pay} pm WHERE ${advW} GROUP BY pm.${T.pid} HAVING SUM(pm.amount - COALESCE((SELECT SUM(a.allocated_amount) FROM ${T.al} a WHERE a.${T.payfk}=pm.id),0)) > 0.005`, advP);
  const advances = new Map(adv.rows.map((x) => [x.party_id, r2(Number(x.unallocated))]));
  const list = [...parties.values()].map((x) => ({ ...x, ...Object.fromEntries(Object.keys(grand).map((k) => [k, r2(x[k])])), unallocatedAdvance: advances.get(x.partyId) ?? 0 })).sort((a, b) => b.total - a.total);
  const advTotal = r2([...advances.values()].reduce((s, v) => s + v, 0));
  return { kind: q.kind, asOf: q.asOf, buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label })), parties: list, totals: Object.fromEntries(Object.keys(grand).map((k) => [k, r2(grand[k])])), unallocatedAdvances: advTotal, netExposure: r2(grand.total - advTotal), note: 'الأعمار من تاريخ الفاتورة؛ «المتأخر» = ما تجاوز مهلة السداد المسجّلة للعميل/المورد (payment_term_days). بعملة الأساس بسعر الفاتورة.' };
}

async function sums(ctx: RequestContext, from: string | null, to: string, excludeClosing = false) {
  ctx.assertPermission('accounting.journal.view');
  const vis = ctx.visibleBranchIds();
  const p: unknown[] = [ctx.companyId, to]; let w = `je.status='posted' AND je.company_id=$1 AND je.entry_date<=$2`;
  if (from) { p.push(from); w += ` AND je.entry_date>=$${p.length}`; }
  if (excludeClosing) w += ` AND COALESCE(je.source_document_type,'') NOT IN ('year_end_close','year_end_close_reversal')`;
  if (vis !== null) { p.push(vis); w += ` AND je.branch_id = ANY($${p.length}::uuid[])`; }
  const { rows } = await pool.query(
    `SELECT a.id, a.code, a.name_ar, a.account_type, COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id WHERE ${w}
     GROUP BY a.id, a.code, a.name_ar, a.account_type ORDER BY a.code`, p);
  return rows;
}

/** قائمة الدخل: الإيرادات − المصروفات خلال الفترة (القيود المرحَّلة). */
export async function incomeStatement(ctx: RequestContext, raw: z.input<typeof periodSchema>) {
  const q = periodSchema.parse(raw);
  if (q.from > q.to) throw new ValidationError('from يجب أن يسبق to');
  const rows = await sums(ctx, q.from, q.to, true); // قيود إقفال السنة لا تدخل قائمة الدخل
  const rev = rows.filter((r) => r.account_type === 'revenue').map((r) => ({ code: r.code, name: r.name_ar, amount: r2(Number(r.c) - Number(r.d)) })).filter((r) => r.amount !== 0);
  const exp = rows.filter((r) => r.account_type === 'expense').map((r) => ({ code: r.code, name: r.name_ar, amount: r2(Number(r.d) - Number(r.c)) })).filter((r) => r.amount !== 0);
  const totalRevenue = r2(rev.reduce((s, r) => s + r.amount, 0)), totalExpense = r2(exp.reduce((s, r) => s + r.amount, 0));
  const net = r2(totalRevenue - totalExpense);
  return { from: q.from, to: q.to, revenue: rev, expenses: exp, totalRevenue, totalExpense, netIncome: net, margin: totalRevenue ? r2((net / totalRevenue) * 100) : null };
}

/** المركز المالي: أصول = خصوم + حقوق ملكية + صافي أرباح (إيرادات − مصروفات) المتراكم حتى التاريخ. */
export async function balanceSheet(ctx: RequestContext, raw: z.input<typeof asOfSchema>) {
  const q = asOfSchema.parse(raw);
  const rows = await sums(ctx, null, q.asOf);
  const side = (t: string, sign: 1 | -1) => rows.filter((r) => r.account_type === t).map((r) => ({ code: r.code, name: r.name_ar, amount: r2(sign * (Number(r.d) - Number(r.c))) })).filter((r) => r.amount !== 0);
  const assets = side('asset', 1), liabilities = side('liability', -1), equity = side('equity', -1);
  const earnings = r2(rows.filter((r) => r.account_type === 'revenue').reduce((s, r) => s + Number(r.c) - Number(r.d), 0) - rows.filter((r) => r.account_type === 'expense').reduce((s, r) => s + Number(r.d) - Number(r.c), 0));
  const tA = r2(assets.reduce((s, r) => s + r.amount, 0)), tL = r2(liabilities.reduce((s, r) => s + r.amount, 0)), tE = r2(equity.reduce((s, r) => s + r.amount, 0));
  return { asOf: q.asOf, assets, liabilities, equity, currentEarnings: earnings, totalAssets: tA, totalLiabilities: tL, totalEquity: tE, totalLiabilitiesAndEquity: r2(tL + tE + earnings), balanced: Math.abs(tA - (tL + tE + earnings)) < 0.01 };
}

/** اقتراحات إعادة الطلب: المتاح (رصيد − محجوز) + وارد أوامر الشراء المؤكدة ≤ نقطة الطلب ⇒ يُقترح max(كمية الطلب، العجز حتى ضعف النقطة). */
export async function reorderSuggestions(ctx: RequestContext, raw: z.input<typeof reorderSchema>) {
  const q = reorderSchema.parse(raw);
  ctx.assertPermission('inventory.balance.view');
  const p: unknown[] = [ctx.companyId]; let wh = '';
  if (q.warehouseId) { p.push(q.warehouseId); wh = ` AND sb.warehouse_id=$${p.length}`; }
  const { rows } = await pool.query(
    `SELECT i.id, i.code, i.name_ar, i.reorder_point, i.reorder_qty,
            COALESCE((SELECT SUM(sb.quantity_on_hand - sb.quantity_reserved) FROM stock_balances sb WHERE sb.item_id=i.id AND sb.company_id=i.company_id${wh}),0) AS available,
            COALESCE((SELECT SUM(l.quantity - l.received_quantity) FROM purchase_order_lines l JOIN purchase_orders po ON po.id=l.purchase_order_id WHERE l.item_id=i.id AND l.company_id=i.company_id AND po.status='confirmed'),0) AS incoming
     FROM items i WHERE i.company_id=$1 AND i.is_active AND i.reorder_point>0 ORDER BY i.code`, p);
  const out = rows.map((r) => {
    const rp = Number(r.reorder_point), pos = Number(r.available) + Number(r.incoming);
    if (pos > rp) return null;
    const sug = Math.max(Number(r.reorder_qty), rp * 2 - pos);
    return { itemId: r.id, code: r.code, name: r.name_ar, available: Number(r.available), incoming: Number(r.incoming), reorderPoint: rp, position: pos, suggestedQty: r2(sug), urgency: Number(r.available) <= 0 ? 'out_of_stock' : 'below_point' };
  }).filter(Boolean) as Array<{ urgency: string; position: number }>;
  const rank: Record<string, number> = { out_of_stock: 0, below_point: 1 };
  out.sort((a, b) => rank[a.urgency] - rank[b.urgency]);
  return { items: out, count: out.length };
}

export const vatSchema = z.object({ from: D, to: D });
/**
 * إقرار ضريبة القيمة المضافة (تحليلي): ضريبة المخرجات (فواتير بيع مرحَّلة − مرتجعات مرحَّلة) وضريبة المدخلات
 * (فواتير موردين + مصروفات − مرتجعات مشتريات)، لكل نوع ضريبة، بعملة الأساس بسعر المستند. الصافي = مخرجات − مدخلات.
 * مطابقة مع الدفتر: حركة حسابات الضريبة المرتبطة بالأنواع في القيود المرحَّلة؛ أي فرق يُعرض تحذيرًا (قيود يدوية/تسويات).
 */
export async function vatReturn(ctx: RequestContext, raw: z.input<typeof vatSchema>) {
  const q = vatSchema.parse(raw);
  if (q.from > q.to) throw new ValidationError('from يجب أن يسبق to');
  ctx.assertPermission('accounting.journal.view');
  const vis = ctx.visibleBranchIds();
  const bp = vis !== null ? [vis] : []; const br = (alias: string, n: number) => (vis !== null ? ` AND ${alias}.branch_id = ANY($${n}::uuid[])` : '');
  const run = async (sql: string) => (await pool.query(sql, [ctx.companyId, q.from, q.to, ...bp])).rows;
  const sel = (lines: string, hdr: string, dateCol: string, fk: string, extra = '') =>
    `SELECT l.tax_type_id, SUM(l.subtotal * h.exchange_rate) AS base, SUM(l.tax_amount * h.exchange_rate) AS tax, count(*)::int AS n FROM ${lines} l JOIN ${hdr} h ON h.id=l.${fk} WHERE h.company_id=$1 AND h.status='posted' AND h.${dateCol} BETWEEN $2 AND $3${br('h', 4)} ${extra} GROUP BY l.tax_type_id`;
  const salesLine = await run(sel('sales_invoice_lines', 'sales_invoices', 'invoice_date', 'sales_invoice_id'));
  const salesRet = await run(`SELECT sil.tax_type_id, SUM(l.subtotal * h.exchange_rate) AS base, SUM(l.tax_amount * h.exchange_rate) AS tax, count(*)::int AS n FROM sales_return_lines l JOIN sales_returns h ON h.id=l.sales_return_id JOIN sales_invoice_lines sil ON sil.id=l.sales_invoice_line_id WHERE h.company_id=$1 AND h.status='posted' AND h.return_date BETWEEN $2 AND $3${br('h', 4)} GROUP BY sil.tax_type_id`);
  const purLine = await run(sel('supplier_invoice_lines', 'supplier_invoices', 'invoice_date', 'supplier_invoice_id'));
  const expLine = await run(sel('expense_invoice_lines', 'expense_invoices', 'invoice_date', 'expense_invoice_id'));
  const purRet = await run(`SELECT sil.tax_type_id, SUM(l.subtotal * h.exchange_rate) AS base, SUM(l.tax_amount * h.exchange_rate) AS tax, count(*)::int AS n FROM purchase_return_lines l JOIN purchase_returns h ON h.id=l.purchase_return_id JOIN supplier_invoice_lines sil ON sil.id=l.supplier_invoice_line_id WHERE h.company_id=$1 AND h.status='posted' AND h.return_date BETWEEN $2 AND $3${br('h', 4)} GROUP BY sil.tax_type_id`);
  const types = (await pool.query(`SELECT id, name_ar, sales_tax_account_id, purchase_tax_account_id FROM tax_types WHERE company_id=$1`, [ctx.companyId])).rows;
  const nm = new Map(types.map((t) => [t.id, t.name_ar as string]));
  type Acc = { outBase: number; outTax: number; inBase: number; inTax: number };
  const by = new Map<string, Acc>(); const slot = (k: string | null) => { const key = k ?? 'none'; if (!by.has(key)) by.set(key, { outBase: 0, outTax: 0, inBase: 0, inTax: 0 }); return by.get(key)!; };
  const add = (rows: any[], f: 'out' | 'in', sign: 1 | -1) => { for (const r of rows) { const s = slot(r.tax_type_id); s[`${f}Base` as 'outBase'] += sign * Number(r.base); s[`${f}Tax` as 'outTax'] += sign * Number(r.tax); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  add(salesLine, 'out', 1); add(salesRet, 'out', -1); add(purLine, 'in', 1); add(expLine, 'in', 1); add(purRet, 'in', -1);
  const rows = [...by].map(([k, v]) => ({ taxTypeId: k === 'none' ? null : k, name: k === 'none' ? 'بدون ضريبة / معفى' : nm.get(k) ?? k, outputBase: r2(v.outBase), outputTax: r2(v.outTax), inputBase: r2(v.inBase), inputTax: r2(v.inTax) })).sort((a, b) => b.outputTax + b.inputTax - (a.outputTax + a.inputTax));
  const tot = (k: 'outputBase' | 'outputTax' | 'inputBase' | 'inputTax') => r2(rows.reduce((s, r) => s + r[k], 0));
  const outputTax = tot('outputTax'), inputTax = tot('inputTax');
  // مطابقة الدفتر
  const salesAcc = [...new Set(types.map((t) => t.sales_tax_account_id).filter(Boolean))], purAcc = [...new Set(types.map((t) => t.purchase_tax_account_id).filter(Boolean))];
  const gl = async (accs: string[], sign: 1 | -1) => {
    if (!accs.length) return null;
    const p: unknown[] = [ctx.companyId, q.from, q.to, accs]; let w = `je.status='posted' AND je.company_id=$1 AND je.entry_date BETWEEN $2 AND $3 AND jl.account_id = ANY($4::uuid[])`;
    if (vis !== null) { p.push(vis); w += ` AND je.branch_id = ANY($5::uuid[])`; }
    const r = (await pool.query(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE ${w}`, p)).rows[0];
    return r2(sign * Number(r.b));
  };
  const glOut = await gl(salesAcc as string[], -1), glIn = await gl(purAcc as string[], 1);
  const warnings: string[] = [];
  if (glOut !== null && Math.abs(glOut - outputTax) > 0.01) warnings.push(`فرق عن الدفتر في ضريبة المخرجات: الدفتر ${glOut} مقابل المستندات ${outputTax}`);
  if (glIn !== null && Math.abs(glIn - inputTax) > 0.01) warnings.push(`فرق عن الدفتر في ضريبة المدخلات: الدفتر ${glIn} مقابل المستندات ${inputTax}`);
  const net = r2(outputTax - inputTax);
  return { from: q.from, to: q.to, rows, totals: { outputBase: tot('outputBase'), outputTax, inputBase: tot('inputBase'), inputTax }, netPayable: net, position: net > 0 ? 'payable' : net < 0 ? 'refundable' : 'nil', ledger: { output: glOut, input: glIn, reconciled: warnings.length === 0 }, warnings };
}
