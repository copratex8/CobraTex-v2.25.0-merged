import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { JournalLineInput } from '@/modules/accounting/accountingService';

/**
 * إقفال الفترات وقيد إقفال السنة (2.16.0). الإقفال تدعمه قاعدة البيانات بمشغّل يمنع ترحيل قيد في فترة مقفلة (0065).
 * قيد إقفال السنة: يُصفِّر حسابات الإيرادات والمصروفات للفترة المحددة ويُرحِّل الصافي إلى حساب الأرباح المرحَّلة.
 */
const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD'); const uuid = z.uuid();
export const closeSchema = z.strictObject({ note: z.string().optional() });
export const reopenSchema = z.strictObject({ reason: z.string().min(3) });
export const yearEndSchema = z.strictObject({ fromDate: D, toDate: D, closingDate: D.optional(), retainedAccountId: uuid, branchId: uuid.optional() });
export const reverseYearEndSchema = z.strictObject({ reason: z.string().min(3) });
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const CLOSING_SOURCES = ['year_end_close', 'year_end_close_reversal'];

async function period(ctx: RequestContext, id: string) {
  const p = (await pool.query(`SELECT *, start_date::text AS s, end_date::text AS e FROM fiscal_periods WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!p) throw new NotFoundError('الفترة المالية غير موجودة'); return p;
}

/** فحص ما قبل الإقفال: القيود غير المرحَّلة تمنع الإقفال؛ المستندات المسودة تُعرض تحذيرًا. */
export async function preCloseCheck(ctx: RequestContext, periodId: string) {
  ctx.assertPermission('accounting.period.close');
  const p = await period(ctx, periodId);
  const je = (await pool.query(`SELECT status, count(*)::int AS n FROM journal_entries WHERE company_id=$1 AND fiscal_period_id=$2 AND status IN ('draft','pending_review','approved') GROUP BY status`, [ctx.companyId, periodId])).rows;
  const docs: Array<[string, string, string]> = [['sales_invoices', 'invoice_date', 'فواتير بيع'], ['supplier_invoices', 'invoice_date', 'فواتير موردين'], ['expense_invoices', 'invoice_date', 'فواتير مصروفات'], ['customer_payments', 'payment_date', 'تحصيلات'], ['supplier_payments', 'payment_date', 'مدفوعات موردين'], ['goods_receipts', 'receipt_date', 'إيصالات استلام'], ['sales_returns', 'return_date', 'مرتجعات بيع'], ['purchase_returns', 'return_date', 'مرتجعات شراء']];
  const drafts: Array<{ kind: string; count: number }> = [];
  for (const [t, c, label] of docs) { const n = (await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE company_id=$1 AND status='draft' AND ${c} BETWEEN $2 AND $3`, [ctx.companyId, p.s, p.e])).rows[0].n; if (n) drafts.push({ kind: label, count: n }); }
  const tb = (await pool.query(`SELECT COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE je.company_id=$1 AND je.status='posted' AND je.fiscal_period_id=$2`, [ctx.companyId, periodId])).rows[0];
  const blockers = je.map((r) => `${r.n} قيد بحالة ${r.status} لم يُرحَّل`);
  const earlierOpen = (await pool.query(`SELECT count(*)::int AS n FROM fiscal_periods WHERE company_id=$1 AND status='open' AND end_date < $2`, [ctx.companyId, p.s])).rows[0].n;
  const warnings = [...drafts.map((d) => `${d.count} ${d.kind} مسودة بتواريخ الفترة (لن تُرحَّل بعد الإقفال)`), ...(earlierOpen ? [`يوجد ${earlierOpen} فترة أقدم ما زالت مفتوحة`] : []), ...(Math.abs(Number(tb.d) - Number(tb.c)) > 0.0001 ? ['القيود المرحَّلة غير متوازنة'] : [])];
  return { periodId, startDate: p.s, endDate: p.e, status: p.status, canClose: p.status === 'open' && blockers.length === 0, blockers, warnings, drafts };
}

export async function closePeriod(ctx: RequestContext, id: string, raw: z.input<typeof closeSchema> = {}) {
  ctx.assertPermission('accounting.period.close'); const b = closeSchema.parse(raw);
  const chk = await preCloseCheck(ctx, id);
  if (chk.status === 'closed') throw new ConflictError('الفترة مقفلة بالفعل');
  if (chk.blockers.length) throw new ValidationError(`لا يمكن الإقفال: ${chk.blockers.join('، ')}`);
  const row = (await pool.query(`UPDATE fiscal_periods SET status='closed', closed_at=now(), closed_by=$3, close_note=$4 WHERE id=$1 AND company_id=$2 AND status='open' RETURNING *`, [id, ctx.companyId, ctx.userId, b.note ?? null])).rows[0];
  if (!row) throw new ConflictError('الفترة مقفلة بالفعل');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'fiscal_period', entityId: id, afterJson: { closed: true, warnings: chk.warnings.length } });
  return { ...row, warnings: chk.warnings };
}

/** إعادة الفتح: بسبب إلزامي (مطلوب لعكس قيد إقفال السنة أو لتعديل الفترة). إن كان قيد إقفال سنة قائمًا يغطيها تُرجَع تحذيرًا: أي تعديل لاحق يجعله قديمًا فاعكسه وأعد إصداره. */
export async function reopenPeriod(ctx: RequestContext, id: string, raw: z.input<typeof reopenSchema>) {
  ctx.assertPermission('accounting.period.reopen'); const b = reopenSchema.parse(raw); const p = await period(ctx, id);
  if (p.status !== 'closed') throw new ConflictError('الفترة مفتوحة أصلًا');
  const ye = (await pool.query(`SELECT 1 FROM year_end_closings WHERE company_id=$1 AND status='posted' AND $2 BETWEEN from_date AND to_date`, [ctx.companyId, p.s])).rows.length;
  const row = (await pool.query(`UPDATE fiscal_periods SET status='open', reopened_at=now(), reopened_by=$3, reopen_reason=$4 WHERE id=$1 AND company_id=$2 RETURNING *`, [id, ctx.companyId, ctx.userId, b.reason])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'fiscal_period', entityId: id, afterJson: { reopened: true, reason: b.reason } });
  return { ...row, warnings: ye ? ['يوجد قيد إقفال سنة قائم يغطي هذه الفترة — اعكسه وأعد إصداره بعد أي تعديل'] : [] };
}

async function balances(client: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }, companyId: string, from: string, to: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await client.query(`SELECT a.id, a.code, a.name_ar, a.account_type, SUM(jl.debit - jl.credit) AS net FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id
    WHERE je.company_id=$1 AND je.status='posted' AND je.entry_date BETWEEN $2 AND $3 AND a.account_type IN ('revenue','expense') AND COALESCE(je.source_document_type,'') <> ALL($4::text[]) GROUP BY a.id, a.code, a.name_ar, a.account_type HAVING ABS(SUM(jl.debit - jl.credit)) > 0.00005 ORDER BY a.code`, [companyId, from, to, CLOSING_SOURCES])).rows;
}

/** معاينة قيد إقفال السنة بلا ترحيل. */
export async function previewYearEnd(ctx: RequestContext, raw: z.input<typeof yearEndSchema>) {
  ctx.assertPermission('accounting.yearend.close'); const b = yearEndSchema.parse(raw);
  if (b.fromDate > b.toDate) throw new ValidationError('fromDate يجب أن يسبق toDate');
  const rows = await balances(pool as never, ctx.companyId, b.fromDate, b.toDate);
  const rev = rows.filter((r) => r.account_type === 'revenue'), exp = rows.filter((r) => r.account_type === 'expense');
  const revenue = r4(rev.reduce((s, r) => s - Number(r.net), 0)), expense = r4(exp.reduce((s, r) => s + Number(r.net), 0));
  return { fromDate: b.fromDate, toDate: b.toDate, accounts: rows.map((r) => ({ code: r.code, name: r.name_ar, type: r.account_type, balance: r4(Number(r.net)) })), revenue, expense, netIncome: r4(revenue - expense) };
}

export async function closeYear(ctx: RequestContext, raw: z.input<typeof yearEndSchema>) {
  ctx.assertPermission('accounting.yearend.close'); const b = yearEndSchema.parse(raw); const closingDate = b.closingDate ?? b.toDate;
  if (closingDate < b.fromDate || closingDate > b.toDate) throw new ValidationError('تاريخ القيد يجب أن يقع داخل الفترة');
  const ra = (await pool.query(`SELECT account_type FROM accounts WHERE id=$1 AND company_id=$2`, [b.retainedAccountId, ctx.companyId])).rows[0];
  if (!ra) throw new ValidationError('حساب الأرباح المرحَّلة غير موجود'); if (ra.account_type !== 'equity') throw new ValidationError('حساب الأرباح المرحَّلة يجب أن يكون من حقوق الملكية');
  return withTransaction(async (client) => {
    const overlap = (await client.query(`SELECT 1 FROM year_end_closings WHERE company_id=$1 AND status='posted' AND from_date <= $3 AND to_date >= $2`, [ctx.companyId, b.fromDate, b.toDate])).rows.length;
    if (overlap) throw new ConflictError('يوجد قيد إقفال سنة قائم يتداخل مع هذه الفترة');
    const rows = await balances(client as never, ctx.companyId, b.fromDate, b.toDate);
    if (!rows.length) throw new ValidationError('لا أرصدة إيرادات/مصروفات للإقفال في هذه الفترة');
    const lines: JournalLineInput[] = rows.map((r) => { const n = Number(r.net); return n > 0 ? { accountId: r.id, debit: '0', credit: n.toFixed(4), description: `إقفال ${r.code}` } : { accountId: r.id, debit: (-n).toFixed(4), credit: '0', description: `إقفال ${r.code}` }; });
    const sumDr = lines.reduce((s, l) => s + Number(l.debit), 0), sumCr = lines.reduce((s, l) => s + Number(l.credit), 0); const net = r4(sumDr - sumCr); // الفرق = صافي الدخل (ربح ⇒ مدين زائد ⇒ دائن الأرباح المرحَّلة)
    if (net > 0) lines.push({ accountId: b.retainedAccountId, debit: '0', credit: net.toFixed(4), description: 'صافي ربح السنة' }); else if (net < 0) lines.push({ accountId: b.retainedAccountId, debit: (-net).toFixed(4), credit: '0', description: 'صافي خسارة السنة' });
    const branchId = b.branchId ?? (await client.query(`SELECT id FROM branches WHERE company_id=$1 ORDER BY created_at LIMIT 1`, [ctx.companyId])).rows[0]?.id; if (!branchId) throw new ValidationError('لا فرع');
    const je = await postBaseEntry(ctx, client, { branchId, date: closingDate, lines, sourceType: 'year_end_close' });
    const rev = r4(rows.filter((r) => r.account_type === 'revenue').reduce((s, r) => s - Number(r.net), 0)), exp = r4(rows.filter((r) => r.account_type === 'expense').reduce((s, r) => s + Number(r.net), 0));
    const row = (await client.query(`INSERT INTO year_end_closings(company_id,branch_id,from_date,to_date,closing_date,retained_account_id,revenue_total,expense_total,net_income,accounts_closed,journal_entry_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [ctx.companyId, branchId, b.fromDate, b.toDate, closingDate, b.retainedAccountId, rev, exp, r4(rev - exp), rows.length, je, ctx.userId])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'year_end_closing', entityId: row.id, afterJson: { from: b.fromDate, to: b.toDate, net: r4(rev - exp) } });
    return row;
  });
}

export async function reverseYearEnd(ctx: RequestContext, id: string, raw: z.input<typeof reverseYearEndSchema>) {
  ctx.assertPermission('accounting.yearend.close'); const b = reverseYearEndSchema.parse(raw);
  return withTransaction(async (client) => {
    const y = (await client.query(`SELECT *, closing_date::text AS cd FROM year_end_closings WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!y) throw new NotFoundError('قيد الإقفال غير موجود'); if (y.status !== 'posted') throw new ConflictError('معكوس بالفعل');
    const ls = (await client.query(`SELECT account_id, debit, credit, description FROM journal_lines WHERE journal_entry_id=$1`, [y.journal_entry_id])).rows;
    const rje = await postBaseEntry(ctx, client, { branchId: y.branch_id, date: y.cd, sourceType: 'year_end_close_reversal', sourceId: y.journal_entry_id, lines: ls.map((l) => ({ accountId: l.account_id, debit: String(l.credit), credit: String(l.debit), description: `عكس: ${l.description ?? ''}` })) });
    const row = (await client.query(`UPDATE year_end_closings SET status='reversed', reversal_entry_id=$2, reverse_reason=$3, reversed_at=now() WHERE id=$1 RETURNING *`, [id, rje, b.reason])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'year_end_closing', entityId: id, afterJson: { reversed: true, reason: b.reason } });
    return row;
  });
}
export async function listYearEnd(ctx: RequestContext) {
  ctx.assertPermission('accounting.yearend.close');
  return (await pool.query(`SELECT id, from_date::text AS from_date, to_date::text AS to_date, closing_date::text AS closing_date, revenue_total, expense_total, net_income, accounts_closed, status FROM year_end_closings WHERE company_id=$1 ORDER BY to_date DESC, created_at DESC`, [ctx.companyId])).rows;
}
