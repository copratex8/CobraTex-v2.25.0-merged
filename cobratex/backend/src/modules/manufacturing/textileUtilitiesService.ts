import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { z } from 'zod';
import { uuid } from '@/shared/zodSchemas';

/** فواتير المرافق وتوزيعها على المراحل (هجرة 0047). تقرير تحليلي: لا ترحيل ولا قيود. */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const utilityBillSchema = z.strictObject({
  branchId: uuid, kind: z.enum(['electricity', 'steam', 'water', 'gas', 'compressed_air', 'other']), periodFrom: date, periodTo: date,
  quantity: z.number().positive().optional(), unit: z.string().max(20).optional(), totalCost: z.number().positive().max(1e12),
  driver: z.enum(['energy_kwh', 'run_hours', 'output']).optional(), notes: z.string().max(300).optional(),
}).refine((b) => b.periodTo >= b.periodFrom, { message: 'نهاية الفترة قبل بدايتها' });
export const utilityQuerySchema = z.object({ from: date.optional(), to: date.optional() }).passthrough();

/** توزيع مبلغ بنسب الأوزان بطريقة «أكبر باقٍ» بوحدات 0.0001 فيتطابق المجموع تمامًا. أوزان كلها صفر → null. */
export function allocate(total: number, weights: number[]): number[] | null {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return null;
  const T = Math.round(total * 1e4);
  const raw = weights.map((w) => (T * w) / sum);
  const floor = raw.map(Math.floor);
  let rest = T - floor.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) floor[order[k].i] += 1;
  return floor.map((v) => v / 1e4);
}

export async function createBill(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.utilities.manage', b.branchId);
  const driver = b.driver ?? (b.kind === 'electricity' ? 'energy_kwh' : 'run_hours');
  try {
    const r = (await pool.query(
      `INSERT INTO utility_bills(company_id, branch_id, kind, period_from, period_to, quantity, unit, total_cost, driver, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.companyId, b.branchId, b.kind, b.periodFrom, b.periodTo, b.quantity ?? null, b.unit ?? null, b.totalCost, driver, b.notes ?? null, ctx.userId])).rows[0];
    await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'utility_bill', entityId: r.id, afterJson: { kind: b.kind, totalCost: b.totalCost } });
    return r;
  } catch (e) { if ((e as { code?: string }).code === '23503') throw new ValidationError('الفرع غير موجود'); throw e; }
}
export async function listBills(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.utilities.view');
  return (await pool.query(
    `SELECT * FROM utility_bills WHERE company_id=$1 AND ($2::date IS NULL OR period_to>=$2) AND ($3::date IS NULL OR period_from<=$3)
       AND ($4::uuid[] IS NULL OR branch_id = ANY($4)) ORDER BY period_to DESC LIMIT 300`, [ctx.companyId, q.from ?? null, q.to ?? null, ctx.visibleBranchIds()])).rows;
}
export async function deleteBill(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx);
  const b = (await pool.query(`SELECT branch_id FROM utility_bills WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!b) throw new NotFoundError('الفاتورة غير موجودة');
  ctx.assertPermission('textile.utilities.manage', b.branch_id);
  await pool.query(`DELETE FROM utility_bills WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  return { id, deleted: true };
}

/** لكل فاتورة: يوزَّع إجماليها على المراحل حسب المحرّك داخل فترتها؛ ثم تُجمَّع لكل مرحلة مع تكلفة الوحدة. */
export async function allocationReport(ctx: RequestContext, q: { from?: string; to?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.utilities.view');
  const bills = await listBills(ctx, q);
  const byStage = new Map<string, { stageId: string | null; stageName: string; byKind: Record<string, number>; total: number; output: number }>();
  const warnings: string[] = [];
  for (const bill of bills) {
    const from = String(bill.period_from.toISOString?.().slice(0, 10) ?? bill.period_from).slice(0, 10);
    const to = String(bill.period_to.toISOString?.().slice(0, 10) ?? bill.period_to).slice(0, 10);
    const rows = (await pool.query(
      `SELECT m.stage_id, COALESCE(s.name_ar,'بدون مرحلة') AS stage_name,
              COALESCE(SUM(l.energy_kwh),0) AS kwh, COALESCE(SUM(l.run_hours),0) AS hours, COALESCE(SUM(l.output_quantity),0) AS output
       FROM machine_production_logs l JOIN machines m ON m.id=l.machine_id AND m.company_id=l.company_id
       LEFT JOIN textile_stages s ON s.id=m.stage_id AND s.company_id=m.company_id
       WHERE l.company_id=$1 AND l.branch_id=$2 AND l.log_date BETWEEN $3 AND $4 GROUP BY m.stage_id, s.name_ar`,
      [ctx.companyId, bill.branch_id, from, to])).rows;
    let driver: string = bill.driver;
    let w = rows.map((r) => Number(driver === 'energy_kwh' ? r.kwh : driver === 'output' ? r.output : r.hours));
    if (!(w.reduce((s, x) => s + x, 0) > 0) && driver === 'energy_kwh') { driver = 'run_hours'; w = rows.map((r) => Number(r.hours)); warnings.push(`فاتورة ${bill.kind} (${from}→${to}): لا kWh مسجَّلة فاستُخدمت ساعات التشغيل`); }
    const parts = allocate(Number(bill.total_cost), w);
    if (!parts) { warnings.push(`فاتورة ${bill.kind} (${from}→${to}): لا سجلات إنتاج في الفترة — لم تُوزَّع`); continue; }
    rows.forEach((r, i) => {
      const key = r.stage_id ?? 'none';
      const e = byStage.get(key) ?? { stageId: r.stage_id, stageName: r.stage_name, byKind: {}, total: 0, output: 0 };
      e.byKind[bill.kind] = +(((e.byKind[bill.kind] ?? 0) + parts[i]).toFixed(4));
      e.total = +(e.total + parts[i]).toFixed(4);
      byStage.set(key, e);
    });
  }
  // كمية الإنتاج للمراحل عن الفترة المطلوبة (مقام تكلفة الوحدة)
  const outs = (await pool.query(
    `SELECT m.stage_id, COALESCE(SUM(l.output_quantity),0) AS output FROM machine_production_logs l JOIN machines m ON m.id=l.machine_id AND m.company_id=l.company_id
     WHERE l.company_id=$1 AND ($2::date IS NULL OR l.log_date>=$2) AND ($3::date IS NULL OR l.log_date<=$3) GROUP BY m.stage_id`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  for (const o of outs) { const e = byStage.get(o.stage_id ?? 'none'); if (e) e.output = Number(o.output); }
  const stages = [...byStage.values()].map((e) => ({ ...e, costPerUnit: e.output > 0 ? +(e.total / e.output).toFixed(4) : null })).sort((a, b) => b.total - a.total);
  return { billsCount: bills.length, grandTotal: +stages.reduce((s, x) => s + x.total, 0).toFixed(4), stages, warnings };
}
