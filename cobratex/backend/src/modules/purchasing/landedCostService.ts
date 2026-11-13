import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { resolveDocumentRate } from '@/modules/accounting/fxRatesService';
import { JournalLineInput } from '@/modules/accounting/accountingService';

/**
 * التكاليف الإضافية على المشتريات (Landed Cost) — 2.14.0. تُوزَّع مكوّنات (شحن/جمارك/تأمين/تخليص…) على أسطر
 * إيصالات استلام مرحَّلة بطريقة تُختار لكل مكوّن (القيمة/الكمية/الوزن/الحجم/بالتساوي/نِسَب يدوية) ضمن الطرق
 * المسموحة للشركة. الجزء الباقي في المخزون يُرسمَل في متوسط التكلفة المرجَّح؛ الجزء المستهلَك يُحمَّل على حساب
 * الفروق (سياسة expense_consumed) أو يُرسمَل كله على الباقي (capitalize_remaining). لا يمس خدمات المخزون:
 * يُحدَّث متوسط التكلفة في stock_balances فقط، والسجل في landed_cost_lines (مصدر إعادة التطبيق بعد أي إعادة بناء).
 */
export const METHODS = ['value', 'quantity', 'weight', 'volume', 'equal', 'manual'] as const;
type Method = (typeof METHODS)[number];
const uuid = z.uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD'); const money = z.string().regex(/^\d+(\.\d{1,4})?$/, 'مبلغ غير صالح');
export const settingsSchema = z.strictObject({ defaultMethod: z.enum(METHODS).optional(), allowedMethods: z.array(z.enum(METHODS)).min(1).optional(), consumedPolicy: z.enum(['expense_consumed', 'capitalize_remaining']).optional(), inventoryAccountId: uuid.nullable().optional(), varianceAccountId: uuid.nullable().optional() });
const component = z.strictObject({ name: z.string().min(1), amount: money, currency: z.string().length(3).optional(), exchangeRate: z.string().optional(), method: z.enum(METHODS).optional(), creditAccountId: uuid, supplierId: uuid.optional(), reference: z.string().optional() });
const line = z.strictObject({ goodsReceiptLineId: uuid, weight: money.optional(), volume: money.optional(), manualPercent: money.optional() });
export const docSchema = z.strictObject({ docNo: z.string().min(1).max(40).optional(), docDate: date, branchId: uuid.optional(), method: z.enum(METHODS).optional(), components: z.array(component).min(1), lines: z.array(line).min(1), notes: z.string().optional() });
export const previewSchema = docSchema.omit({ docNo: true, notes: true });
export const reverseSchema = z.strictObject({ reason: z.string().min(3) });
export const reportSchema = z.object({ from: date, to: date });
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** توزيع مبلغ على أسطر بالأوزان مع تصحيح الباقي على أكبر سطر ليتطابق المجموع تمامًا. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) throw new ValidationError('مجموع أساس التوزيع صفر');
  const out = weights.map((w) => r4((total * w) / sum));
  const diff = r4(total - out.reduce((s, v) => s + v, 0));
  if (diff !== 0) { let k = 0; weights.forEach((w, i) => { if (w > weights[k]) k = i; }); out[k] = r4(out[k] + diff); }
  return out;
}
export function basisFor(method: Method, l: { value: number; qty: number; weight: number | null; volume: number | null; manualPercent: number | null }): number {
  switch (method) {
    case 'value': return l.value; case 'quantity': return l.qty; case 'equal': return 1;
    case 'weight': if (l.weight === null) throw new ValidationError('طريقة الوزن تتطلب وزنًا لكل سطر'); return l.weight;
    case 'volume': if (l.volume === null) throw new ValidationError('طريقة الحجم تتطلب حجمًا لكل سطر'); return l.volume;
    case 'manual': if (l.manualPercent === null) throw new ValidationError('التوزيع اليدوي يتطلب نسبة لكل سطر'); return l.manualPercent;
  }
}

export async function getSettings(ctx: RequestContext) {
  ctx.assertPermission('landed.view');
  const r = (await pool.query(`SELECT * FROM landed_cost_settings WHERE company_id=$1`, [ctx.companyId])).rows[0];
  return r ?? { company_id: ctx.companyId, default_method: 'value', allowed_methods: [...METHODS], consumed_policy: 'expense_consumed', inventory_account_id: null, variance_account_id: null };
}
export async function saveSettings(ctx: RequestContext, raw: z.input<typeof settingsSchema>) {
  ctx.assertPermission('landed.settings'); const b = settingsSchema.parse(raw); const cur = await getSettings(ctx);
  const allowed = b.allowedMethods ?? cur.allowed_methods; const def = b.defaultMethod ?? cur.default_method;
  if (!allowed.includes(def)) throw new ValidationError('الطريقة الافتراضية يجب أن تكون ضمن المسموحة');
  for (const k of ['inventoryAccountId', 'varianceAccountId'] as const) if (b[k] && !(await pool.query(`SELECT 1 FROM accounts WHERE id=$1 AND company_id=$2`, [b[k], ctx.companyId])).rows.length) throw new ValidationError('حساب غير موجود');
  const inv = 'inventoryAccountId' in b ? b.inventoryAccountId ?? null : cur.inventory_account_id, vr = 'varianceAccountId' in b ? b.varianceAccountId ?? null : cur.variance_account_id;
  const row = (await pool.query(`INSERT INTO landed_cost_settings(company_id,default_method,allowed_methods,consumed_policy,inventory_account_id,variance_account_id) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (company_id) DO UPDATE SET default_method=EXCLUDED.default_method, allowed_methods=EXCLUDED.allowed_methods, consumed_policy=EXCLUDED.consumed_policy, inventory_account_id=EXCLUDED.inventory_account_id, variance_account_id=EXCLUDED.variance_account_id, updated_at=now() RETURNING *`,
    [ctx.companyId, def, allowed, b.consumedPolicy ?? cur.consumed_policy, inv, vr])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'landed_cost_settings', entityId: ctx.companyId, afterJson: b });
  return row;
}

type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function compute(ctx: RequestContext, db: Q, b: z.infer<typeof previewSchema>) {
  const st = await getSettings(ctx); const allowed: string[] = st.allowed_methods; const method = (b.method ?? st.default_method) as Method;
  const methods = new Set<string>([method, ...b.components.map((c) => c.method ?? method)]);
  for (const m of methods) if (!allowed.includes(m)) throw new ValidationError(`طريقة التوزيع «${m}» غير مسموحة لهذه الشركة`);
  if (new Set(b.lines.map((l) => l.goodsReceiptLineId)).size !== b.lines.length) throw new ValidationError('سطر استلام مكرر');
  const base = (await db.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId])).rows[0].base_currency_code as string;
  const comps: Array<{ name: string; method: Method; amount: number; currency: string; rate: number; base: number; creditAccountId: string; supplierId?: string; reference?: string }> = [];
  for (const c of b.components) {
    const cur = c.currency ?? base; const rate = Number(await resolveDocumentRate(ctx, cur, b.docDate, c.exchangeRate, 'buy', db as never));
    comps.push({ name: c.name, method: (c.method ?? method) as Method, amount: Number(c.amount), currency: cur, rate, base: r4(Number(c.amount) * rate), creditAccountId: c.creditAccountId, supplierId: c.supplierId, reference: c.reference });
  }
  const ids = b.lines.map((l) => l.goodsReceiptLineId);
  const rows = (await db.query(
    `SELECT l.id, l.item_id, l.quantity, l.unit_cost, g.status AS gr_status, m.warehouse_id, m.batch_id, m.status AS mv_status, g.branch_id,
            COALESCE((SELECT SUM(sb.quantity_on_hand) FROM stock_balances sb WHERE sb.company_id=l.company_id AND sb.warehouse_id=m.warehouse_id AND sb.item_id=l.item_id AND sb.batch_id IS NOT DISTINCT FROM m.batch_id),0) AS on_hand,
            COALESCE((SELECT MAX(sb.weighted_average_cost) FROM stock_balances sb WHERE sb.company_id=l.company_id AND sb.warehouse_id=m.warehouse_id AND sb.item_id=l.item_id AND sb.batch_id IS NOT DISTINCT FROM m.batch_id),0) AS wac
     FROM goods_receipt_lines l JOIN goods_receipts g ON g.id=l.goods_receipt_id LEFT JOIN stock_movements m ON m.id=l.stock_movement_id
     WHERE l.company_id=$1 AND l.id = ANY($2::uuid[])`, [ctx.companyId, ids])).rows;
  const by = new Map(rows.map((r) => [r.id, r]));
  const lines = b.lines.map((l) => {
    const r = by.get(l.goodsReceiptLineId); if (!r) throw new NotFoundError('سطر استلام غير موجود');
    if (r.gr_status !== 'posted' || !r.warehouse_id || r.mv_status !== 'posted') throw new ValidationError('يلزم إيصال استلام مرحَّل له حركة مخزون');
    return { r, l, qty: Number(r.quantity), value: r4(Number(r.quantity) * Number(r.unit_cost)), weight: l.weight !== undefined ? Number(l.weight) : null, volume: l.volume !== undefined ? Number(l.volume) : null, manualPercent: l.manualPercent !== undefined ? Number(l.manualPercent) : null };
  });
  const alloc = lines.map(() => 0);
  for (const c of comps) {
    if (c.method === 'manual') { const tot = lines.reduce((s, x) => s + (x.manualPercent ?? 0), 0); if (Math.abs(tot - 100) > 0.001) throw new ValidationError(`مجموع النسب اليدوية ${tot} ويجب أن يساوي 100`); }
    allocate(c.base, lines.map((x) => basisFor(c.method, x))).forEach((v, i) => { alloc[i] = r4(alloc[i] + v); });
  }
  const out = lines.map((x, i) => {
    const portion = Math.min(1, x.qty > 0 ? Math.min(Number(x.r.on_hand), x.qty) / x.qty : 0);
    const onHand = Number(x.r.on_hand); const A = alloc[i];
    let cap = st.consumed_policy === 'capitalize_remaining' ? (onHand > 0 ? A : 0) : r4(A * portion);
    cap = Math.min(A, cap); const exp = r4(A - cap);
    const wac = Number(x.r.wac); const after = onHand > 0 && cap > 0 ? r4((onHand * wac + cap) / onHand) : wac;
    return { goodsReceiptLineId: x.l.goodsReceiptLineId, itemId: x.r.item_id, warehouseId: x.r.warehouse_id, batchId: x.r.batch_id, branchId: x.r.branch_id, receivedQty: x.qty, onHand, lineValue: x.value, weight: x.weight, volume: x.volume, manualPercent: x.manualPercent, allocated: A, capitalized: cap, expensed: exp, wacBefore: wac, wacAfter: after, unitLanded: x.qty > 0 ? r4(A / x.qty) : 0 };
  });
  const total = r4(comps.reduce((s, c) => s + c.base, 0));
  return { st, method, comps, lines: out, total, capitalized: r4(out.reduce((s, l) => s + l.capitalized, 0)), expensed: r4(out.reduce((s, l) => s + l.expensed, 0)) };
}

export async function preview(ctx: RequestContext, raw: z.input<typeof previewSchema>) {
  ctx.assertPermission('landed.view'); const b = previewSchema.parse(raw);
  const c = await compute(ctx, pool as unknown as Q, b);
  return { method: c.method, total: c.total, capitalized: c.capitalized, expensed: c.expensed, components: c.comps, lines: c.lines };
}

export async function post(ctx: RequestContext, raw: z.input<typeof docSchema>) {
  ctx.assertPermission('landed.post'); const b = docSchema.parse(raw);
  return withTransaction(async (client) => {
    const c = await compute(ctx, client as unknown as Q, b);
    if (!c.st.inventory_account_id) throw new ValidationError('حدّد حساب المخزون في إعدادات التكاليف الإضافية');
    if (c.expensed > 0 && !c.st.variance_account_id) throw new ValidationError('حدّد حساب الفروق/تكلفة المبيعات لتحميل الجزء المستهلَك');
    const branchId = b.branchId ?? c.lines[0].branchId;
    const docNo = b.docNo ?? `LC-${b.docDate.replace(/-/g, '')}-${String((await client.query(`SELECT count(*)::int+1 AS n FROM landed_cost_docs WHERE company_id=$1`, [ctx.companyId])).rows[0].n).padStart(4, '0')}`;
    if ((await client.query(`SELECT 1 FROM landed_cost_docs WHERE company_id=$1 AND doc_no=$2`, [ctx.companyId, docNo])).rows.length) throw new ConflictError('رقم المستند مستخدم');
    const lines: JournalLineInput[] = [];
    if (c.capitalized > 0) lines.push({ accountId: c.st.inventory_account_id, debit: c.capitalized.toFixed(4), credit: '0', description: `تكاليف إضافية ${docNo}` });
    if (c.expensed > 0) lines.push({ accountId: c.st.variance_account_id, debit: c.expensed.toFixed(4), credit: '0', description: `جزء مستهلَك من تكاليف إضافية ${docNo}` });
    for (const k of c.comps) lines.push({ accountId: k.creditAccountId, debit: '0', credit: k.base.toFixed(4), description: `${k.name} ${docNo}` });
    const je = await postBaseEntry(ctx, client, { branchId, date: b.docDate, lines, sourceType: 'landed_cost', sourceId: undefined });
    const doc = (await client.query(`INSERT INTO landed_cost_docs(company_id,branch_id,doc_no,doc_date,default_method,consumed_policy,total_amount,capitalized_total,expensed_total,journal_entry_id,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ctx.companyId, branchId, docNo, b.docDate, c.method, c.st.consumed_policy, c.total, c.capitalized, c.expensed, je, b.notes ?? null, ctx.userId])).rows[0];
    for (const k of c.comps) await client.query(`INSERT INTO landed_cost_components(doc_id,company_id,name,method,amount,currency_code,exchange_rate,amount_base,credit_account_id,supplier_id,reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [doc.id, ctx.companyId, k.name, k.method, k.amount, k.currency, k.rate, k.base, k.creditAccountId, k.supplierId ?? null, k.reference ?? null]);
    for (const l of c.lines) {
      await client.query(`INSERT INTO landed_cost_lines(doc_id,company_id,goods_receipt_line_id,item_id,warehouse_id,batch_id,received_qty,on_hand_at_post,line_value,weight,volume,manual_percent,allocated_amount,capitalized_amount,expensed_amount,wac_before,wac_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [doc.id, ctx.companyId, l.goodsReceiptLineId, l.itemId, l.warehouseId, l.batchId, l.receivedQty, l.onHand, l.lineValue, l.weight, l.volume, l.manualPercent, l.allocated, l.capitalized, l.expensed, l.wacBefore, l.wacAfter]);
      if (l.wacAfter !== l.wacBefore) await client.query(`UPDATE stock_balances SET weighted_average_cost=$5, last_recalculated_at=now() WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4`, [ctx.companyId, l.warehouseId, l.itemId, l.batchId, l.wacAfter]);
    }
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'landed_cost', entityId: doc.id, afterJson: { docNo, total: c.total, method: c.method } });
    return { ...doc, lines: c.lines, components: c.comps };
  });
}

/** عكس المستند: قيد معاكس + إنقاص متوسط التكلفة بما رُسمِل (يُحسب على الرصيد الحالي، فيبقى تقريبيًا إن تغيّر الرصيد منذ الترحيل). */
export async function reverse(ctx: RequestContext, id: string, raw: z.input<typeof reverseSchema>) {
  ctx.assertPermission('landed.reverse'); const b = reverseSchema.parse(raw);
  return withTransaction(async (client) => {
    const d = (await client.query(`SELECT * FROM landed_cost_docs WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!d) throw new NotFoundError('المستند غير موجود'); if (d.status !== 'posted') throw new ConflictError('المستند معكوس بالفعل');
    const ls = (await client.query(`SELECT account_id, debit, credit, description FROM journal_lines WHERE journal_entry_id=$1`, [d.journal_entry_id])).rows;
    const date = String(d.doc_date instanceof Date ? d.doc_date.toISOString() : d.doc_date).slice(0, 10);
    const rje = await postBaseEntry(ctx, client, { branchId: d.branch_id, date, sourceType: 'landed_cost_reversal', sourceId: d.journal_entry_id, lines: ls.map((l) => ({ accountId: l.account_id, debit: String(l.credit), credit: String(l.debit), description: `عكس: ${l.description ?? ''}` })) });
    for (const l of (await client.query(`SELECT * FROM landed_cost_lines WHERE doc_id=$1`, [id])).rows) {
      const cap = Number(l.capitalized_amount); if (cap <= 0) continue;
      const sb = (await client.query(`SELECT quantity_on_hand, weighted_average_cost FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4`, [ctx.companyId, l.warehouse_id, l.item_id, l.batch_id])).rows[0];
      if (sb && Number(sb.quantity_on_hand) > 0) await client.query(`UPDATE stock_balances SET weighted_average_cost=$5, last_recalculated_at=now() WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4`, [ctx.companyId, l.warehouse_id, l.item_id, l.batch_id, Math.max(0, r4((Number(sb.quantity_on_hand) * Number(sb.weighted_average_cost) - cap) / Number(sb.quantity_on_hand)))]);
    }
    const row = (await client.query(`UPDATE landed_cost_docs SET status='reversed', reversal_entry_id=$2, reverse_reason=$3, reversed_at=now() WHERE id=$1 RETURNING *`, [id, rje, b.reason])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'landed_cost', entityId: id, afterJson: { reversed: true, reason: b.reason } });
    return row;
  });
}

export async function list(ctx: RequestContext) {
  ctx.assertPermission('landed.view');
  return (await pool.query(`SELECT id, doc_no, doc_date::text AS doc_date, default_method, total_amount, capitalized_total, expensed_total, status FROM landed_cost_docs WHERE company_id=$1 ORDER BY doc_date DESC, created_at DESC LIMIT 200`, [ctx.companyId])).rows;
}
export async function getDoc(ctx: RequestContext, id: string) {
  ctx.assertPermission('landed.view');
  const d = (await pool.query(`SELECT * FROM landed_cost_docs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0]; if (!d) throw new NotFoundError('المستند غير موجود');
  return { ...d, components: (await pool.query(`SELECT * FROM landed_cost_components WHERE doc_id=$1`, [id])).rows, lines: (await pool.query(`SELECT l.*, i.code AS item_code, i.name_ar AS item_name FROM landed_cost_lines l JOIN items i ON i.id=l.item_id WHERE l.doc_id=$1`, [id])).rows };
}

/** تقرير: أثر التكاليف الإضافية لكل صنف (تكلفة الشراء مقابل المحمَّلة) ولكل مكوّن، للمستندات غير المعكوسة. */
export async function report(ctx: RequestContext, raw: z.input<typeof reportSchema>) {
  ctx.assertPermission('landed.view'); const q = reportSchema.parse(raw);
  const byItem = (await pool.query(`SELECT i.code, i.name_ar AS name, SUM(l.received_qty) AS qty, SUM(l.line_value) AS purchase_value, SUM(l.allocated_amount) AS landed, SUM(l.capitalized_amount) AS capitalized, SUM(l.expensed_amount) AS expensed
    FROM landed_cost_lines l JOIN landed_cost_docs d ON d.id=l.doc_id JOIN items i ON i.id=l.item_id WHERE d.company_id=$1 AND d.status='posted' AND d.doc_date BETWEEN $2 AND $3 GROUP BY i.code, i.name_ar ORDER BY SUM(l.allocated_amount) DESC`, [ctx.companyId, q.from, q.to])).rows
    .map((r) => ({ code: r.code, name: r.name, qty: Number(r.qty), purchaseValue: r4(Number(r.purchase_value)), landed: r4(Number(r.landed)), capitalized: r4(Number(r.capitalized)), expensed: r4(Number(r.expensed)), upliftPercent: Number(r.purchase_value) > 0 ? Math.round((Number(r.landed) / Number(r.purchase_value)) * 1e4) / 100 : null, landedPerUnit: Number(r.qty) > 0 ? r4(Number(r.landed) / Number(r.qty)) : null }));
  const byComponent = (await pool.query(`SELECT c.name, SUM(c.amount_base) AS total, count(*)::int AS n FROM landed_cost_components c JOIN landed_cost_docs d ON d.id=c.doc_id WHERE d.company_id=$1 AND d.status='posted' AND d.doc_date BETWEEN $2 AND $3 GROUP BY c.name ORDER BY SUM(c.amount_base) DESC`, [ctx.companyId, q.from, q.to])).rows.map((r) => ({ name: r.name, total: r4(Number(r.total)), count: r.n }));
  return { from: q.from, to: q.to, byItem, byComponent, totals: { purchaseValue: r4(byItem.reduce((s, r) => s + r.purchaseValue, 0)), landed: r4(byItem.reduce((s, r) => s + r.landed, 0)) } };
}

export const reapplySchema = z.strictObject({ warehouseId: uuid.optional(), itemId: uuid.optional() });
const LEDGER_IN = new Set(['opening', 'in', 'transfer_in', 'adjustment_in']); const LEDGER_OUT = new Set(['out', 'transfer_out', 'adjustment_out', 'loss']); // نفس مجموعتَي rebuildStockBalanceFromLedger
/**
 * إعادة تطبيق التكاليف الإضافية بعد إعادة بناء الأرصدة من السجل (rebuild يمحو تعديل المتوسط): لكل (مخزن/صنف/دفعة) لها
 * بنود في مستندات مرحَّلة غير معكوسة، يُعاد حساب المتوسط = (كمية السجل × متوسط السجل + مجموع المرسمَل) ÷ الكمية. آمن للتكرار
 * (لا يتراكم) لأنه يبدأ دائمًا من السجل لا من الرصيد الحالي.
 */
export async function reapply(ctx: RequestContext, raw: z.input<typeof reapplySchema> = {}) {
  ctx.assertPermission('landed.settings'); const b = reapplySchema.parse(raw);
  return withTransaction(async (client) => {
    const p: unknown[] = [ctx.companyId]; let w = '';
    if (b.warehouseId) { p.push(b.warehouseId); w += ` AND l.warehouse_id=$${p.length}`; } if (b.itemId) { p.push(b.itemId); w += ` AND l.item_id=$${p.length}`; }
    const keys = (await client.query(`SELECT l.warehouse_id, l.item_id, l.batch_id, SUM(l.capitalized_amount) AS cap FROM landed_cost_lines l JOIN landed_cost_docs d ON d.id=l.doc_id WHERE l.company_id=$1 AND d.status='posted'${w} GROUP BY l.warehouse_id, l.item_id, l.batch_id`, p)).rows;
    const changes: Array<{ itemId: string; warehouseId: string; before: number; after: number }> = [];
    for (const k of keys) {
      const mv = (await client.query(`SELECT movement_type, quantity, unit_cost FROM stock_movements WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4 AND status='posted' ORDER BY effective_date, created_at, id`, [ctx.companyId, k.warehouse_id, k.item_id, k.batch_id])).rows;
      let qty = 0, avg = 0;
      for (const m of mv) { const mq = Number(m.quantity); if (LEDGER_IN.has(m.movement_type)) { const nq = qty + mq; avg = nq > 0 ? (qty * avg + mq * Number(m.unit_cost)) / nq : 0; qty = nq; } else if (LEDGER_OUT.has(m.movement_type)) qty -= mq; }
      if (qty <= 0) continue;
      const after = r4((qty * avg + Number(k.cap)) / qty);
      const cur = (await client.query(`SELECT weighted_average_cost FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4`, [ctx.companyId, k.warehouse_id, k.item_id, k.batch_id])).rows[0];
      if (!cur) continue;
      if (Math.abs(Number(cur.weighted_average_cost) - after) > 0.00005) {
        await client.query(`UPDATE stock_balances SET weighted_average_cost=$5, last_recalculated_at=now() WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND batch_id IS NOT DISTINCT FROM $4`, [ctx.companyId, k.warehouse_id, k.item_id, k.batch_id, after]);
        changes.push({ itemId: k.item_id, warehouseId: k.warehouse_id, before: Number(cur.weighted_average_cost), after });
      }
    }
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'landed_cost_reapply', entityId: ctx.companyId, afterJson: { changed: changes.length } });
    return { checked: keys.length, changed: changes.length, changes };
  });
}
