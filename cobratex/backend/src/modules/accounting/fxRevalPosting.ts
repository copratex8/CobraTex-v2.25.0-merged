import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { revaluation } from '@/modules/accounting/fxRatesService';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { JournalLineInput } from '@/modules/accounting/accountingService';

/**
 * ترحيل قيد تقييم الأرصدة الأجنبية (2.7.0). لكل طرف: ربح غير محقَّق → مدين حساب الطرف / دائن حساب فروق التقييم؛ خسارة → العكس.
 * فرق السداد المحقَّق في النواة يُحسب مقابل سعر الفاتورة، فيجب عكس قيد التقييم قبل السداد أو في بداية الفترة التالية وإلا تكرر الفرق:
 * لذلك تقييم فعّال واحد فقط في آن واحد، ويُعكس بقيد معاكس بتاريخ لاحق (reversalDate عند الترحيل أو لاحقًا).
 */
const uuid = z.uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const postRevalSchema = z.strictObject({ asOf: date, reversalDate: date.optional(), branchId: uuid.optional() });
export const reverseRevalSchema = z.strictObject({ reversalDate: date });
export const accountsSchema = z.strictObject({ salesAllowanceAccountId: uuid.nullable().optional(), fxUnrealizedAccountId: uuid.nullable().optional() });
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const swap = (ls: JournalLineInput[]): JournalLineInput[] => ls.map((l) => ({ ...l, debit: l.credit, credit: l.debit, description: `عكس: ${l.description ?? ''}` }));

export async function setAccounts(ctx: RequestContext, b: z.infer<typeof accountsSchema>) {
  ctx.assertPermission('fx.rates.manage');
  for (const [k, v] of Object.entries(b)) if (v) { if (!(await pool.query(`SELECT 1 FROM accounts WHERE id=$1 AND company_id=$2`, [v, ctx.companyId])).rows.length) throw new ValidationError(`الحساب غير موجود (${k})`); }
  const r = (await pool.query(`UPDATE companies SET sales_allowance_account_id = CASE WHEN $2::boolean THEN $3::uuid ELSE sales_allowance_account_id END, fx_unrealized_account_id = CASE WHEN $4::boolean THEN $5::uuid ELSE fx_unrealized_account_id END WHERE id=$1 RETURNING sales_allowance_account_id, fx_unrealized_account_id`,
    [ctx.companyId, 'salesAllowanceAccountId' in b, b.salesAllowanceAccountId ?? null, 'fxUnrealizedAccountId' in b, b.fxUnrealizedAccountId ?? null])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'company_fx_accounts', entityId: ctx.companyId, afterJson: b });
  return r;
}
export async function getAccounts(ctx: RequestContext) {
  ctx.assertPermission('fx.rates.view');
  return (await pool.query(`SELECT sales_allowance_account_id, fx_unrealized_account_id FROM companies WHERE id=$1`, [ctx.companyId])).rows[0];
}

export async function postRevaluation(ctx: RequestContext, b: z.infer<typeof postRevalSchema>) {
  ctx.assertPermission('fx.reval.post');
  if (b.reversalDate && b.reversalDate <= b.asOf) throw new ValidationError('تاريخ العكس يجب أن يلي تاريخ التقييم');
  const rev = await revaluation(ctx, { asOf: b.asOf });
  if (rev.warnings.some((w) => /استُبعدت/.test(w))) throw new ValidationError(`لا يُرحَّل تقييم ناقص: ${rev.warnings.filter((w) => /استُبعدت/.test(w)).join(' ')}`);
  return withTransaction(async (client) => {
    const co = (await client.query(`SELECT fx_unrealized_account_id FROM companies WHERE id=$1 FOR UPDATE`, [ctx.companyId])).rows[0];
    if (!co.fx_unrealized_account_id) throw new ValidationError('حدّد حساب فروق التقييم غير المحقَّقة أولًا (PUT /fx/accounts)');
    if ((await client.query(`SELECT 1 FROM fx_revaluations WHERE company_id=$1 AND status='posted'`, [ctx.companyId])).rows.length) throw new ConflictError('يوجد تقييم فعّال لم يُعكس — اعكسه أولًا قبل ترحيل تقييم جديد');
    const byAcc = new Map<string, number>();
    for (const d of rev.documents) { if (!d.partyAccountId) throw new ValidationError(`الطرف ${d.party} بلا حساب مربوط`); byAcc.set(d.partyAccountId, (byAcc.get(d.partyAccountId) ?? 0) + d.unrealizedGainLoss); }
    const lines: JournalLineInput[] = []; let debits = 0, credits = 0;
    for (const [acc, v0] of byAcc) { const v = r4(v0); if (v === 0) continue;
      if (v > 0) { lines.push({ accountId: acc, debit: v.toFixed(4), credit: '0', description: `تقييم عملات حتى ${b.asOf} — ربح غير محقَّق` }); debits += v; }
      else { lines.push({ accountId: acc, debit: '0', credit: (-v).toFixed(4), description: `تقييم عملات حتى ${b.asOf} — خسارة غير محقَّقة` }); credits += -v; } }
    if (!lines.length) throw new ValidationError('لا فروق تقييم لترحيلها');
    const net = r4(debits - credits);
    if (net > 0) lines.push({ accountId: co.fx_unrealized_account_id, debit: '0', credit: net.toFixed(4), description: `فروق تقييم عملات ${b.asOf}` });
    else if (net < 0) lines.push({ accountId: co.fx_unrealized_account_id, debit: (-net).toFixed(4), credit: '0', description: `فروق تقييم عملات ${b.asOf}` });
    const br = b.branchId ?? (await client.query(`SELECT id FROM branches WHERE company_id=$1 ORDER BY created_at LIMIT 1`, [ctx.companyId])).rows[0]?.id;
    if (!br) throw new ValidationError('لا فرع لترحيل القيد');
    const je = await postBaseEntry(ctx, client, { branchId: br, date: b.asOf, lines, sourceType: 'fx_revaluation' });
    let rje: string | null = null;
    if (b.reversalDate) rje = await postBaseEntry(ctx, client, { branchId: br, date: b.reversalDate, lines: swap(lines), sourceType: 'fx_revaluation_reversal', sourceId: je });
    const row = (await client.query(`INSERT INTO fx_revaluations(company_id,branch_id,as_of,net_amount,detail,journal_entry_id,status,reversal_date,reversal_entry_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.companyId, br, b.asOf, net, { byCurrency: rev.byCurrency, documents: rev.documents.length }, je, rje ? 'reversed' : 'posted', b.reversalDate ?? null, rje, ctx.userId])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'fx_revaluation', entityId: row.id, afterJson: { asOf: b.asOf, net, reversalDate: b.reversalDate ?? null } });
    return { ...row, lines: lines.length };
  });
}

export async function reverseRevaluation(ctx: RequestContext, id: string, b: z.infer<typeof reverseRevalSchema>) {
  ctx.assertPermission('fx.reval.post');
  return withTransaction(async (client) => {
    const r = (await client.query(`SELECT * FROM fx_revaluations WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!r) throw new NotFoundError('التقييم غير موجود'); if (r.status !== 'posted') throw new ConflictError('التقييم معكوس بالفعل');
    const asOf = String(r.as_of instanceof Date ? r.as_of.toISOString() : r.as_of).slice(0, 10);
    if (b.reversalDate <= asOf) throw new ValidationError('تاريخ العكس يجب أن يلي تاريخ التقييم');
    const ls = (await client.query(`SELECT account_id, debit, credit, description FROM journal_lines WHERE journal_entry_id=$1`, [r.journal_entry_id])).rows;
    const rje = await postBaseEntry(ctx, client, { branchId: r.branch_id, date: b.reversalDate, sourceType: 'fx_revaluation_reversal', sourceId: r.journal_entry_id,
      lines: swap(ls.map((l) => ({ accountId: l.account_id, debit: String(l.debit), credit: String(l.credit), description: l.description ?? '' }))) });
    const row = (await client.query(`UPDATE fx_revaluations SET status='reversed', reversal_date=$2, reversal_entry_id=$3 WHERE id=$1 RETURNING *`, [id, b.reversalDate, rje])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'fx_revaluation', entityId: id, afterJson: { status: 'reversed', reversalDate: b.reversalDate } });
    return row;
  });
}
export async function listRevaluations(ctx: RequestContext) {
  ctx.assertPermission('fx.reval.view');
  return (await pool.query(`SELECT * FROM fx_revaluations WHERE company_id=$1 ORDER BY as_of DESC, created_at DESC LIMIT 100`, [ctx.companyId])).rows;
}
