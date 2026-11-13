import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { tollStatement } from '@/modules/manufacturing/textileMill';

/**
 * التصنيع لدى الغير (مصبغة/مصنع خارجي): دفتر تشغيلي بلا ترحيل مخزون/قيود (راجع 0043).
 * يعيد استخدام حساب «التشغيل للغير» بعد عكس الأدوار: المُرسَل = المستلَم عندهم، والمستلَم المعالج = الناتج، والأجر مستحق للمقاول،
 * والزائد عن الفاقد المسموح يُحمَّل عليه بقيمة الخامة عند الإقفال فيُخصم من صافي المستحق له.
 */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function totals(companyId: string, jobId: string) {
  const r = (await pool.query(
    `SELECT COALESCE(sum(quantity) FILTER (WHERE movement_type='sent'),0) AS sent,
            COALESCE(sum(quantity) FILTER (WHERE movement_type='received'),0) AS received,
            COALESCE(sum(quantity) FILTER (WHERE movement_type='waste_returned'),0) AS wr,
            COALESCE(sum(quantity) FILTER (WHERE movement_type='waste_retained'),0) AS wk,
            COALESCE(sum(amount) FILTER (WHERE movement_type='invoice'),0) AS invoiced
     FROM subcontract_movements WHERE job_id=$1 AND company_id=$2`, [jobId, companyId])).rows[0];
  return { receipt: r.sent, output: r.received, wasteReturned: r.wr, wasteRetained: r.wk, invoicedAmount: r.invoiced };
}

export function subcontractStatement(t: ReturnType<typeof totals> extends Promise<infer R> ? R : never, job: B, closing: boolean) {
  const s = tollStatement(t, {
    feePerUnit: job.fee_per_unit, feeBasis: job.fee_basis === 'sent' ? 'received' : 'output',
    allowedLossPercent: job.allowed_loss_percent, materialValuePerUnit: job.material_value_per_unit,
  }, closing);
  return {
    sent: s.received, receivedBack: s.output, wasteReturned: s.wasteReturned, wasteRetained: s.wasteRetained,
    heldAtVendor: s.heldAtMill, lossPercent: s.lossPercent, allowedLossQty: s.allowedLossQty, excessLossQty: s.excessLossQty,
    feeEarned: s.feeEarned, invoiced: s.invoiced, feeDue: s.feeDue, chargeToVendor: s.compensation, netPayable: s.netDue,
    note: closing ? 'بعد الإقفال: الرصيد المتبقي لدى المقاول يُعدّ فاقدًا ويُحمَّل عليه الزائد عن المسموح بقيمة الخامة' : 'قبل الإقفال: الرصيد ما زال لدى المقاول قيد التشغيل',
  };
}

export async function createSubcontractJob(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.subcontract.manage', b.branchId);
  try {
    return (await pool.query(
      `INSERT INTO subcontract_jobs(company_id, branch_id, job_no, supplier_id, service_type, material_description, unit, fee_per_unit, fee_basis, allowed_loss_percent, material_value_per_unit, production_order_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ctx.companyId, b.branchId, b.jobNo, b.supplierId, b.serviceType, b.materialDescription, b.unit ?? 'kg', b.feePerUnit, b.feeBasis ?? 'received', b.allowedLossPercent ?? '0', b.materialValuePerUnit ?? '0', b.productionOrderId ?? null, b.notes ?? null, ctx.userId])).rows[0];
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new ConflictError(`رقم العمل "${b.jobNo}" مستخدم`);
    if (code === '23503') throw new ValidationError('المورد أو الفرع أو أمر التصنيع غير موجود');
    throw e;
  }
}

export async function listSubcontractJobs(ctx: RequestContext, q: { status?: string; supplierId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.subcontract.view');
  return (await pool.query(
    `SELECT j.*, s.name_ar AS supplier_name,
            COALESCE(t.sent,0) AS sent, COALESCE(t.received,0) AS received,
            COALESCE(t.sent,0) - COALESCE(t.received,0) - COALESCE(t.wr,0) - COALESCE(t.wk,0) AS held_at_vendor
     FROM subcontract_jobs j JOIN suppliers s ON s.id=j.supplier_id AND s.company_id=j.company_id
     LEFT JOIN (SELECT job_id,
                  sum(quantity) FILTER (WHERE movement_type='sent') sent, sum(quantity) FILTER (WHERE movement_type='received') received,
                  sum(quantity) FILTER (WHERE movement_type='waste_returned') wr, sum(quantity) FILTER (WHERE movement_type='waste_retained') wk
                FROM subcontract_movements WHERE company_id=$1 GROUP BY job_id) t ON t.job_id=j.id
     WHERE j.company_id=$1 AND ($2::text IS NULL OR j.status=$2) AND ($3::uuid IS NULL OR j.supplier_id=$3) ORDER BY j.created_at DESC LIMIT 300`,
    [ctx.companyId, q.status ?? null, q.supplierId ?? null])).rows;
}

export async function getSubcontractJob(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.subcontract.view');
  const job = (await pool.query(`SELECT j.*, s.name_ar AS supplier_name FROM subcontract_jobs j JOIN suppliers s ON s.id=j.supplier_id AND s.company_id=j.company_id WHERE j.id=$1 AND j.company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!job) throw new NotFoundError('العمل غير موجود');
  const movements = (await pool.query(`SELECT * FROM subcontract_movements WHERE job_id=$1 AND company_id=$2 ORDER BY movement_date, created_at`, [id, ctx.companyId])).rows;
  return { ...job, movements, statement: subcontractStatement(await totals(ctx.companyId, id), job, job.status === 'closed') };
}

export async function addSubcontractMovement(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.subcontract.manage');
  const job = (await pool.query(`SELECT * FROM subcontract_jobs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!job) throw new NotFoundError('العمل غير موجود');
  if (job.status === 'closed') throw new ConflictError('العمل مُقفَل — لا حركات بعد الإقفال');
  const isInvoice = b.movementType === 'invoice';
  if (isInvoice && b.amount === undefined) throw new ValidationError('قيمة الفاتورة مطلوبة');
  if (!isInvoice && b.quantity === undefined) throw new ValidationError('الكمية مطلوبة');
  await withTransaction(async (client) => {
    await client.query(`SELECT id FROM subcontract_jobs WHERE id=$1 FOR UPDATE`, [id]);
    await client.query(
      `INSERT INTO subcontract_movements(job_id, company_id, movement_type, movement_date, quantity, amount, reference, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ctx.companyId, b.movementType, b.movementDate, isInvoice ? '0' : b.quantity, isInvoice ? b.amount : null, b.reference ?? null, b.notes ?? null, ctx.userId]);
    const t = (await client.query(
      `SELECT COALESCE(sum(quantity) FILTER (WHERE movement_type='sent'),0) s, COALESCE(sum(quantity) FILTER (WHERE movement_type IN ('received','waste_returned','waste_retained')),0) o FROM subcontract_movements WHERE job_id=$1`, [id])).rows[0];
    if (new Decimal(t.o).greaterThan(t.s)) throw new ValidationError('إجمالي المستلَم والهالك يتجاوز الكمية المرسلة للمقاول');
  });
  return getSubcontractJob(ctx, id);
}

export async function closeSubcontractJob(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.subcontract.manage');
  const r = await pool.query(`UPDATE subcontract_jobs SET status='closed', closed_at=now() WHERE id=$1 AND company_id=$2 AND status='open' RETURNING id`, [id, ctx.companyId]);
  if (r.rows.length === 0) throw new ConflictError('العمل غير موجود أو مُقفَل مسبقًا');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'subcontract_job', entityId: id, afterJson: { status: 'closed' } });
  return getSubcontractJob(ctx, id);
}
