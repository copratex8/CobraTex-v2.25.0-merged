import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { fourPointGrade } from '@/modules/manufacturing/textileCosting';

/**
 * كتالوج العيوب + رول بعيوب مسجَّلة + إذن التسليم (هجرة 0046).
 * إذن التسليم يربط وحدات تعبئة/رولات بعميل ويضع الوحدات «مشحونة»؛ لا قيود ولا حركة مخزون
 * (الفوترة والمخزون المالي يبقيان عبر فاتورة البيع الأصلية).
 */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** كتالوج عيوب افتراضي شائع في النسيج (نقاط 4-point: 1 حتى 4). */
export const DEFAULT_DEFECTS: Array<{ code: string; nameAr: string; category: string; points: number }> = [
  { code: 'W-BRK', nameAr: 'قطع سدى', category: 'warp', points: 2 }, { code: 'W-FLT', nameAr: 'لحمة طائرة', category: 'weft', points: 2 },
  { code: 'W-MIS', nameAr: 'لحمة ناقصة', category: 'weft', points: 3 }, { code: 'W-SLB', nameAr: 'عقدة/سلب', category: 'yarn', points: 1 },
  { code: 'K-HOL', nameAr: 'ثقب ترايكو', category: 'knit', points: 4 }, { code: 'K-DRP', nameAr: 'غرزة مفقودة', category: 'knit', points: 3 },
  { code: 'K-LIN', nameAr: 'خط إبرة', category: 'knit', points: 3 }, { code: 'D-STN', nameAr: 'بقعة صباغة', category: 'dye', points: 3 },
  { code: 'D-SHD', nameAr: 'اختلاف درجة', category: 'dye', points: 4 }, { code: 'F-CRS', nameAr: 'تكسّر/كرمشة', category: 'finish', points: 2 },
  { code: 'O-OIL', nameAr: 'بقعة زيت', category: 'other', points: 4 },
];

export async function seedDefectCatalog(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  let added = 0;
  for (const d of DEFAULT_DEFECTS) {
    const r = await pool.query(`INSERT INTO textile_defect_types(company_id, code, name_ar, category, points) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id, code) DO NOTHING`, [ctx.companyId, d.code, d.nameAr, d.category, d.points]);
    added += r.rowCount ?? 0;
  }
  return { added };
}
export async function listDefectTypes(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  return (await pool.query(`SELECT * FROM textile_defect_types WHERE company_id=$1 ORDER BY category, code`, [ctx.companyId])).rows;
}
export async function createDefectType(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  try {
    return (await pool.query(`INSERT INTO textile_defect_types(company_id, code, name_ar, category, points) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [ctx.companyId, b.code, b.nameAr, b.category ?? 'other', b.points])).rows[0];
  } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError(`كود العيب "${b.code}" مستخدم`); throw e; }
}
export async function updateDefectType(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.manage');
  const map: Record<string, string> = { code: 'code', nameAr: 'name_ar', category: 'category', points: 'points', isActive: 'is_active' };
  const keys = Object.keys(b).filter((k) => map[k]);
  if (!keys.length) throw new ValidationError('لا حقول للتعديل');
  const r = await pool.query(`UPDATE textile_defect_types SET ${keys.map((k, i) => `${map[k]}=$${i + 3}`).join(',')} WHERE id=$1 AND company_id=$2 RETURNING *`, [id, ctx.companyId, ...keys.map((k) => b[k])]);
  if (!r.rows[0]) throw new NotFoundError('نوع العيب غير موجود');
  return r.rows[0];
}

/** مجموع النقاط = Σ (تكرار × نقاط النوع). دالة صافية للاختبار. */
export function sumDefectPoints(items: Array<{ occurrences: number; points: number }>): number {
  return items.reduce((s, x) => s + x.occurrences * x.points, 0);
}

export async function createRollWithDefects(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.inspection.manage');
  const ids: string[] = [...new Set<string>(b.defects.map((d: B) => d.defectTypeId))];
  const types = ids.length ? (await pool.query(`SELECT id, points, is_active FROM textile_defect_types WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, ids])).rows : [];
  if (types.length !== ids.length) throw new ValidationError('نوع عيب غير موجود');
  if (types.some((t) => !t.is_active)) throw new ValidationError('نوع عيب معطَّل');
  const pts = new Map<string, number>(types.map((t) => [t.id, Number(t.points)]));
  const total = sumDefectPoints(b.defects.map((d: B) => ({ occurrences: d.occurrences, points: pts.get(d.defectTypeId)! })));
  const g = fourPointGrade(total, b.lengthM, b.widthCm);
  return withTransaction(async (client) => {
    let roll;
    try {
      roll = (await client.query(
        `INSERT INTO fabric_rolls(company_id, production_order_id, item_id, roll_no, length_m, width_cm, weight_kg, defect_points, points_per_100sqyd, grade, inspected_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.companyId, b.productionOrderId ?? null, b.itemId ?? null, b.rollNo, b.lengthM, b.widthCm, b.weightKg ?? null, total, g.pointsPer100SqYd, g.grade, ctx.userId])).rows[0];
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError(`رقم الرول "${b.rollNo}" مستخدم`); throw e; }
    for (const d of b.defects) {
      await client.query(`INSERT INTO fabric_roll_defects(company_id, roll_id, defect_type_id, occurrences, points_each, position_m) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.companyId, roll.id, d.defectTypeId, d.occurrences, pts.get(d.defectTypeId), d.positionM ?? null]);
    }
    return { ...roll, totalPoints: total };
  });
}

/** باريتو العيوب: الأكثر تسبّبًا في النقاط، لفترة/أمر. */
export async function defectPareto(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const rows = (await pool.query(
    `SELECT t.code, t.name_ar, t.category, SUM(d.occurrences)::int AS occurrences, SUM(d.occurrences*d.points_each)::int AS points, COUNT(DISTINCT d.roll_id)::int AS rolls
     FROM fabric_roll_defects d JOIN textile_defect_types t ON t.id=d.defect_type_id AND t.company_id=d.company_id JOIN fabric_rolls r ON r.id=d.roll_id
     WHERE d.company_id=$1 AND ($2::date IS NULL OR r.inspected_at::date>=$2) AND ($3::date IS NULL OR r.inspected_at::date<=$3)
     GROUP BY t.code, t.name_ar, t.category ORDER BY points DESC`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  const total = rows.reduce((s, r) => s + r.points, 0);
  let cum = 0;
  return rows.map((r) => { cum += r.points; return { ...r, sharePercent: total ? +(r.points * 100 / total).toFixed(1) : 0, cumulativePercent: total ? +(cum * 100 / total).toFixed(1) : 0 }; });
}

/* ============================== إذن التسليم ============================== */

export async function createDeliveryNote(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.delivery.manage', b.branchId);
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['dn:' + ctx.companyId]);
    const cust = (await client.query(`SELECT id FROM customers WHERE id=$1 AND company_id=$2`, [b.customerId, ctx.companyId])).rows[0];
    if (!cust) throw new ValidationError('العميل غير موجود');
    const units = b.packingUnitIds.length ? (await client.query(`SELECT id, status, branch_id FROM packing_units WHERE company_id=$1 AND id = ANY($2::uuid[]) FOR UPDATE`, [ctx.companyId, b.packingUnitIds])).rows : [];
    if (units.length !== b.packingUnitIds.length) throw new ValidationError('وحدة تعبئة غير موجودة');
    if (units.some((u) => u.status !== 'in_stock')) throw new ConflictError('وحدة تعبئة مشحونة بالفعل');
    if (units.some((u) => u.branch_id !== b.branchId)) throw new ValidationError('وحدة تعبئة من فرع آخر');
    if (b.fabricRollIds.length) {
      const rolls = (await client.query(`SELECT id FROM fabric_rolls WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, b.fabricRollIds])).rows;
      if (rolls.length !== b.fabricRollIds.length) throw new ValidationError('رول غير موجود');
    }
    const seq = Number((await client.query(`SELECT COUNT(*)::int AS n FROM delivery_notes WHERE company_id=$1`, [ctx.companyId])).rows[0].n) + 1;
    const noteNo = `DN-${b.noteDate.slice(0, 4)}-${String(seq).padStart(5, '0')}`;
    const note = (await client.query(
      `INSERT INTO delivery_notes(company_id, branch_id, note_no, customer_id, sales_order_id, note_date, vehicle_no, driver_name, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.companyId, b.branchId, noteNo, b.customerId, b.salesOrderId ?? null, b.noteDate, b.vehicleNo ?? null, b.driverName ?? null, b.notes ?? null, ctx.userId])).rows[0];
    try {
      for (const u of b.packingUnitIds) await client.query(`INSERT INTO delivery_note_lines(company_id, delivery_note_id, packing_unit_id) VALUES ($1,$2,$3)`, [ctx.companyId, note.id, u]);
      for (const r of b.fabricRollIds) await client.query(`INSERT INTO delivery_note_lines(company_id, delivery_note_id, fabric_roll_id) VALUES ($1,$2,$3)`, [ctx.companyId, note.id, r]);
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError('وحدة/رول مُدرج في إذن تسليم آخر'); throw e; }
    if (b.packingUnitIds.length) await client.query(`UPDATE packing_units SET status='shipped', shipped_at=now() WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, b.packingUnitIds]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'delivery_note', entityId: note.id, afterJson: { noteNo, units: b.packingUnitIds.length, rolls: b.fabricRollIds.length } });
    return note;
  });
}

export async function cancelDeliveryNote(ctx: RequestContext, id: string, reason: string) {
  await assertManufacturingEnabled(ctx);
  return withTransaction(async (client) => {
    const n = (await client.query(`SELECT * FROM delivery_notes WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!n) throw new NotFoundError('إذن التسليم غير موجود');
    ctx.assertPermission('textile.delivery.manage', n.branch_id);
    if (n.status === 'cancelled') throw new ConflictError('الإذن ملغى بالفعل');
    await client.query(`UPDATE packing_units SET status='in_stock', shipped_at=NULL WHERE company_id=$1 AND id IN (SELECT packing_unit_id FROM delivery_note_lines WHERE delivery_note_id=$2 AND packing_unit_id IS NOT NULL)`, [ctx.companyId, id]);
    await client.query(`DELETE FROM delivery_note_lines WHERE delivery_note_id=$1`, [id]);
    await client.query(`UPDATE delivery_notes SET status='cancelled', cancelled_reason=$3 WHERE id=$1 AND company_id=$2`, [id, ctx.companyId, reason]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'delivery_note', entityId: id, afterJson: { status: 'cancelled', reason } });
    return { id, status: 'cancelled' };
  });
}

export async function listDeliveryNotes(ctx: RequestContext, q: { customerId?: string; from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.delivery.view');
  return (await pool.query(
    `SELECT n.*, c.name_ar AS customer_name,
       (SELECT COUNT(*) FROM delivery_note_lines l WHERE l.delivery_note_id=n.id)::int AS lines_count
     FROM delivery_notes n JOIN customers c ON c.id=n.customer_id AND c.company_id=n.company_id
     WHERE n.company_id=$1 AND ($2::uuid IS NULL OR n.customer_id=$2) AND ($3::date IS NULL OR n.note_date>=$3) AND ($4::date IS NULL OR n.note_date<=$4)
       AND ($5::uuid[] IS NULL OR n.branch_id = ANY($5)) ORDER BY n.note_date DESC, n.note_no DESC LIMIT 500`,
    [ctx.companyId, q.customerId ?? null, q.from ?? null, q.to ?? null, ctx.visibleBranchIds()])).rows;
}

/** بيانات الطباعة: رأس الإذن + وحدات التعبئة (صافي/إجمالي) + الرولات (طول/وزن/درجة) + الإجماليات. */
export async function deliveryNoteDoc(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.delivery.view');
  const note = (await pool.query(
    `SELECT n.*, c.name_ar AS customer_name, so.document_number AS sales_order_no, si.document_number AS sales_invoice_no FROM delivery_notes n
     JOIN customers c ON c.id=n.customer_id AND c.company_id=n.company_id LEFT JOIN sales_orders so ON so.id=n.sales_order_id LEFT JOIN sales_invoices si ON si.id=n.sales_invoice_id
     WHERE n.id=$1 AND n.company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!note) throw new NotFoundError('إذن التسليم غير موجود');
  const units = (await pool.query(
    `SELECT p.packing_no, p.unit_type, p.lot_number, p.packages_count, p.gross_kg, p.tare_kg, p.net_kg, i.name_ar AS item_name
     FROM delivery_note_lines l JOIN packing_units p ON p.id=l.packing_unit_id JOIN items i ON i.id=p.item_id AND i.company_id=p.company_id
     WHERE l.delivery_note_id=$1 ORDER BY p.packing_no`, [id])).rows;
  const rolls = (await pool.query(
    `SELECT r.roll_no, r.length_m, r.width_cm, r.weight_kg, r.grade, i.name_ar AS item_name
     FROM delivery_note_lines l JOIN fabric_rolls r ON r.id=l.fabric_roll_id LEFT JOIN items i ON i.id=r.item_id AND i.company_id=r.company_id
     WHERE l.delivery_note_id=$1 ORDER BY r.roll_no`, [id])).rows;
  const sum = (xs: B[], k: string) => xs.reduce((s, x) => s + Number(x[k] ?? 0), 0);
  return { note, units, rolls, totals: {
    unitsCount: units.length, rollsCount: rolls.length, packages: sum(units, 'packages_count'),
    grossKg: +sum(units, 'gross_kg').toFixed(3), netKg: +sum(units, 'net_kg').toFixed(3), rollsMeters: +sum(rolls, 'length_m').toFixed(3), rollsKg: +sum(rolls, 'weight_kg').toFixed(3) } };
}

/** وحدات التعبئة والرولات المتاحة للشحن (غير مدرجة في إذن). */
export async function shippable(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.delivery.view');
  const units = (await pool.query(
    `SELECT p.id, p.packing_no, p.unit_type, p.lot_number, p.net_kg, i.name_ar AS item_name FROM packing_units p JOIN items i ON i.id=p.item_id AND i.company_id=p.company_id
     WHERE p.company_id=$1 AND p.status='in_stock' AND ($2::uuid[] IS NULL OR p.branch_id = ANY($2)) ORDER BY p.packing_no LIMIT 500`, [ctx.companyId, ctx.visibleBranchIds()])).rows;
  const rolls = (await pool.query(
    `SELECT r.id, r.roll_no, r.length_m, r.weight_kg, r.grade FROM fabric_rolls r WHERE r.company_id=$1
       AND NOT EXISTS (SELECT 1 FROM delivery_note_lines l WHERE l.fabric_roll_id=r.id) ORDER BY r.roll_no LIMIT 500`, [ctx.companyId])).rows;
  return { units, rolls };
}

/* ============================== ربط الإذن بفاتورة البيع (0048) ============================== */

/** فواتير العميل القابلة للربط بالإذن (غير ملغاة/معكوسة)، وأولويتها لفواتير نفس أمر البيع. */
export async function invoiceCandidates(ctx: RequestContext, noteId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.delivery.view');
  const n = (await pool.query(`SELECT customer_id, sales_order_id FROM delivery_notes WHERE id=$1 AND company_id=$2`, [noteId, ctx.companyId])).rows[0];
  if (!n) throw new NotFoundError('إذن التسليم غير موجود');
  return (await pool.query(
    `SELECT id, document_number, invoice_date, status, (sales_order_id IS NOT DISTINCT FROM $3::uuid AND $3::uuid IS NOT NULL) AS same_order
     FROM sales_invoices WHERE company_id=$1 AND customer_id=$2 AND status IN ('draft','posted') ORDER BY same_order DESC, invoice_date DESC LIMIT 100`,
    [ctx.companyId, n.customer_id, n.sales_order_id])).rows;
}

export async function linkInvoice(ctx: RequestContext, noteId: string, invoiceId: string | null) {
  await assertManufacturingEnabled(ctx);
  const n = (await pool.query(`SELECT id, branch_id, customer_id, status FROM delivery_notes WHERE id=$1 AND company_id=$2`, [noteId, ctx.companyId])).rows[0];
  if (!n) throw new NotFoundError('إذن التسليم غير موجود');
  ctx.assertPermission('textile.delivery.manage', n.branch_id);
  if (n.status !== 'issued') throw new ConflictError('الإذن ملغى');
  if (invoiceId) {
    const inv = (await pool.query(`SELECT customer_id, status FROM sales_invoices WHERE id=$1 AND company_id=$2`, [invoiceId, ctx.companyId])).rows[0];
    if (!inv) throw new NotFoundError('الفاتورة غير موجودة');
    if (inv.customer_id !== n.customer_id) throw new ValidationError('عميل الفاتورة يختلف عن عميل الإذن');
    if (!['draft', 'posted'].includes(inv.status)) throw new ConflictError('الفاتورة ملغاة أو معكوسة');
  }
  await pool.query(`UPDATE delivery_notes SET sales_invoice_id=$3 WHERE id=$1 AND company_id=$2`, [noteId, ctx.companyId, invoiceId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'delivery_note_invoice_link', entityId: noteId, afterJson: { invoiceId } });
  return { noteId, invoiceId };
}

/** مطابقة: لكل صنف في الفاتورة — المفوتر مقابل المُسلَّم (كجم من وحدات التعبئة، ومتر/كجم من الرولات) عبر كل الأذون المرتبطة.
 *  الوحدات قد تختلف (فاتورة بالمتر مقابل تسليم بالكجم) فيُعرض الرقمان ولا يُحكم تلقائيًا إلا بتطابق الوحدة الأساسية الظاهرة. */
const NONE = '__none__'; // لفات بلا صنف مرتبط تظهر في صف مستقل بدل أن تُحذف من المطابقة
export async function invoiceReconciliation(ctx: RequestContext, invoiceId: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.delivery.view');
  const inv = (await pool.query(`SELECT id, document_number, status FROM sales_invoices WHERE id=$1 AND company_id=$2`, [invoiceId, ctx.companyId])).rows[0];
  if (!inv) throw new NotFoundError('الفاتورة غير موجودة');
  const lines = (await pool.query(
    `SELECT l.item_id, i.name_ar AS item_name, u.symbol AS uom, SUM(l.quantity) AS invoiced
     FROM sales_invoice_lines l JOIN items i ON i.id=l.item_id AND i.company_id=l.company_id JOIN uoms u ON u.id=l.uom_id AND u.company_id=l.company_id
     WHERE l.sales_invoice_id=$1 AND l.company_id=$2 GROUP BY l.item_id, i.name_ar, u.symbol`, [invoiceId, ctx.companyId])).rows;
  const kg = (await pool.query(
    `SELECT p.item_id, SUM(p.net_kg) AS kg, COUNT(*)::int AS units FROM delivery_notes n JOIN delivery_note_lines dl ON dl.delivery_note_id=n.id JOIN packing_units p ON p.id=dl.packing_unit_id
     WHERE n.company_id=$1 AND n.sales_invoice_id=$2 AND n.status='issued' GROUP BY p.item_id`, [ctx.companyId, invoiceId])).rows;
  const rl = (await pool.query(
    `SELECT r.item_id, SUM(r.length_m) AS meters, SUM(r.weight_kg) AS kg, COUNT(*)::int AS rolls FROM delivery_notes n JOIN delivery_note_lines dl ON dl.delivery_note_id=n.id JOIN fabric_rolls r ON r.id=dl.fabric_roll_id
     WHERE n.company_id=$1 AND n.sales_invoice_id=$2 AND n.status='issued' GROUP BY r.item_id`, [ctx.companyId, invoiceId])).rows;
  const items = new Set<string>([...lines.map((l) => l.item_id), ...kg.map((x) => x.item_id), ...rl.map((x) => x.item_id ?? NONE)]);
  const out = [...items].map((id) => {
    const l = lines.find((x) => x.item_id === id); const k = kg.find((x) => x.item_id === id); const r = rl.find((x) => (x.item_id ?? NONE) === id);
    return { itemId: id === NONE ? null : id, itemName: l?.item_name ?? null, invoicedQty: l ? Number(l.invoiced) : 0, uom: l?.uom ?? null,
      deliveredKg: Number(k?.kg ?? 0) + Number(r?.kg ?? 0), deliveredMeters: Number(r?.meters ?? 0), units: k?.units ?? 0, rolls: r?.rolls ?? 0, notInvoice: !l };
  });
  return { invoice: inv, items: out };
}
