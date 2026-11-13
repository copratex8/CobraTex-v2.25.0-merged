import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { z } from 'zod';
import { uuid } from '@/shared/zodSchemas';

/**
 * نسب الخيوط (هجرة 0054): وصفة لكل صنف ولكل ماكينة (أو افتراضية)، تُثبَّت فلا تُعدَّل،
 * وأي تغيير في النسب = إصدار جديد يحلّ محل السابق عند تثبيته. تُربط بأمر التصنيع وتُقارن بالاستهلاك الفعلي.
 */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lineSchema = z.strictObject({ yarnItemId: uuid, role: z.enum(['main', 'warp', 'weft', 'pile', 'ground']).default('main'), percent: z.number().positive().max(100), notes: z.string().max(200).optional() });
export const recipeCreateSchema = z.strictObject({
  itemId: uuid, machineId: uuid.nullable().optional(), name: z.string().min(1).max(120), wastePercent: z.number().min(0).lt(100).optional(),
  notes: z.string().max(500).optional(), lines: z.array(lineSchema).min(1).max(30),
});
export const recipeUpdateSchema = z.strictObject({
  name: z.string().min(1).max(120).optional(), wastePercent: z.number().min(0).lt(100).optional(), notes: z.string().max(500).optional(), lines: z.array(lineSchema).min(1).max(30).optional(),
});
export const newVersionSchema = z.strictObject({ reason: z.string().min(3).max(300), machineId: uuid.nullable().optional() });
export const recipeQuerySchema = z.object({ itemId: uuid.optional(), machineId: uuid.optional(), status: z.enum(['draft', 'locked', 'superseded']).optional() }).passthrough();
export const resolveQuerySchema = z.object({ itemId: uuid, machineId: uuid.optional() });
export const reqQuerySchema = z.object({ quantity: z.coerce.number().positive() });
export const attachSchema = z.strictObject({ recipeId: uuid.optional() });
export const genBomSchema = z.strictObject({ code: z.string().min(1).max(40).optional() });
export const costQuerySchema = z.object({ conversionCostPerUnit: z.coerce.number().min(0).optional(), warehouseId: uuid.optional() });
export const blendReportQuerySchema = z.object({ from: date.optional(), to: date.optional(), machineId: uuid.optional() }).passthrough();

const EPS = 0.0001;
/** مجموع النسب (بوحدات 1e-4 لتفادي أخطاء الفاصلة) — يجب أن يساوي 100. */
export function sumPercent(lines: { percent: number | string }[]): number { return lines.reduce((s, l) => s + Math.round(Number(l.percent) * 1e4), 0) / 1e4; }
/** كمية كل خيط (كجم) لإنتاج كمية معيّنة: الكمية × النسبة × (1 + هالك%). */
export function yarnRequirements(quantity: number, wastePercent: number, lines: { yarnItemId: string; percent: number | string }[]) {
  return lines.map((l) => ({ yarnItemId: l.yarnItemId, percent: Number(l.percent), quantity: Math.round(quantity * (Number(l.percent) / 100) * (1 + wastePercent / 100) * 1e4) / 1e4 }));
}

async function loadLines(db: { query: typeof pool.query }, ids: string[]) {
  if (!ids.length) return new Map<string, any[]>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const rows = (await db.query(
    `SELECT l.recipe_id, l.yarn_item_id, l.role, l.percent, l.notes, i.name_ar AS yarn_name, i.code AS yarn_code
     FROM yarn_blend_lines l JOIN items i ON i.id=l.yarn_item_id AND i.company_id=l.company_id WHERE l.recipe_id = ANY($1::uuid[]) ORDER BY l.percent DESC, i.name_ar`, [ids])).rows;
  const m = new Map<string, any[]>(); for (const r of rows) { (m.get(r.recipe_id) ?? m.set(r.recipe_id, []).get(r.recipe_id)!).push(r); } return m; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function checkLines(db: { query: typeof pool.query }, ctx: RequestContext, itemId: string, lines: B[]) {
  const ids = lines.map((l) => l.yarnItemId);
  const keys = lines.map((l) => `${l.yarnItemId}|${l.role ?? 'main'}`);
  if (new Set(keys).size !== keys.length) throw new ValidationError('نفس الخيط والدور مكرر في الوصفة');
  if (ids.includes(itemId)) throw new ValidationError('صنف الوصفة لا يمكن أن يكون أحد خيوطها');
  const found = (await db.query(`SELECT id FROM items WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, [...new Set(ids)]])).rows.length;
  if (found !== new Set(ids).size) throw new ValidationError('أحد الخيوط غير موجود');
}
async function getOwned(db: { query: typeof pool.query }, ctx: RequestContext, id: string, forUpdate = false) {
  const r = (await db.query(`SELECT * FROM yarn_blend_recipes WHERE id=$1 AND company_id=$2 ${forUpdate ? 'FOR UPDATE' : ''}`, [id, ctx.companyId])).rows[0];
  if (!r) throw new NotFoundError('الوصفة غير موجودة'); return r;
}
async function assertMachine(db: { query: typeof pool.query }, ctx: RequestContext, machineId: string | null | undefined) {
  if (!machineId) return;
  if (!(await db.query(`SELECT 1 FROM machines WHERE id=$1 AND company_id=$2`, [machineId, ctx.companyId])).rows[0]) throw new ValidationError('الماكينة غير موجودة');
}

export async function createRecipe(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.manage');
  return withTransaction(async (client) => {
    if (!(await client.query(`SELECT 1 FROM items WHERE id=$1 AND company_id=$2`, [b.itemId, ctx.companyId])).rows[0]) throw new ValidationError('الصنف غير موجود');
    await assertMachine(client, ctx, b.machineId); await checkLines(client, ctx, b.itemId, b.lines);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['blend:' + ctx.companyId + b.itemId]);
    const ver = Number((await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS v FROM yarn_blend_recipes WHERE company_id=$1 AND item_id=$2 AND machine_id IS NOT DISTINCT FROM $3`, [ctx.companyId, b.itemId, b.machineId ?? null])).rows[0].v);
    const r = (await client.query(
      `INSERT INTO yarn_blend_recipes(company_id,item_id,machine_id,name,version_no,waste_percent,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.companyId, b.itemId, b.machineId ?? null, b.name, ver, b.wastePercent ?? 0, b.notes ?? null, ctx.userId])).rows[0];
    for (const l of b.lines) await client.query(`INSERT INTO yarn_blend_lines(company_id,recipe_id,yarn_item_id,role,percent,notes) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.companyId, r.id, l.yarnItemId, l.role ?? 'main', l.percent, l.notes ?? null]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'yarn_blend_recipe', entityId: r.id, afterJson: { itemId: b.itemId, machineId: b.machineId ?? null, version: ver, lines: b.lines.length } });
    return { ...r, lines: (await loadLines(client, [r.id])).get(r.id) ?? [], percentTotal: sumPercent(b.lines) };
  });
}

export async function updateDraft(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.manage');
  return withTransaction(async (client) => {
    const r = await getOwned(client, ctx, id, true);
    if (r.status !== 'draft') throw new ConflictError('الوصفة مثبَّتة ولا يمكن تعديلها؛ أنشئ إصدارًا جديدًا');
    if (b.lines) {
      await checkLines(client, ctx, r.item_id, b.lines);
      await client.query(`DELETE FROM yarn_blend_lines WHERE recipe_id=$1`, [id]);
      for (const l of b.lines) await client.query(`INSERT INTO yarn_blend_lines(company_id,recipe_id,yarn_item_id,role,percent,notes) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.companyId, id, l.yarnItemId, l.role ?? 'main', l.percent, l.notes ?? null]);
    }
    const u = (await client.query(`UPDATE yarn_blend_recipes SET name=COALESCE($2,name), waste_percent=COALESCE($3,waste_percent), notes=COALESCE($4,notes) WHERE id=$1 RETURNING *`, [id, b.name ?? null, b.wastePercent ?? null, b.notes ?? null])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'yarn_blend_recipe', entityId: id, afterJson: { name: b.name, lines: b.lines?.length } });
    const lines = (await loadLines(client, [id])).get(id) ?? [];
    return { ...u, lines, percentTotal: sumPercent(lines) };
  });
}

export async function deleteDraft(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.manage');
  const r = await getOwned(pool, ctx, id);
  if (r.status !== 'draft') throw new ConflictError('لا تُحذف وصفة مثبَّتة');
  await pool.query(`DELETE FROM yarn_blend_recipes WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'delete', entityType: 'yarn_blend_recipe', entityId: id, beforeJson: { version: r.version_no } });
  return { deleted: true };
}

/** تثبيت: مجموع النسب = 100 بالضبط، ثم تُحال الوصفة المثبَّتة السابقة لنفس النطاق إلى superseded في نفس المعاملة. */
export async function lockRecipe(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.lock');
  return withTransaction(async (client) => {
    const r = await getOwned(client, ctx, id, true);
    if (r.status !== 'draft') throw new ConflictError('الوصفة مثبَّتة بالفعل');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['blend:' + ctx.companyId + r.item_id]);
    const lines = (await loadLines(client, [id])).get(id) ?? [];
    if (!lines.length) throw new ValidationError('وصفة بلا خيوط');
    const total = sumPercent(lines);
    if (Math.abs(total - 100) > EPS) throw new ValidationError(`مجموع النسب ${total}% ويجب أن يساوي 100% قبل التثبيت`);
    const prev = (await client.query(`UPDATE yarn_blend_recipes SET status='superseded' WHERE company_id=$1 AND item_id=$2 AND machine_id IS NOT DISTINCT FROM $3 AND status='locked' RETURNING id, version_no`, [ctx.companyId, r.item_id, r.machine_id])).rows;
    const u = (await client.query(`UPDATE yarn_blend_recipes SET status='locked', locked_at=now(), locked_by=$2 WHERE id=$1 RETURNING *`, [id, ctx.userId])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'lock', entityType: 'yarn_blend_recipe', entityId: id, afterJson: { version: u.version_no, supersedes: prev.map((p) => p.version_no) } });
    return { ...u, lines, percentTotal: total, supersededVersions: prev.map((p) => p.version_no) };
  });
}

/** إصدار جديد (مسودة) منسوخ من وصفة قائمة — لتعديل النسب أو لوصفة ماكينة أخرى (machineId يغيّر النطاق). */
export async function newVersion(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.manage');
  return withTransaction(async (client) => {
    const src = await getOwned(client, ctx, id);
    const machineId = b.machineId === undefined ? src.machine_id : b.machineId;
    await assertMachine(client, ctx, machineId);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['blend:' + ctx.companyId + src.item_id]);
    const ver = Number((await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS v FROM yarn_blend_recipes WHERE company_id=$1 AND item_id=$2 AND machine_id IS NOT DISTINCT FROM $3`, [ctx.companyId, src.item_id, machineId])).rows[0].v);
    const r = (await client.query(
      `INSERT INTO yarn_blend_recipes(company_id,item_id,machine_id,name,version_no,waste_percent,parent_recipe_id,change_reason,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.companyId, src.item_id, machineId, src.name, ver, src.waste_percent, src.id, b.reason, src.notes, ctx.userId])).rows[0];
    await client.query(`INSERT INTO yarn_blend_lines(company_id,recipe_id,yarn_item_id,role,percent,notes) SELECT company_id,$2,yarn_item_id,role,percent,notes FROM yarn_blend_lines WHERE recipe_id=$1`, [id, r.id]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'yarn_blend_recipe', entityId: r.id, afterJson: { parent: id, reason: b.reason, version: ver } });
    const lines = (await loadLines(client, [r.id])).get(r.id) ?? [];
    return { ...r, lines, percentTotal: sumPercent(lines) };
  });
}

export async function listRecipes(ctx: RequestContext, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const rows = (await pool.query(
    `SELECT r.*, it.name_ar AS item_name, it.code AS item_code, m.code AS machine_code, m.name_ar AS machine_name
     FROM yarn_blend_recipes r JOIN items it ON it.id=r.item_id AND it.company_id=r.company_id LEFT JOIN machines m ON m.id=r.machine_id AND m.company_id=r.company_id
     WHERE r.company_id=$1 AND ($2::uuid IS NULL OR r.item_id=$2) AND ($3::uuid IS NULL OR r.machine_id=$3) AND ($4::text IS NULL OR r.status=$4)
     ORDER BY it.name_ar, m.code NULLS FIRST, r.version_no DESC`, [ctx.companyId, q.itemId ?? null, q.machineId ?? null, q.status ?? null])).rows;
  const lines = await loadLines(pool, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lines: lines.get(r.id) ?? [], percentTotal: sumPercent(lines.get(r.id) ?? []) }));
}

export async function getRecipe(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const r = await getOwned(pool, ctx, id); const lines = (await loadLines(pool, [id])).get(id) ?? [];
  const history = (await pool.query(`SELECT id, version_no, status, machine_id, change_reason, locked_at FROM yarn_blend_recipes WHERE company_id=$1 AND item_id=$2 AND machine_id IS NOT DISTINCT FROM $3 ORDER BY version_no DESC`, [ctx.companyId, r.item_id, r.machine_id])).rows;
  return { ...r, lines, percentTotal: sumPercent(lines), history };
}

/** أي وصفة تُستخدم: المثبَّتة الحالية لتلك الماكينة، وإلا الافتراضية للصنف، وإلا لا شيء. */
export async function resolveRecipe(ctx: RequestContext, q: { itemId: string; machineId?: string | null }, db: { query: typeof pool.query } = pool) {
  const r = (await db.query(
    `SELECT * FROM yarn_blend_recipes WHERE company_id=$1 AND item_id=$2 AND status='locked' AND (machine_id IS NULL OR machine_id=$3)
     ORDER BY (machine_id IS NULL) ASC LIMIT 1`, [ctx.companyId, q.itemId, q.machineId ?? null])).rows[0];
  if (!r) return null;
  const lines = (await loadLines(db, [r.id])).get(r.id) ?? [];
  return { ...r, lines, percentTotal: sumPercent(lines), source: r.machine_id ? 'machine' : 'default' };
}
export async function resolve(ctx: RequestContext, q: { itemId: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  return resolveRecipe(ctx, q);
}

export async function requirements(ctx: RequestContext, id: string, quantity: number) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const r = await getOwned(pool, ctx, id); const lines = (await loadLines(pool, [id])).get(id) ?? [];
  const req = yarnRequirements(quantity, Number(r.waste_percent), lines.map((l) => ({ yarnItemId: l.yarn_item_id, percent: l.percent })));
  return { recipeId: id, version: r.version_no, wastePercent: Number(r.waste_percent), outputQuantity: quantity,
    lines: req.map((x) => ({ ...x, yarnName: lines.find((l) => l.yarn_item_id === x.yarnItemId)?.yarn_name })), totalYarn: Math.round(req.reduce((s, x) => s + x.quantity, 0) * 1e4) / 1e4 };
}

/** ربط أمر تصنيع (مسودة) بوصفة مثبَّتة: صنفها = مخرج الأمر، ووصفة الماكينة تلزمها نفس ماكينة الأمر. بلا recipeId تُحلّ تلقائيًا. */
export async function attachToOrder(ctx: RequestContext, orderId: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.manage');
  return withTransaction(async (client) => {
    const o = (await client.query(`SELECT id, status, output_item_id, machine_id, branch_id, bom_id FROM production_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId])).rows[0];
    if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
    if (o.status !== 'draft') throw new ConflictError('لا تُغيَّر وصفة أمر مرحَّل أو معكوس');
    let rec: B | null;
    if (b.recipeId) {
      rec = await getOwned(client, ctx, b.recipeId);
      if (rec.status !== 'locked') throw new ValidationError('تُربط وصفة مثبَّتة وحالية فقط');
      if (rec.item_id !== o.output_item_id) throw new ValidationError('صنف الوصفة لا يطابق مخرج الأمر');
      if (rec.machine_id && rec.machine_id !== o.machine_id) throw new ValidationError('هذه الوصفة تخص ماكينة أخرى غير ماكينة الأمر');
    } else {
      rec = await resolveRecipe(ctx, { itemId: o.output_item_id, machineId: o.machine_id }, client);
      if (!rec) throw new NotFoundError('لا توجد وصفة مثبَّتة لهذا الصنف/الماكينة');
    }
    await client.query(`UPDATE production_orders SET blend_recipe_id=$2 WHERE id=$1`, [orderId, rec.id]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'production_order_blend', entityId: orderId, afterJson: { recipeId: rec.id, version: rec.version_no, machineId: o.machine_id } });
    const bomOf = (await client.query(`SELECT blend_recipe_id FROM bill_of_materials WHERE id=$1 AND company_id=$2`, [o.bom_id, ctx.companyId])).rows[0];
    return { orderId, recipeId: rec.id, version: rec.version_no, machineBound: !!rec.machine_id, bomMatchesRecipe: bomOf?.blend_recipe_id === rec.id };
  });
}

/** انحراف الاستهلاك الفعلي عن نسب الوصفة لأمر مرحَّل: النسبة الفعلية لكل خيط = مستهلكه ÷ إجمالي الخيوط المستهلكة. */
export async function orderVariance(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const o = (await pool.query(`SELECT id, document_number, status, blend_recipe_id, actual_output_quantity FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
  if (!o.blend_recipe_id) throw new ValidationError('الأمر غير مربوط بوصفة');
  const lines = (await loadLines(pool, [o.blend_recipe_id])).get(o.blend_recipe_id) ?? [];
  const cons = (await pool.query(`SELECT component_item_id, i.name_ar, SUM(consumed_quantity) AS qty FROM production_order_lines l JOIN items i ON i.id=l.component_item_id AND i.company_id=l.company_id WHERE l.production_order_id=$1 AND l.company_id=$2 AND l.consumed_quantity IS NOT NULL GROUP BY component_item_id, i.name_ar`, [orderId, ctx.companyId])).rows;
  const yarnIds = new Set(lines.map((l) => l.yarn_item_id));
  const inYarn = cons.filter((c) => yarnIds.has(c.component_item_id)); const outside = cons.filter((c) => !yarnIds.has(c.component_item_id));
  const total = inYarn.reduce((s, c) => s + Number(c.qty), 0);
  const byYarn = new Map<string, number>(); for (const c of inYarn) byYarn.set(c.component_item_id, Number(c.qty));
  const rows = lines.map((l) => { const q = byYarn.get(l.yarn_item_id) ?? 0; const actual = total > 0 ? Math.round((q / total) * 1e6) / 1e4 : null;
    return { yarnItemId: l.yarn_item_id, yarnName: l.yarn_name, role: l.role, expectedPercent: Number(l.percent), consumedQty: q, actualPercent: actual, deviation: actual === null ? null : Math.round((actual - Number(l.percent)) * 1e4) / 1e4 }; });
  return { orderId, orderNo: o.document_number, status: o.status, consumedYarnTotal: total, lines: rows, outsideRecipe: outside.map((c) => ({ itemId: c.component_item_id, name: c.name_ar, qty: Number(c.qty) })), measurable: total > 0 };
}

/** الإنتاج مفصولًا لكل ماكينة ولكل وصفة (من سجل الماكينة المربوط بأمر له وصفة) مع الخيوط المستهلكة نظريًا حسب النسب. */
export async function machineBlendReport(ctx: RequestContext, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const rows = (await pool.query(
    `SELECT m.id AS machine_id, m.code AS machine_code, m.name_ar AS machine_name, r.id AS recipe_id, r.name AS recipe_name, r.version_no, it.name_ar AS item_name,
            r.waste_percent, SUM(g.output_quantity) AS output, SUM(g.run_hours) AS run_hours, COUNT(*)::int AS logs
     FROM machine_production_logs g JOIN machines m ON m.id=g.machine_id AND m.company_id=g.company_id
     JOIN production_orders po ON po.id=g.production_order_id AND po.company_id=g.company_id JOIN yarn_blend_recipes r ON r.id=po.blend_recipe_id AND r.company_id=po.company_id
     JOIN items it ON it.id=r.item_id AND it.company_id=r.company_id
     WHERE g.company_id=$1 AND ($2::date IS NULL OR g.log_date>=$2) AND ($3::date IS NULL OR g.log_date<=$3) AND ($4::uuid IS NULL OR g.machine_id=$4)
     GROUP BY m.id, m.code, m.name_ar, r.id, r.name, r.version_no, it.name_ar, r.waste_percent ORDER BY m.code, it.name_ar, r.version_no`, [ctx.companyId, q.from ?? null, q.to ?? null, q.machineId ?? null])).rows;
  const lines = await loadLines(pool, [...new Set(rows.map((r) => r.recipe_id))]);
  return rows.map((r) => ({
    machineId: r.machine_id, machineCode: r.machine_code, machineName: r.machine_name, recipeId: r.recipe_id, recipeName: r.recipe_name, version: r.version_no, itemName: r.item_name,
    output: Number(r.output), runHours: Number(r.run_hours), logs: r.logs,
    yarnUsage: yarnRequirements(Number(r.output), Number(r.waste_percent), (lines.get(r.recipe_id) ?? []).map((l) => ({ yarnItemId: l.yarn_item_id, percent: l.percent })))
      .map((x) => ({ ...x, yarnName: (lines.get(r.recipe_id) ?? []).find((l) => l.yarn_item_id === x.yarnItemId)?.yarn_name })),
  }));
}


/** توليد قائمة مواد من وصفة مثبَّتة: مخرج 1 كجم، وبند لكل خيط بكمية = النسبة/100 وهالك الوصفة. واحدة لكل وصفة (إصدار)؛ وصفة ماكينة جديدة = BOM جديدة. */
export async function generateBom(ctx: RequestContext, recipeId: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.manage'); ctx.assertPermission('manufacturing.bom.create');
  return withTransaction(async (client) => {
    const r = await getOwned(client, ctx, recipeId, true);
    if (r.status !== 'locked') throw new ValidationError('تُولَّد قائمة المواد من وصفة مثبَّتة وحالية فقط');
    if ((await client.query(`SELECT 1 FROM bill_of_materials WHERE company_id=$1 AND blend_recipe_id=$2`, [ctx.companyId, recipeId])).rows[0]) throw new ConflictError('تم توليد قائمة مواد لهذه الوصفة من قبل');
    const meta = (await client.query(`SELECT it.code AS item_code, it.name_ar AS item_name, m.code AS machine_code FROM items it LEFT JOIN machines m ON m.id=$3 AND m.company_id=$2 WHERE it.id=$1 AND it.company_id=$2`, [r.item_id, ctx.companyId, r.machine_id])).rows[0];
    const code = b.code ?? `BOM-${meta.item_code}${meta.machine_code ? '-' + meta.machine_code : ''}-v${r.version_no}`;
    const lines = (await loadLines(client, [recipeId])).get(recipeId) ?? [];
    let bom;
    try {
      bom = (await client.query(`INSERT INTO bill_of_materials(company_id,output_item_id,code,name_ar,name_en,output_quantity,created_by,blend_recipe_id) VALUES ($1,$2,$3,$4,$4,1,$5,$6) RETURNING *`,
        [ctx.companyId, r.item_id, code, `${meta.item_name} — ${r.name} v${r.version_no}${meta.machine_code ? ' (' + meta.machine_code + ')' : ''}`, ctx.userId, recipeId])).rows[0];
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError(`كود قائمة المواد "${code}" مُستخدَم بالفعل`); throw e; }
    let seq = 0;
    for (const l of lines) await client.query(`INSERT INTO bom_lines(bom_id,company_id,component_item_id,quantity,sequence,waste_percent) VALUES ($1,$2,$3,$4,$5,$6)`, [bom.id, ctx.companyId, l.yarn_item_id, Number(l.percent) / 100, seq++, r.waste_percent]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'bill_of_materials', entityId: bom.id, afterJson: { fromRecipe: recipeId, lines: lines.length } });
    return { bomId: bom.id, code, lines: lines.length };
  });
}

/** تكلفة كجم المنتج من الوصفة: Σ نسبة × (1+هالك) × متوسط تكلفة الخيط المرجَّح من المخزون (+ تكلفة تحويل اختيارية للكجم). خيط بلا رصيد/تكلفة يُبلَّغ عنه ولا يُقدَّر. */
export async function recipeCost(ctx: RequestContext, id: string, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const r = await getOwned(pool, ctx, id); const lines = (await loadLines(pool, [id])).get(id) ?? [];
  const wac = (await pool.query(`SELECT item_id, SUM(quantity_on_hand) AS qty, SUM(quantity_on_hand*weighted_average_cost) AS val FROM stock_balances WHERE company_id=$1 AND item_id = ANY($2::uuid[]) AND quantity_on_hand>0 AND ($3::uuid IS NULL OR warehouse_id=$3) GROUP BY item_id`, [ctx.companyId, lines.map((l) => l.yarn_item_id), q.warehouseId ?? null])).rows;
  const missing: string[] = []; let material = 0;
  const rows = lines.map((l) => {
    const w = wac.find((x) => x.item_id === l.yarn_item_id); const cost = w && Number(w.qty) > 0 ? Number(w.val) / Number(w.qty) : null;
    const perKg = cost === null ? null : Math.round((Number(l.percent) / 100) * (1 + Number(r.waste_percent) / 100) * cost * 1e4) / 1e4;
    if (cost === null) missing.push(l.yarn_name); else material += perKg!;
    return { yarnItemId: l.yarn_item_id, yarnName: l.yarn_name, percent: Number(l.percent), unitCost: cost === null ? null : Math.round(cost * 1e4) / 1e4, costPerKg: perKg };
  });
  const conv = Number(q.conversionCostPerUnit ?? 0); const material4 = Math.round(material * 1e4) / 1e4;
  return { recipeId: id, version: r.version_no, wastePercent: Number(r.waste_percent), lines: rows, materialCostPerKg: material4, conversionCostPerKg: conv, totalCostPerKg: Math.round((material4 + conv) * 1e4) / 1e4, complete: missing.length === 0, missingCost: missing };
}

/** مقارنة تكلفة كجم الصنف بين وصفاته (إصدارات وماكينات) لمعرفة أرخص نسب/ماكينة. للمكتملة التكلفة فقط تُرتَّب. */
export async function costComparison(ctx: RequestContext, itemId: string, q: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const recs = (await pool.query(`SELECT r.id, r.name, r.version_no, r.status, m.code AS machine_code FROM yarn_blend_recipes r LEFT JOIN machines m ON m.id=r.machine_id AND m.company_id=r.company_id WHERE r.company_id=$1 AND r.item_id=$2 AND r.status IN ('locked','superseded') ORDER BY m.code NULLS FIRST, r.version_no DESC`, [ctx.companyId, itemId])).rows;
  const out = [];
  for (const r of recs) { const c = await recipeCost(ctx, r.id, q); out.push({ recipeId: r.id, name: r.name, version: r.version_no, status: r.status, machineCode: r.machine_code, materialCostPerKg: c.materialCostPerKg, totalCostPerKg: c.totalCostPerKg, complete: c.complete }); }
  const comparable = out.filter((x) => x.complete).sort((a, b) => a.totalCostPerKg - b.totalCostPerKg);
  return { itemId, recipes: out, cheapest: comparable[0] ?? null, savingVsDearestPerKg: comparable.length > 1 ? Math.round((comparable[comparable.length - 1].totalCostPerKg - comparable[0].totalCostPerKg) * 1e4) / 1e4 : null };
}

/** هل رصيد المخزن يكفي خيوط الأمر حسب وصفته؟ المتاح = الرصيد − المحجوز. */
export async function orderAvailability(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.blend.view');
  const o = (await pool.query(`SELECT id, document_number, warehouse_id, blend_recipe_id, planned_output_quantity FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
  if (!o.blend_recipe_id) throw new ValidationError('الأمر غير مربوط بوصفة');
  const rec = await getOwned(pool, ctx, o.blend_recipe_id); const lines = (await loadLines(pool, [o.blend_recipe_id])).get(o.blend_recipe_id) ?? [];
  const need = yarnRequirements(Number(o.planned_output_quantity), Number(rec.waste_percent), lines.map((l) => ({ yarnItemId: l.yarn_item_id, percent: l.percent })));
  const bal = (await pool.query(`SELECT item_id, SUM(quantity_on_hand) AS onhand, SUM(quantity_reserved) AS reserved FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id = ANY($3::uuid[]) GROUP BY item_id`, [ctx.companyId, o.warehouse_id, lines.map((l) => l.yarn_item_id)])).rows;
  const rows = need.map((n) => { const b = bal.find((x) => x.item_id === n.yarnItemId); const avail = b ? Number(b.onhand) - Number(b.reserved) : 0; const short = Math.max(0, Math.round((n.quantity - avail) * 1e4) / 1e4);
    return { yarnItemId: n.yarnItemId, yarnName: lines.find((l) => l.yarn_item_id === n.yarnItemId)?.yarn_name, required: n.quantity, available: avail, shortage: short, ok: short === 0 }; });
  return { orderId, orderNo: o.document_number, plannedQty: Number(o.planned_output_quantity), lines: rows, allAvailable: rows.every((x) => x.ok) };
}
