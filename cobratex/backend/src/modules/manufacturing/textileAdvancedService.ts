import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { planMaterials, computeOee, type MrpBom } from '@/modules/manufacturing/textileMrp';

/* إضافات متقدمة لمصنع الغزل والنسيج: بيمات السدى، التعبئة، الفاقد غير المفسَّر، OEE، تكلفة الوصفة والانحراف، تخطيط المتطلبات.
 * كلها فوق وحدة التصنيع (تتعطّل بتعطيلها) وبصلاحيات textile.* (تُمنح للمالك تلقائيًا). */

const D = (v: Decimal.Value) => new Decimal(v);

async function insertUnique(sql: string, params: unknown[], dupMsg: string) {
  try { return (await pool.query(sql, params)).rows[0]; } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError(dupMsg);
    throw e;
  }
}

/* ============================== بيمات السدى ============================== */

export async function createBeam(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.beam.manage', b.branchId);
  return insertUnique(
    `INSERT INTO weaving_beams(company_id, branch_id, beam_no, beam_type, yarn_item_id, lot_number, yarn_count_ne, total_ends, length_m, weight_kg, sizing_pickup_percent, production_order_id, notes, created_by)
     VALUES ($1,$2,$3,COALESCE($4,'warp'),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [ctx.companyId, b.branchId, b.beamNo, b.beamType ?? null, b.yarnItemId ?? null, b.lotNumber ?? null, b.yarnCountNe ?? null, b.totalEnds, b.lengthM, b.weightKg ?? null, b.sizingPickupPercent ?? null, b.productionOrderId ?? null, b.notes ?? null, ctx.userId],
    `رقم البيم "${b.beamNo}" مستخدم`,
  );
}

export async function listBeams(ctx: RequestContext, q: { status?: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.beam.manage');
  return (await pool.query(
    `SELECT w.*, (w.length_m - w.meters_woven) AS remaining_m, m.code AS machine_code, m.name_ar AS machine_name_ar
     FROM weaving_beams w LEFT JOIN machines m ON m.id = w.machine_id AND m.company_id = w.company_id
     WHERE w.company_id=$1 AND ($2::text IS NULL OR w.status=$2) AND ($3::uuid IS NULL OR w.machine_id=$3)
     ORDER BY w.created_at DESC LIMIT 500`, [ctx.companyId, q.status ?? null, q.machineId ?? null])).rows;
}

async function lockBeam(client: any, ctx: RequestContext, id: string) {
  const r = await client.query(`SELECT * FROM weaving_beams WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId]);
  if (r.rows.length === 0) throw new NotFoundError('البيم غير موجود');
  ctx.assertPermission('textile.beam.manage', r.rows[0].branch_id);
  return r.rows[0];
}

/** تركيب بيم مجهَّز على نول. نول واحد = بيم نشط واحد (يحميه فهرس فريد أيضًا ضد التزامن). */
export async function mountBeam(ctx: RequestContext, id: string, machineId: string) {
  await assertManufacturingEnabled(ctx);
  return withTransaction(async (client) => {
    const beam = await lockBeam(client, ctx, id);
    if (beam.status !== 'prepared') throw new ValidationError('لا يُركَّب إلا بيم في حالة «مجهَّز»');
    const m = await client.query(`SELECT id FROM machines WHERE id=$1 AND company_id=$2 AND is_active=true`, [machineId, ctx.companyId]);
    if (m.rows.length === 0) throw new NotFoundError('النول غير موجود أو غير مفعَّل');
    try {
      const r = await client.query(`UPDATE weaving_beams SET status='on_loom', machine_id=$2, mounted_at=now() WHERE id=$1 RETURNING *`, [id, machineId]);
      return r.rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('هذا النول يحمل بيمًا نشطًا بالفعل');
      throw e;
    }
  });
}

/** تسجيل أمتار منسوجة من البيم؛ يُغلَق تلقائيًا عند استنفاد الطول. */
export async function addBeamProgress(ctx: RequestContext, id: string, meters: string) {
  await assertManufacturingEnabled(ctx);
  return withTransaction(async (client) => {
    const beam = await lockBeam(client, ctx, id);
    if (beam.status !== 'on_loom') throw new ValidationError('تُسجَّل الأمتار على بيم مركَّب على نول فقط');
    const woven = D(beam.meters_woven).plus(meters);
    if (woven.greaterThan(beam.length_m)) throw new ValidationError(`الأمتار المنسوجة (${woven.toFixed(3)}) تتجاوز طول البيم (${beam.length_m})`);
    const done = woven.equals(D(beam.length_m));
    const r = await client.query(
      `UPDATE weaving_beams SET meters_woven=$2, status=CASE WHEN $3 THEN 'finished' ELSE status END, finished_at=CASE WHEN $3 THEN now() ELSE finished_at END WHERE id=$1 RETURNING *`,
      [id, woven.toFixed(3), done]);
    return r.rows[0];
  });
}

export async function scrapBeam(ctx: RequestContext, id: string, reason: string) {
  await assertManufacturingEnabled(ctx);
  return withTransaction(async (client) => {
    const beam = await lockBeam(client, ctx, id);
    if (!['prepared', 'on_loom'].includes(beam.status)) throw new ValidationError('لا يُشطَب إلا بيم مجهَّز أو مركَّب');
    const r = await client.query(
      `UPDATE weaving_beams SET status='scrapped', finished_at=now(), notes=concat_ws(E'\n', notes, $2::text) WHERE id=$1 RETURNING *`, [id, `شطب: ${reason}`]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'weaving_beam', entityId: id, action: 'update', afterJson: { status: 'scrapped', reason } });
    return r.rows[0];
  });
}

/* ============================== التعبئة ============================== */

export async function createPackingUnits(ctx: RequestContext, b: { branchId: string; units: Array<Record<string, any>> }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.packing.manage', b.branchId);
  const nos = b.units.map((u) => u.packingNo);
  if (new Set(nos).size !== nos.length) throw new ValidationError('أرقام التعبئة مكررة داخل الطلب');
  try {
    return await withTransaction(async (client) => {
      const out = [];
      for (const u of b.units) {
        if (D(u.tareKg ?? 0).greaterThanOrEqualTo(u.grossKg)) throw new ValidationError(`الوزن الفارغ يجب أن يكون أقل من القائم (${u.packingNo})`);
        const it = await client.query(`SELECT id FROM items WHERE id=$1 AND company_id=$2`, [u.itemId, ctx.companyId]);
        if (it.rows.length === 0) throw new NotFoundError('الصنف غير موجود');
        const r = await client.query(
          `INSERT INTO packing_units(company_id, branch_id, packing_no, unit_type, item_id, lot_number, production_order_id, packages_count, gross_kg, tare_kg, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [ctx.companyId, b.branchId, u.packingNo, u.unitType, u.itemId, u.lotNumber ?? null, u.productionOrderId ?? null, u.packagesCount ?? 0, u.grossKg, u.tareKg ?? '0', u.notes ?? null, ctx.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError('أحد أرقام التعبئة مستخدم من قبل');
    throw e;
  }
}

export async function listPackingUnits(ctx: RequestContext, q: { lot?: string; status?: string; itemId?: string; productionOrderId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.packing.manage');
  const args = [ctx.companyId, q.lot ?? null, q.status ?? null, q.itemId ?? null, q.productionOrderId ?? null];
  const where = `p.company_id=$1 AND ($2::text IS NULL OR p.lot_number=$2) AND ($3::text IS NULL OR p.status=$3) AND ($4::uuid IS NULL OR p.item_id=$4) AND ($5::uuid IS NULL OR p.production_order_id=$5)`;
  const units = (await pool.query(
    `SELECT p.*, i.code AS item_code, i.name_ar AS item_name_ar FROM packing_units p JOIN items i ON i.id=p.item_id AND i.company_id=p.company_id
     WHERE ${where} ORDER BY p.created_at DESC LIMIT 500`, args)).rows;
  const summary = (await pool.query(
    `SELECT p.lot_number, p.item_id, i.code AS item_code, count(*)::int AS units, COALESCE(sum(p.packages_count),0)::int AS packages,
            sum(p.gross_kg) AS gross_kg, sum(p.tare_kg) AS tare_kg, sum(p.net_kg) AS net_kg
     FROM packing_units p JOIN items i ON i.id=p.item_id AND i.company_id=p.company_id
     WHERE ${where} GROUP BY p.lot_number, p.item_id, i.code ORDER BY p.lot_number NULLS LAST, i.code`, args)).rows;
  return { units, summary };
}

export async function shipPackingUnits(ctx: RequestContext, ids: string[]) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.packing.manage');
  return withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE packing_units SET status='shipped', shipped_at=now() WHERE company_id=$1 AND id = ANY($2::uuid[]) AND status='in_stock' RETURNING id`, [ctx.companyId, ids]);
    if (r.rows.length !== new Set(ids).size) throw new ValidationError('بعض الوحدات غير موجودة أو شُحنت من قبل — لم يتغيّر شيء');
    return { shipped: r.rows.length };
  });
}

/* ============================== الفاقد غير المفسَّر (ميزان المواد) ============================== */

/**
 * ميزان المادة لكل أمر مرحَّل: المُدخَل (الخامة الرئيسية) − المخرجات − الهوالك المسجَّلة = فرق غير مفسَّر.
 * هذا هو "الفاقد غير المرئي" الحقيقي (رطوبة/غبار/أخطاء وزن) أو تسجيل ناقص؛ يصبح تحقيق الإدارة.
 * يُقارَن فقط حين تتطابق وحدة قياس الخامة والمخرجات (غزل→غزل كجم)، وإلا يُعلَّم «غير قابل للمقارنة» (مثل غزل→قماش بالمتر).
 */
export async function reportMaterialBalance(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const orders = (await pool.query(
    `SELECT o.id, o.document_number, o.order_date, s.code AS stage_code, s.name_ar AS stage_name_ar, mc.qty AS main_qty,
            (SELECT COALESCE(sum(po.quantity),0) FROM production_order_outputs po JOIN items i ON i.id=po.output_item_id AND i.company_id=po.company_id WHERE po.production_order_id=o.id) AS out_qty,
            (SELECT count(*) FROM production_order_outputs po JOIN items i ON i.id=po.output_item_id AND i.company_id=po.company_id WHERE po.production_order_id=o.id AND i.base_uom_id <> mc.uom_id)::int AS other_uom_outputs,
            (SELECT COALESCE(sum(w.quantity),0) FROM production_order_waste w WHERE w.production_order_id=o.id) AS waste_qty
     FROM production_orders o
     LEFT JOIN textile_stages s ON s.id=o.stage_id AND s.company_id=o.company_id
     JOIN LATERAL (SELECT l.consumed_quantity AS qty, i.base_uom_id AS uom_id FROM production_order_lines l JOIN items i ON i.id=l.component_item_id AND i.company_id=l.company_id
                   WHERE l.production_order_id=o.id AND l.consumed_quantity IS NOT NULL ORDER BY l.is_main_material DESC, l.consumed_quantity DESC LIMIT 1) mc ON true
     WHERE o.company_id=$1 AND o.status='posted' AND ($2::date IS NULL OR o.order_date >= $2) AND ($3::date IS NULL OR o.order_date <= $3)
     ORDER BY o.order_date DESC, o.document_number DESC LIMIT 500`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;

  const rows = orders.map((o) => {
    const comparable = o.other_uom_outputs === 0 && D(o.main_qty).greaterThan(0);
    const unexplained = comparable ? D(o.main_qty).minus(o.out_qty).minus(o.waste_qty) : null;
    return {
      orderId: o.id, documentNumber: o.document_number, orderDate: o.order_date, stageCode: o.stage_code, stageNameAr: o.stage_name_ar,
      mainInputQty: o.main_qty, outputQty: o.out_qty, recordedWasteQty: o.waste_qty, comparable,
      unexplainedQty: unexplained ? unexplained.toFixed(4) : null,
      unexplainedPercent: unexplained ? unexplained.dividedBy(o.main_qty).times(100).toFixed(3) : null,
    };
  });
  const byStage = new Map<string, { stageCode: string | null; stageNameAr: string | null; input: Decimal; unexplained: Decimal; orders: number }>();
  for (const r of rows.filter((x) => x.comparable)) {
    const k = r.stageCode ?? '-';
    const cur = byStage.get(k) ?? { stageCode: r.stageCode, stageNameAr: r.stageNameAr, input: D(0), unexplained: D(0), orders: 0 };
    cur.input = cur.input.plus(r.mainInputQty); cur.unexplained = cur.unexplained.plus(r.unexplainedQty!); cur.orders++;
    byStage.set(k, cur);
  }
  return {
    orders: rows,
    byStage: [...byStage.values()].map((s) => ({ stageCode: s.stageCode, stageNameAr: s.stageNameAr, orders: s.orders, inputQty: s.input.toFixed(4), unexplainedQty: s.unexplained.toFixed(4),
      unexplainedPercent: s.input.greaterThan(0) ? s.unexplained.dividedBy(s.input).times(100).toFixed(3) : null })),
  };
}

/* ============================== OEE وطاقة الماكينات ============================== */

export async function reportOee(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const rows = (await pool.query(
    `SELECT m.id AS machine_id, m.code, m.name_ar, m.output_unit, count(*)::int AS shifts,
            sum(l.run_hours) AS run_hours, sum(l.downtime_hours) AS downtime_hours, sum(l.output_quantity) AS output, sum(l.waste_quantity) AS waste,
            round(m.rated_output_per_hour * sum(l.run_hours), 4) AS theoretical_output,
            sum(l.energy_kwh) AS energy_kwh, sum(l.operators_count * (l.run_hours)) AS operator_hours
     FROM machine_production_logs l JOIN machines m ON m.id=l.machine_id AND m.company_id=l.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3)
     GROUP BY m.id, m.code, m.name_ar, m.output_unit, m.rated_output_per_hour ORDER BY m.code`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  return rows.map((r) => ({
    machineId: r.machine_id, code: r.code, nameAr: r.name_ar, outputUnit: r.output_unit, shifts: r.shifts,
    runHours: r.run_hours, downtimeHours: r.downtime_hours, output: r.output, waste: r.waste,
    ...computeOee(r.run_hours, r.downtime_hours, r.output, r.theoretical_output, r.waste),
    kwhPerUnit: r.energy_kwh !== null && D(r.output).greaterThan(0) ? D(r.energy_kwh).dividedBy(r.output).toFixed(4) : null,
    outputPerOperatorHour: r.operator_hours !== null && D(r.operator_hours).greaterThan(0) ? D(r.output).dividedBy(r.operator_hours).toFixed(4) : null,
  }));
}

/* ============================== تكلفة الوصفة والانحراف ============================== */

/** تكلفة الوحدة المرجعية للصنف: standard_cost إن وُجدت، وإلا متوسط التكلفة المرجَّح لكل الأرصدة (أو لمخزن محدد). */
const COST_SQL = `
  SELECT i.id AS item_id, i.code, i.name_ar, i.standard_cost,
         (SELECT CASE WHEN sum(sb.quantity_on_hand) > 0 THEN sum(sb.quantity_on_hand * sb.weighted_average_cost) / sum(sb.quantity_on_hand) END
          FROM stock_balances sb WHERE sb.company_id=i.company_id AND sb.item_id=i.id AND sb.quantity_on_hand > 0 AND ($3::uuid IS NULL OR sb.warehouse_id=$3)) AS wac
  FROM items i WHERE i.company_id=$1 AND i.id = ANY($2::uuid[])`;

async function unitCosts(companyId: string, itemIds: string[], warehouseId: string | null) {
  const r = await pool.query(COST_SQL, [companyId, itemIds, warehouseId]);
  return new Map<string, { code: string; nameAr: string; cost: Decimal | null; source: 'standard' | 'average' | 'missing' }>(
    r.rows.map((x) => [x.item_id, {
      code: x.code, nameAr: x.name_ar,
      cost: x.standard_cost !== null ? D(x.standard_cost) : x.wac !== null ? D(x.wac) : null,
      source: x.standard_cost !== null ? 'standard' : x.wac !== null ? 'average' : 'missing',
    }]));
}

export async function bomCost(ctx: RequestContext, bomId: string, warehouseId?: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.planning.view');
  const bom = (await pool.query(`SELECT * FROM bill_of_materials WHERE id=$1 AND company_id=$2`, [bomId, ctx.companyId])).rows[0];
  if (!bom) throw new NotFoundError('الوصفة غير موجودة');
  const lines = (await pool.query(`SELECT * FROM bom_lines WHERE bom_id=$1 ORDER BY sequence`, [bomId])).rows;
  const ops = (await pool.query(`SELECT COALESCE(sum(cost_amount),0) AS c FROM bom_operations WHERE bom_id=$1`, [bomId])).rows[0].c;
  const costs = await unitCosts(ctx.companyId, lines.map((l) => l.component_item_id), warehouseId ?? null);
  let materials = D(0);
  const missing: string[] = [];
  const detail = lines.map((l) => {
    const c = costs.get(l.component_item_id);
    const qty = D(l.quantity).times(D(1).plus(D(l.waste_percent).dividedBy(100)));
    const unit = c?.cost ?? D(0);
    if (!c || c.source === 'missing') missing.push(c?.code ?? l.component_item_id);
    const lineCost = qty.times(unit);
    materials = materials.plus(lineCost);
    return { itemId: l.component_item_id, code: c?.code, nameAr: c?.nameAr, quantityWithWaste: qty.toFixed(4), wastePercent: l.waste_percent, unitCost: unit.toFixed(4), costSource: c?.source ?? 'missing', lineCost: lineCost.toFixed(4) };
  });
  const total = materials.plus(ops);
  const out = D(bom.output_quantity);
  return {
    bomId, code: bom.code, outputQuantity: out.toFixed(4),
    materialsCost: materials.toFixed(4), conversionCost: D(ops).toFixed(4), totalCost: total.toFixed(4), unitCost: total.dividedBy(out).toFixed(4),
    missingCostItems: missing, lines: detail,
    note: 'التكلفة بأسعار اليوم (تكلفة معيارية للصنف إن وُجدت وإلا متوسط المخزون). مكوّن بلا تكلفة يُحسب صفرًا ويُذكر في missingCostItems.',
  };
}

/** انحراف التكلفة: تكلفة الوحدة الفعلية للأمر المرحَّل مقابل تكلفة وصفته الحالية. موجب = أغلى من المعيار. */
export async function reportCostVariance(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const orders = (await pool.query(
    `SELECT o.id, o.document_number, o.order_date, o.bom_id, o.output_item_id, o.total_cost,
            COALESCE(o.actual_output_quantity, o.planned_output_quantity) AS out_qty, i.code AS item_code, i.name_ar AS item_name_ar
     FROM production_orders o JOIN items i ON i.id=o.output_item_id AND i.company_id=o.company_id
     WHERE o.company_id=$1 AND o.status='posted' AND o.total_cost IS NOT NULL AND ($2::date IS NULL OR o.order_date >= $2) AND ($3::date IS NULL OR o.order_date <= $3)
     ORDER BY o.order_date DESC LIMIT 200`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  const stdByBom = new Map<string, Decimal>();
  for (const bid of new Set(orders.map((o) => o.bom_id as string))) stdByBom.set(bid, D((await bomCost(ctx, bid)).unitCost));
  return orders.map((o) => {
    const actual = D(o.total_cost).dividedBy(o.out_qty);
    const std = stdByBom.get(o.bom_id)!;
    const variance = actual.minus(std);
    return {
      orderId: o.id, documentNumber: o.document_number, orderDate: o.order_date, itemCode: o.item_code, itemNameAr: o.item_name_ar, outputQty: o.out_qty,
      actualUnitCost: actual.toFixed(4), standardUnitCost: std.toFixed(4), variance: variance.toFixed(4),
      variancePercent: std.greaterThan(0) ? variance.dividedBy(std).times(100).toFixed(2) : null,
    };
  });
}

/* ============================== تخطيط المتطلبات (MRP) ============================== */

export async function planRequirements(ctx: RequestContext, b: { items: Array<{ itemId: string; quantity: string }>; warehouseId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.planning.view');
  // أحدث وصفة نشطة لكل صنف مُنتَج.
  const bomRows = (await pool.query(
    `SELECT DISTINCT ON (output_item_id) id, output_item_id, output_quantity FROM bill_of_materials WHERE company_id=$1 AND is_active=true ORDER BY output_item_id, created_at DESC`, [ctx.companyId])).rows;
  const lineRows = bomRows.length === 0 ? [] : (await pool.query(
    `SELECT bom_id, component_item_id, quantity, waste_percent FROM bom_lines WHERE company_id=$1 AND bom_id = ANY($2::uuid[])`, [ctx.companyId, bomRows.map((r) => r.id)])).rows;
  const boms = new Map<string, MrpBom>(bomRows.map((r) => [r.output_item_id, {
    outputQuantity: r.output_quantity,
    lines: lineRows.filter((l) => l.bom_id === r.id).map((l) => ({ componentItemId: l.component_item_id, quantity: l.quantity, wastePercent: l.waste_percent })),
  }]));

  const stock = (await pool.query(
    `SELECT item_id, sum(quantity_on_hand - quantity_reserved) AS qty FROM stock_balances WHERE company_id=$1 AND ($2::uuid IS NULL OR warehouse_id=$2) GROUP BY item_id`,
    [ctx.companyId, b.warehouseId ?? null])).rows;
  const onHand = new Map<string, Decimal.Value>(stock.map((r) => [r.item_id, r.qty]));

  const plan = planMaterials(b.items.map((i) => ({ itemId: i.itemId, quantity: i.quantity })), boms, onHand);
  const ids = plan.map((p) => p.itemId);
  const meta = new Map((await pool.query(`SELECT id, code, name_ar, reorder_point FROM items WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, ids])).rows.map((r) => [r.id, r]));
  const incoming = new Map((await pool.query(
    `SELECT l.item_id, sum(l.quantity - l.received_quantity) AS qty FROM purchase_order_lines l JOIN purchase_orders p ON p.id=l.purchase_order_id AND p.company_id=l.company_id
     WHERE l.company_id=$1 AND p.status='confirmed' AND l.item_id = ANY($2::uuid[]) GROUP BY l.item_id`, [ctx.companyId, ids])).rows.map((r) => [r.item_id, D(r.qty)]));

  const rows = plan.map((p) => {
    const m = meta.get(p.itemId);
    const inc = incoming.get(p.itemId) ?? D(0);
    const toBuy = Decimal.max(D(p.toPurchase).minus(inc), 0);
    return { ...p, code: m?.code, nameAr: m?.name_ar, incomingPurchaseQty: inc.toFixed(4), shortageToPurchase: toBuy.toFixed(4), kind: D(p.toProduce).greaterThan(0) ? 'manufactured' : 'raw' };
  });
  return {
    rows,
    summary: { itemsToPurchase: rows.filter((r) => D(r.shortageToPurchase).greaterThan(0)).length, itemsToManufacture: rows.filter((r) => r.kind === 'manufactured').length },
    note: 'المتاح = الكمية بالمخزن − المحجوز. «قيد الاستلام» من أوامر شراء مؤكَّدة غير مستلمة بالكامل. يُستخدم أحدث وصفة نشطة لكل صنف.',
  };
}
