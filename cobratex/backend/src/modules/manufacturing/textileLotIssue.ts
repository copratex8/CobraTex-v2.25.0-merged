import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { recordOutMovement, recordInMovement } from '@/modules/inventory/stockService';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';

/**
 * صرف خامات أمر التصنيع بالدفعة (2.10.0). كل مكوّن (نوع غزل) في الأمر يمكن أن يُصرف من لوط واحد أو عدّة لوطات، وتُسجَّل
 * كل لوط بحركة مستقلة بتكلفتها (المتوسط المرجّح لذلك اللوط) فتبقى منفصلة في المخزون والتكلفة وكارت اللوط.
 * أمر بلا تخصيص لوطات يُصرف كما كان تمامًا (من رصيد المكوّن بلا دفعة).
 */
const uuid = z.uuid();
export const setLotsSchema = z.strictObject({ lots: z.array(z.strictObject({ batchId: uuid, quantity: z.number().positive() })).max(50) });
export const suggestSchema = z.object({ strategy: z.enum(['fifo', 'cheapest', 'largest']).optional(), apply: z.enum(['true', 'false']).optional() });
export const autoSchema = z.strictObject({ strategy: z.enum(['fifo', 'cheapest', 'largest']).optional() });
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const d10 = (v: unknown) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
type Q = { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Strategy = 'fifo' | 'cheapest' | 'largest';
/** تخصيص كمية على لوطات متاحة حسب الاستراتيجية. FIFO: الأقدم إنتاجًا ثم رقم اللوط؛ cheapest: الأقل تكلفة؛ largest: الأكبر رصيدًا (أقل عدد لوطات). */
export function allocate(need: number, lots: Array<{ batchId: string; available: number; avgCost: number; productionDate: string | null; batchNo: string }>, strategy: Strategy = 'fifo') {
  const sorted = [...lots].filter((l) => l.available > 0).sort((a, b) =>
    strategy === 'cheapest' ? a.avgCost - b.avgCost || a.batchNo.localeCompare(b.batchNo)
    : strategy === 'largest' ? b.available - a.available || a.batchNo.localeCompare(b.batchNo)
    : (a.productionDate ?? '9999').localeCompare(b.productionDate ?? '9999') || a.batchNo.localeCompare(b.batchNo));
  let left = need; const out: Array<{ batchId: string; batchNo: string; quantity: number; avgCost: number }> = [];
  for (const l of sorted) { if (left <= 0.00005) break; const q = r4(Math.min(left, l.available)); if (q > 0) { out.push({ batchId: l.batchId, batchNo: l.batchNo, quantity: q, avgCost: l.avgCost }); left = r4(left - q); } }
  return { allocations: out, shortfall: left > 0.00005 ? r4(left) : 0 };
}

async function loadOrder(db: Q, ctx: RequestContext, orderId: string) {
  const o = (await db.query(`SELECT id, branch_id, warehouse_id, status, order_date, document_number, activity_id FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود'); return o;
}
const consumeOf = (l: any) => Number(l.actual_quantity ?? l.planned_quantity); // eslint-disable-line @typescript-eslint/no-explicit-any

async function lotsOf(db: Q, ctx: RequestContext, warehouseId: string, itemId: string) {
  return (await db.query(
    `SELECT b.id AS batch_id, b.batch_no, b.production_date, s.name_ar AS supplier, sb.quantity_on_hand, sb.quantity_reserved, sb.weighted_average_cost
     FROM stock_balances sb JOIN batches b ON b.id=sb.batch_id AND b.company_id=sb.company_id LEFT JOIN suppliers s ON s.id=b.supplier_id AND s.company_id=b.company_id
     WHERE sb.company_id=$1 AND sb.warehouse_id=$2 AND sb.item_id=$3 AND sb.quantity_on_hand > 0`, [ctx.companyId, warehouseId, itemId])).rows
    .map((r) => ({ batchId: r.batch_id, batchNo: r.batch_no, productionDate: d10(r.production_date), supplier: r.supplier, onHand: Number(r.quantity_on_hand), available: Number(r.quantity_on_hand) - Number(r.quantity_reserved), avgCost: Number(r.weighted_average_cost) }));
}

/** مكوّنات الأمر مع اللوطات المتاحة لكل مكوّن والتخصيص الحالي والمتبقي. */
export async function orderLots(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.lots.view');
  const o = await loadOrder(pool, ctx, orderId);
  const lines = (await pool.query(`SELECT l.id, l.component_item_id, l.planned_quantity, l.actual_quantity, l.is_main_material, i.code, i.name_ar FROM production_order_lines l JOIN items i ON i.id=l.component_item_id AND i.company_id=l.company_id WHERE l.production_order_id=$1 AND l.company_id=$2 ORDER BY l.is_main_material DESC, i.code`, [orderId, ctx.companyId])).rows;
  const alloc = (await pool.query(`SELECT a.production_order_line_id, a.batch_id, a.quantity, a.unit_cost, a.line_cost, b.batch_no FROM production_line_lots a JOIN batches b ON b.id=a.batch_id AND b.company_id=a.company_id WHERE a.production_order_id=$1 AND a.company_id=$2`, [orderId, ctx.companyId])).rows;
  const out = [];
  for (const l of lines) {
    const need = consumeOf(l); const mine = alloc.filter((a) => a.production_order_line_id === l.id);
    const allocated = r4(mine.reduce((s, a) => s + Number(a.quantity), 0));
    out.push({ lineId: l.id, itemId: l.component_item_id, itemCode: l.code, itemName: l.name_ar, isMain: l.is_main_material, required: need, allocated, remaining: r4(need - allocated),
      allocations: mine.map((a) => ({ batchId: a.batch_id, batchNo: a.batch_no, quantity: Number(a.quantity), unitCost: a.unit_cost === null ? null : Number(a.unit_cost), lineCost: a.line_cost === null ? null : Number(a.line_cost) })),
      availableLots: o.status === 'draft' ? await lotsOf(pool, ctx, o.warehouse_id, l.component_item_id) : [] });
  }
  return { orderId, orderNo: o.document_number, status: o.status, lines: out, ready: out.every((l) => l.allocated === 0 || Math.abs(l.remaining) < 0.00005) };
}

/** تحديد لوطات مكوّن (يستبدل التخصيص السابق). المجموع لا يتجاوز المطلوب؛ ويجب أن يساويه عند الترحيل. */
export async function setLineLots(ctx: RequestContext, orderId: string, lineId: string, b: z.infer<typeof setLotsSchema>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.lots.manage');
  return withTransaction(async (client) => {
    const o = await loadOrder(client, ctx, orderId); if (o.status !== 'draft') throw new ConflictError('تحديد اللوطات لأوامر المسودة فقط');
    const line = (await client.query(`SELECT id, component_item_id, planned_quantity, actual_quantity FROM production_order_lines WHERE id=$1 AND production_order_id=$2 AND company_id=$3`, [lineId, orderId, ctx.companyId])).rows[0];
    if (!line) throw new NotFoundError('مكوّن الأمر غير موجود');
    const ids = b.lots.map((x) => x.batchId); if (new Set(ids).size !== ids.length) throw new ValidationError('لوط مكرر في التخصيص');
    const need = consumeOf(line); const total = r4(b.lots.reduce((s, x) => s + x.quantity, 0));
    if (total > need + 0.00005) throw new ValidationError(`مجموع اللوطات (${total}) يتجاوز المطلوب (${need})`);
    const avail = new Map((await lotsOf(client, ctx, o.warehouse_id, line.component_item_id)).map((l) => [l.batchId, l]));
    for (const x of b.lots) {
      const bt = (await client.query(`SELECT batch_no, item_id FROM batches WHERE id=$1 AND company_id=$2`, [x.batchId, ctx.companyId])).rows[0];
      if (!bt) throw new ValidationError('لوط غير موجود'); if (bt.item_id !== line.component_item_id) throw new ValidationError(`اللوط ${bt.batch_no} ليس من نفس صنف المكوّن`);
      const a = avail.get(x.batchId); if (!a) throw new ValidationError(`اللوط ${bt.batch_no} بلا رصيد في مخزن الأمر`);
      if (x.quantity > a.available + 0.00005) throw new ValidationError(`اللوط ${bt.batch_no}: المتاح ${a.available} أقل من ${x.quantity}`);
    }
    await client.query(`DELETE FROM production_line_lots WHERE production_order_line_id=$1`, [lineId]);
    for (const x of b.lots) await client.query(`INSERT INTO production_line_lots(company_id,production_order_id,production_order_line_id,batch_id,quantity,created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.companyId, orderId, lineId, x.batchId, x.quantity, ctx.userId]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'production_line_lots', entityId: lineId, afterJson: { orderId, lots: b.lots } });
    return { lineId, allocated: total, remaining: r4(need - total) };
  });
}

/** اقتراح تخصيص لكل مكوّن (أو تطبيقه على المكوّنات غير المخصَّصة). */
export async function autoAllocate(ctx: RequestContext, orderId: string, b: { strategy?: Strategy }, apply: boolean) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission(apply ? 'textile.lots.manage' : 'textile.lots.view');
  const o = await loadOrder(pool, ctx, orderId); if (o.status !== 'draft') throw new ConflictError('للأوامر المسودة فقط');
  const lines = (await pool.query(`SELECT id, component_item_id, planned_quantity, actual_quantity FROM production_order_lines WHERE production_order_id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows;
  const done = new Set((await pool.query(`SELECT DISTINCT production_order_line_id AS id FROM production_line_lots WHERE production_order_id=$1`, [orderId])).rows.map((r) => r.id));
  const res = [];
  for (const l of lines) {
    if (done.has(l.id)) { res.push({ lineId: l.id, skipped: 'مخصَّص مسبقًا' }); continue; }
    const r = allocate(consumeOf(l), await lotsOf(pool, ctx, o.warehouse_id, l.component_item_id), b.strategy ?? 'fifo');
    if (apply && r.allocations.length) await setLineLots(ctx, orderId, l.id, { lots: r.allocations.map((a) => ({ batchId: a.batchId, quantity: a.quantity })) });
    res.push({ lineId: l.id, strategy: b.strategy ?? 'fifo', ...r, applied: apply && r.allocations.length > 0 });
  }
  return { orderId, lines: res, complete: res.every((x: any) => x.skipped || x.shortfall === 0) }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * يُستدعى من ترحيل أمر التصنيع لكل مكوّن: إن كان له تخصيص لوطات يُصرف كل لوط بحركة مستقلة بتكلفته ويُسجَّل عليه؛ وإلا يعيد null (المسار القديم).
 * المجموع يجب أن يساوي الكمية المستهلكة تمامًا وإلا الرفض (لا صرف جزئي صامت).
 */
export async function issueLineLots(ctx: RequestContext, client: Q, order: { id: string; branch_id: string; warehouse_id: string; order_date: string; activity_id?: string | null }, line: { id: string; component_item_id: string }, consumeQty: string) {
  const al = (await client.query(`SELECT a.id, a.batch_id, a.quantity, b.batch_no FROM production_line_lots a JOIN batches b ON b.id=a.batch_id AND b.company_id=a.company_id WHERE a.production_order_line_id=$1 ORDER BY b.batch_no`, [line.id])).rows;
  if (!al.length) return null;
  const sum = al.reduce((s, a) => s.plus(a.quantity), new Decimal(0));
  if (!sum.equals(new Decimal(consumeQty))) throw new ValidationError(`مجموع اللوطات المخصَّصة (${sum.toFixed(4)}) لا يساوي الكمية المستهلكة (${new Decimal(consumeQty).toFixed(4)}) — أكمل التخصيص أو أزله`);
  let total = new Decimal(0), first: string | null = null;
  for (const a of al) {
    const mv = await recordOutMovement(ctx, { branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: line.component_item_id, batchId: a.batch_id, quantity: String(a.quantity), movementDate: order.order_date, movementType: 'production_consume', sourceDocumentType: 'production_order', sourceDocumentId: order.id, activityId: order.activity_id ?? undefined });
    const cost = new Decimal(mv.costOfGoodsConsumed); total = total.plus(cost); first = first ?? mv.movementId;
    await client.query(`UPDATE production_line_lots SET unit_cost=$2, line_cost=$3, stock_movement_id=$4 WHERE id=$1`, [a.id, cost.dividedBy(a.quantity).toFixed(4), cost.toFixed(4), mv.movementId]);
  }
  return { lineCost: total.toFixed(4), firstMovementId: first as string, lots: al.length };
}

/** عكس صرف اللوطات عند عكس الأمر: كل لوط يعود لنفسه بتكلفته. يعيد true إن عالج المكوّن. */
export async function reverseLineLots(ctx: RequestContext, client: Q, order: { id: string; branch_id: string; warehouse_id: string; order_date: string; activity_id?: string | null }, line: { id: string; component_item_id: string }) {
  const al = (await client.query(`SELECT batch_id, quantity, unit_cost FROM production_line_lots WHERE production_order_line_id=$1 AND stock_movement_id IS NOT NULL`, [line.id])).rows;
  if (!al.length) return false;
  for (const a of al) await recordInMovement(ctx, { branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: line.component_item_id, batchId: a.batch_id, quantity: String(a.quantity), unitCost: String(a.unit_cost), movementDate: order.order_date, movementType: 'production_consume', sourceDocumentType: 'production_order_reversal', sourceDocumentId: order.id, activityId: order.activity_id ?? undefined });
  return true;
}

/** فصل اللوتات: لكل مكوّن، كل لوط بكميته وتكلفته وحصته، وإسناد المخرجات للوط بنسبة حصته من المكوّن الرئيسي. */
export async function lotRun(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.lots.view');
  const o = (await pool.query(`SELECT id, document_number, status, planned_output_quantity, actual_output_quantity FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
  const rows = (await pool.query(`SELECT a.production_order_line_id AS line_id, a.quantity, a.unit_cost, a.line_cost, a.stock_movement_id, b.batch_no, s.name_ar AS supplier, l.is_main_material, i.code, i.name_ar
    FROM production_line_lots a JOIN production_order_lines l ON l.id=a.production_order_line_id JOIN batches b ON b.id=a.batch_id AND b.company_id=a.company_id LEFT JOIN suppliers s ON s.id=b.supplier_id AND s.company_id=b.company_id JOIN items i ON i.id=l.component_item_id AND i.company_id=l.company_id
    WHERE a.production_order_id=$1 AND a.company_id=$2 ORDER BY l.is_main_material DESC, i.code, b.batch_no`, [orderId, ctx.companyId])).rows;
  const output = Number(o.actual_output_quantity ?? o.planned_output_quantity);
  const lineTotals = new Map<string, number>(); for (const r of rows) lineTotals.set(r.line_id, (lineTotals.get(r.line_id) ?? 0) + Number(r.quantity));
  const mainIds = [...new Set(rows.filter((r) => r.is_main_material).map((r) => r.line_id))];
  const lots = rows.map((r) => { const share = lineTotals.get(r.line_id)! > 0 ? Number(r.quantity) / lineTotals.get(r.line_id)! : 0;
    return { itemCode: r.code, itemName: r.name_ar, isMain: r.is_main_material, batchNo: r.batch_no, supplier: r.supplier, quantity: Number(r.quantity), unitCost: r.unit_cost === null ? null : Number(r.unit_cost), cost: r.line_cost === null ? null : Number(r.line_cost), sharePercent: Math.round(share * 1000) / 10, posted: !!r.stock_movement_id,
      attributedOutput: r.is_main_material && mainIds.length === 1 ? r4(output * share) : null }; });
  return { orderId, orderNo: o.document_number, status: o.status, output, lots, totalCost: r4(rows.reduce((s, r) => s + Number(r.line_cost ?? 0), 0)),
    note: mainIds.length > 1 ? 'عدّة مكوّنات رئيسية: يُعرض لكل لوط حصته من مكوّنه، ولا يُسند الناتج لتعذّر التقسيم بينها.' : null };
}
