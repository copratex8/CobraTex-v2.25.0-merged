import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';

/**
 * عمليات المصنع المساندة (هجرة 0044 + قراءات فوق ما سبق):
 *   • جدولة الإنتاج وتعارض الماكينة   • العمالة وحوافز الإنتاج   • بيانات ملصقات الباركود   • رصيد وبيع الهوالك.
 * كلها فوق وحدة التصنيع (تتعطّل بتعطيلها)، ولا تُرحِّل مخزونًا ولا قيودًا (دفاتر تشغيلية/تقارير).
 */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const branchFilter = (ctx: RequestContext) => ctx.visibleBranchIds();

function dbError(e: unknown, msg: string): never {
  const code = (e as { code?: string }).code;
  if (code === '23505') throw new ConflictError(msg);
  if (code === '23503') throw new ValidationError('مرجع غير موجود (عامل/ماكينة/مرحلة/فرع/أمر)');
  throw e;
}

/* ============================== الجدولة ============================== */

const OVERLAP_SQL = `
  SELECT a.id AS order_id, a.document_number AS order_no, b.id AS other_id, b.document_number AS other_no,
         GREATEST(a.planned_start, b.planned_start) AS overlap_from, LEAST(a.planned_end, b.planned_end) AS overlap_to
  FROM production_orders a
  JOIN production_orders b ON b.company_id = a.company_id AND b.machine_id = a.machine_id AND b.id <> a.id
   AND b.status <> 'reversed' AND b.planned_start IS NOT NULL AND b.planned_end IS NOT NULL
   AND b.planned_start <= a.planned_end AND a.planned_start <= b.planned_end`;

/** يحدد/يعدّل جدولة أمر مسودة. تعارض الماكينة يُرفض (409) ما لم يُرسَل force. */
export async function scheduleOrder(ctx: RequestContext, orderId: string, b: B) {
  await assertManufacturingEnabled(ctx);
  if (b.plannedEnd < b.plannedStart) throw new ValidationError('تاريخ الانتهاء قبل تاريخ البدء');
  const cur = (await pool.query(`SELECT id, branch_id, status, machine_id, planned_start, planned_end FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!cur) throw new NotFoundError('أمر التصنيع غير موجود');
  ctx.assertPermission('textile.schedule.manage', cur.branch_id);
  if (cur.status !== 'draft') throw new ConflictError('الجدولة متاحة لأوامر المسودة فقط');
  const machineId = b.machineId ?? cur.machine_id;
  if (!machineId) throw new ValidationError('حدّد الماكينة (machineId) للجدولة');
  const m = (await pool.query(`SELECT id, is_active FROM machines WHERE id=$1 AND company_id=$2`, [machineId, ctx.companyId])).rows[0];
  if (!m) throw new ValidationError('الماكينة غير موجودة');
  if (!m.is_active) throw new ValidationError('الماكينة غير نشطة');

  const clash = (await pool.query(
    `SELECT b.id, b.document_number, b.planned_start, b.planned_end FROM production_orders b
     WHERE b.company_id=$1 AND b.machine_id=$2 AND b.id<>$3 AND b.status<>'reversed' AND b.planned_start IS NOT NULL AND b.planned_end IS NOT NULL
       AND b.planned_start <= $5::date AND $4::date <= b.planned_end`, [ctx.companyId, machineId, orderId, b.plannedStart, b.plannedEnd])).rows;
  if (clash.length && !b.force) {
    throw new ConflictError(`تعارض على الماكينة مع: ${clash.map((c) => `${c.document_number} (${String(c.planned_start).slice(0, 10)} → ${String(c.planned_end).slice(0, 10)})`).join('، ')} — أعد الجدولة أو أرسل force`);
  }
  const row = (await pool.query(
    `UPDATE production_orders SET planned_start=$3, planned_end=$4, machine_id=$5 WHERE id=$1 AND company_id=$2 RETURNING id, document_number, machine_id, planned_start, planned_end`,
    [orderId, ctx.companyId, b.plannedStart, b.plannedEnd, machineId])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'production_order_schedule', entityId: orderId, afterJson: { ...b } });
  return { order: row, conflicts: clash };
}

/** لوحة الجدولة: أوامر الفترة لكل ماكينة + التعارضات + نسبة الحمل (أيام الجدولة ÷ أيام الفترة). */
export async function scheduleBoard(ctx: RequestContext, q: { from?: string; to?: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.schedule.view');
  const from = q.from ?? new Date().toISOString().slice(0, 10);
  const to = q.to ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  if (to < from) throw new ValidationError('نهاية الفترة قبل بدايتها');
  const args = [ctx.companyId, from, to, q.machineId ?? null, branchFilter(ctx)];
  const scope = `o.company_id=$1 AND o.status<>'reversed' AND o.planned_start IS NOT NULL AND o.planned_end IS NOT NULL
                 AND o.planned_start <= $3::date AND o.planned_end >= $2::date AND ($4::uuid IS NULL OR o.machine_id=$4) AND ($5::uuid[] IS NULL OR o.branch_id = ANY($5))`;
  const orders = (await pool.query(
    `SELECT o.id, o.document_number, o.status, o.machine_id, m.code AS machine_code, m.name_ar AS machine_name, o.planned_start, o.planned_end,
            o.planned_output_quantity, i.name_ar AS output_item
     FROM production_orders o LEFT JOIN machines m ON m.id=o.machine_id AND m.company_id=o.company_id LEFT JOIN items i ON i.id=o.output_item_id AND i.company_id=o.company_id
     WHERE ${scope} ORDER BY m.code NULLS LAST, o.planned_start`, args)).rows;
  const conflicts = (await pool.query(
    `${OVERLAP_SQL} WHERE a.company_id=$1 AND a.id < b.id AND a.status<>'reversed' AND a.planned_start IS NOT NULL AND a.planned_end IS NOT NULL
       AND a.planned_start <= $3::date AND a.planned_end >= $2::date AND ($4::uuid IS NULL OR a.machine_id=$4) AND ($5::uuid[] IS NULL OR a.branch_id = ANY($5))`, args)).rows;
  const load = (await pool.query(
    `SELECT m.id AS machine_id, m.code, m.name_ar,
            COALESCE(sum((LEAST(o.planned_end, $3::date) - GREATEST(o.planned_start, $2::date)) + 1), 0)::int AS scheduled_days,
            (($3::date - $2::date) + 1) AS period_days
     FROM machines m LEFT JOIN production_orders o ON o.machine_id=m.id AND o.company_id=m.company_id AND ${scope.replace('$4::uuid IS NULL OR o.machine_id=$4', 'true')}
     WHERE m.company_id=$1 AND m.is_active AND ($4::uuid IS NULL OR m.id=$4)
     GROUP BY m.id, m.code, m.name_ar ORDER BY m.code`, args)).rows
    .map((r) => ({ ...r, load_percent: Math.min(100, Math.round((r.scheduled_days / r.period_days) * 1000) / 10) }));
  return { from, to, orders, conflicts, load };
}

/* ============================== العمالة والحوافز ============================== */

export async function listWorkers(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.view');
  return (await pool.query(
    `SELECT w.*, s.name_ar AS stage_name FROM textile_workers w LEFT JOIN textile_stages s ON s.id=w.stage_id AND s.company_id=w.company_id
     WHERE w.company_id=$1 ORDER BY w.is_active DESC, w.code`, [ctx.companyId])).rows;
}

export async function createWorker(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.manage', b.branchId);
  try {
    return (await pool.query(
      `INSERT INTO textile_workers(company_id, branch_id, code, name_ar, job_title, stage_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [ctx.companyId, b.branchId ?? null, b.code, b.nameAr, b.jobTitle ?? null, b.stageId ?? null])).rows[0];
  } catch (e) { return dbError(e, `كود العامل "${b.code}" مستخدم`); }
}

export async function updateWorker(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.manage');
  const r = (await pool.query(
    `UPDATE textile_workers SET name_ar=COALESCE($3,name_ar), job_title=COALESCE($4,job_title), stage_id=COALESCE($5,stage_id), is_active=COALESCE($6,is_active)
     WHERE id=$1 AND company_id=$2 RETURNING *`, [id, ctx.companyId, b.nameAr ?? null, b.jobTitle ?? null, b.stageId ?? null, b.isActive ?? null])).rows[0];
  if (!r) throw new NotFoundError('العامل غير موجود');
  return r;
}

export async function listIncentiveRates(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.view');
  return (await pool.query(
    `SELECT r.*, s.name_ar AS stage_name FROM incentive_rates r LEFT JOIN textile_stages s ON s.id=r.stage_id AND s.company_id=r.company_id
     WHERE r.company_id=$1 AND r.is_active ORDER BY r.stage_id NULLS FIRST, r.effective_from DESC`, [ctx.companyId])).rows;
}

export async function createIncentiveRate(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.manage');
  if (b.bonusRatePerUnit !== undefined && b.bonusThreshold === undefined) throw new ValidationError('معدّل الزيادة يتطلب تحديد الحدّ (bonusThreshold)');
  try {
    return (await pool.query(
      `INSERT INTO incentive_rates(company_id, stage_id, unit, rate_per_unit, bonus_threshold, bonus_rate_per_unit, effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.companyId, b.stageId ?? null, b.unit ?? 'kg', b.ratePerUnit, b.bonusThreshold ?? null, b.bonusRatePerUnit ?? null, b.effectiveFrom])).rows[0];
  } catch (e) { return dbError(e, 'معدّل مكرر'); }
}

export async function deleteIncentiveRate(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.manage');
  const r = await pool.query(`UPDATE incentive_rates SET is_active=false WHERE id=$1 AND company_id=$2 AND is_active RETURNING id`, [id, ctx.companyId]);
  if (!r.rowCount) throw new NotFoundError('المعدّل غير موجود');
  return { id, deleted: true };
}

export async function addWorkerLog(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.manage', b.branchId);
  const w = (await pool.query(`SELECT is_active, stage_id FROM textile_workers WHERE id=$1 AND company_id=$2`, [b.workerId, ctx.companyId])).rows[0];
  if (!w) throw new ValidationError('العامل غير موجود');
  if (!w.is_active) throw new ValidationError('العامل غير نشط');
  if (b.defectiveQuantity !== undefined && Number(b.defectiveQuantity) > Number(b.quantity)) throw new ValidationError('المعيب أكبر من الكمية');
  try {
    return (await pool.query(
      `INSERT INTO worker_output_logs(company_id, branch_id, worker_id, machine_id, stage_id, production_order_id, log_date, shift, quantity, defective_quantity, unit, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ctx.companyId, b.branchId, b.workerId, b.machineId ?? null, b.stageId ?? w.stage_id ?? null, b.productionOrderId ?? null, b.logDate, b.shift, b.quantity, b.defectiveQuantity ?? '0', b.unit ?? 'kg', b.notes ?? null, ctx.userId])).rows[0];
  } catch (e) { return dbError(e, 'تم تسجيل هذا العامل على نفس الماكينة والوردية واليوم مسبقًا'); }
}

export async function listWorkerLogs(ctx: RequestContext, q: { from?: string; to?: string; workerId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.view');
  return (await pool.query(
    `SELECT l.*, w.code AS worker_code, w.name_ar AS worker_name, m.code AS machine_code FROM worker_output_logs l
     JOIN textile_workers w ON w.id=l.worker_id AND w.company_id=l.company_id LEFT JOIN machines m ON m.id=l.machine_id AND m.company_id=l.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date>=$2) AND ($3::date IS NULL OR l.log_date<=$3) AND ($4::uuid IS NULL OR l.worker_id=$4) AND ($5::uuid[] IS NULL OR l.branch_id = ANY($5))
     ORDER BY l.log_date DESC, l.shift LIMIT 500`, [ctx.companyId, q.from ?? null, q.to ?? null, q.workerId ?? null, branchFilter(ctx)])).rows;
}

/**
 * كشف حوافز الإنتاج: لكل سجل وردية يُختار أنسب معدّل (مرحلة محددة قبل العام، ثم الأحدث سريانًا ≤ تاريخ السجل).
 * الحافز = الصافي (الكمية − المعيب) × المعدّل؛ وإن وُجد حدّ: حتى الحدّ بالمعدّل الأساسي وما زاد بمعدّل الزيادة.
 * السجلات بلا معدّل تُحصى (unrated_logs) ولا تُدفع صامتةً بصفر دون إنذار.
 */
export async function incentiveReport(ctx: RequestContext, q: { from?: string; to?: string; workerId?: string; stageId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.workforce.view');
  const args = [ctx.companyId, q.from ?? null, q.to ?? null, q.workerId ?? null, q.stageId ?? null, branchFilter(ctx)];
  const rows = (await pool.query(
    `WITH l AS (
       SELECT o.id, o.worker_id, o.log_date, o.quantity, o.defective_quantity, GREATEST(o.quantity - o.defective_quantity, 0) AS net,
              r.rate_per_unit, r.bonus_threshold, r.bonus_rate_per_unit
       FROM worker_output_logs o
       LEFT JOIN LATERAL (
         SELECT * FROM incentive_rates r WHERE r.company_id=o.company_id AND r.is_active AND r.unit=o.unit
            AND (r.stage_id IS NULL OR r.stage_id=o.stage_id) AND r.effective_from <= o.log_date
         ORDER BY (r.stage_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1) r ON true
       WHERE o.company_id=$1 AND ($2::date IS NULL OR o.log_date>=$2) AND ($3::date IS NULL OR o.log_date<=$3)
         AND ($4::uuid IS NULL OR o.worker_id=$4) AND ($5::uuid IS NULL OR o.stage_id=$5) AND ($6::uuid[] IS NULL OR o.branch_id = ANY($6)))
     SELECT w.id AS worker_id, w.code, w.name_ar, count(*)::int AS shifts, sum(l.quantity) AS total_quantity, sum(l.defective_quantity) AS defective_quantity, sum(l.net) AS net_quantity,
            round(CASE WHEN sum(l.quantity) > 0 THEN sum(l.defective_quantity) / sum(l.quantity) * 100 END, 2) AS defect_percent,
            COALESCE(sum(CASE WHEN l.rate_per_unit IS NULL THEN 0
                 WHEN l.bonus_threshold IS NULL THEN l.net * l.rate_per_unit
                 ELSE LEAST(l.net, l.bonus_threshold) * l.rate_per_unit + GREATEST(l.net - l.bonus_threshold, 0) * COALESCE(l.bonus_rate_per_unit, l.rate_per_unit) END), 0)::numeric(18,4) AS incentive,
            count(*) FILTER (WHERE l.rate_per_unit IS NULL)::int AS unrated_logs
     FROM l JOIN textile_workers w ON w.id=l.worker_id AND w.company_id=$1
     GROUP BY w.id, w.code, w.name_ar ORDER BY incentive DESC, w.code`, args)).rows;
  const total = rows.reduce((a, r) => a + Number(r.incentive), 0);
  return { workers: rows, totalIncentive: total.toFixed(4), unratedLogs: rows.reduce((a, r) => a + r.unrated_logs, 0) };
}

/* ============================== الملصقات ============================== */

type Line = { label: string; value: string };
interface Label { kind: string; id: string; code: string; title: string; lines: Line[] }
const f = (v: unknown, unit = '') => (v === null || v === undefined || v === '' ? '—' : `${v}${unit ? ' ' + unit : ''}`);
const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : '—');

/** بيانات ملصقات (رولة/وحدة تعبئة/لوط ألياف/دفعة صباغة) — الرسم والطباعة في الواجهة (Code128 بالـSVG). */
export async function labelsData(ctx: RequestContext, kind: string, ids: string[]): Promise<{ company: string; labels: Label[] }> {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.labels.view');
  const company = (await pool.query(`SELECT display_name FROM companies WHERE id=$1`, [ctx.companyId])).rows[0]?.display_name ?? '';
  const A = [ctx.companyId, ids];
  let labels: Label[] = [];
  if (kind === 'roll') {
    labels = (await pool.query(
      `SELECT r.*, i.name_ar AS item_name, o.document_number AS order_no FROM fabric_rolls r LEFT JOIN items i ON i.id=r.item_id AND i.company_id=r.company_id
       LEFT JOIN production_orders o ON o.id=r.production_order_id AND o.company_id=r.company_id WHERE r.company_id=$1 AND r.id = ANY($2::uuid[]) ORDER BY r.roll_no`, A)).rows.map((r) => ({
      kind, id: r.id, code: r.roll_no, title: `رولة قماش ${r.roll_no}`, lines: [
        { label: 'الصنف', value: f(r.item_name) }, { label: 'الطول', value: f(r.length_m, 'م') }, { label: 'العرض', value: f(r.width_cm, 'سم') },
        { label: 'الوزن', value: f(r.weight_kg, 'كجم') }, { label: 'الدرجة', value: f(r.grade) }, { label: 'نقاط/100ياردة²', value: f(r.points_per_100sqyd) }, { label: 'أمر التصنيع', value: f(r.order_no) }] }));
  } else if (kind === 'packing') {
    labels = (await pool.query(
      `SELECT p.*, i.name_ar AS item_name FROM packing_units p LEFT JOIN items i ON i.id=p.item_id AND i.company_id=p.company_id WHERE p.company_id=$1 AND p.id = ANY($2::uuid[]) ORDER BY p.packing_no`, A)).rows.map((r) => ({
      kind, id: r.id, code: r.packing_no, title: `وحدة تعبئة ${r.packing_no}`, lines: [
        { label: 'الصنف', value: f(r.item_name) }, { label: 'اللوط', value: f(r.lot_number) }, { label: 'عدد العبوات', value: f(r.packages_count) },
        { label: 'القائم', value: f(r.gross_kg, 'كجم') }, { label: 'الغلاف', value: f(r.tare_kg, 'كجم') }, { label: 'الصافي', value: f(r.net_kg, 'كجم') }] }));
  } else if (kind === 'fiber-lot') {
    labels = (await pool.query(`SELECT * FROM fiber_lots WHERE company_id=$1 AND id = ANY($2::uuid[]) ORDER BY lot_code`, A)).rows.map((r) => ({
      kind, id: r.id, code: r.lot_code, title: `لوط ألياف ${r.lot_code}`, lines: [
        { label: 'النوع', value: f(r.fiber_type) }, { label: 'الصنف', value: f(r.variety) }, { label: 'المنشأ', value: f(r.origin) }, { label: 'المورد', value: f(r.supplier_name) }] }));
  } else {
    labels = (await pool.query(
      `SELECT b.*, s.name_ar AS shade_name FROM dye_batches b LEFT JOIN shades s ON s.id=b.shade_id AND s.company_id=b.company_id WHERE b.company_id=$1 AND b.id = ANY($2::uuid[]) ORDER BY b.batch_no`, A)).rows.map((r) => ({
      kind, id: r.id, code: r.batch_no, title: `دفعة صباغة ${r.batch_no}`, lines: [
        { label: 'اللون', value: f(r.shade_name) }, { label: 'الوزن', value: f(r.material_kg, 'كجم') }, { label: 'التاريخ', value: d10(r.batch_date) }] }));
  }
  if (labels.length === 0) throw new NotFoundError('لا توجد سجلات مطابقة للملصقات');
  return { company, labels };
}

/* ============================== رصيد وبيع الهوالك ============================== */

/**
 * كشف الهوالك القابلة للاسترداد: المُنتَج (من أوامر مرحَّلة) − المباع (فواتير بيع مرحَّلة لنفس صنف الهالك) = المتوقع لدى المخزن،
 * مع الرصيد الفعلي بالمخزن ومتوسط التكلفة. الفرق (variance) بين المتوقع والفعلي ينبّه لهوالك بيعت/استُهلكت خارج الفواتير أو سُرقت.
 */
export async function wasteStockReport(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const args = [ctx.companyId, q.from ?? null, q.to ?? null];
  const rows = (await pool.query(
    `WITH prod AS (
       SELECT COALESCE(w.recovery_item_id, t.recovery_item_id) AS item_id, sum(w.quantity) AS qty, sum(COALESCE(w.recovered_value,0)) AS value
       FROM production_order_waste w JOIN production_orders o ON o.id=w.production_order_id AND o.company_id=w.company_id AND o.status='posted'
       JOIN waste_types t ON t.id=w.waste_type_id AND t.company_id=w.company_id
       WHERE w.company_id=$1 AND t.is_recoverable AND ($2::date IS NULL OR o.order_date>=$2) AND ($3::date IS NULL OR o.order_date<=$3)
       GROUP BY 1),
     sold AS (
       SELECT l.item_id, sum(l.quantity) AS qty, sum(l.subtotal) AS revenue
       FROM sales_invoice_lines l JOIN sales_invoices s ON s.id=l.sales_invoice_id AND s.company_id=l.company_id AND s.status='posted'
       WHERE l.company_id=$1 AND ($2::date IS NULL OR s.invoice_date>=$2) AND ($3::date IS NULL OR s.invoice_date<=$3)
       GROUP BY l.item_id),
     stock AS (SELECT item_id, sum(quantity_on_hand) AS qty, max(weighted_average_cost) AS avg_cost FROM stock_balances WHERE company_id=$1 GROUP BY item_id)
     SELECT i.id AS item_id, i.name_ar AS item_name, COALESCE(p.qty,0) AS produced_qty, COALESCE(p.value,0) AS produced_value,
            COALESCE(s.qty,0) AS sold_qty, COALESCE(s.revenue,0) AS sold_revenue, COALESCE(k.qty,0) AS on_hand_qty, k.avg_cost,
            COALESCE(p.qty,0) - COALESCE(s.qty,0) AS expected_qty,
            CASE WHEN COALESCE(s.qty,0) > 0 THEN round(s.revenue / s.qty, 4) END AS avg_sale_price
     FROM prod p FULL JOIN sold s ON s.item_id=p.item_id
     JOIN items i ON i.id=COALESCE(p.item_id, s.item_id) AND i.company_id=$1
     LEFT JOIN stock k ON k.item_id=i.id
     WHERE p.item_id IS NOT NULL
     ORDER BY i.name_ar`, args)).rows;
  return {
    items: rows,
    note: 'المتوقع = المُنتَج − المباع ضمن نفس الفترة؛ قارنه بالرصيد الفعلي فقط عند ترك الفترة مفتوحة (من بداية التشغيل)، فالرصيد تراكمي وليس بالفترة.',
  };
}
