import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { JournalLineInput } from '@/modules/accounting/accountingService';

/**
 * الأصول الثابتة والإهلاك (2.12.0). إهلاك شهري كامل الشهر يبدأ من شهر الاقتناء؛ قيد واحد لكل شهر (مجمَّع
 * على أزواج حسابات المصروف/المجمّع) داخل معاملة واحدة مع تحديث الأصول. أقساط القسط الثابت = (التكلفة − الخردة)/العمر
 * والشهر الأخير يأخذ الباقي؛ القسط المتناقص = القيمة الدفترية × 2/العمر بالأشهر ولا يهبط تحت الخردة.
 */
const uuid = z.uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD');
const money = z.string().regex(/^\d+(\.\d{1,4})?$/, 'مبلغ غير صالح');
export const assetSchema = z.strictObject({ code: z.string().min(1).max(40), nameAr: z.string().min(1), acquisitionDate: date, cost: money, salvageValue: money.default('0'), usefulLifeMonths: z.number().int().min(1).max(1200), method: z.enum(['straight_line', 'declining_balance']).default('straight_line'), assetAccountId: uuid, accumulatedAccountId: uuid, expenseAccountId: uuid, branchId: uuid.optional(), notes: z.string().optional(), acquisitionCreditAccountId: uuid.optional() });
export const runSchema = z.strictObject({ through: date, dryRun: z.boolean().optional().default(false) });
export const reverseSchema = z.strictObject({ periodEnd: date, reason: z.string().min(3) });
export const disposeSchema = z.strictObject({ date, proceeds: money.default('0'), proceedsAccountId: uuid.optional(), gainLossAccountId: uuid });
export const listSchema = z.object({ status: z.enum(['active', 'fully_depreciated', 'disposed']).optional() });
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export const monthEnd = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).toISOString().slice(0, 10);
const nextMonthEnd = (d: string) => { const [y, m] = d.split('-').map(Number); return monthEnd(y, m); }; // d شهر m (1-12) ⇒ m0 = m ⇒ الشهر التالي
const thisMonthEnd = (d: string) => { const [y, m] = d.split('-').map(Number); return monthEnd(y, m - 1); };

/** قسط شهر واحد (دالة صرفة). */
export function monthlyAmount(a: { cost: number; salvage: number; lifeMonths: number; method: string; accumulated: number; monthsDone: number }): number {
  const depreciable = a.cost - a.salvage; const left = r4(depreciable - a.accumulated);
  if (left <= 0.00005) return 0;
  if (a.method === 'straight_line') return a.monthsDone + 1 >= a.lifeMonths ? left : Math.min(left, r4(depreciable / a.lifeMonths));
  const nbv = a.cost - a.accumulated;
  return Math.min(left, r4((nbv * 2) / a.lifeMonths));
}
/** جدول الإهلاك المتوقَّع المتبقي (للمعاينة). */
export function projectSchedule(a: { cost: number; salvage: number; lifeMonths: number; method: string; accumulated: number; startMonthEnd: string }, maxMonths = 600) {
  const out: Array<{ periodEnd: string; amount: number; accumulated: number; nbv: number }> = [];
  let acc = a.accumulated, pe = a.startMonthEnd, done = 0;
  while (out.length < maxMonths) {
    const amt = monthlyAmount({ ...a, accumulated: acc, monthsDone: done });
    if (amt <= 0) break;
    acc = r4(acc + amt); out.push({ periodEnd: pe, amount: amt, accumulated: acc, nbv: r4(a.cost - acc) }); pe = nextMonthEnd(pe); done++;
    if (a.method === 'declining_balance' && amt < 0.01) break;
  }
  return out;
}

async function accountOk(ctx: RequestContext, id: string, label: string, type?: string[]) {
  const r = (await pool.query(`SELECT account_type FROM accounts WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!r) throw new ValidationError(`${label}: الحساب غير موجود`);
  if (type && !type.includes(r.account_type)) throw new ValidationError(`${label}: نوع الحساب غير مناسب (${r.account_type})`);
}

export async function createAsset(ctx: RequestContext, raw: z.input<typeof assetSchema>) {
  ctx.assertPermission('assets.manage');
  const b = assetSchema.parse(raw);
  if (Number(b.salvageValue) >= Number(b.cost)) throw new ValidationError('قيمة الخردة يجب أن تقل عن التكلفة');
  await accountOk(ctx, b.assetAccountId, 'حساب الأصل', ['asset']); await accountOk(ctx, b.accumulatedAccountId, 'حساب مجمّع الإهلاك', ['asset', 'liability']); await accountOk(ctx, b.expenseAccountId, 'حساب مصروف الإهلاك', ['expense']);
  const br = b.branchId ?? (await pool.query(`SELECT id FROM branches WHERE company_id=$1 ORDER BY created_at LIMIT 1`, [ctx.companyId])).rows[0]?.id;
  if (!br) throw new ValidationError('لا فرع');
  if (b.acquisitionCreditAccountId) await accountOk(ctx, b.acquisitionCreditAccountId, 'حساب مقابل الاقتناء', ['asset', 'liability', 'equity']);
  try {
    return await withTransaction(async (client) => {
      const row = (await client.query(`INSERT INTO fixed_assets(company_id,branch_id,code,name_ar,acquisition_date,cost,salvage_value,useful_life_months,method,asset_account_id,accumulated_account_id,expense_account_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [ctx.companyId, br, b.code, b.nameAr, b.acquisitionDate, b.cost, b.salvageValue, b.usefulLifeMonths, b.method, b.assetAccountId, b.accumulatedAccountId, b.expenseAccountId, b.notes ?? null, ctx.userId])).rows[0];
      if (b.acquisitionCreditAccountId) {
        const je = await postBaseEntry(ctx, client, { branchId: br, date: b.acquisitionDate, sourceType: 'fixed_asset_acquisition', sourceId: row.id, lines: [{ accountId: b.assetAccountId, debit: b.cost, credit: '0', description: `اقتناء ${b.code}` }, { accountId: b.acquisitionCreditAccountId, debit: '0', credit: b.cost, description: `اقتناء ${b.code}` }] });
        row.acquisition_entry_id = (await client.query(`UPDATE fixed_assets SET acquisition_entry_id=$2 WHERE id=$1 RETURNING acquisition_entry_id`, [row.id, je])).rows[0].acquisition_entry_id;
      }
      await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'fixed_asset', entityId: row.id, afterJson: { code: b.code, cost: b.cost, acquisitionPosted: !!b.acquisitionCreditAccountId } });
      return row;
    });
  } catch (e: any) { if (e.code === '23505') throw new ConflictError('كود الأصل مستخدم'); throw e; } // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function listAssets(ctx: RequestContext, raw: z.input<typeof listSchema>) {
  ctx.assertPermission('assets.view'); const q = listSchema.parse(raw);
  const p: unknown[] = [ctx.companyId]; let w = 'company_id=$1'; if (q.status) { p.push(q.status); w += ` AND status=$${p.length}`; }
  const rows = (await pool.query(`SELECT *, (cost - accumulated_depreciation) AS net_book_value FROM fixed_assets WHERE ${w} ORDER BY code`, p)).rows;
  const sum = (k: string) => r4(rows.filter((r) => r.status !== 'disposed').reduce((s, r) => s + Number(r[k]), 0));
  return { assets: rows, totals: { cost: sum('cost'), accumulated: sum('accumulated_depreciation'), netBookValue: sum('net_book_value') } };
}

export async function assetCard(ctx: RequestContext, id: string) {
  ctx.assertPermission('assets.view');
  const a = (await pool.query(`SELECT *, acquisition_date::text AS acq_text, depreciated_through::text AS dt_text FROM fixed_assets WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!a) throw new NotFoundError('الأصل غير موجود');
  const history = (await pool.query(`SELECT period_end::text AS period_end, amount, status, journal_entry_id FROM fixed_asset_depreciations WHERE asset_id=$1 ORDER BY period_end, created_at`, [id])).rows;
  const done = history.filter((h) => h.status === 'posted').length;
  const start = a.depreciated_through ? nextMonthEnd(a.dt_text) : thisMonthEnd(a.acq_text);
  const schedule = a.status === 'active' ? projectSchedule({ cost: Number(a.cost), salvage: Number(a.salvage_value), lifeMonths: a.useful_life_months, method: a.method, accumulated: Number(a.accumulated_depreciation), startMonthEnd: start }).map((s, i) => ({ ...s, n: done + i + 1 })) : [];
  return { asset: { ...a, net_book_value: r4(Number(a.cost) - Number(a.accumulated_depreciation)) }, history, schedule };
}

/** تشغيل الإهلاك حتى نهاية شهر `through`: قيد لكل شهر. dryRun = معاينة بلا ترحيل. */
export async function runDepreciation(ctx: RequestContext, raw: z.input<typeof runSchema>) {
  ctx.assertPermission('assets.depreciate');
  const b = runSchema.parse(raw); const through = thisMonthEnd(b.through);
  const assets = (await pool.query(`SELECT *, acquisition_date::text AS acq_text, depreciated_through::text AS dt_text FROM fixed_assets WHERE company_id=$1 AND status='active' ORDER BY code`, [ctx.companyId])).rows;
  type Item = { asset: any; periodEnd: string; amount: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const items: Item[] = [];
  for (const a of assets) {
    let acc = Number(a.accumulated_depreciation);
    let pe = a.depreciated_through ? nextMonthEnd(a.dt_text) : thisMonthEnd(a.acq_text);
    let done = (await pool.query(`SELECT count(*)::int AS n FROM fixed_asset_depreciations WHERE asset_id=$1 AND status='posted'`, [a.id])).rows[0].n;
    while (pe <= through) {
      const amt = monthlyAmount({ cost: Number(a.cost), salvage: Number(a.salvage_value), lifeMonths: a.useful_life_months, method: a.method, accumulated: acc, monthsDone: done });
      if (amt <= 0) break;
      items.push({ asset: a, periodEnd: pe, amount: amt }); acc = r4(acc + amt); done++; pe = nextMonthEnd(pe);
    }
  }
  const months = [...new Set(items.map((i) => i.periodEnd))].sort();
  if (months.length > 36) throw new ValidationError('أكثر من ٣٦ شهرًا في تشغيل واحد — قسّمه على دفعات');
  const summary = months.map((m) => ({ periodEnd: m, assets: items.filter((i) => i.periodEnd === m).length, total: r4(items.filter((i) => i.periodEnd === m).reduce((s, i) => s + i.amount, 0)) }));
  if (b.dryRun || !items.length) return { dryRun: b.dryRun, months: summary, total: r4(summary.reduce((s, m) => s + m.total, 0)), posted: [] };
  return withTransaction(async (client) => {
    const posted: Array<{ periodEnd: string; journalEntryId: string }> = [];
    for (const m of months) {
      const mi = items.filter((i) => i.periodEnd === m);
      const exp = new Map<string, number>(), acc = new Map<string, number>();
      for (const i of mi) { exp.set(i.asset.expense_account_id, r4((exp.get(i.asset.expense_account_id) ?? 0) + i.amount)); acc.set(i.asset.accumulated_account_id, r4((acc.get(i.asset.accumulated_account_id) ?? 0) + i.amount)); }
      const lines: JournalLineInput[] = [...[...exp].map(([accountId, v]) => ({ accountId, debit: v.toFixed(4), credit: '0', description: `إهلاك ${m}` })), ...[...acc].map(([accountId, v]) => ({ accountId, debit: '0', credit: v.toFixed(4), description: `مجمّع إهلاك ${m}` }))];
      const je = await postBaseEntry(ctx, client, { branchId: mi[0].asset.branch_id, date: m, lines, sourceType: 'fixed_asset_depreciation' });
      for (const i of mi) {
        await client.query(`INSERT INTO fixed_asset_depreciations(company_id,asset_id,period_end,amount,journal_entry_id,created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.companyId, i.asset.id, m, i.amount, je, ctx.userId]);
        const na = (await client.query(`UPDATE fixed_assets SET accumulated_depreciation = accumulated_depreciation + $2, depreciated_through = $3, status = CASE WHEN cost - salvage_value - (accumulated_depreciation + $2) <= 0.00005 THEN 'fully_depreciated' ELSE status END WHERE id=$1 RETURNING status`, [i.asset.id, i.amount, m])).rows[0];
        void na;
      }
      posted.push({ periodEnd: m, journalEntryId: je });
      await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'fixed_asset_depreciation_run', entityId: je, afterJson: { periodEnd: m, assets: mi.length } });
    }
    return { dryRun: false, months: summary, total: r4(summary.reduce((s, m) => s + m.total, 0)), posted };
  });
}

/** عكس إهلاك شهر كامل (قيد معاكس بنفس التاريخ) — لا يجوز إن وُجد إهلاك لاحق لأي أصل فيه أو كان مستبعَدًا. */
export async function reverseDepreciation(ctx: RequestContext, raw: z.input<typeof reverseSchema>) {
  ctx.assertPermission('assets.depreciate');
  const b = reverseSchema.parse(raw);
  return withTransaction(async (client) => {
    const rows = (await client.query(`SELECT d.*, a.status AS asset_status, a.branch_id FROM fixed_asset_depreciations d JOIN fixed_assets a ON a.id=d.asset_id WHERE d.company_id=$1 AND d.period_end=$2 AND d.status='posted' FOR UPDATE OF d, a`, [ctx.companyId, b.periodEnd])).rows;
    if (!rows.length) throw new NotFoundError('لا إهلاك مرحَّل لهذا الشهر');
    for (const r of rows) {
      if (r.asset_status === 'disposed') throw new ConflictError('أصل مستبعَد ضمن هذا الشهر');
      const later = (await client.query(`SELECT 1 FROM fixed_asset_depreciations WHERE asset_id=$1 AND status='posted' AND period_end > $2`, [r.asset_id, b.periodEnd])).rows.length;
      if (later) throw new ConflictError('يوجد إهلاك لاحق — اعكس الأحدث أولًا');
    }
    for (const je of [...new Set(rows.map((r) => r.journal_entry_id))]) {
      const ls = (await client.query(`SELECT account_id, debit, credit, description FROM journal_lines WHERE journal_entry_id=$1`, [je])).rows;
      const rje = await postBaseEntry(ctx, client, { branchId: rows[0].branch_id, date: b.periodEnd, sourceType: 'fixed_asset_depreciation_reversal', sourceId: je, lines: ls.map((l) => ({ accountId: l.account_id, debit: String(l.credit), credit: String(l.debit), description: `عكس: ${l.description ?? ''}` })) });
      await client.query(`UPDATE fixed_asset_depreciations SET status='reversed', reversal_entry_id=$2, reverse_reason=$3 WHERE journal_entry_id=$1 AND status='posted'`, [je, rje, b.reason]);
    }
    for (const r of rows) {
      const prev = (await client.query(`SELECT max(period_end)::text AS m FROM fixed_asset_depreciations WHERE asset_id=$1 AND status='posted'`, [r.asset_id])).rows[0].m;
      await client.query(`UPDATE fixed_assets SET accumulated_depreciation = accumulated_depreciation - $2, depreciated_through=$3, status='active' WHERE id=$1`, [r.asset_id, r.amount, prev]);
    }
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'fixed_asset_depreciation_run', entityId: rows[0].journal_entry_id, afterJson: { reversed: b.periodEnd, reason: b.reason } });
    return { reversed: rows.length, periodEnd: b.periodEnd };
  });
}

/** استبعاد/بيع أصل: Dr مجمّع + Dr حصيلة (إن وُجدت) + Dr خسارة | Cr الأصل (التكلفة) + Cr ربح. يلزم اكتمال الإهلاك حتى نهاية الشهر السابق لتاريخ الاستبعاد. */
export async function disposeAsset(ctx: RequestContext, id: string, raw: z.input<typeof disposeSchema>) {
  ctx.assertPermission('assets.dispose');
  const b = disposeSchema.parse(raw); const proceeds = Number(b.proceeds);
  if (proceeds > 0 && !b.proceedsAccountId) throw new ValidationError('حساب الحصيلة مطلوب عند وجود مبلغ بيع');
  if (b.proceedsAccountId) await accountOk(ctx, b.proceedsAccountId, 'حساب الحصيلة', ['asset']);
  await accountOk(ctx, b.gainLossAccountId, 'حساب ربح/خسارة الاستبعاد', ['revenue', 'expense']);
  return withTransaction(async (client) => {
    const a = (await client.query(`SELECT *, acquisition_date::text AS acq_text, depreciated_through::text AS dt_text FROM fixed_assets WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!a) throw new NotFoundError('الأصل غير موجود'); if (a.status === 'disposed') throw new ConflictError('الأصل مستبعَد بالفعل');
    const acq = a.acq_text; if (b.date < acq) throw new ValidationError('تاريخ الاستبعاد يسبق الاقتناء');
    const [y, m] = b.date.split('-').map(Number); const prevEnd = monthEnd(y, m - 2);
    const dt = a.depreciated_through ? a.dt_text : null;
    const needed = prevEnd >= thisMonthEnd(acq);
    const remaining = r4(Number(a.cost) - Number(a.salvage_value) - Number(a.accumulated_depreciation));
    if (a.status === 'active' && needed && (!dt || dt < prevEnd) && remaining > 0.00005) throw new ValidationError(`شغِّل الإهلاك حتى ${prevEnd} قبل الاستبعاد`);
    const acc = Number(a.accumulated_depreciation), nbv = r4(Number(a.cost) - acc), gl = r4(proceeds - nbv);
    const lines: JournalLineInput[] = [{ accountId: a.accumulated_account_id, debit: acc.toFixed(4), credit: '0', description: `استبعاد ${a.code}` }, { accountId: a.asset_account_id, debit: '0', credit: Number(a.cost).toFixed(4), description: `استبعاد ${a.code}` }];
    if (proceeds > 0) lines.push({ accountId: b.proceedsAccountId!, debit: proceeds.toFixed(4), credit: '0', description: `حصيلة بيع ${a.code}` });
    if (gl > 0) lines.push({ accountId: b.gainLossAccountId, debit: '0', credit: gl.toFixed(4), description: `ربح بيع ${a.code}` });
    else if (gl < 0) lines.push({ accountId: b.gainLossAccountId, debit: (-gl).toFixed(4), credit: '0', description: `خسارة استبعاد ${a.code}` });
    const lines2 = lines.filter((l) => Number(l.debit) > 0 || Number(l.credit) > 0);
    const je = await postBaseEntry(ctx, client, { branchId: a.branch_id, date: b.date, lines: lines2, sourceType: 'fixed_asset_disposal', sourceId: id });
    const row = (await client.query(`UPDATE fixed_assets SET status='disposed', disposed_at=$2, disposal_proceeds=$3, disposal_entry_id=$4 WHERE id=$1 RETURNING *`, [id, b.date, proceeds, je])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'fixed_asset', entityId: id, afterJson: { disposed: b.date, proceeds, gainLoss: gl } });
    return { asset: row, nbvAtDisposal: nbv, gainLoss: gl, journalEntryId: je };
  });
}
