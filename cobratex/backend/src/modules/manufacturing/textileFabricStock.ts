import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { z } from 'zod';
import { uuid } from '@/shared/zodSchemas';

/** تحويل الأقمشة بين الكجم/المتر/الياردة بالـGSM والعرض، ومخزون الرولات حسب الدرجة والعمر. دوال التحويل نقية. */
const M_PER_YD = 0.9144;
export interface ConvInput { gsm: number; widthCm: number; kg?: number; meters?: number; yards?: number; pricePerKg?: number; pricePerMeter?: number }
/** كجم/متر = GSM × العرض(م) ÷ 1000. يُعطى واحد من (كجم/متر/ياردة) والباقي يُشتق. السعر يُحوَّل بين الكجم والمتر. */
export function convertFabric(i: ConvInput) {
  if (!(i.gsm > 0) || !(i.widthCm > 0)) throw new ValidationError('GSM والعرض مطلوبان وموجبان');
  const given = [i.kg, i.meters, i.yards].filter((v) => v !== undefined);
  if (given.length !== 1) throw new ValidationError('أعطِ كمية واحدة فقط: kg أو meters أو yards');
  const kgPerM = (i.gsm * (i.widthCm / 100)) / 1000;
  const meters = i.meters ?? (i.yards !== undefined ? i.yards * M_PER_YD : (i.kg as number) / kgPerM);
  const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  const out: Record<string, number | null> = { kgPerMeter: r(kgPerM, 6), metersPerKg: r(1 / kgPerM, 4), kg: r(meters * kgPerM, 4), meters: r(meters, 4), yards: r(meters / M_PER_YD, 4), sqMeters: r(meters * (i.widthCm / 100), 4), linearYardPerKg: r(1 / kgPerM / M_PER_YD, 4) };
  out.pricePerKg = i.pricePerKg ?? (i.pricePerMeter !== undefined ? r(i.pricePerMeter / kgPerM, 4) : null);
  out.pricePerMeter = i.pricePerMeter ?? (i.pricePerKg !== undefined ? r(i.pricePerKg * kgPerM, 4) : null);
  out.pricePerYard = out.pricePerMeter === null ? null : r((out.pricePerMeter as number) * M_PER_YD, 4);
  out.totalValue = out.pricePerKg === null ? null : r((out.pricePerKg as number) * (out.kg as number), 2);
  return out;
}
export const convSchema = z.object({
  itemId: uuid.optional(), gsm: z.coerce.number().positive().optional(), widthCm: z.coerce.number().positive().optional(),
  kg: z.coerce.number().positive().optional(), meters: z.coerce.number().positive().optional(), yards: z.coerce.number().positive().optional(),
  pricePerKg: z.coerce.number().min(0).optional(), pricePerMeter: z.coerce.number().min(0).optional(),
}).refine((q) => [q.kg, q.meters, q.yards].filter((v) => v !== undefined).length === 1, { message: 'كمية واحدة فقط: kg أو meters أو yards' })
  .refine((q) => q.pricePerKg === undefined || q.pricePerMeter === undefined, { message: 'سعر واحد فقط' });
export async function convert(ctx: RequestContext, q: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  let gsm = q.gsm, widthCm = q.widthCm, source = 'manual';
  if (q.itemId && (!gsm || !widthCm)) {
    const s = (await pool.query(`SELECT fabric_gsm AS gsm, fabric_width_cm AS width_cm FROM item_textile_specs WHERE item_id=$1 AND company_id=$2`, [q.itemId, ctx.companyId])).rows[0];
    if (!s) throw new NotFoundError('لا مواصفات لهذا الصنف'); gsm = gsm ?? (s.gsm ? Number(s.gsm) : undefined); widthCm = widthCm ?? (s.width_cm ? Number(s.width_cm) : undefined); source = 'item_specs';
    if (!gsm || !widthCm) throw new ValidationError('مواصفات الصنف ناقصة (GSM أو العرض) — أكملها أو مرّرها يدويًا');
  }
  return { source, gsm, widthCm, ...convertFabric({ gsm, widthCm, kg: q.kg, meters: q.meters, yards: q.yards, pricePerKg: q.pricePerKg, pricePerMeter: q.pricePerMeter }) };
}

export const AGE_BUCKETS = [{ key: '0-30', max: 30 }, { key: '31-90', max: 90 }, { key: '91-180', max: 180 }, { key: '180+', max: Infinity }] as const;
export const bucketOf = (days: number) => AGE_BUCKETS.find((b) => days <= b.max)!.key;
export const stockQuerySchema = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), itemId: uuid.optional() });
/** رولات بالمخزن (غير مسلَّمة بإذن ساري): لكل صنف ودرجة — العدد/الأمتار/الكجم، وتوزيع العمر. */
export async function rollStock(ctx: RequestContext, q: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.master.view');
  const asOf = q.asOf ?? new Date().toISOString().slice(0, 10);
  const rows = (await pool.query(
    `SELECT r.id, r.roll_no, r.item_id, COALESCE(i.name_ar,'(بلا صنف)') AS item_name, r.grade, r.length_m, r.weight_kg, r.inspected_at::date AS d
     FROM fabric_rolls r LEFT JOIN items i ON i.id=r.item_id AND i.company_id=r.company_id
     WHERE r.company_id=$1 AND r.inspected_at::date <= $2::date AND ($3::uuid IS NULL OR r.item_id=$3)
       AND NOT EXISTS (SELECT 1 FROM delivery_note_lines dl JOIN delivery_notes n ON n.id=dl.delivery_note_id AND n.status='issued' WHERE dl.fabric_roll_id=r.id AND n.note_date <= $2::date)`, [ctx.companyId, asOf, q.itemId ?? null])).rows;
  const g = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of rows) {
    const key = `${r.item_id ?? 'none'}|${r.grade}`; const days = Math.max(0, Math.round((new Date(asOf).getTime() - new Date(r.d).getTime()) / 86400000));
    const e = g.get(key) ?? { itemId: r.item_id, itemName: r.item_name, grade: r.grade, rolls: 0, meters: 0, kg: 0, oldestDays: 0, ageing: { '0-30': 0, '31-90': 0, '91-180': 0, '180+': 0 } };
    e.rolls++; e.meters += Number(r.length_m); e.kg += Number(r.weight_kg ?? 0); e.oldestDays = Math.max(e.oldestDays, days); e.ageing[bucketOf(days)]++; g.set(key, e);
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const list = [...g.values()].map((e) => ({ ...e, meters: r3(e.meters), kg: r3(e.kg) })).sort((a, b) => a.itemName.localeCompare(b.itemName) || a.grade.localeCompare(b.grade));
  return { asOf, totalRolls: rows.length, totalMeters: r3(list.reduce((s, e) => s + e.meters, 0)), totalKg: r3(list.reduce((s, e) => s + e.kg, 0)), gradeCShare: rows.length ? Math.round((rows.filter((r) => r.grade === 'C').length / rows.length) * 1000) / 10 : 0, groups: list };
}
