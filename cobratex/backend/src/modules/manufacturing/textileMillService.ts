import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import {
  blendProperties, dyeRequirements, shadeVerdict, tollStatement, suggestConversion, commercialWeight, STANDARD_REGAIN,
  type Rate, type DyeBasis,
} from '@/modules/manufacturing/textileMill';

/* إضافات مصنع الغزل والنسيج: لوطات الألياف والخلط، الصباغة، التشغيل للغير، معدّلات التكلفة، تقرير الإنتاج اليومي.
 * فوق وحدة التصنيع (تتعطّل بتعطيلها) وبصلاحيات textile.* — لا تلمس المخزون ولا القيود (راجع 0042). */

const snake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function insertUnique(sql: string, params: unknown[], dupMsg: string) {
  try { return (await pool.query(sql, params)).rows[0]; } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ConflictError(dupMsg);
    throw e;
  }
}
async function partialUpdate(table: string, id: string, companyId: string, allowed: string[], body: B) {
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of allowed) { if (body[k] === undefined) continue; vals.push(body[k]); sets.push(`${snake(k)} = $${vals.length}`); }
  if (sets.length === 0) throw new ValidationError('لا توجد حقول للتعديل');
  vals.push(id, companyId);
  const r = await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`, vals);
  if (r.rows.length === 0) throw new NotFoundError('السجل غير موجود');
  return r.rows[0];
}
const fk = (e: unknown, msg: string) => { if ((e as { code?: string }).code === '23503') throw new ValidationError(msg); throw e; };

/* ============================== لوطات الألياف ============================== */

export async function listFiberLots(ctx: RequestContext, q: { status?: string; fiberType?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.fiber.view');
  return (await pool.query(
    `SELECT * FROM fiber_lots WHERE company_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR fiber_type=$3) ORDER BY created_at DESC LIMIT 500`,
    [ctx.companyId, q.status ?? null, q.fiberType ?? null])).rows;
}
export async function createFiberLot(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.fiber.manage');
  try {
    return await insertUnique(
      `INSERT INTO fiber_lots(company_id, lot_code, fiber_type, variety, origin, supplier_name, item_id, bales_count, net_weight_kg, staple_length_mm, micronaire, strength_gtex,
         uniformity_percent, short_fiber_percent, trash_percent, moisture_percent, color_grade, price_per_kg, received_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [ctx.companyId, b.lotCode, b.fiberType, b.variety ?? null, b.origin ?? null, b.supplierName ?? null, b.itemId ?? null, b.balesCount ?? null, b.netWeightKg,
        b.stapleLengthMm ?? null, b.micronaire ?? null, b.strengthGtex ?? null, b.uniformityPercent ?? null, b.shortFiberPercent ?? null, b.trashPercent ?? null,
        b.moisturePercent ?? null, b.colorGrade ?? null, b.pricePerKg ?? null, b.receivedDate ?? null, b.notes ?? null, ctx.userId],
      `رقم اللوط "${b.lotCode}" مستخدم`);
  } catch (e) { return fk(e, 'الصنف المرتبط غير موجود'); }
}
export async function updateFiberLot(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.fiber.manage');
  return partialUpdate('fiber_lots', id, ctx.companyId, ['status', 'netWeightKg', 'pricePerKg', 'notes', 'supplierName'], b);
}

async function planLines(companyId: string, planId: string) {
  return (await pool.query(
    `SELECT l.id, l.lot_id, l.percent, f.lot_code, f.net_weight_kg, f.staple_length_mm, f.micronaire, f.strength_gtex, f.uniformity_percent, f.short_fiber_percent,
            f.trash_percent, f.moisture_percent, f.price_per_kg, f.status AS lot_status, f.fiber_type, f.variety
     FROM mixing_plan_lines l JOIN fiber_lots f ON f.id=l.lot_id AND f.company_id=l.company_id
     WHERE l.plan_id=$1 AND l.company_id=$2 ORDER BY l.percent DESC`, [planId, companyId])).rows;
}
const toMix = (r: B) => ({
  percent: r.percent, lotCode: r.lot_code, netWeightKg: r.net_weight_kg, stapleLengthMm: r.staple_length_mm, micronaire: r.micronaire, strengthGtex: r.strength_gtex,
  uniformityPercent: r.uniformity_percent, shortFiberPercent: r.short_fiber_percent, trashPercent: r.trash_percent, moisturePercent: r.moisture_percent, pricePerKg: r.price_per_kg,
});

export async function createMixingPlan(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.fiber.manage');
  const ids = b.lines.map((l: B) => l.lotId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('لا يتكرر اللوط نفسه في الخطة');
  const lots = await pool.query(`SELECT id, status FROM fiber_lots WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, ids]);
  if (lots.rows.length !== ids.length) throw new NotFoundError('أحد اللوطات غير موجود');
  if (lots.rows.some((l) => l.status === 'rejected')) throw new ValidationError('لا يمكن استخدام لوط مرفوض في خطة خلط');
  return withTransaction(async (client) => {
    let plan;
    try {
      plan = (await client.query(
        `INSERT INTO mixing_plans(company_id, plan_no, name, target_count_ne, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.companyId, b.planNo, b.name, b.targetCountNe ?? null, b.notes ?? null, ctx.userId])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError(`رقم الخطة "${b.planNo}" مستخدم`);
      throw e;
    }
    for (const l of b.lines) {
      await client.query(`INSERT INTO mixing_plan_lines(plan_id, company_id, lot_id, percent) VALUES ($1,$2,$3,$4)`, [plan.id, ctx.companyId, l.lotId, l.percent]);
    }
    return plan;
  });
}
export async function listMixingPlans(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.fiber.view');
  return (await pool.query(
    `SELECT p.*, COALESCE(s.total,0) AS total_percent, COALESCE(s.n,0) AS lots_count FROM mixing_plans p
     LEFT JOIN (SELECT plan_id, sum(percent) total, count(*) n FROM mixing_plan_lines GROUP BY plan_id) s ON s.plan_id = p.id
     WHERE p.company_id=$1 ORDER BY p.created_at DESC LIMIT 200`, [ctx.companyId])).rows;
}
export async function getMixingPlan(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.fiber.view');
  const plan = (await pool.query(`SELECT * FROM mixing_plans WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!plan) throw new NotFoundError('خطة الخلط غير موجودة');
  const lines = await planLines(ctx.companyId, id);
  const blend = blendProperties(lines.map(toMix));
  if (lines.some((l) => l.lot_status === 'consumed')) blend.warnings.push('بعض اللوطات حالتها «مستهلك» — تحقق من توفرها');
  return { ...plan, lines, blend };
}
/** اعتماد الخطة: يشترط مجموع نسب 100% ولوطات غير مرفوضة. */
export async function approveMixingPlan(ctx: RequestContext, id: string) {
  const plan = await getMixingPlan(ctx, id);
  ctx.assertPermission('textile.fiber.manage');
  if (!plan.blend.balanced) throw new ValidationError(`مجموع النسب ${plan.blend.totalPercent}% — يجب 100% قبل الاعتماد`);
  if (plan.lines.some((l: B) => l.lot_status === 'rejected')) throw new ValidationError('الخطة تحتوي لوطًا مرفوضًا');
  await pool.query(`UPDATE mixing_plans SET status='approved' WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'approve', entityType: 'mixing_plan', entityId: id });
  return { ...plan, status: 'approved' };
}

/* ============================== الصباغة ============================== */

export async function listShades(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.view');
  return (await pool.query(`SELECT * FROM shades WHERE company_id=$1 ORDER BY code`, [ctx.companyId])).rows;
}
export async function createShade(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.manage');
  return insertUnique(`INSERT INTO shades(company_id, code, name_ar, name_en, color_hex, pantone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ctx.companyId, b.code, b.nameAr, b.nameEn, b.colorHex ?? null, b.pantone ?? null], `كود الدرجة "${b.code}" مستخدم`);
}
export async function updateShade(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.manage');
  return partialUpdate('shades', id, ctx.companyId, ['nameAr', 'nameEn', 'colorHex', 'pantone', 'isActive'], b);
}

export async function createRecipe(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.manage');
  if (b.lines.some((l: B) => l.basis === 'g_per_l') && !b.liquorRatio) throw new ValidationError('نسبة الحمّام مطلوبة عند وجود مواد بوحدة جم/لتر');
  return withTransaction(async (client) => {
    let rec;
    try {
      rec = (await client.query(
        `INSERT INTO dye_recipes(company_id, code, shade_id, fiber_type, process_type, liquor_ratio, temperature_c, duration_min, ph, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [ctx.companyId, b.code, b.shadeId ?? null, b.fiberType ?? null, b.processType ?? 'exhaust', b.liquorRatio ?? null, b.temperatureC ?? null, b.durationMin ?? null, b.ph ?? null, b.notes ?? null])).rows[0];
    } catch (e) {
      const c = (e as { code?: string }).code;
      if (c === '23505') throw new ConflictError(`كود الوصفة "${b.code}" مستخدم`);
      if (c === '23503') throw new ValidationError('الدرجة اللونية غير موجودة');
      throw e;
    }
    for (const [i, l] of b.lines.entries()) {
      try {
        await client.query(`INSERT INTO dye_recipe_lines(recipe_id, company_id, item_id, amount, basis, sequence) VALUES ($1,$2,$3,$4,$5,$6)`, [rec.id, ctx.companyId, l.itemId, l.amount, l.basis, i]);
      } catch (e) { fk(e, 'أحد أصناف الوصفة غير موجود'); }
    }
    return rec;
  });
}
export async function listRecipes(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.view');
  return (await pool.query(
    `SELECT r.*, s.name_ar AS shade_name_ar, s.color_hex, (SELECT count(*) FROM dye_recipe_lines l WHERE l.recipe_id=r.id) AS lines_count
     FROM dye_recipes r LEFT JOIN shades s ON s.id=r.shade_id AND s.company_id=r.company_id WHERE r.company_id=$1 ORDER BY r.code`, [ctx.companyId])).rows;
}

export async function createDyeBatch(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.manage', b.branchId);
  const rec = (await pool.query(`SELECT id, shade_id FROM dye_recipes WHERE id=$1 AND company_id=$2 AND is_active=true`, [b.recipeId, ctx.companyId])).rows[0];
  if (!rec) throw new NotFoundError('وصفة الصباغة غير موجودة أو غير مفعَّلة');
  try {
    return await insertUnique(
      `INSERT INTO dye_batches(company_id, branch_id, batch_no, recipe_id, shade_id, machine_id, production_order_id, material_kg, batch_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.companyId, b.branchId, b.batchNo, b.recipeId, rec.shade_id, b.machineId ?? null, b.productionOrderId ?? null, b.materialKg, b.batchDate, b.notes ?? null, ctx.userId],
      `رقم الدفعة "${b.batchNo}" مستخدم`);
  } catch (e) { return fk(e, 'الماكينة أو أمر التصنيع غير موجود'); }
}
export async function listDyeBatches(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.view');
  return (await pool.query(
    `SELECT b.*, r.code AS recipe_code, s.name_ar AS shade_name_ar, s.color_hex FROM dye_batches b
     JOIN dye_recipes r ON r.id=b.recipe_id AND r.company_id=b.company_id LEFT JOIN shades s ON s.id=b.shade_id AND s.company_id=b.company_id
     WHERE b.company_id=$1 AND ($2::date IS NULL OR b.batch_date >= $2) AND ($3::date IS NULL OR b.batch_date <= $3) ORDER BY b.batch_date DESC, b.created_at DESC LIMIT 500`,
    [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
}
export async function updateDyeBatchResult(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.manage');
  const patch: B = { ...b };
  // حكم ΔE تلقائي (الحد 1.0) إن أُدخلت القيمة دون حكم صريح.
  if (patch.deltaE !== undefined && patch.shadeResult === undefined) patch.shadeResult = shadeVerdict(patch.deltaE);
  try {
    return await partialUpdate('dye_batches', id, ctx.companyId,
      ['status', 'deltaE', 'shadeResult', 'fastnessWash', 'fastnessRub', 'fastnessLight', 'waterLiters', 'steamKg', 'energyKwh', 'notes'], patch);
  } catch (e) {
    if ((e as { code?: string }).code === '23514') throw new ValidationError('قيمة الثباتية خارج المدى (غسيل/احتكاك 1–5، ضوء 1–8)');
    throw e;
  }
}
/** احتياج دفعة الصباغة من الأصناف (كجم) حسب الوصفة ووزن المادة. */
export async function dyeBatchRequirements(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.view');
  const b = (await pool.query(`SELECT b.*, r.liquor_ratio FROM dye_batches b JOIN dye_recipes r ON r.id=b.recipe_id AND r.company_id=b.company_id WHERE b.id=$1 AND b.company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!b) throw new NotFoundError('الدفعة غير موجودة');
  const lines = (await pool.query(
    `SELECT l.item_id, l.amount, l.basis, i.code, i.name_ar FROM dye_recipe_lines l JOIN items i ON i.id=l.item_id AND i.company_id=l.company_id WHERE l.recipe_id=$1 ORDER BY l.sequence`, [b.recipe_id])).rows;
  const req = dyeRequirements(lines.map((l) => ({ itemId: l.item_id, amount: l.amount, basis: l.basis as DyeBasis })), b.material_kg, b.liquor_ratio);
  return { batchNo: b.batch_no, materialKg: b.material_kg, liquorRatio: b.liquor_ratio, requirements: req.map((r, i) => ({ ...r, itemCode: lines[i].code, itemName: lines[i].name_ar })) };
}
export async function reportDyeing(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.dyeing.view');
  const r = (await pool.query(
    `SELECT count(*) AS batches, COALESCE(sum(material_kg),0) AS total_kg,
            count(*) FILTER (WHERE status IN ('rework','rejected') OR shade_result='fail') AS redye_batches,
            COALESCE(sum(water_liters),0) AS water_l, COALESCE(sum(energy_kwh),0) AS kwh, COALESCE(sum(steam_kg),0) AS steam_kg,
            COALESCE(sum(material_kg) FILTER (WHERE water_liters IS NOT NULL),0) AS kg_with_water,
            COALESCE(sum(material_kg) FILTER (WHERE energy_kwh IS NOT NULL),0) AS kg_with_energy
     FROM dye_batches WHERE company_id=$1 AND ($2::date IS NULL OR batch_date >= $2) AND ($3::date IS NULL OR batch_date <= $3)`,
    [ctx.companyId, q.from ?? null, q.to ?? null])).rows[0];
  const per = (a: string, b: string) => (new Decimal(b).isZero() ? null : new Decimal(a).dividedBy(b).toFixed(3));
  return {
    batches: Number(r.batches), totalKg: r.total_kg, redyeBatches: Number(r.redye_batches),
    redyeRatePercent: Number(r.batches) === 0 ? null : new Decimal(r.redye_batches).dividedBy(r.batches).times(100).toFixed(2),
    waterLitersPerKg: per(r.water_l, r.kg_with_water), kwhPerKg: per(r.kwh, r.kg_with_energy),
  };
}

/* ============================== التشغيل للغير ============================== */

async function tollTotals(companyId: string, jobId: string) {
  const r = (await pool.query(
    `SELECT COALESCE(sum(quantity) FILTER (WHERE movement_type='receipt'),0) AS receipt,
            COALESCE(sum(quantity) FILTER (WHERE movement_type='output'),0) AS output,
            COALESCE(sum(quantity) FILTER (WHERE movement_type='waste_returned'),0) AS waste_returned,
            COALESCE(sum(quantity) FILTER (WHERE movement_type='waste_retained'),0) AS waste_retained,
            COALESCE(sum(amount) FILTER (WHERE movement_type='invoice'),0) AS invoiced
     FROM toll_movements WHERE job_id=$1 AND company_id=$2`, [jobId, companyId])).rows[0];
  return { receipt: r.receipt, output: r.output, wasteReturned: r.waste_returned, wasteRetained: r.waste_retained, invoicedAmount: r.invoiced };
}
const termsOf = (j: B) => ({ feePerUnit: j.fee_per_unit, feeBasis: j.fee_basis, allowedLossPercent: j.allowed_loss_percent, materialValuePerUnit: j.material_value_per_unit });

export async function createTollJob(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.toll.manage', b.branchId);
  try {
    return await insertUnique(
      `INSERT INTO toll_jobs(company_id, branch_id, job_no, customer_id, service_type, material_description, unit, fee_per_unit, fee_basis, allowed_loss_percent, material_value_per_unit, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [ctx.companyId, b.branchId, b.jobNo, b.customerId, b.serviceType, b.materialDescription, b.unit ?? 'kg', b.feePerUnit, b.feeBasis ?? 'output', b.allowedLossPercent ?? '0', b.materialValuePerUnit ?? '0', b.notes ?? null, ctx.userId],
      `رقم العمل "${b.jobNo}" مستخدم`);
  } catch (e) { return fk(e, 'العميل أو الفرع غير موجود'); }
}
export async function listTollJobs(ctx: RequestContext, q: { status?: string; customerId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.toll.view');
  return (await pool.query(
    `SELECT j.*, c.name_ar AS customer_name,
            COALESCE(t.receipt,0) AS received, COALESCE(t.output,0) AS output,
            COALESCE(t.receipt,0) - COALESCE(t.output,0) - COALESCE(t.wr,0) - COALESCE(t.wk,0) AS held_at_mill
     FROM toll_jobs j JOIN customers c ON c.id=j.customer_id AND c.company_id=j.company_id
     LEFT JOIN (SELECT job_id,
                  sum(quantity) FILTER (WHERE movement_type='receipt') receipt, sum(quantity) FILTER (WHERE movement_type='output') output,
                  sum(quantity) FILTER (WHERE movement_type='waste_returned') wr, sum(quantity) FILTER (WHERE movement_type='waste_retained') wk
                FROM toll_movements WHERE company_id=$1 GROUP BY job_id) t ON t.job_id=j.id
     WHERE j.company_id=$1 AND ($2::text IS NULL OR j.status=$2) AND ($3::uuid IS NULL OR j.customer_id=$3) ORDER BY j.created_at DESC LIMIT 300`,
    [ctx.companyId, q.status ?? null, q.customerId ?? null])).rows;
}
export async function getTollJob(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.toll.view');
  const job = (await pool.query(`SELECT j.*, c.name_ar AS customer_name FROM toll_jobs j JOIN customers c ON c.id=j.customer_id AND c.company_id=j.company_id WHERE j.id=$1 AND j.company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!job) throw new NotFoundError('العمل غير موجود');
  const movements = (await pool.query(`SELECT * FROM toll_movements WHERE job_id=$1 AND company_id=$2 ORDER BY movement_date, created_at`, [id, ctx.companyId])).rows;
  const statement = tollStatement(await tollTotals(ctx.companyId, id), termsOf(job), job.status === 'closed');
  return { ...job, movements, statement };
}
export async function addTollMovement(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.toll.manage');
  const job = (await pool.query(`SELECT * FROM toll_jobs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!job) throw new NotFoundError('العمل غير موجود');
  if (job.status === 'closed') throw new ConflictError('العمل مُقفَل — لا حركات بعد الإقفال');
  const isInvoice = b.movementType === 'invoice';
  if (isInvoice && (b.amount === undefined || new Decimal(b.amount).lte(0))) throw new ValidationError('قيمة الفاتورة مطلوبة');
  if (!isInvoice && (b.quantity === undefined || new Decimal(b.quantity).lte(0))) throw new ValidationError('الكمية مطلوبة وأكبر من صفر');
  await withTransaction(async (client) => {
    await client.query(`SELECT id FROM toll_jobs WHERE id=$1 FOR UPDATE`, [id]); // تسلسل الحركات المتزامنة على العمل الواحد
    await client.query(
      `INSERT INTO toll_movements(job_id, company_id, movement_type, movement_date, quantity, amount, reference, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ctx.companyId, b.movementType, b.movementDate, isInvoice ? '0' : b.quantity, isInvoice ? b.amount : null, b.reference ?? null, b.notes ?? null, ctx.userId]);
    const t = (await client.query(
      `SELECT COALESCE(sum(quantity) FILTER (WHERE movement_type='receipt'),0) r, COALESCE(sum(quantity) FILTER (WHERE movement_type IN ('output','waste_returned','waste_retained')),0) o FROM toll_movements WHERE job_id=$1`, [id])).rows[0];
    if (new Decimal(t.o).greaterThan(t.r)) throw new ValidationError('إجمالي المُسلَّم والهالك يتجاوز الخامة المستلمة من العميل');
  });
  return getTollJob(ctx, id);
}
/** إقفال العمل: يثبّت كشف الحساب النهائي (الرصيد المتبقي = فاقد، والزائد عن المسموح يُحمَّل على المصنع). */
export async function closeTollJob(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.toll.manage');
  const r = await pool.query(`UPDATE toll_jobs SET status='closed', closed_at=now() WHERE id=$1 AND company_id=$2 AND status='open' RETURNING id`, [id, ctx.companyId]);
  if (r.rows.length === 0) throw new ConflictError('العمل غير موجود أو مُقفَل مسبقًا');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'toll_job', entityId: id, afterJson: { status: 'closed' } });
  return getTollJob(ctx, id);
}

/* ============================== معدّلات تكلفة التحويل ============================== */

export async function listCostRates(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.rates.manage');
  return (await pool.query(
    `SELECT r.*, s.name_ar AS stage_name_ar, m.name_ar AS machine_name_ar FROM textile_cost_rates r
     LEFT JOIN textile_stages s ON s.id=r.stage_id AND s.company_id=r.company_id LEFT JOIN machines m ON m.id=r.machine_id AND m.company_id=r.company_id
     WHERE r.company_id=$1 AND r.is_active ORDER BY r.rate_type, s.name_ar NULLS FIRST, m.name_ar NULLS FIRST`, [ctx.companyId])).rows;
}
/** يستبدل المعدّل النشط لنفس (النوع، المرحلة، الماكينة). */
export async function upsertCostRate(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.rates.manage');
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE textile_cost_rates SET is_active=false WHERE company_id=$1 AND rate_type=$2 AND is_active
         AND COALESCE(stage_id,'00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         AND COALESCE(machine_id,'00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
      [ctx.companyId, b.rateType, b.stageId ?? null, b.machineId ?? null]);
    try {
      return (await client.query(`INSERT INTO textile_cost_rates(company_id, stage_id, machine_id, rate_type, rate, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.companyId, b.stageId ?? null, b.machineId ?? null, b.rateType, b.rate, b.notes ?? null])).rows[0];
    } catch (e) { return fk(e, 'المرحلة أو الماكينة غير موجودة'); }
  });
}
export async function deactivateCostRate(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.rates.manage');
  const r = await pool.query(`UPDATE textile_cost_rates SET is_active=false WHERE id=$1 AND company_id=$2 RETURNING id`, [id, ctx.companyId]);
  if (r.rows.length === 0) throw new NotFoundError('المعدّل غير موجود');
  return { id, isActive: false };
}

export async function conversionForOrder(ctx: RequestContext, orderId: string) {
  const order = (await pool.query(`SELECT id, status, document_number FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!order) throw new NotFoundError('أمر التصنيع غير موجود');
  const logs = (await pool.query(
    `SELECT l.machine_id, m.stage_id, l.run_hours, l.energy_kwh FROM machine_production_logs l JOIN machines m ON m.id=l.machine_id AND m.company_id=l.company_id
     WHERE l.company_id=$1 AND l.production_order_id=$2`, [ctx.companyId, orderId])).rows;
  const rates = (await pool.query(`SELECT rate_type, rate, stage_id, machine_id FROM textile_cost_rates WHERE company_id=$1 AND is_active`, [ctx.companyId])).rows
    .map((r): Rate => ({ rateType: r.rate_type, rate: r.rate, stageId: r.stage_id, machineId: r.machine_id }));
  const s = suggestConversion(logs.map((l) => ({ machineId: l.machine_id, stageId: l.stage_id, runHours: l.run_hours, energyKwh: l.energy_kwh })), rates);
  return { order, logsCount: logs.length, ...s };
}
export async function suggestOrderConversion(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.rates.manage');
  const { order, ...rest } = await conversionForOrder(ctx, orderId);
  return { orderId, documentNumber: order.document_number, status: order.status, ...rest };
}
/** يضيف/يحدّث بنود تكلفة تحويل تلقائية (عمالة/كهرباء/مصاريف) على مسودة الأمر من سجل ساعات الماكينات. آمن للتكرار. */
export async function applyOrderConversion(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.rates.manage');
  const c = await conversionForOrder(ctx, orderId);
  if (c.order.status !== 'draft') throw new ConflictError('تُطبَّق المعدّلات على مسودة الأمر فقط');
  if (c.logsCount === 0) throw new ValidationError('لا توجد سجلات ورديات مربوطة بهذا الأمر');
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM production_order_operations WHERE production_order_id=$1 AND company_id=$2 AND name LIKE '[تلقائي]%'`, [orderId, ctx.companyId]);
    const seq = Number((await client.query(`SELECT COALESCE(max(sequence),0) AS s FROM production_order_operations WHERE production_order_id=$1`, [orderId])).rows[0].s);
    const lines: Array<[string, string, string]> = [
      ['[تلقائي] عمالة تشغيل', 'labor', c.labor], ['[تلقائي] طاقة كهربائية', 'overhead', c.energy], ['[تلقائي] مصاريف تشغيل', 'overhead', c.overhead],
    ];
    let n = seq;
    for (const [name, type, amount] of lines) {
      if (new Decimal(amount).isZero()) continue;
      n += 1;
      await client.query(
        `INSERT INTO production_order_operations(production_order_id, company_id, sequence, name, cost_type, planned_cost, actual_cost) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [orderId, ctx.companyId, n, name, type, amount]);
    }
  });
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'production_order', entityId: orderId, reason: 'تطبيق معدلات تكلفة التحويل', afterJson: { labor: c.labor, energy: c.energy, overhead: c.overhead } });
  const { order, ...rest } = c;
  return { orderId, documentNumber: order.document_number, applied: true, ...rest };
}

/* ============================== تقرير الإنتاج اليومي + أدوات ============================== */

/** إنتاج وهالك وتشغيل لكل يوم ومرحلة (من سجل الورديات). */
export async function reportDailyProduction(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const rows = (await pool.query(
    `SELECT l.log_date, COALESCE(s.name_ar,'بدون مرحلة') AS stage_name, COALESCE(s.sort_order, 9999) AS stage_order, m.output_unit,
            count(DISTINCT l.machine_id) AS machines, sum(l.output_quantity) AS output, sum(l.waste_quantity) AS waste,
            sum(l.run_hours) AS run_hours, sum(l.downtime_hours) AS downtime_hours
     FROM machine_production_logs l JOIN machines m ON m.id=l.machine_id AND m.company_id=l.company_id LEFT JOIN textile_stages s ON s.id=m.stage_id AND s.company_id=m.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3)
     GROUP BY l.log_date, s.name_ar, s.sort_order, m.output_unit ORDER BY l.log_date DESC, stage_order LIMIT 1000`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  return rows.map((r) => ({
    ...r, wastePercent: new Decimal(r.output).plus(r.waste).isZero() ? null : new Decimal(r.waste).dividedBy(new Decimal(r.output).plus(r.waste)).times(100).toFixed(2),
  }));
}

export function commercialWeightTool(q: { actualKg: string; moisturePercent: string; fiber?: string; regainPercent?: string }) {
  const regain = q.regainPercent ?? (q.fiber ? String(STANDARD_REGAIN[q.fiber]) : undefined);
  if (regain === undefined) throw new ValidationError('حدِّد نوع الألياف أو نسبة الاسترداد regainPercent');
  return { regainPercent: regain, ...commercialWeight(q.actualKg, q.moisturePercent, regain) };
}
