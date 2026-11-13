import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { reportWaste, reportMachineEfficiency } from '@/modules/manufacturing/textileService';

/* جودة معملية + صيانة + تتبّع لوطات + لوحة المؤشرات. كلها فوق وحدة التصنيع (تتعطّل بتعطيلها) وبصلاحيات textile.*. */

const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

async function insertUnique(sql: string, params: unknown[], dupMsg: string) {
  try { return (await pool.query(sql, params)).rows[0]; } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError(dupMsg);
    throw e;
  }
}

/* ============================== أنواع الاختبارات ============================== */

export async function listQualityTypes(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.quality.view');
  return (await pool.query(`SELECT * FROM quality_test_types WHERE company_id=$1 ORDER BY applies_to, code`, [ctx.companyId])).rows;
}
export async function createQualityType(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.quality.manage');
  return insertUnique(
    `INSERT INTO quality_test_types(company_id, code, name_ar, name_en, applies_to, unit, min_value, max_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ctx.companyId, b.code, b.nameAr, b.nameEn, b.appliesTo, b.unit ?? null, b.minValue ?? null, b.maxValue ?? null], `كود الاختبار "${b.code}" مستخدم`);
}
export async function updateQualityType(ctx: RequestContext, id: string, b: Record<string, unknown>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.quality.manage');
  const allowed = ['code', 'nameAr', 'nameEn', 'appliesTo', 'unit', 'minValue', 'maxValue', 'isActive'];
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of allowed) { if (b[k] === undefined) continue; vals.push(b[k]); sets.push(`${snake(k)} = $${vals.length}`); }
  if (sets.length === 0) throw new ValidationError('لا توجد حقول للتعديل');
  vals.push(id, ctx.companyId);
  try {
    const r = await pool.query(`UPDATE quality_test_types SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`, vals);
    if (r.rows.length === 0) throw new NotFoundError('نوع الاختبار غير موجود');
    return r.rows[0];
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new ConflictError('الكود مستخدم');
    if (code === '23514') throw new ValidationError('الحد الأدنى يجب ألا يتجاوز الحد الأعلى');
    throw e;
  }
}

/* ============================== نتائج الاختبارات ============================== */

export async function createQualityResult(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.quality.manage');
  const t = (await pool.query(`SELECT * FROM quality_test_types WHERE id=$1 AND company_id=$2 AND is_active=true`, [b.testTypeId, ctx.companyId])).rows[0];
  if (!t) throw new NotFoundError('نوع الاختبار غير موجود أو غير مفعَّل');
  if (!b.productionOrderId && !b.itemId && !b.lotNumber) throw new ValidationError('حدِّد أمر تصنيع أو صنفًا أو رقم لوط للنتيجة');
  const v = new Decimal(b.value);
  const passed = (t.min_value === null || v.greaterThanOrEqualTo(t.min_value)) && (t.max_value === null || v.lessThanOrEqualTo(t.max_value));
  const r = await pool.query(
    `INSERT INTO quality_test_results(company_id, test_type_id, production_order_id, item_id, lot_number, value, passed, min_applied, max_applied, notes, tested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [ctx.companyId, b.testTypeId, b.productionOrderId ?? null, b.itemId ?? null, b.lotNumber ?? null, b.value, passed, t.min_value, t.max_value, b.notes ?? null, ctx.userId]);
  return r.rows[0];
}

export async function listQualityResults(ctx: RequestContext, q: { from?: string; to?: string; lot?: string; productionOrderId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.quality.view');
  return (await pool.query(
    `SELECT r.*, t.code AS test_code, t.name_ar AS test_name_ar, t.unit, t.applies_to
     FROM quality_test_results r JOIN quality_test_types t ON t.id = r.test_type_id AND t.company_id = r.company_id
     WHERE r.company_id=$1 AND ($2::date IS NULL OR r.tested_at::date >= $2) AND ($3::date IS NULL OR r.tested_at::date <= $3)
       AND ($4::text IS NULL OR r.lot_number = $4) AND ($5::uuid IS NULL OR r.production_order_id = $5)
     ORDER BY r.tested_at DESC LIMIT 500`,
    [ctx.companyId, q.from ?? null, q.to ?? null, q.lot ?? null, q.productionOrderId ?? null])).rows;
}

/* ============================== الصيانة ============================== */

export async function listMaintenancePlans(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.maintenance.view');
  return (await pool.query(
    `SELECT p.*, m.code AS machine_code, m.name_ar AS machine_name_ar, (p.next_due_date < CURRENT_DATE) AS overdue
     FROM maintenance_plans p JOIN machines m ON m.id = p.machine_id AND m.company_id = p.company_id
     WHERE p.company_id=$1 ORDER BY p.is_active DESC, p.next_due_date`, [ctx.companyId])).rows;
}
export async function createMaintenancePlan(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.maintenance.manage');
  const m = await pool.query(`SELECT id FROM machines WHERE id=$1 AND company_id=$2`, [b.machineId, ctx.companyId]);
  if (m.rows.length === 0) throw new NotFoundError('الماكينة غير موجودة');
  return (await pool.query(
    `INSERT INTO maintenance_plans(company_id, machine_id, task_name, interval_days, next_due_date)
     VALUES ($1,$2,$3,$4, COALESCE($5::date, CURRENT_DATE + $4::int)) RETURNING *`,
    [ctx.companyId, b.machineId, b.taskName, b.intervalDays, b.nextDueDate ?? null])).rows[0];
}
export async function updateMaintenancePlan(ctx: RequestContext, id: string, b: Record<string, unknown>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.maintenance.manage');
  const allowed = ['taskName', 'intervalDays', 'nextDueDate', 'isActive'];
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of allowed) { if (b[k] === undefined) continue; vals.push(b[k]); sets.push(`${snake(k)} = $${vals.length}`); }
  if (sets.length === 0) throw new ValidationError('لا توجد حقول للتعديل');
  vals.push(id, ctx.companyId);
  const r = await pool.query(`UPDATE maintenance_plans SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`, vals);
  if (r.rows.length === 0) throw new NotFoundError('خطة الصيانة غير موجودة');
  return r.rows[0];
}

/** تسجيل صيانة. إن كانت وقائية ومرتبطة بخطة: تُحدَّث الخطة (آخر تنفيذ + الاستحقاق القادم = تاريخ التنفيذ + الدورية). */
export async function createMaintenanceLog(ctx: RequestContext, b: Record<string, any>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.maintenance.manage');
  return withTransaction(async (client) => {
    const m = await client.query(`SELECT id FROM machines WHERE id=$1 AND company_id=$2`, [b.machineId, ctx.companyId]);
    if (m.rows.length === 0) throw new NotFoundError('الماكينة غير موجودة');
    if (b.planId) {
      const p = await client.query(`SELECT machine_id FROM maintenance_plans WHERE id=$1 AND company_id=$2 FOR UPDATE`, [b.planId, ctx.companyId]);
      if (p.rows.length === 0) throw new NotFoundError('خطة الصيانة غير موجودة');
      if (p.rows[0].machine_id !== b.machineId) throw new ValidationError('الخطة لا تخص هذه الماكينة');
    }
    const log = (await client.query(
      `INSERT INTO maintenance_logs(company_id, machine_id, plan_id, log_type, log_date, downtime_hours, cost, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ctx.companyId, b.machineId, b.planId ?? null, b.logType, b.logDate, b.downtimeHours ?? '0', b.cost ?? '0', b.description ?? null, ctx.userId])).rows[0];
    if (b.planId && b.logType === 'preventive') {
      await client.query(
        `UPDATE maintenance_plans SET last_done_date=$1::date, next_due_date=($1::date + interval_days) WHERE id=$2 AND company_id=$3`,
        [b.logDate, b.planId, ctx.companyId]);
    }
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, entityType: 'maintenance_log', entityId: log.id, action: 'create', afterJson: { machineId: b.machineId, logType: b.logType, cost: b.cost ?? '0' } });
    return log;
  });
}

export async function listMaintenanceLogs(ctx: RequestContext, q: { from?: string; to?: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.maintenance.view');
  return (await pool.query(
    `SELECT l.*, m.code AS machine_code, m.name_ar AS machine_name_ar FROM maintenance_logs l JOIN machines m ON m.id = l.machine_id AND m.company_id = l.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3) AND ($4::uuid IS NULL OR l.machine_id = $4)
     ORDER BY l.log_date DESC, l.created_at DESC LIMIT 500`, [ctx.companyId, q.from ?? null, q.to ?? null, q.machineId ?? null])).rows;
}

/** الخطط المتأخرة أو المستحقة خلال N يوم (افتراضي 7). */
export async function listMaintenanceDue(ctx: RequestContext, days = 7) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.maintenance.view');
  return (await pool.query(
    `SELECT p.*, m.code AS machine_code, m.name_ar AS machine_name_ar, (p.next_due_date < CURRENT_DATE) AS overdue, (p.next_due_date - CURRENT_DATE) AS days_left
     FROM maintenance_plans p JOIN machines m ON m.id = p.machine_id AND m.company_id = p.company_id
     WHERE p.company_id=$1 AND p.is_active AND m.is_active AND p.next_due_date <= CURRENT_DATE + $2::int ORDER BY p.next_due_date`, [ctx.companyId, days])).rows;
}

/** تكلفة وتوقف الصيانة لكل ماكينة في فترة. */
export async function reportMaintenance(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  return (await pool.query(
    `SELECT m.id AS machine_id, m.code, m.name_ar,
            count(*) FILTER (WHERE l.log_type='breakdown')::int AS breakdowns, count(*) FILTER (WHERE l.log_type='preventive')::int AS preventive,
            COALESCE(sum(l.downtime_hours),0) AS downtime_hours, COALESCE(sum(l.cost),0) AS cost
     FROM maintenance_logs l JOIN machines m ON m.id = l.machine_id AND m.company_id = l.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3)
     GROUP BY m.id, m.code, m.name_ar ORDER BY COALESCE(sum(l.cost),0) DESC`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
}

/* ============================== تتبّع اللوطات ============================== */

/** يبحث عن رقم لوط: كمُنتَج (مخرجات)، أو كخامة مستهلكة (سطر يحتوي الرقم ضمن input_lot_numbers)، مع نتائج الجودة. */
export async function traceLot(ctx: RequestContext, lot: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  if (!lot) throw new ValidationError('رقم اللوط مطلوب');
  const produced = (await pool.query(
    `SELECT o.id AS order_id, o.document_number, o.order_date, o.status, po.output_item_id AS item_id, i.name_ar AS item_name_ar, po.grade, po.quantity, po.unit_cost
     FROM production_order_outputs po JOIN production_orders o ON o.id = po.production_order_id
     LEFT JOIN items i ON i.id = po.output_item_id AND i.company_id = po.company_id
     WHERE po.company_id=$1 AND po.lot_number = $2 ORDER BY o.order_date, o.document_number`, [ctx.companyId, lot])).rows;
  const consumed = (await pool.query(
    `SELECT o.id AS order_id, o.document_number, o.order_date, o.status, l.component_item_id AS item_id, i.name_ar AS item_name_ar,
            COALESCE(l.consumed_quantity, l.actual_quantity, l.planned_quantity) AS quantity, l.input_lot_numbers
     FROM production_order_lines l JOIN production_orders o ON o.id = l.production_order_id
     LEFT JOIN items i ON i.id = l.component_item_id AND i.company_id = l.company_id
     WHERE l.company_id=$1 AND l.input_lot_numbers IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(string_to_array(l.input_lot_numbers, ',')) AS x(v) WHERE btrim(x.v) = $2)
     ORDER BY o.order_date, o.document_number`, [ctx.companyId, lot])).rows;
  const quality = await listQualityResults(ctx, { lot });
  // لوطات الخامات التي دخلت في إنتاج هذا اللوط (مستويات: الأوامر المنتجة له ← خاماتها).
  const orderIds = produced.map((p) => p.order_id);
  const inputs = orderIds.length === 0 ? [] : (await pool.query(
    `SELECT o.document_number, l.component_item_id AS item_id, i.name_ar AS item_name_ar, l.input_lot_numbers,
            COALESCE(l.consumed_quantity, l.actual_quantity, l.planned_quantity) AS quantity
     FROM production_order_lines l JOIN production_orders o ON o.id = l.production_order_id
     LEFT JOIN items i ON i.id = l.component_item_id AND i.company_id = l.company_id
     WHERE l.company_id=$1 AND l.production_order_id = ANY($2::uuid[]) ORDER BY o.document_number`, [ctx.companyId, orderIds])).rows;
  return { lot, produced, consumed, inputsOfProduced: inputs, quality };
}

/* ============================== سعة الماكينة ============================== */

export async function capacityEstimate(ctx: RequestContext, machineId: string, quantity: number) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  const m = (await pool.query(`SELECT code, name_ar, rated_output_per_hour, output_unit FROM machines WHERE id=$1 AND company_id=$2`, [machineId, ctx.companyId])).rows[0];
  if (!m) throw new NotFoundError('الماكينة غير موجودة');
  const rate = new Decimal(m.rated_output_per_hour);
  if (rate.lessThanOrEqualTo(0)) throw new ValidationError('لم تُحدَّد الطاقة الاسمية للماكينة');
  const hours = new Decimal(quantity).dividedBy(rate);
  return {
    machine: m.code, machineName: m.name_ar, outputUnit: m.output_unit, ratedOutputPerHour: rate.toFixed(4),
    quantity, hoursAt100: hours.toFixed(2), hoursAt85: hours.dividedBy(0.85).toFixed(2), shiftsAt85_8h: hours.dividedBy(0.85).dividedBy(8).toFixed(2),
  };
}

/* ============================== لوحة المؤشرات ============================== */

export async function dashboard(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const from = q.from ?? null; const to = q.to ?? null;
  const orders = (await pool.query(
    `SELECT count(*) FILTER (WHERE status='posted')::int AS posted, count(*) FILTER (WHERE status='draft')::int AS draft,
            COALESCE(sum(total_cost) FILTER (WHERE status='posted'),0) AS total_cost, COALESCE(sum(abnormal_loss_total) FILTER (WHERE status='posted'),0) AS abnormal_loss,
            COALESCE(sum(recovered_value_total) FILTER (WHERE status='posted'),0) AS recovered_value
     FROM production_orders WHERE company_id=$1 AND ($2::date IS NULL OR order_date >= $2) AND ($3::date IS NULL OR order_date <= $3)`, [ctx.companyId, from, to])).rows[0];
  const waste = await reportWaste(ctx, { from: from ?? undefined, to: to ?? undefined });
  const eff = await reportMachineEfficiency(ctx, { from: from ?? undefined, to: to ?? undefined });
  const sum = (rows: any[], k: string) => rows.reduce((a, r) => a.plus(r[k] ?? 0), new Decimal(0));
  const mainQty = sum(waste.byStage, 'main_consumed'); const wasteQty = sum(waste.byStage, 'waste_qty');
  const theo = sum(eff.machines, 'theoretical_output'); const out = sum(eff.machines, 'output');
  const run = sum(eff.machines, 'run_hours'); const down = sum(eff.machines, 'downtime_hours');
  const rolls = (await pool.query(
    `SELECT grade, count(*)::int AS rolls, COALESCE(sum(length_m),0) AS length_m FROM fabric_rolls
     WHERE company_id=$1 AND ($2::date IS NULL OR inspected_at::date >= $2) AND ($3::date IS NULL OR inspected_at::date <= $3) GROUP BY grade ORDER BY grade`, [ctx.companyId, from, to])).rows;
  const quality = (await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT passed)::int AS failed FROM quality_test_results
     WHERE company_id=$1 AND ($2::date IS NULL OR tested_at::date >= $2) AND ($3::date IS NULL OR tested_at::date <= $3)`, [ctx.companyId, from, to])).rows[0];
  const maint = (await pool.query(
    `SELECT count(*) FILTER (WHERE next_due_date < CURRENT_DATE)::int AS overdue, count(*) FILTER (WHERE next_due_date >= CURRENT_DATE AND next_due_date <= CURRENT_DATE + 7)::int AS due_soon
     FROM maintenance_plans p JOIN machines m ON m.id = p.machine_id AND m.company_id = p.company_id WHERE p.company_id=$1 AND p.is_active AND m.is_active`, [ctx.companyId])).rows[0];
  return {
    orders,
    wastePercent: mainQty.greaterThan(0) ? wasteQty.dividedBy(mainQty).times(100).toFixed(3) : null,
    wasteByStage: waste.byStage.map((s: any) => ({ code: s.code, nameAr: s.name_ar, standard: s.standard_waste_percent, actual: s.actual_waste_percent })),
    machineEfficiencyPercent: theo.greaterThan(0) ? out.dividedBy(theo).times(100).toFixed(2) : null,
    utilizationPercent: run.plus(down).greaterThan(0) ? run.dividedBy(run.plus(down)).times(100).toFixed(2) : null,
    topDowntime: eff.downtime.slice(0, 5), rolls, quality, maintenance: maint,
  };
}
