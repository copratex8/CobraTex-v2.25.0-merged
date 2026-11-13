import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { z } from 'zod';
import { uuid } from '@/shared/zodSchemas';

/**
 * (هجرة 0056) تتبّع الدفعات ثنائي الاتجاه + مطالبات العملاء الجودية.
 * تتبّع أمامي: لوط خامة ← أوامر ← رولات ← أذون تسليم ← عملاء (نطاق السحب Recall). خلفي: رول ← أمر ← لوطات ← صباغة ← تسليم ← مطالبات.
 */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const lotBodySchema = z.strictObject({
  productionOrderId: uuid, itemId: uuid, lotRef: z.string().min(1).max(80), fiberLotId: uuid.optional(), supplierId: uuid.optional(),
  quantity: z.number().positive().max(1e9), notes: z.string().max(300).optional(),
});
export const traceQuerySchema = z.object({ rollId: uuid.optional(), rollNo: z.string().max(60).optional(), lotRef: z.string().max(80).optional() })
  .refine((q) => [q.rollId, q.rollNo, q.lotRef].filter(Boolean).length === 1, { message: 'حدّد واحدًا فقط: rollId أو rollNo أو lotRef' });
export const CATEGORIES = ['shade', 'defect', 'count', 'strength', 'shrinkage', 'width', 'gsm', 'contamination', 'packing', 'delay', 'other'] as const;
export const claimBodySchema = z.strictObject({
  branchId: uuid, customerId: uuid, claimDate: date, category: z.enum(CATEGORIES), severity: z.enum(['minor', 'major', 'critical']).optional(),
  deliveryNoteId: uuid.optional(), fabricRollId: uuid.optional(), packingUnitId: uuid.optional(),
  claimedQuantity: z.number().positive().optional(), claimedUnit: z.enum(['kg', 'm']).optional(), claimedValue: z.number().min(0).optional(),
  description: z.string().min(3).max(1000),
}).refine((b) => (b.claimedQuantity === undefined) === (b.claimedUnit === undefined), { message: 'الكمية والوحدة معًا' });
export const claimStatusSchema = z.strictObject({
  status: z.enum(['investigating', 'accepted', 'rejected', 'settled']), rootCause: z.string().min(3).max(500).optional(), rootCauseStageId: uuid.optional(),
  resolution: z.enum(['credit_note', 'replacement', 'discount', 'return', 'none']).optional(), settledValue: z.number().min(0).optional(), note: z.string().max(300).optional(),
});
export const claimQuerySchema = z.object({ customerId: uuid.optional(), status: z.string().optional(), category: z.string().optional(), from: date.optional(), to: date.optional() }).passthrough();

/** انتقالات حالة المطالبة المسموحة. */
export const CLAIM_FLOW: Record<string, string[]> = { open: ['investigating', 'accepted', 'rejected'], investigating: ['accepted', 'rejected'], accepted: ['settled'], settled: [], rejected: [] };

export async function recordLot(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.trace.manage');
  const o = (await pool.query(`SELECT id, status FROM production_orders WHERE id=$1 AND company_id=$2`, [b.productionOrderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود'); if (o.status === 'reversed') throw new ConflictError('أمر معكوس');
  if (!(await pool.query(`SELECT 1 FROM items WHERE id=$1 AND company_id=$2`, [b.itemId, ctx.companyId])).rows[0]) throw new ValidationError('الصنف غير موجود');
  try {
    const r = (await pool.query(`INSERT INTO order_material_lots(company_id,production_order_id,item_id,lot_ref,fiber_lot_id,supplier_id,quantity,notes,created_by) VALUES ($1,$2,$3,btrim($4),$5,$6,$7,$8,$9) RETURNING *`,
      [ctx.companyId, b.productionOrderId, b.itemId, b.lotRef, b.fiberLotId ?? null, b.supplierId ?? null, b.quantity, b.notes ?? null, ctx.userId])).rows[0];
    await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'order_material_lot', entityId: r.id, afterJson: { order: b.productionOrderId, lot: b.lotRef, qty: b.quantity } });
    return r;
  } catch (e) {
    const c = (e as { code?: string }).code;
    if (c === '23505') throw new ConflictError('هذا اللوط مسجَّل بالفعل لنفس الصنف على هذا الأمر');
    if (c === '23503') throw new ValidationError('لوط ألياف غير موجود');
    throw e;
  }
}
export async function listOrderLots(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.trace.view');
  return (await pool.query(`SELECT l.*, i.name_ar AS item_name FROM order_material_lots l JOIN items i ON i.id=l.item_id AND i.company_id=l.company_id WHERE l.company_id=$1 AND l.production_order_id=$2 ORDER BY i.name_ar, l.lot_ref`, [ctx.companyId, orderId])).rows;
}
export async function deleteLot(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.trace.manage');
  const r = (await pool.query(`DELETE FROM order_material_lots WHERE id=$1 AND company_id=$2 RETURNING lot_ref, production_order_id`, [id, ctx.companyId])).rows[0];
  if (!r) throw new NotFoundError('السجل غير موجود');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'delete', entityType: 'order_material_lot', entityId: id, beforeJson: r });
  return { deleted: true };
}

const DELIVERED = `SELECT dl.fabric_roll_id, dl.packing_unit_id, n.id AS note_id, n.note_no, n.note_date, n.customer_id, c.name_ar AS customer_name FROM delivery_note_lines dl
  JOIN delivery_notes n ON n.id=dl.delivery_note_id AND n.company_id=$1 AND n.status='issued' JOIN customers c ON c.id=n.customer_id AND c.company_id=n.company_id`;

export async function trace(ctx: RequestContext, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.trace.view');
  return q.lotRef ? traceLot(ctx, String(q.lotRef).trim()) : traceRoll(ctx, q);
}

async function traceRoll(ctx: RequestContext, q: B) {
  const roll = (await pool.query(`SELECT r.*, i.name_ar AS item_name FROM fabric_rolls r LEFT JOIN items i ON i.id=r.item_id AND i.company_id=r.company_id WHERE r.company_id=$1 AND (r.id=$2 OR r.roll_no=$3)`, [ctx.companyId, q.rollId ?? null, q.rollNo ?? null])).rows[0];
  if (!roll) throw new NotFoundError('الرول غير موجود');
  const order = roll.production_order_id ? (await pool.query(
    `SELECT po.id, po.document_number, po.order_date, po.status, po.machine_id, m.code AS machine_code, po.blend_recipe_id, br.name AS recipe_name, br.version_no AS recipe_version
     FROM production_orders po LEFT JOIN machines m ON m.id=po.machine_id AND m.company_id=po.company_id LEFT JOIN yarn_blend_recipes br ON br.id=po.blend_recipe_id AND br.company_id=po.company_id
     WHERE po.id=$1 AND po.company_id=$2`, [roll.production_order_id, ctx.companyId])).rows[0] ?? null : null;
  const lots = order ? await listOrderLotsRaw(ctx, order.id) : [];
  const dye = order ? (await pool.query(`SELECT batch_no, batch_date, status, shade_result, delta_e FROM dye_batches WHERE company_id=$1 AND production_order_id=$2 ORDER BY batch_date`, [ctx.companyId, order.id])).rows : [];
  const delivered = (await pool.query(`${DELIVERED} WHERE dl.fabric_roll_id=$2`, [ctx.companyId, roll.id])).rows;
  const claims = (await pool.query(`SELECT claim_no, status, category, severity, claim_date FROM quality_claims WHERE company_id=$1 AND fabric_roll_id=$2 ORDER BY claim_date`, [ctx.companyId, roll.id])).rows;
  return { kind: 'roll', roll, order, materialLots: lots, dyeBatches: dye, delivered, claims, traceComplete: !!order && lots.length > 0 };
}
async function listOrderLotsRaw(ctx: RequestContext, orderId: string) {
  return (await pool.query(`SELECT l.lot_ref, l.quantity, l.item_id, i.name_ar AS item_name, l.fiber_lot_id, l.supplier_id FROM order_material_lots l JOIN items i ON i.id=l.item_id AND i.company_id=l.company_id WHERE l.company_id=$1 AND l.production_order_id=$2 ORDER BY i.name_ar, l.lot_ref`, [ctx.companyId, orderId])).rows;
}

/** نطاق السحب لوط: كل أمر استهلكه، ورولاته، وما سُلِّم منها لأي عميل وما بقي بالمخزن، ومطالباتها. */
async function traceLot(ctx: RequestContext, lotRef: string) {
  const uses = (await pool.query(
    `SELECT l.production_order_id, po.document_number AS order_no, po.order_date, po.status AS order_status, l.item_id, i.name_ar AS item_name, l.quantity
     FROM order_material_lots l JOIN production_orders po ON po.id=l.production_order_id AND po.company_id=l.company_id JOIN items i ON i.id=l.item_id AND i.company_id=l.company_id
     WHERE l.company_id=$1 AND l.lot_ref=$2 ORDER BY po.order_date`, [ctx.companyId, lotRef])).rows;
  const orderIds = [...new Set(uses.map((u) => u.production_order_id))];
  const rolls = orderIds.length ? (await pool.query(`SELECT id, roll_no, production_order_id, length_m, weight_kg, grade FROM fabric_rolls WHERE company_id=$1 AND production_order_id = ANY($2::uuid[]) ORDER BY roll_no`, [ctx.companyId, orderIds])).rows : [];
  const packs = (await pool.query(`SELECT id, packing_no, net_kg, status, production_order_id FROM packing_units WHERE company_id=$1 AND (lot_number=$2 OR production_order_id = ANY($3::uuid[])) ORDER BY packing_no`, [ctx.companyId, lotRef, orderIds])).rows;
  const rollIds = rolls.map((r) => r.id), packIds = packs.map((p) => p.id);
  const delivered = rollIds.length || packIds.length ? (await pool.query(`${DELIVERED} WHERE dl.fabric_roll_id = ANY($2::uuid[]) OR dl.packing_unit_id = ANY($3::uuid[])`, [ctx.companyId, rollIds, packIds])).rows : [];
  const deliveredRoll = new Set(delivered.map((d) => d.fabric_roll_id).filter(Boolean)), deliveredPack = new Set(delivered.map((d) => d.packing_unit_id).filter(Boolean));
  const claims = rollIds.length ? (await pool.query(`SELECT claim_no, status, category, severity, customer_id, fabric_roll_id FROM quality_claims WHERE company_id=$1 AND fabric_roll_id = ANY($2::uuid[])`, [ctx.companyId, rollIds])).rows : [];
  const byCustomer = new Map<string, { customerId: string; customerName: string; rolls: number; packs: number; meters: number; kg: number }>();
  for (const d of delivered) {
    const e = byCustomer.get(d.customer_id) ?? { customerId: d.customer_id, customerName: d.customer_name, rolls: 0, packs: 0, meters: 0, kg: 0 };
    if (d.fabric_roll_id) { const r = rolls.find((x) => x.id === d.fabric_roll_id)!; e.rolls++; e.meters += Number(r.length_m); e.kg += Number(r.weight_kg ?? 0); }
    if (d.packing_unit_id) { const p = packs.find((x) => x.id === d.packing_unit_id)!; e.packs++; e.kg += Number(p.net_kg); }
    byCustomer.set(d.customer_id, e);
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    kind: 'lot', lotRef, found: uses.length > 0, totalIssuedQty: r3(uses.reduce((s, u) => s + Number(u.quantity), 0)), orders: uses,
    rolls: rolls.map((r) => ({ ...r, delivered: deliveredRoll.has(r.id) })), packingUnits: packs.map((p) => ({ ...p, delivered: deliveredPack.has(p.id) })),
    recall: { customers: [...byCustomer.values()].map((c) => ({ ...c, meters: r3(c.meters), kg: r3(c.kg) })), inStockRolls: rolls.filter((r) => !deliveredRoll.has(r.id)).length, inStockPacks: packs.filter((p) => !deliveredPack.has(p.id)).length },
    claims,
  };
}

/* ======================= المطالبات ======================= */
export async function createClaim(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.manage', b.branchId);
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['claim:' + ctx.companyId]);
    if (!(await client.query(`SELECT 1 FROM customers WHERE id=$1 AND company_id=$2`, [b.customerId, ctx.companyId])).rows[0]) throw new ValidationError('العميل غير موجود');
    let noteId: string | null = b.deliveryNoteId ?? null;
    if (b.fabricRollId || b.packingUnitId) {
      const ref = b.fabricRollId ? { col: 'fabric_roll_id', id: b.fabricRollId, tbl: 'fabric_rolls' } : { col: 'packing_unit_id', id: b.packingUnitId, tbl: 'packing_units' };
      if (!(await client.query(`SELECT 1 FROM ${ref.tbl} WHERE id=$1 AND company_id=$2`, [ref.id, ctx.companyId])).rows[0]) throw new ValidationError('الرول/وحدة التعبئة غير موجودة');
      const d = (await client.query(`SELECT n.id, n.customer_id FROM delivery_note_lines dl JOIN delivery_notes n ON n.id=dl.delivery_note_id WHERE dl.${ref.col}=$1 AND n.company_id=$2 AND n.status='issued'`, [ref.id, ctx.companyId])).rows[0];
      if (d) { if (d.customer_id !== b.customerId) throw new ValidationError('هذا الرول/الوحدة سُلِّم لعميل آخر'); noteId = noteId ?? d.id; }
    }
    if (noteId) {
      const n = (await client.query(`SELECT customer_id FROM delivery_notes WHERE id=$1 AND company_id=$2`, [noteId, ctx.companyId])).rows[0];
      if (!n) throw new ValidationError('إذن التسليم غير موجود'); if (n.customer_id !== b.customerId) throw new ValidationError('إذن التسليم لعميل آخر');
    }
    const seq = Number((await client.query(`SELECT COUNT(*)::int AS n FROM quality_claims WHERE company_id=$1`, [ctx.companyId])).rows[0].n) + 1;
    const claimNo = `CL-${b.claimDate.slice(0, 4)}-${String(seq).padStart(5, '0')}`;
    const r = (await client.query(
      `INSERT INTO quality_claims(company_id,branch_id,claim_no,customer_id,claim_date,delivery_note_id,fabric_roll_id,packing_unit_id,category,severity,claimed_quantity,claimed_unit,claimed_value,description,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [ctx.companyId, b.branchId, claimNo, b.customerId, b.claimDate, noteId, b.fabricRollId ?? null, b.packingUnitId ?? null, b.category, b.severity ?? 'minor', b.claimedQuantity ?? null, b.claimedUnit ?? null, b.claimedValue ?? null, b.description, ctx.userId])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'quality_claim', entityId: r.id, afterJson: { claimNo, category: b.category } });
    return r;
  });
}

export async function updateClaimStatus(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.manage');
  return withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM quality_claims WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!c) throw new NotFoundError('المطالبة غير موجودة');
    if (!CLAIM_FLOW[c.status].includes(b.status)) throw new ConflictError(`لا يمكن الانتقال من ${c.status} إلى ${b.status}`);
    const rootCause = b.rootCause ?? c.root_cause;
    if (b.status === 'accepted' && !rootCause) throw new ValidationError('السبب الجذري مطلوب عند قبول المطالبة');
    if (b.status === 'rejected' && !(b.note || rootCause)) throw new ValidationError('اذكر سبب الرفض (note أو rootCause)');
    if (b.status === 'settled') {
      if (!b.resolution || b.settledValue === undefined) throw new ValidationError('التسوية تتطلب نوع الحل وقيمته');
      if (b.resolution === 'none' && b.settledValue > 0) throw new ValidationError('حل «بلا» لا يحمل قيمة');
    }
    if (b.rootCauseStageId && !(await client.query(`SELECT 1 FROM textile_stages WHERE id=$1 AND company_id=$2`, [b.rootCauseStageId, ctx.companyId])).rows[0]) throw new ValidationError('المرحلة غير موجودة');
    const closed = b.status === 'settled' || b.status === 'rejected';
    const u = (await client.query(
      `UPDATE quality_claims SET status=$2, root_cause=COALESCE($3,root_cause), root_cause_stage_id=COALESCE($4,root_cause_stage_id), resolution=COALESCE($5,resolution), settled_value=COALESCE($6,settled_value), closed_at=CASE WHEN $7 THEN now() ELSE closed_at END WHERE id=$1 RETURNING *`,
      [id, b.status, b.rootCause ?? (b.status === 'rejected' ? b.note ?? null : null), b.rootCauseStageId ?? null, b.resolution ?? null, b.settledValue ?? null, closed])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'quality_claim', entityId: id, beforeJson: { status: c.status }, afterJson: { status: b.status, resolution: b.resolution, settledValue: b.settledValue } });
    return u;
  });
}

export async function listClaims(ctx: RequestContext, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.view');
  return (await pool.query(
    `SELECT k.*, cu.name_ar AS customer_name, n.note_no, r.roll_no FROM quality_claims k JOIN customers cu ON cu.id=k.customer_id AND cu.company_id=k.company_id
     LEFT JOIN delivery_notes n ON n.id=k.delivery_note_id LEFT JOIN fabric_rolls r ON r.id=k.fabric_roll_id
     WHERE k.company_id=$1 AND ($2::uuid IS NULL OR k.customer_id=$2) AND ($3::text IS NULL OR k.status=$3) AND ($4::text IS NULL OR k.category=$4) AND ($5::date IS NULL OR k.claim_date>=$5) AND ($6::date IS NULL OR k.claim_date<=$6)
     ORDER BY k.claim_date DESC, k.claim_no DESC`, [ctx.companyId, q.customerId ?? null, q.status ?? null, q.category ?? null, q.from ?? null, q.to ?? null])).rows;
}

export async function getClaim(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.view');
  const c = (await pool.query(`SELECT k.*, cu.name_ar AS customer_name FROM quality_claims k JOIN customers cu ON cu.id=k.customer_id AND cu.company_id=k.company_id WHERE k.id=$1 AND k.company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!c) throw new NotFoundError('المطالبة غير موجودة');
  ctx.assertPermission('textile.trace.view');
  return { claim: c, trace: c.fabric_roll_id ? await traceRoll(ctx, { rollId: c.fabric_roll_id }) : null };
}

/** تحليل المطالبات: حسب التصنيف والمرحلة المسبِّبة والعميل، وزمن الإغلاق، والمفتوحة المتأخرة. */
export async function claimsReport(ctx: RequestContext, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.view');
  const rows = (await pool.query(
    `SELECT k.category, k.status, k.customer_id, cu.name_ar AS customer_name, k.root_cause_stage_id, st.name_ar AS stage_name, k.claimed_value, k.settled_value, k.claim_date, k.closed_at
     FROM quality_claims k JOIN customers cu ON cu.id=k.customer_id AND cu.company_id=k.company_id LEFT JOIN textile_stages st ON st.id=k.root_cause_stage_id AND st.company_id=k.company_id
     WHERE k.company_id=$1 AND ($2::date IS NULL OR k.claim_date>=$2) AND ($3::date IS NULL OR k.claim_date<=$3)`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  const sum = (a: any[], f: (x: any) => number) => Math.round(a.reduce((s, x) => s + f(x), 0) * 100) / 100; // eslint-disable-line @typescript-eslint/no-explicit-any
  const group = (key: (x: B) => string | null, label: (x: B) => string) => {
    const m = new Map<string, B[]>(); for (const r of rows) { const k = key(r); if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return [...m.entries()].map(([k, a]) => ({ key: k, label: label(a[0]), count: a.length, claimedValue: sum(a, (x) => Number(x.claimed_value ?? 0)), settledValue: sum(a, (x) => Number(x.settled_value ?? 0)) })).sort((x, y) => y.count - x.count || y.settledValue - x.settledValue);
  };
  const closed = rows.filter((r) => r.closed_at);
  const days = closed.map((r) => (new Date(r.closed_at).getTime() - new Date(r.claim_date).getTime()) / 86400000);
  const open = rows.filter((r) => !r.closed_at);
  return {
    total: rows.length, open: open.length, accepted: rows.filter((r) => r.status === 'accepted' || r.status === 'settled').length, rejected: rows.filter((r) => r.status === 'rejected').length,
    claimedValue: sum(rows, (x) => Number(x.claimed_value ?? 0)), settledValue: sum(rows, (x) => Number(x.settled_value ?? 0)),
    avgDaysToClose: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
    byCategory: group((r) => r.category, (r) => r.category), byStage: group((r) => r.root_cause_stage_id, (r) => r.stage_name), byCustomer: group((r) => r.customer_id, (r) => r.customer_name),
  };
}
