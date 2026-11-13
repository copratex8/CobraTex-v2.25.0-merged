import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { z } from 'zod';

/**
 * أسعار الصرف والعملات (هجرة 0057). السعر = وحدات عملة الأساس لكل 1 وحدة أجنبية.
 * أنواع السعر: mid متوسط، buy شراء (يُستخدم لمستندات الشراء والمدفوعات)، sell بيع (للمبيعات والمقبوضات)؛ وغيابه يرجع إلى mid.
 */
type Q = { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = z.string().regex(/^[A-Za-z]{3}$/, 'رمز العملة 3 أحرف').transform((s) => s.toUpperCase());
export const currencyBodySchema = z.strictObject({ code, name: z.string().min(2).max(60), nameAr: z.string().max(60).optional(), symbol: z.string().max(6).optional(), decimals: z.number().int().min(0).max(4).optional(), isActive: z.boolean().optional() });
export const rateBodySchema = z.strictObject({ currencyCode: code, rateDate: date, rate: z.number().positive().max(1e9), rateType: z.enum(['mid', 'buy', 'sell']).optional(), source: z.string().max(60).optional() });
export const bulkRatesSchema = z.strictObject({ rates: z.array(rateBodySchema).min(1).max(500) });
export const rateQuerySchema = z.object({ currency: code, date: date.optional(), type: z.enum(['mid', 'buy', 'sell']).optional() });
export const ratesListSchema = z.object({ currency: code.optional(), from: date.optional(), to: date.optional() });
export const convertQuerySchema = z.object({ amount: z.coerce.number(), from: code, to: code, date: date.optional(), type: z.enum(['mid', 'buy', 'sell']).optional() });
export const revalQuerySchema = z.object({ asOf: date.optional() });
const STALE_DAYS = 3, MAX_JUMP = 0.1, MAX_MANUAL_DEVIATION = 0.3;
const today = () => new Date().toISOString().slice(0, 10);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6, r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export async function baseCurrency(db: Q, companyId: string): Promise<string> {
  const r = (await db.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [companyId])).rows[0];
  if (!r) throw new NotFoundError('الشركة غير موجودة'); return r.base_currency_code;
}

export async function listCurrencies(ctx: RequestContext) {
  ctx.assertPermission('fx.rates.view');
  const base = await baseCurrency(pool, ctx.companyId);
  return (await pool.query(`SELECT code, name, name_ar, symbol, decimals, is_active FROM currencies ORDER BY (code=$1) DESC, is_active DESC, code`, [base])).rows.map((c) => ({ ...c, isBase: c.code === base }));
}
export async function upsertCurrency(ctx: RequestContext, b: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx.assertPermission('fx.rates.manage');
  const base = await baseCurrency(pool, ctx.companyId);
  if (b.code === base && b.isActive === false) throw new ValidationError('لا يمكن تعطيل عملة الأساس');
  const r = (await pool.query(
    `INSERT INTO currencies(code,name,name_ar,symbol,decimals,is_active) VALUES ($1,$2,$3,$4,COALESCE($5,2),COALESCE($6,true))
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, name_ar=COALESCE(EXCLUDED.name_ar,currencies.name_ar), symbol=COALESCE(EXCLUDED.symbol,currencies.symbol), decimals=COALESCE($5,currencies.decimals), is_active=COALESCE($6,currencies.is_active) RETURNING *`,
    [b.code, b.name, b.nameAr ?? null, b.symbol ?? null, b.decimals ?? null, b.isActive ?? null])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'currency', entityId: ctx.companyId, afterJson: { code: b.code, isActive: r.is_active } });
  return r;
}

async function setRateTx(db: Q, ctx: RequestContext, base: string, b: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (b.currencyCode === base) throw new ValidationError('لا سعر صرف لعملة الأساس (دائمًا 1)');
  const cur = (await db.query(`SELECT is_active FROM currencies WHERE code=$1`, [b.currencyCode])).rows[0];
  if (!cur) throw new ValidationError(`العملة ${b.currencyCode} غير معرَّفة — أضفها أولًا`); if (!cur.is_active) throw new ValidationError(`العملة ${b.currencyCode} معطَّلة`);
  const type = b.rateType ?? 'mid';
  const prev = (await db.query(`SELECT rate FROM exchange_rates WHERE company_id=$1 AND currency_code=$2 AND rate_type=$3 AND rate_date<$4 ORDER BY rate_date DESC LIMIT 1`, [ctx.companyId, b.currencyCode, type, b.rateDate])).rows[0];
  const r = (await db.query(
    `INSERT INTO exchange_rates(company_id,currency_code,rate_date,rate_type,rate,source,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id,currency_code,rate_date,rate_type) DO UPDATE SET rate=EXCLUDED.rate, source=EXCLUDED.source, created_by=EXCLUDED.created_by RETURNING *`,
    [ctx.companyId, b.currencyCode, b.rateDate, type, b.rate, b.source ?? null, ctx.userId])).rows[0];
  const jump = prev ? Math.abs(b.rate - Number(prev.rate)) / Number(prev.rate) : 0;
  return { ...r, warning: jump > MAX_JUMP ? `تغيّر السعر ${r4(jump * 100)}% عن آخر سعر مسجَّل (${prev.rate}) — تأكد من الإدخال` : null };
}
export async function setRate(ctx: RequestContext, b: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx.assertPermission('fx.rates.manage');
  const base = await baseCurrency(pool, ctx.companyId); const r = await setRateTx(pool, ctx, base, b);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'exchange_rate', entityId: r.id, afterJson: { c: b.currencyCode, d: b.rateDate, rate: b.rate, type: b.rateType ?? 'mid' } });
  return r;
}
export async function setRates(ctx: RequestContext, b: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx.assertPermission('fx.rates.manage');
  return withTransaction(async (client) => {
    const base = await baseCurrency(client, ctx.companyId); const out = [];
    for (const x of b.rates) out.push(await setRateTx(client, ctx, base, x));
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'exchange_rate_batch', entityId: ctx.companyId, afterJson: { count: out.length } });
    return { saved: out.length, warnings: out.filter((r) => r.warning).map((r) => `${r.currency_code} ${String(r.rate_date).slice(0, 10)}: ${r.warning}`) };
  });
}
export async function listRates(ctx: RequestContext, q: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx.assertPermission('fx.rates.view');
  return (await pool.query(`SELECT * FROM exchange_rates WHERE company_id=$1 AND ($2::text IS NULL OR currency_code=$2) AND ($3::date IS NULL OR rate_date>=$3) AND ($4::date IS NULL OR rate_date<=$4) ORDER BY rate_date DESC, currency_code, rate_type LIMIT 1000`, [ctx.companyId, q.currency ?? null, q.from ?? null, q.to ?? null])).rows;
}

/** آخر سعر بتاريخ ≤ المطلوب. النوع المطلوب أولًا ثم mid. يُعلن العمر والتقادم. */
export async function findRate(db: Q, companyId: string, currency: string, on: string, type: 'mid' | 'buy' | 'sell' = 'mid') {
  const base = await baseCurrency(db, companyId);
  if (currency === base) return { rate: 1, rateDate: on, ageDays: 0, stale: false, type: 'base' as const };
  const r = (await db.query(`SELECT rate, rate_date, rate_type FROM exchange_rates WHERE company_id=$1 AND currency_code=$2 AND rate_date<=$3 AND rate_type IN ($4,'mid') ORDER BY rate_date DESC, (rate_type=$4) DESC LIMIT 1`, [companyId, currency, on, type])).rows[0];
  if (!r) return null;
  const d = String(r.rate_date).slice(0, 10), age = Math.round((new Date(on).getTime() - new Date(d).getTime()) / 86400000);
  return { rate: Number(r.rate), rateDate: d, ageDays: age, stale: age > STALE_DAYS, type: r.rate_type as string };
}
export async function getRate(ctx: RequestContext, q: { currency: string; date?: string; type?: 'mid' | 'buy' | 'sell' }) {
  ctx.assertPermission('fx.rates.view');
  const r = await findRate(pool, ctx.companyId, q.currency, q.date ?? today(), q.type ?? 'mid');
  if (!r) throw new NotFoundError(`لا سعر صرف للعملة ${q.currency} في أو قبل ${q.date ?? today()}`);
  return { currency: q.currency, ...r };
}
/** تحويل بين أي عملتين عبر عملة الأساس: السعر المركّب = rate(from)/rate(to). */
export async function convert(ctx: RequestContext, q: { amount: number; from: string; to: string; date?: string; type?: 'mid' | 'buy' | 'sell' }) {
  ctx.assertPermission('fx.rates.view');
  const on = q.date ?? today(); const f = await findRate(pool, ctx.companyId, q.from, on, q.type ?? 'mid'), t = await findRate(pool, ctx.companyId, q.to, on, q.type ?? 'mid');
  if (!f) throw new NotFoundError(`لا سعر لـ ${q.from}`); if (!t) throw new NotFoundError(`لا سعر لـ ${q.to}`);
  const cross = f.rate / t.rate;
  return { amount: q.amount, from: q.from, to: q.to, rate: r6(cross), result: r4(q.amount * cross), stale: f.stale || t.stale, ratesDate: [f.rateDate, t.rateDate].sort().at(-1) };
}

/**
 * سعر مستند: عملة الأساس ← '1'. أجنبية بسعر مُمرَّر ← يُحقَّق موجبًا ويُرفض إن انحرف >30% عن سعر الجدول (حماية من خطأ الإدخال)، وإلا يُستخدم كما هو.
 * أجنبية بلا سعر ← من الجدول (بيع للمبيعات/المقبوضات، شراء للمشتريات/المدفوعات)، وإن لم يوجد → رفض صريح بدل الصمت على 1.
 */
export async function resolveDocumentRate(ctx: RequestContext, currencyCode: string, on: string, given: string | undefined, type: 'buy' | 'sell', db: Q = pool): Promise<string> {
  const base = await baseCurrency(db, ctx.companyId);
  if (currencyCode === base) return given ?? '1';
  if (given !== undefined && given !== null && given !== '') {
    const g = Number(given); if (!(g > 0)) throw new ValidationError('سعر الصرف يجب أن يكون موجبًا');
    const t = await findRate(db, ctx.companyId, currencyCode, on, type);
    if (t && g !== 1 && Math.abs(g - t.rate) / t.rate > MAX_MANUAL_DEVIATION) throw new ValidationError(`سعر الصرف المُدخَل ${given} ينحرف أكثر من 30% عن سعر ${currencyCode} المسجَّل (${t.rate} بتاريخ ${t.rateDate}) — راجعه أو حدّث جدول الأسعار`);
    return String(given);
  }
  const t = await findRate(db, ctx.companyId, currencyCode, on, type);
  if (!t) throw new ValidationError(`لا يوجد سعر صرف لـ ${currencyCode} في أو قبل ${on} — أضِف السعر من «أسعار الصرف» أو مرّره يدويًا`);
  return String(t.rate);
}

/**
 * تقييم الأرصدة الأجنبية المفتوحة (تحليلي، بلا ترحيل): مستحق الفاتورة بعملتها × (سعر التقييم − سعر الفاتورة).
 * مدينون: فرق موجب = ربح غير محقَّق؛ دائنون: العكس. المتبقي = صافي الأسطر − المرتجعات المرحَّلة − التخصيصات.
 */
export async function revaluation(ctx: RequestContext, q: { asOf?: string }) {
  ctx.assertPermission('fx.reval.view');
  const asOf = q.asOf ?? today(); const base = await baseCurrency(pool, ctx.companyId);
  const recv = (await pool.query(
    `SELECT i.id, i.document_number, i.currency_code, i.exchange_rate, i.invoice_date, p.name_ar AS party, p.linked_account_id AS party_account,
            (SELECT COALESCE(SUM(line_total),0) FROM sales_invoice_lines WHERE sales_invoice_id=i.id)
          - (SELECT COALESCE(SUM(srl.line_total),0) FROM sales_return_lines srl JOIN sales_returns sr ON sr.id=srl.sales_return_id WHERE sr.sales_invoice_id=i.id AND sr.status='posted')
          - (SELECT COALESCE(SUM(allocated_amount),0) FROM customer_payment_allocations WHERE sales_invoice_id=i.id) AS outstanding
     FROM sales_invoices i JOIN customers p ON p.id=i.customer_id AND p.company_id=i.company_id WHERE i.company_id=$1 AND i.status='posted' AND i.currency_code<>$2 AND i.invoice_date<=$3`, [ctx.companyId, base, asOf])).rows.map((r) => ({ ...r, kind: 'receivable' }));
  const pay = (await pool.query(
    `SELECT i.id, i.document_number, i.currency_code, i.exchange_rate, i.invoice_date, p.name_ar AS party, p.linked_account_id AS party_account,
            (SELECT COALESCE(SUM(line_total),0) FROM supplier_invoice_lines WHERE supplier_invoice_id=i.id)
          - (SELECT COALESCE(SUM(prl.line_total),0) FROM purchase_return_lines prl JOIN purchase_returns pr ON pr.id=prl.purchase_return_id WHERE pr.supplier_invoice_id=i.id AND pr.status='posted')
          - (SELECT COALESCE(SUM(allocated_amount),0) FROM supplier_payment_allocations WHERE supplier_invoice_id=i.id) AS outstanding
     FROM supplier_invoices i JOIN suppliers p ON p.id=i.supplier_id AND p.company_id=i.company_id WHERE i.company_id=$1 AND i.status='posted' AND i.currency_code<>$2 AND i.invoice_date<=$3`, [ctx.companyId, base, asOf])).rows.map((r) => ({ ...r, kind: 'payable' }));
  const warnings: string[] = []; const cache = new Map<string, number | null>(); const rows = [];
  for (const d of [...recv, ...pay]) {
    const out = Number(d.outstanding); if (!(out > 0.00005)) continue;
    if (!cache.has(d.currency_code)) { const f = await findRate(pool, ctx.companyId, d.currency_code, asOf, 'mid'); cache.set(d.currency_code, f ? f.rate : null); if (!f) warnings.push(`لا سعر تقييم للعملة ${d.currency_code} حتى ${asOf}: استُبعدت مستنداتها.`); else if (f.stale) warnings.push(`سعر ${d.currency_code} قديم (${f.ageDays} يوم).`); }
    const nr = cache.get(d.currency_code); if (nr === null || nr === undefined) continue;
    const bookBase = out * Number(d.exchange_rate), newBase = out * nr;
    const diff = d.kind === 'receivable' ? newBase - bookBase : bookBase - newBase;
    rows.push({ kind: d.kind, documentNumber: d.document_number, party: d.party, partyAccountId: d.party_account, currency: d.currency_code, invoiceDate: String(d.invoice_date).slice(0, 10), outstanding: r4(out), bookRate: Number(d.exchange_rate), revalRate: nr, bookBase: r4(bookBase), revaluedBase: r4(newBase), unrealizedGainLoss: r4(diff) });
  }
  const byCurrency = new Map<string, { currency: string; receivables: number; payables: number; net: number }>();
  for (const r of rows) { const e = byCurrency.get(r.currency) ?? { currency: r.currency, receivables: 0, payables: 0, net: 0 }; if (r.kind === 'receivable') e.receivables += r.unrealizedGainLoss; else e.payables += r.unrealizedGainLoss; e.net += r.unrealizedGainLoss; byCurrency.set(r.currency, e); }
  const totals = [...byCurrency.values()].map((e) => ({ currency: e.currency, receivables: r4(e.receivables), payables: r4(e.payables), net: r4(e.net) }));
  return { asOf, baseCurrency: base, documents: rows, byCurrency: totals, netUnrealized: r4(totals.reduce((s, t) => s + t.net, 0)), warnings: [...new Set(warnings)] };
}
