import { Router } from 'express';
import { z } from 'zod';
import { validate } from '@/middleware/validate';
import { pool } from '@/db/pool';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { ValidationError } from '@/shared/errors';
import { simulateLine } from '@/modules/manufacturing/textileSimulator';

export const textileSimulatorRouter = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown) => async (req: any, res: any, next: any) => { try { res.json(await fn(req)); } catch (e) { next(e); } };

const stage = z.strictObject({ name: z.string().min(1).max(60), ratePerHour: z.number().positive(), units: z.number().int().min(1).max(100000), efficiencyPercent: z.number().gt(0).max(100), hoursPerDay: z.number().gt(0).max(24), unitsPerFinal: z.number().positive(), setupHoursPerDay: z.number().min(0).max(24).optional(), breakdownPercent: z.number().min(0).lt(100).optional() });
const body = z.strictObject({ stages: z.array(stage).min(1).max(30), targetPerDay: z.number().positive().optional(), demandQty: z.number().positive().optional() });

/** قيم افتراضية من الماكينات: مجموع الطاقة المقدَّرة لكل مرحلة والكفاءة الفعلية من سجلات آخر 30 يومًا (إن وُجدت). */
/** قيم افتراضية من الماكينات: مجموع الطاقة المقدَّرة لكل مرحلة والتشغيل الفعلي لآخر 30 يومًا (إن وُجد). */
export async function simulatorDefaults(ctx: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.report.view');
  const rows = (await pool.query(
    `SELECT COALESCE(s.name_ar,'بدون مرحلة') AS name, COALESCE(s.sort_order, 999) AS ord, SUM(m.units_count)::int AS units, MAX(m.rated_output_per_hour) AS rate,
            (SELECT COALESCE(SUM(l.output_quantity),0) FROM machine_production_logs l JOIN machines mm ON mm.id=l.machine_id WHERE mm.stage_id=m.stage_id AND mm.company_id=$1 AND l.log_date>=current_date-30) AS out30,
            (SELECT COALESCE(SUM(l.run_hours),0) FROM machine_production_logs l JOIN machines mm ON mm.id=l.machine_id WHERE mm.stage_id=m.stage_id AND mm.company_id=$1 AND l.log_date>=current_date-30) AS hrs30
     FROM machines m LEFT JOIN textile_stages s ON s.id=m.stage_id AND s.company_id=m.company_id
     WHERE m.company_id=$1 AND m.is_active AND m.rated_output_per_hour>0 GROUP BY m.stage_id, s.name_ar, s.sort_order ORDER BY ord`, [ctx.companyId])).rows;
  return rows.map((x) => ({ name: x.name, ratePerHour: Number(x.rate), units: x.units, efficiencyPercent: 85, hoursPerDay: 22, unitsPerFinal: 1, observedOutput30d: Number(x.out30), observedRunHours30d: Number(x.hrs30) }));
}
textileSimulatorRouter.get('/textile/simulator/defaults', h((r) => simulatorDefaults(r.ctx)));
textileSimulatorRouter.post('/textile/simulator/run', validate({ body }), h(async (r) => {
  await assertManufacturingEnabled(r.ctx); r.ctx.assertPermission('textile.report.view');
  try { return simulateLine(r.body.stages, r.body.targetPerDay, r.body.demandQty); } catch (e) { throw new ValidationError((e as Error).message); }
}));
