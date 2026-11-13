import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled, getProductionOrderById } from '@/modules/manufacturing/manufacturingService';
import { computeTextileCosting, fourPointGrade } from '@/modules/manufacturing/textileCosting';

/* كل دوال هذا الملف تعمل فوق وحدة التصنيع: تُعطَّل بتعطيلها، وتتطلب صلاحيات textile.* (تُمنح للمالك تلقائيًا). */

const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

/** يبني UPDATE جزئيًا آمنًا من قائمة حقول مسموحة فقط (لا يُدرَج اسم عمود من المدخلات أبدًا). */
async function partialUpdate(table: string, id: string, companyId: string, allowed: string[], body: Record<string, unknown>) {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of allowed) {
    if (body[k] === undefined) continue;
    vals.push(body[k]); sets.push(`${snake(k)} = $${vals.length}`);
  }
  if (sets.length === 0) throw new ValidationError('لا توجد حقول للتعديل');
  vals.push(id, companyId);
  const r = await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
  if (r.rows.length === 0) throw new NotFoundError('السجل غير موجود');
  return r.rows[0];
}

async function insertUnique(sql: string, params: unknown[], dupMsg: string) {
  try { return (await pool.query(sql, params)).rows[0]; } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError(dupMsg);
    throw e;
  }
}

/* ============================== المراحل ============================== */

export async function listStages(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  return (await pool.query(`SELECT * FROM textile_stages WHERE company_id=$1 ORDER BY sort_order, code`, [ctx.companyId])).rows;
}
export async function createStage(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  return insertUnique(
    `INSERT INTO textile_stages(company_id, code, name_ar, name_en, stage_type, standard_waste_percent, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [ctx.companyId, b.code, b.nameAr, b.nameEn, b.stageType, b.standardWastePercent ?? '0', b.sortOrder ?? 0], `كود المرحلة "${b.code}" مستخدم`,
  );
}
export async function updateStage(ctx: RequestContext, id: string, b: Record<string, unknown>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  return partialUpdate('textile_stages', id, ctx.companyId, ['code', 'nameAr', 'nameEn', 'stageType', 'standardWastePercent', 'sortOrder', 'isActive'], b);
}

/* ============================== أنواع الهالك ============================== */

export async function listWasteTypes(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  return (await pool.query(
    `SELECT w.*, s.name_ar AS stage_name_ar, i.name_ar AS recovery_item_name_ar
     FROM waste_types w LEFT JOIN textile_stages s ON s.id = w.stage_id AND s.company_id = w.company_id
     LEFT JOIN items i ON i.id = w.recovery_item_id AND i.company_id = w.company_id
     WHERE w.company_id=$1 ORDER BY s.sort_order NULLS LAST, w.code`, [ctx.companyId])).rows;
}
export async function createWasteType(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  return insertUnique(
    `INSERT INTO waste_types(company_id, code, name_ar, name_en, stage_id, is_recoverable, recovery_item_id, recovery_unit_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ctx.companyId, b.code, b.nameAr, b.nameEn, b.stageId ?? null, b.isRecoverable ?? false, b.recoveryItemId ?? null, b.recoveryUnitValue ?? '0'], `كود نوع الهالك "${b.code}" مستخدم`,
  );
}
export async function updateWasteType(ctx: RequestContext, id: string, b: Record<string, unknown>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  return partialUpdate('waste_types', id, ctx.companyId, ['code', 'nameAr', 'nameEn', 'stageId', 'isRecoverable', 'recoveryItemId', 'recoveryUnitValue', 'isActive'], b);
}

/* ============================== مواصفات الصنف ============================== */

export async function getItemSpecs(ctx: RequestContext, itemId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  const r = await pool.query(`SELECT * FROM item_textile_specs WHERE item_id=$1 AND company_id=$2`, [itemId, ctx.companyId]);
  return r.rows[0] ?? null;
}
export async function upsertItemSpecs(ctx: RequestContext, itemId: string, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  const item = await pool.query(`SELECT id FROM items WHERE id=$1 AND company_id=$2`, [itemId, ctx.companyId]);
  if (item.rows.length === 0) throw new NotFoundError('الصنف غير موجود');
  const cols = ['countSystem', 'yarnCount', 'ply', 'twistTpi', 'fiberComposition', 'spinningType', 'weaveType', 'fabricGsm', 'fabricWidthCm', 'epi', 'ppi', 'warpCountNe', 'weftCountNe', 'shrinkagePercent', 'notes', 'knitStructure', 'knitGauge', 'machineDiameterIn', 'stitchLengthMm', 'needlesCount', 'feedersCount'];
  const dbCols = cols.map(snake);
  const vals = cols.map((c) => b[c] ?? null);
  const r = await pool.query(
    `INSERT INTO item_textile_specs(item_id, company_id, ${dbCols.join(', ')}) VALUES ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')})
     ON CONFLICT (item_id) DO UPDATE SET ${dbCols.map((c) => `${c}=EXCLUDED.${c}`).join(', ')}, updated_at=now() RETURNING *`,
    [itemId, ctx.companyId, ...vals],
  );
  return r.rows[0];
}

/* ============================== الماكينات وسجل الإنتاج ============================== */

export async function listMachines(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  return (await pool.query(
    `SELECT m.*, s.name_ar AS stage_name_ar FROM machines m LEFT JOIN textile_stages s ON s.id = m.stage_id AND s.company_id = m.company_id
     WHERE m.company_id=$1 ORDER BY m.code`, [ctx.companyId])).rows;
}
export async function createMachine(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  return insertUnique(
    `INSERT INTO machines(company_id, branch_id, code, name_ar, name_en, stage_id, machine_type, units_count, rated_output_per_hour, output_unit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [ctx.companyId, b.branchId ?? null, b.code, b.nameAr, b.nameEn, b.stageId ?? null, b.machineType ?? null, b.unitsCount ?? 1, b.ratedOutputPerHour ?? '0', b.outputUnit ?? 'kg'],
    `كود الماكينة "${b.code}" مستخدم`,
  );
}
export async function updateMachine(ctx: RequestContext, id: string, b: Record<string, unknown>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  return partialUpdate('machines', id, ctx.companyId, ['code', 'nameAr', 'nameEn', 'branchId', 'stageId', 'machineType', 'unitsCount', 'ratedOutputPerHour', 'outputUnit', 'isActive'], b);
}

export async function createMachineLog(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.log.create', b.branchId);
  const run = new Decimal(b.runHours); const down = new Decimal(b.downtimeHours ?? 0);
  if (run.plus(down).greaterThan(24)) throw new ValidationError('ساعات التشغيل + التوقف لا يمكن أن تتجاوز 24 ساعة');
  if (down.greaterThan(0) && !b.downtimeReason) throw new ValidationError('سبب التوقف مطلوب عند وجود ساعات توقف');
  const m = await pool.query(`SELECT id FROM machines WHERE id=$1 AND company_id=$2 AND is_active=true`, [b.machineId, ctx.companyId]);
  if (m.rows.length === 0) throw new NotFoundError('الماكينة غير موجودة أو غير مفعَّلة');
  return insertUnique(
    `INSERT INTO machine_production_logs(company_id, branch_id, machine_id, shift, log_date, production_order_id, run_hours, downtime_hours, downtime_reason, output_quantity, waste_quantity, notes, created_by, energy_kwh, operators_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [ctx.companyId, b.branchId, b.machineId, b.shift, b.logDate, b.productionOrderId ?? null, b.runHours, b.downtimeHours ?? '0', b.downtimeReason ?? null, b.outputQuantity, b.wasteQuantity ?? '0', b.notes ?? null, ctx.userId, b.energyKwh ?? null, b.operatorsCount ?? null],
    'يوجد سجل لنفس الماكينة والتاريخ والوردية',
  );
}
export async function listMachineLogs(ctx: RequestContext, q: { from?: string; to?: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.log.view');
  return (await pool.query(
    `SELECT l.*, m.code AS machine_code, m.name_ar AS machine_name_ar FROM machine_production_logs l
     JOIN machines m ON m.id = l.machine_id AND m.company_id = l.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3) AND ($4::uuid IS NULL OR l.machine_id = $4)
     ORDER BY l.log_date DESC, l.shift LIMIT 500`, [ctx.companyId, q.from ?? null, q.to ?? null, q.machineId ?? null])).rows;
}

/* ============================== الإنتاج الفعلي والهالك على أمر التصنيع ============================== */

/** يسجّل (يستبدل) الاستهلاك الفعلي والمخرجات والهالك على مسودة أمر تصنيع. لا أثر على المخزون/الدفاتر قبل الترحيل. */
export async function saveOrderCompletion(ctx: RequestContext, orderId: string, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx);
  await withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM production_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('أمر التصنيع غير موجود');
    const order = found.rows[0];
    ctx.assertPermission('textile.completion.manage', order.branch_id);
    if (order.status !== 'draft') throw new ValidationError('لا يمكن تعديل الإنتاج الفعلي إلا لأمر في حالة مسودة');

    for (const l of b.lines ?? []) {
      const r = await client.query(
        `UPDATE production_order_lines SET actual_quantity=$1, is_main_material=COALESCE($2, is_main_material), input_lot_numbers=COALESCE($5, input_lot_numbers) WHERE id=$3 AND production_order_id=$4 RETURNING id`,
        [l.actualQuantity, l.isMainMaterial ?? null, l.lineId, orderId, l.inputLotNumbers ?? null]);
      if (r.rows.length === 0) throw new NotFoundError('سطر غير موجود في هذا الأمر');
    }
    if ((b.lines ?? []).some((l: any) => l.isMainMaterial === true)) {
      // خامة رئيسية واحدة فقط: نُسقط العلامة عن الأسطر التي لم تُحدَّد صراحةً.
      const chosen = (b.lines as any[]).filter((l) => l.isMainMaterial === true).map((l) => l.lineId);
      await client.query(`UPDATE production_order_lines SET is_main_material=false WHERE production_order_id=$1 AND id <> ALL($2::uuid[])`, [orderId, chosen]);
    }

    let std: string | null = b.standardWastePercent ?? null;
    if (std === null && b.stageId) {
      const st = await client.query(`SELECT standard_waste_percent FROM textile_stages WHERE id=$1 AND company_id=$2`, [b.stageId, ctx.companyId]);
      if (st.rows.length === 0) throw new NotFoundError('المرحلة غير موجودة');
      std = st.rows[0].standard_waste_percent;
    }
    await client.query(
      `UPDATE production_orders SET stage_id=COALESCE($2, stage_id), machine_id=COALESCE($3, machine_id), standard_waste_percent=COALESCE($4, standard_waste_percent) WHERE id=$1`,
      [orderId, b.stageId ?? null, b.machineId ?? null, std]);

    await client.query(`DELETE FROM production_order_outputs WHERE production_order_id=$1`, [orderId]);
    await client.query(`DELETE FROM production_order_waste WHERE production_order_id=$1`, [orderId]);
    for (const o of b.outputs) {
      const it = await client.query(`SELECT id FROM items WHERE id=$1 AND company_id=$2`, [o.outputItemId, ctx.companyId]);
      if (it.rows.length === 0) throw new NotFoundError('صنف المخرجات غير موجود');
      await client.query(
        `INSERT INTO production_order_outputs(production_order_id, company_id, output_item_id, grade, quantity, cost_weight, lot_number) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, ctx.companyId, o.outputItemId, o.grade, o.quantity, o.costWeight ?? '1', o.lotNumber ?? null]);
    }
    for (const w of b.wastes ?? []) {
      const t = await client.query(`SELECT recovery_unit_value FROM waste_types WHERE id=$1 AND company_id=$2 AND is_active=true`, [w.wasteTypeId, ctx.companyId]);
      if (t.rows.length === 0) throw new NotFoundError('نوع الهالك غير موجود أو غير مفعَّل');
      await client.query(
        `INSERT INTO production_order_waste(production_order_id, company_id, waste_type_id, quantity, recovery_item_id, recovery_unit_value, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, ctx.companyId, w.wasteTypeId, w.quantity, w.recoveryItemId ?? null, w.recoveryUnitValue ?? t.rows[0].recovery_unit_value, w.notes ?? null]);
    }
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'production_order', entityId: orderId, action: 'update',
      afterJson: { completion: { outputs: b.outputs.length, wastes: (b.wastes ?? []).length } },
    });
  });
  return getProductionOrderById(ctx, orderId);
}

/** معاينة قبل الترحيل: تكلفة الهالك والمخرجات بمتوسط تكلفة المخزون الحالي (لا تغيّر شيئًا). */
export async function previewOrderCompletion(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.completion.manage');
  const o = (await pool.query(`SELECT * FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
  const lines = (await pool.query(
    `SELECT l.*, COALESCE(sb.weighted_average_cost, 0) AS wac FROM production_order_lines l
     LEFT JOIN stock_balances sb ON sb.company_id = l.company_id AND sb.warehouse_id = $2 AND sb.item_id = l.component_item_id AND sb.batch_id IS NULL
     WHERE l.production_order_id=$1`, [orderId, o.warehouse_id])).rows;
  const outs = (await pool.query(`SELECT * FROM production_order_outputs WHERE production_order_id=$1`, [orderId])).rows;
  const wastes = (await pool.query(`SELECT * FROM production_order_waste WHERE production_order_id=$1`, [orderId])).rows;
  if (outs.length === 0) throw new ValidationError('سجِّل المخرجات أولًا');
  const info = lines.map((l) => {
    const qty = new Decimal(l.actual_quantity ?? l.planned_quantity);
    return { qty, unitCost: new Decimal(l.wac), cost: qty.times(l.wac), isMain: !!l.is_main_material };
  });
  const materials = info.reduce((a, x) => a.plus(x.cost), new Decimal(0));
  const ops = (await pool.query(`SELECT COALESCE(SUM(COALESCE(actual_cost, planned_cost)),0) AS c FROM production_order_operations WHERE production_order_id=$1`, [orderId])).rows[0].c;
  const main = info.find((x) => x.isMain) ?? info.reduce((a, b) => (b.qty.greaterThan(a.qty) ? b : a));
  return {
    materialsCost: materials.toFixed(4), conversionCost: new Decimal(ops).toFixed(4),
    ...computeTextileCosting({
      materialsCost: materials, conversionCost: ops, mainConsumedQty: main.qty, mainUnitCost: main.unitCost,
      standardWastePercent: o.standard_waste_percent ?? 0,
      wastes: wastes.map((w) => ({ quantity: w.quantity, recoveryUnitValue: w.recovery_unit_value })),
      outputs: outs.map((x) => ({ quantity: x.quantity, costWeight: x.cost_weight })),
    }),
  };
}

/* ============================== فحص رولات القماش ============================== */

export async function createFabricRoll(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.inspection.manage');
  const g = fourPointGrade(b.defectPoints, b.lengthM, b.widthCm);
  return insertUnique(
    `INSERT INTO fabric_rolls(company_id, production_order_id, item_id, roll_no, length_m, width_cm, weight_kg, defect_points, points_per_100sqyd, grade, inspected_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ctx.companyId, b.productionOrderId ?? null, b.itemId ?? null, b.rollNo, b.lengthM, b.widthCm, b.weightKg ?? null, b.defectPoints, g.pointsPer100SqYd, g.grade, ctx.userId],
    `رقم الرول "${b.rollNo}" مستخدم`,
  );
}
export async function listFabricRolls(ctx: RequestContext, productionOrderId?: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.inspection.manage');
  const rolls = (await pool.query(
    `SELECT * FROM fabric_rolls WHERE company_id=$1 AND ($2::uuid IS NULL OR production_order_id=$2) ORDER BY inspected_at DESC LIMIT 500`, [ctx.companyId, productionOrderId ?? null])).rows;
  const summary = (await pool.query(
    `SELECT grade, count(*)::int AS rolls, COALESCE(sum(length_m),0) AS length_m, COALESCE(sum(weight_kg),0) AS weight_kg
     FROM fabric_rolls WHERE company_id=$1 AND ($2::uuid IS NULL OR production_order_id=$2) GROUP BY grade ORDER BY grade`, [ctx.companyId, productionOrderId ?? null])).rows;
  return { rolls, summary };
}

/* ============================== التقارير ============================== */

/** تحليل الهوالك: حسب المرحلة ونوع الهالك — الكمية، النسبة الفعلية مقابل القياسية، الاسترداد، خسارة غير العادي. أوامر مرحَّلة فقط. */
export async function reportWaste(ctx: RequestContext, q: { from?: string; to?: string; stageId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const args = [ctx.companyId, q.from ?? null, q.to ?? null, q.stageId ?? null];
  const filter = `o.company_id=$1 AND o.status='posted' AND ($2::date IS NULL OR o.order_date >= $2) AND ($3::date IS NULL OR o.order_date <= $3) AND ($4::uuid IS NULL OR o.stage_id = $4)`;
  const byStage = (await pool.query(
    `SELECT s.id AS stage_id, s.code, s.name_ar, s.standard_waste_percent,
            count(*)::int AS orders, COALESCE(sum(mc.main_qty),0) AS main_consumed, COALESCE(sum(o.waste_quantity_total),0) AS waste_qty,
            COALESCE(sum(o.recovered_value_total),0) AS recovered_value, COALESCE(sum(o.abnormal_loss_total),0) AS abnormal_loss,
            CASE WHEN COALESCE(sum(mc.main_qty),0) > 0 THEN round(sum(o.waste_quantity_total) / sum(mc.main_qty) * 100, 3) END AS actual_waste_percent
     FROM production_orders o
     LEFT JOIN textile_stages s ON s.id = o.stage_id AND s.company_id = o.company_id
     LEFT JOIN LATERAL (SELECT COALESCE(sum(consumed_quantity) FILTER (WHERE is_main_material), max(consumed_quantity)) AS main_qty
                        FROM production_order_lines WHERE production_order_id = o.id) mc ON true
     WHERE ${filter} AND o.waste_quantity_total IS NOT NULL
     GROUP BY s.id, s.code, s.name_ar, s.standard_waste_percent ORDER BY s.code NULLS LAST`, args)).rows;
  const byType = (await pool.query(
    `SELECT t.code, t.name_ar, count(*)::int AS entries, sum(w.quantity) AS qty, COALESCE(sum(w.abnormal_quantity),0) AS abnormal_qty,
            COALESCE(sum(w.recovered_value),0) AS recovered_value, COALESCE(sum(w.abnormal_loss),0) AS abnormal_loss
     FROM production_order_waste w JOIN production_orders o ON o.id = w.production_order_id
     JOIN waste_types t ON t.id = w.waste_type_id AND t.company_id = w.company_id
     WHERE ${filter} GROUP BY t.code, t.name_ar ORDER BY sum(w.quantity) DESC`, args)).rows;
  return { byStage, byType };
}

/** تقرير أمر واحد: المدخلات والمخرجات والهالك والعائد (Yield) وتكلفة الوحدة لكل درجة. */
export async function reportOrderYield(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const d = (await getProductionOrderById(ctx, orderId)) as any;
  const main = d.lines.find((l: any) => l.is_main_material) ?? [...d.lines].sort((a: any, b: any) => Number(b.consumed_quantity ?? b.planned_quantity) - Number(a.consumed_quantity ?? a.planned_quantity))[0];
  const mainQty = new Decimal(main?.consumed_quantity ?? main?.actual_quantity ?? main?.planned_quantity ?? 0);
  const outQty = d.outputs.reduce((a: Decimal, o: any) => a.plus(o.quantity), new Decimal(0));
  const wasteQty = d.waste.reduce((a: Decimal, w: any) => a.plus(w.quantity), new Decimal(0));
  const pct = (x: Decimal) => (mainQty.isZero() ? null : x.dividedBy(mainQty).times(100).toFixed(3));
  return {
    order: { id: d.id, documentNumber: d.document_number, status: d.status, orderDate: d.order_date, standardWastePercent: d.standard_waste_percent },
    mainInputQty: mainQty.toFixed(4), outputQty: outQty.toFixed(4), wasteQty: wasteQty.toFixed(4),
    yieldPercent: pct(outQty), actualWastePercent: pct(wasteQty),
    materialsCost: d.materials_cost, conversionCost: d.conversion_cost, totalCost: d.total_cost,
    recoveredValue: d.recovered_value_total, abnormalLoss: d.abnormal_loss_total,
    outputs: d.outputs, waste: d.waste,
  };
}

/** كفاءة الماكينات: الإنتاج الفعلي مقابل الطاقة الاسمية لساعات التشغيل، ونسبة الاستغلال، وأعلى أسباب التوقف. */
export async function reportMachineEfficiency(ctx: RequestContext, q: { from?: string; to?: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const args = [ctx.companyId, q.from ?? null, q.to ?? null, q.machineId ?? null];
  const where = `l.company_id=$1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3) AND ($4::uuid IS NULL OR l.machine_id = $4)`;
  const machines = (await pool.query(
    `SELECT m.id AS machine_id, m.code, m.name_ar, m.output_unit, m.rated_output_per_hour, count(*)::int AS shifts,
            sum(l.run_hours) AS run_hours, sum(l.downtime_hours) AS downtime_hours, sum(l.output_quantity) AS output, sum(l.waste_quantity) AS waste,
            round(m.rated_output_per_hour * sum(l.run_hours), 4) AS theoretical_output,
            CASE WHEN m.rated_output_per_hour * sum(l.run_hours) > 0 THEN round(sum(l.output_quantity) / (m.rated_output_per_hour * sum(l.run_hours)) * 100, 2) END AS efficiency_percent,
            CASE WHEN sum(l.run_hours + l.downtime_hours) > 0 THEN round(sum(l.run_hours) / sum(l.run_hours + l.downtime_hours) * 100, 2) END AS utilization_percent
     FROM machine_production_logs l JOIN machines m ON m.id = l.machine_id AND m.company_id = l.company_id
     WHERE ${where} GROUP BY m.id, m.code, m.name_ar, m.output_unit, m.rated_output_per_hour ORDER BY m.code`, args)).rows;
  const downtime = (await pool.query(
    `SELECT downtime_reason AS reason, sum(downtime_hours) AS hours, count(*)::int AS occurrences FROM machine_production_logs l
     WHERE ${where} AND downtime_hours > 0 GROUP BY downtime_reason ORDER BY sum(downtime_hours) DESC LIMIT 10`, args)).rows;
  return { machines, downtime };
}
