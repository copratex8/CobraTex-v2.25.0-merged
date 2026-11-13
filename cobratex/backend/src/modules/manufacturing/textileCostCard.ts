import { pool } from '@/db/pool';
import { findRate } from '@/modules/accounting/fxRatesService';
import { RequestContext } from '@/shared/requestContext';
import { NotFoundError } from '@/shared/errors';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { conversionForOrder } from '@/modules/manufacturing/textileMillService';
import { z } from 'zod';
import { uuid } from '@/shared/zodSchemas';

/**
 * بطاقة تكلفة أمر التصنيع (تحليلية): مواد + تحويل + مرافق فعلية + حوافز − استرداد، مع الخسارة غير العادية منفصلة،
 * وتكلفة الكجم والمتر والانحراف عن الخطة. لا ترحيل ولا تعديل لمحاسبة التصنيع الأصلية.
 */
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const costQuerySchema = z.object({ includeUtilities: z.enum(['true', 'false']).optional() });
export const costListSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), machineId: uuid.optional() });

export interface CardInput {
  materialsActual: number | null; materialsPlanned: number; opsCost: number; std: { labor: number; overhead: number; energy: number };
  utilities: Record<string, number>; incentives: number; recovered: number; abnormalLoss: number; outputKg: number | null; plannedKg: number; meters: number; includeUtilities: boolean;
}
/** دالة نقية: تجمّع البنود وتمنع ازدواج التحويل (فعلي في الأمر مقابل معياري) والكهرباء (فاتورة فعلية مقابل معدّل kWh). */
export function assembleCostCard(i: CardInput) {
  const warnings: string[] = [];
  const materials = i.materialsActual ?? i.materialsPlanned;
  const materialsBasis = i.materialsActual === null ? 'estimate' : 'actual';
  if (materialsBasis === 'estimate') warnings.push('الأمر غير مرحَّل: المواد تقدير بمتوسط التكلفة الحالي للكميات المخطَّطة.');
  const hasElec = (i.includeUtilities ? i.utilities.electricity ?? 0 : 0) > 0;
  let conversion: number, conversionBasis: 'books' | 'standard' | 'none';
  if (i.opsCost > 0) { conversion = i.opsCost; conversionBasis = 'books'; if (i.includeUtilities && Object.values(i.utilities).some((v) => v > 0)) warnings.push('التحويل مسجَّل في بنود الأمر وقد يشمل كهرباء/مرافق؛ راجع احتمال تكرارها مع فواتير المرافق (يمكن استبعادها includeUtilities=false).'); }
  else { conversion = i.std.labor + i.std.overhead + (hasElec ? 0 : i.std.energy); conversionBasis = conversion > 0 ? 'standard' : 'none'; if (conversionBasis === 'standard') warnings.push('التحويل بمعدّلات معيارية لعدم وجود بنود تحويل على الأمر.'); }
  const utilities = i.includeUtilities ? Object.entries(i.utilities).filter(([, v]) => v > 0).map(([kind, amount]) => ({ kind, amount: r4(amount) })) : [];
  const utilitiesTotal = utilities.reduce((s, u) => s + u.amount, 0);
  const gross = materials + conversion + utilitiesTotal + i.incentives;
  const net = gross - i.recovered - i.abnormalLoss;
  if (net <= 0) warnings.push('صافي التكلفة صفر أو سالب — راجع قيم الاسترداد والبيانات.');
  const per = (d: number | null) => (d && d > 0 && net > 0 ? r4(net / d) : null);
  if (!i.outputKg) warnings.push('لا إنتاج فعلي مرحَّل: تكلفة الكجم غير متاحة بعد.');
  return {
    lines: { materials: r4(materials), materialsBasis, conversion: r4(conversion), conversionBasis, utilities, incentives: r4(i.incentives) },
    gross: r4(gross), recovered: r4(i.recovered), abnormalLoss: r4(i.abnormalLoss), netProductCost: r4(net),
    costPerKg: per(i.outputKg), costPerMeter: per(i.meters),
    materialVariance: i.materialsActual === null ? null : r4(i.materialsActual - i.materialsPlanned), yieldPercent: i.outputKg && i.plannedKg > 0 ? r4((i.outputKg / i.plannedKg) * 100) : null, warnings,
  };
}

export async function costCard(ctx: RequestContext, orderId: string, q: { includeUtilities?: string } = {}) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.log.view');
  const o = (await pool.query(`SELECT id, document_number, status, warehouse_id, planned_output_quantity, actual_output_quantity, recovered_value_total, abnormal_loss_total, sales_order_line_id, output_item_id FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0];
  if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
  const lines = (await pool.query(`SELECT l.component_item_id, l.planned_quantity, l.consumed_quantity, l.line_cost FROM production_order_lines l WHERE l.production_order_id=$1 AND l.company_id=$2`, [orderId, ctx.companyId])).rows;
  const wac = (await pool.query(`SELECT item_id, SUM(quantity_on_hand) AS qty, SUM(quantity_on_hand*weighted_average_cost) AS val FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id = ANY($3::uuid[]) GROUP BY item_id`, [ctx.companyId, o.warehouse_id, lines.map((l) => l.component_item_id)])).rows;
  const unit = (id: string) => { const w = wac.find((x) => x.item_id === id); return w && Number(w.qty) > 0 ? Number(w.val) / Number(w.qty) : 0; };
  const posted = o.status === 'posted';
  const materialsPlanned = lines.reduce((s, l) => s + Number(l.planned_quantity) * unit(l.component_item_id), 0);
  const materialsActual = posted ? lines.reduce((s, l) => s + Number(l.line_cost ?? 0), 0) : null;
  const opsCost = Number((await pool.query(`SELECT COALESCE(SUM(COALESCE(actual_cost, planned_cost)),0) AS c FROM production_order_operations WHERE production_order_id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0].c);
  const conv = await conversionForOrder(ctx, orderId);
  const logs = (await pool.query(`SELECT l.log_date::text AS d, l.branch_id, l.run_hours, l.energy_kwh, l.output_quantity FROM machine_production_logs l WHERE l.company_id=$1 AND l.production_order_id=$2`, [ctx.companyId, orderId])).rows;
  const extraWarnings: string[] = []; const utilities: Record<string, number> = {};
  if (logs.length) {
    const bills = (await pool.query(`SELECT * FROM utility_bills WHERE company_id=$1 AND period_from <= $3::date AND period_to >= $2::date`, [ctx.companyId, logs.map((l) => l.d).sort()[0], logs.map((l) => l.d).sort().at(-1)])).rows;
    for (const b of bills) {
      const f = String(b.period_from).slice(0, 10), t = String(b.period_to).slice(0, 10);
      const tot = (await pool.query(`SELECT COALESCE(SUM(energy_kwh),0) AS kwh, COALESCE(SUM(run_hours),0) AS hrs, COALESCE(SUM(output_quantity),0) AS outq FROM machine_production_logs WHERE company_id=$1 AND branch_id=$2 AND log_date BETWEEN $3 AND $4`, [ctx.companyId, b.branch_id, f, t])).rows[0];
      const mine = logs.filter((l) => l.branch_id === b.branch_id && l.d >= f && l.d <= t);
      const sum = (k: string) => mine.reduce((s, l) => s + Number(l[k] ?? 0), 0);
      let drv = b.driver, den = drv === 'energy_kwh' ? Number(tot.kwh) : drv === 'run_hours' ? Number(tot.hrs) : Number(tot.outq), num = drv === 'energy_kwh' ? sum('energy_kwh') : drv === 'run_hours' ? sum('run_hours') : sum('output_quantity');
      if (!(den > 0) && drv === 'energy_kwh') { drv = 'run_hours'; den = Number(tot.hrs); num = sum('run_hours'); extraWarnings.push('فاتورة كهرباء بلا kWh مسجَّلة: وُزِّعت بساعات التشغيل.'); }
      if (!(den > 0)) { extraWarnings.push(`فاتورة ${b.kind} (${f}→${t}) بلا محرّك توزيع: لم تُحمَّل.`); continue; }
      utilities[b.kind] = (utilities[b.kind] ?? 0) + Number(b.total_cost) * (num / den);
    }
  }
  const inc = (await pool.query(
    `WITH l AS (SELECT o2.quantity, o2.defective_quantity, GREATEST(o2.quantity-o2.defective_quantity,0) AS net, r.rate_per_unit, r.bonus_threshold, r.bonus_rate_per_unit
       FROM worker_output_logs o2 LEFT JOIN LATERAL (SELECT * FROM incentive_rates r WHERE r.company_id=o2.company_id AND r.is_active AND r.unit=o2.unit AND (r.stage_id IS NULL OR r.stage_id=o2.stage_id) AND r.effective_from<=o2.log_date ORDER BY (r.stage_id IS NOT NULL) DESC, r.effective_from DESC LIMIT 1) r ON true
       WHERE o2.company_id=$1 AND o2.production_order_id=$2)
     SELECT COALESCE(SUM(CASE WHEN rate_per_unit IS NULL THEN 0 WHEN bonus_threshold IS NULL THEN net*rate_per_unit ELSE LEAST(net,bonus_threshold)*rate_per_unit + GREATEST(net-bonus_threshold,0)*COALESCE(bonus_rate_per_unit,rate_per_unit) END),0) AS incentive, COUNT(*) FILTER (WHERE rate_per_unit IS NULL)::int AS unrated FROM l`, [ctx.companyId, orderId])).rows[0];
  const rolls = (await pool.query(`SELECT COALESCE(SUM(length_m),0) AS m, COUNT(*)::int AS n FROM fabric_rolls WHERE company_id=$1 AND production_order_id=$2`, [ctx.companyId, orderId])).rows[0];
  const std = { labor: Number(conv.labor ?? 0), overhead: Number(conv.overhead ?? 0), energy: Number(conv.energy ?? 0) };
  const card = assembleCostCard({
    materialsActual, materialsPlanned, opsCost, std, utilities, incentives: Number(inc.incentive), recovered: posted ? Number(o.recovered_value_total ?? 0) : 0, abnormalLoss: posted ? Number(o.abnormal_loss_total ?? 0) : 0,
    outputKg: o.actual_output_quantity ? Number(o.actual_output_quantity) : null, plannedKg: Number(o.planned_output_quantity), meters: Number(rolls.m), includeUtilities: q.includeUtilities !== 'false',
  });
  if (inc.unrated > 0) extraWarnings.push(`${inc.unrated} سجل إنتاج عمال بلا معدّل حافز.`);
  if ((conv.missingRates ?? []).length && card.lines.conversionBasis === 'standard') extraWarnings.push('معدّلات ناقصة: ' + conv.missingRates.join('، '));
  if (!logs.length) extraWarnings.push('لا سجلات ورديات مربوطة بالأمر: لا مرافق ولا تحويل معياري.');
  let sales: { unitPrice: number; marginPerKg: number | null } | null = null;
  if (o.sales_order_line_id) {
    const p = (await pool.query(`SELECT l.unit_price, so.currency_code, so.order_date FROM sales_order_lines l JOIN sales_orders so ON so.id=l.sales_order_id AND so.company_id=l.company_id WHERE l.id=$1 AND l.company_id=$2`, [o.sales_order_line_id, ctx.companyId])).rows[0];
    if (p) { // أمر البيع بلا سعر صرف مخزَّن: نحوّل بسعر البيع المسجَّل بتاريخ الأمر (عملة الأساس ← 1)
      const fx = await findRate(pool, ctx.companyId, p.currency_code, String(p.order_date).slice(0, 10), 'sell');
      if (fx) { const up = Number(p.unit_price) * fx.rate; sales = { unitPrice: up, marginPerKg: card.costPerKg === null ? null : r4(up - card.costPerKg) }; }
    }
  }
  return { orderId, orderNo: o.document_number, status: o.status, rolls: { count: rolls.n, meters: r4(Number(rolls.m)) }, ...card, warnings: [...card.warnings, ...extraWarnings], linkedSale: sales };
}

/** ترتيب أوامر الفترة بتكلفة الكجم (للمرحَّلة فقط) لإظهار الأغلى/الأرخص. */
export async function costRanking(ctx: RequestContext, q: { from?: string; to?: string; machineId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.log.view');
  const ids = (await pool.query(`SELECT id FROM production_orders WHERE company_id=$1 AND status='posted' AND ($2::date IS NULL OR order_date>=$2) AND ($3::date IS NULL OR order_date<=$3) AND ($4::uuid IS NULL OR machine_id=$4) ORDER BY order_date DESC LIMIT 100`, [ctx.companyId, q.from ?? null, q.to ?? null, q.machineId ?? null])).rows;
  const out = [];
  for (const r of ids) { const c = await costCard(ctx, r.id); out.push({ orderId: c.orderId, orderNo: c.orderNo, costPerKg: c.costPerKg, costPerMeter: c.costPerMeter, netProductCost: c.netProductCost, yieldPercent: c.yieldPercent, abnormalLoss: c.abnormalLoss, warnings: c.warnings.length }); }
  const priced = out.filter((x) => x.costPerKg !== null).sort((a, b) => (a.costPerKg as number) - (b.costPerKg as number));
  return { count: out.length, cheapest: priced[0] ?? null, dearest: priced.at(-1) ?? null, orders: priced.concat(out.filter((x) => x.costPerKg === null)) };
}
