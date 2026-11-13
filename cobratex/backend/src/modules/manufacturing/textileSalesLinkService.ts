import Decimal from 'decimal.js';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled, createProductionOrder } from '@/modules/manufacturing/manufacturingService';

/**
 * ربط أمر البيع بأمر التصنيع ووعد التسليم (هجرة 0045).
 * يعتمد أن كمية السطر وكمية أمر التصنيع بنفس وحدة الصنف الأساسية (يتحقق من تطابق الصنف لا الوحدة).
 * لا يرحّل مخزونًا ولا قيودًا؛ يقرأ ويربط فقط، وإنشاء الأمر يمرّ عبر createProductionOrder الأصلية.
 */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const D = (v: unknown) => new Decimal(String(v ?? 0));

async function loadLine(ctx: RequestContext, lineId: string) {
  const r = (await pool.query(
    `SELECT sol.id, sol.item_id, sol.quantity, sol.promised_date, sol.requested_date, so.id AS sales_order_id, so.branch_id, so.status AS order_status, so.document_number
     FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
     WHERE sol.id=$1 AND sol.company_id=$2 AND so.company_id=$2`, [lineId, ctx.companyId])).rows[0];
  if (!r) throw new NotFoundError('سطر أمر البيع غير موجود');
  return r;
}

async function plannedOf(lineId: string, companyId: string) {
  const r = (await pool.query(
    `SELECT COALESCE(SUM(planned_output_quantity),0) AS planned FROM production_orders WHERE sales_order_line_id=$1 AND company_id=$2 AND status<>'reversed'`, [lineId, companyId])).rows[0];
  return D(r.planned);
}

/** تحديد/تعديل وعد التسليم لسطر بيع، مع سجل بالتعديل وسببه. */
export async function setPromise(ctx: RequestContext, lineId: string, b: B) {
  await assertManufacturingEnabled(ctx);
  const line = await loadLine(ctx, lineId);
  ctx.assertPermission('textile.sales_link.manage', line.branch_id);
  if (line.order_status === 'cancelled') throw new ConflictError('أمر البيع ملغى');
  const oldDate: string | null = line.promised_date ? String(line.promised_date.toISOString?.().slice(0, 10) ?? line.promised_date).slice(0, 10) : null;
  if (oldDate && oldDate !== b.promisedDate && !b.reason) throw new ValidationError('سبب تعديل وعد التسليم مطلوب');
  await pool.query(
    `UPDATE sales_order_lines SET promised_date=$3, requested_date=COALESCE($4::date, requested_date) WHERE id=$1 AND company_id=$2`,
    [lineId, ctx.companyId, b.promisedDate, b.requestedDate ?? null]);
  await pool.query(
    `INSERT INTO delivery_promise_changes(company_id, sales_order_line_id, old_date, new_date, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.companyId, lineId, oldDate, b.promisedDate, b.reason ?? null, ctx.userId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'sales_order_line_promise', entityId: lineId, beforeJson: { promisedDate: oldDate }, afterJson: { ...b } });
  return { lineId, promisedDate: b.promisedDate, previous: oldDate };
}

export async function promiseHistory(ctx: RequestContext, lineId: string) {
  ctx.assertPermission('textile.sales_link.view');
  await loadLine(ctx, lineId);
  return (await pool.query(
    `SELECT old_date, new_date, reason, changed_by, changed_at FROM delivery_promise_changes WHERE company_id=$1 AND sales_order_line_id=$2 ORDER BY changed_at DESC`, [ctx.companyId, lineId])).rows;
}

/** ربط أمر تصنيع قائم بسطر بيع (نفس الصنف، أمر البيع مؤكَّد/مفوتر، الأمر غير معكوس). */
export async function linkOrder(ctx: RequestContext, lineId: string, productionOrderId: string) {
  await assertManufacturingEnabled(ctx);
  const line = await loadLine(ctx, lineId);
  ctx.assertPermission('textile.sales_link.manage', line.branch_id);
  if (!['confirmed', 'invoiced'].includes(line.order_status)) throw new ConflictError('الربط متاح لأوامر البيع المؤكَّدة فقط');
  const po = (await pool.query(`SELECT id, output_item_id, status, sales_order_line_id FROM production_orders WHERE id=$1 AND company_id=$2`, [productionOrderId, ctx.companyId])).rows[0];
  if (!po) throw new NotFoundError('أمر التصنيع غير موجود');
  if (po.status === 'reversed') throw new ConflictError('أمر التصنيع معكوس');
  if (po.sales_order_line_id && po.sales_order_line_id !== lineId) throw new ConflictError('أمر التصنيع مرتبط فعلاً بسطر بيع آخر — افصله أولاً');
  if (po.output_item_id !== line.item_id) throw new ValidationError('صنف مخرجات أمر التصنيع لا يطابق صنف سطر البيع');
  await pool.query(`UPDATE production_orders SET sales_order_line_id=$3 WHERE id=$1 AND company_id=$2`, [productionOrderId, ctx.companyId, lineId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'production_order_sales_link', entityId: productionOrderId, afterJson: { lineId } });
  return { lineId, productionOrderId, linked: true };
}

export async function unlinkOrder(ctx: RequestContext, productionOrderId: string) {
  await assertManufacturingEnabled(ctx);
  const po = (await pool.query(`SELECT id, branch_id, status, sales_order_line_id FROM production_orders WHERE id=$1 AND company_id=$2`, [productionOrderId, ctx.companyId])).rows[0];
  if (!po) throw new NotFoundError('أمر التصنيع غير موجود');
  ctx.assertPermission('textile.sales_link.manage', po.branch_id);
  if (!po.sales_order_line_id) throw new ConflictError('الأمر غير مرتبط بسطر بيع');
  if (po.status === 'posted') throw new ConflictError('لا يُفصل أمر مرحَّل عن سطر البيع (اعكسه أولاً)');
  await pool.query(`UPDATE production_orders SET sales_order_line_id=NULL WHERE id=$1 AND company_id=$2`, [productionOrderId, ctx.companyId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'production_order_sales_link', entityId: productionOrderId, beforeJson: { lineId: po.sales_order_line_id }, afterJson: { lineId: null } });
  return { productionOrderId, linked: false };
}

/** إنشاء مسودة أمر تصنيع من سطر بيع (الكمية الافتراضية = المتبقي غير المخطَّط) ثم ربطه به. */
export async function createFromLine(ctx: RequestContext, lineId: string, b: B) {
  await assertManufacturingEnabled(ctx);
  const line = await loadLine(ctx, lineId);
  ctx.assertPermission('textile.sales_link.manage', line.branch_id);
  if (line.order_status !== 'confirmed') throw new ConflictError('أنشئ أمر التصنيع من أمر بيع مؤكَّد فقط');
  const bom = (await pool.query(`SELECT id, output_item_id FROM bill_of_materials WHERE id=$1 AND company_id=$2 AND is_active=true`, [b.bomId, ctx.companyId])).rows[0];
  if (!bom) throw new NotFoundError('قائمة المواد غير موجودة أو غير مفعَّلة');
  if (bom.output_item_id !== line.item_id) throw new ValidationError('مخرج قائمة المواد لا يطابق صنف سطر البيع');
  const remaining = D(line.quantity).minus(await plannedOf(lineId, ctx.companyId));
  const qty = b.plannedOutputQuantity ? D(b.plannedOutputQuantity) : remaining;
  if (qty.lte(0)) throw new ConflictError('السطر مخطَّط بالكامل — لا متبقٍّ لإنشاء أمر جديد (مرّر الكمية صراحة إن أردت التجاوز)');
  const order = await createProductionOrder(ctx, {
    branchId: b.branchId, warehouseId: b.warehouseId, bomId: b.bomId, fiscalPeriodId: b.fiscalPeriodId, orderDate: b.orderDate, plannedOutputQuantity: qty.toFixed(4),
  });
  const id = (order as B).id ?? (order as B).order?.id;
  if (!id) throw new Error('تعذّر تحديد معرّف أمر التصنيع المُنشأ');
  await pool.query(`UPDATE production_orders SET sales_order_line_id=$3 WHERE id=$1 AND company_id=$2`, [id, ctx.companyId, lineId]);
  return { lineId, productionOrderId: id, plannedQuantity: qty.toFixed(4), order };
}

export type TrackStatus = 'on_track' | 'at_risk' | 'late' | 'unplanned' | 'ready' | 'short' | 'delivered';

/** حالة السطر: delivered > late > ready > short > at_risk > unplanned > on_track. «short» = كل أوامره مرحَّلة ولم يكتمل المطلوب (عجز إنتاج). today يُمرَّر للاختبار. */
export function classify(r: { ordered: Decimal; invoiced: Decimal; planned: Decimal; produced: Decimal; promised: string | null; lastEnd: string | null; openOrders?: number; ordersCount?: number }, today: string): TrackStatus {
  if (r.invoiced.gte(r.ordered)) return 'delivered';
  if (r.promised && r.promised < today) return 'late';
  if (r.produced.gte(r.ordered)) return 'ready';
  if ((r.ordersCount ?? 0) > 0 && (r.openOrders ?? 1) === 0) return 'short';
  if (r.promised && r.lastEnd && r.lastEnd > r.promised) return 'at_risk';
  if (r.planned.lt(r.ordered)) return 'unplanned';
  return 'on_track';
}

/** لوحة متابعة أوامر البيع المؤكَّدة/المفوترة: مطلوب ↔ مخطَّط ↔ مُنتَج ↔ مُسلَّم، مع حالة كل سطر. */
export async function tracking(ctx: RequestContext, q: { customerId?: string; status?: string; from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.sales_link.view');
  const rows = (await pool.query(
    `SELECT so.id AS sales_order_id, so.document_number AS sales_order_no, so.order_date, so.status AS order_status,
            cu.id AS customer_id, cu.name_ar AS customer_name, sol.id AS line_id, sol.item_id, it.name_ar AS item_name,
            sol.quantity AS ordered, sol.invoiced_quantity AS invoiced, sol.requested_date, sol.promised_date,
            COALESCE(p.planned,0) AS planned, COALESCE(p.produced,0) AS produced, p.last_end, COALESCE(p.cnt,0) AS orders_count, COALESCE(p.open_cnt,0) AS open_cnt
     FROM sales_order_lines sol
     JOIN sales_orders so ON so.id = sol.sales_order_id AND so.company_id = sol.company_id
     JOIN customers cu ON cu.id = so.customer_id AND cu.company_id = so.company_id
     JOIN items it ON it.id = sol.item_id AND it.company_id = sol.company_id
     LEFT JOIN LATERAL (
       SELECT SUM(planned_output_quantity) FILTER (WHERE status<>'reversed') AS planned,
              SUM(actual_output_quantity) FILTER (WHERE status='posted') AS produced,
              MAX(planned_end) FILTER (WHERE status<>'reversed') AS last_end,
              COUNT(*) FILTER (WHERE status<>'reversed') AS cnt, COUNT(*) FILTER (WHERE status='draft') AS open_cnt
       FROM production_orders po WHERE po.sales_order_line_id = sol.id AND po.company_id = sol.company_id) p ON true
     WHERE so.company_id=$1 AND so.status IN ('confirmed','invoiced')
       AND ($2::uuid IS NULL OR so.customer_id=$2) AND ($3::date IS NULL OR so.order_date>=$3) AND ($4::date IS NULL OR so.order_date<=$4)
       AND ($5::uuid[] IS NULL OR so.branch_id = ANY($5))
     ORDER BY COALESCE(sol.promised_date, '9999-12-31'::date), so.document_number`,
    [ctx.companyId, q.customerId ?? null, q.from ?? null, q.to ?? null, ctx.visibleBranchIds()])).rows;
  const today = new Date().toISOString().slice(0, 10);
  const d10 = (v: unknown) => (v ? String((v as Date).toISOString?.().slice(0, 10) ?? v).slice(0, 10) : null);
  const out = rows.map((r) => {
    const promised = d10(r.promised_date), lastEnd = d10(r.last_end);
    const status = classify({ ordered: D(r.ordered), invoiced: D(r.invoiced), planned: D(r.planned), produced: D(r.produced), promised, lastEnd, openOrders: Number(r.open_cnt ?? 0), ordersCount: Number(r.orders_count) }, today);
    return {
      salesOrderId: r.sales_order_id, salesOrderNo: r.sales_order_no, orderDate: d10(r.order_date), customerId: r.customer_id, customerName: r.customer_name,
      lineId: r.line_id, itemId: r.item_id, itemName: r.item_name,
      orderedQty: D(r.ordered).toFixed(4), plannedQty: D(r.planned).toFixed(4), producedQty: D(r.produced).toFixed(4), deliveredQty: D(r.invoiced).toFixed(4),
      unplannedQty: Decimal.max(0, D(r.ordered).minus(D(r.planned))).toFixed(4),
      requestedDate: d10(r.requested_date), promisedDate: promised, scheduledEnd: lastEnd, suggestedPromise: lastEnd, ordersCount: Number(r.orders_count), status,
    };
  });
  const filtered = q.status ? out.filter((x) => x.status === q.status) : out;
  const summary = (['on_track', 'at_risk', 'late', 'unplanned', 'ready', 'short', 'delivered'] as TrackStatus[]).reduce((a, s) => ({ ...a, [s]: out.filter((x) => x.status === s).length }), {} as Record<string, number>);
  return { today, summary, lines: filtered };
}
