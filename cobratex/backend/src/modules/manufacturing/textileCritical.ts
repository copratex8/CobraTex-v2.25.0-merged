import { z } from 'zod';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { orderAvailability } from '@/modules/manufacturing/textileBlendService';

/**
 * الأوامر الحرجة (2.6.0، تحليلي بلا ترحيل): ترتيب أوامر التصنيع المفتوحة بخطر التأخّر عن وعد العميل.
 * عوامل: تأخّر الوعد، فسحة (وعد − انتهاء مجدول)، عجز خيوط من وصفة الأمر، تعارض ماكينة، تأخّر البدء، غياب الجدولة.
 * ويقترح أقرب فترة خالية على الماكينة نفسها.
 */
export const criticalQuerySchema = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), horizonDays: z.coerce.number().int().min(1).max(180).optional(), level: z.enum(['critical', 'warning', 'ok']).optional(), checkMaterials: z.enum(['true', 'false']).optional() });

const day = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const addDays = (s: string, n: number) => new Date(day(s) + n * 86400000).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string) => Math.round((day(a) - day(b)) / 86400000);
const d10 = (v: unknown) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

/** أقرب بداية خالية لمدة days يومًا بدءًا من from، بين فترات مشغولة [start,end] شاملة الطرفين. */
export function findFreeSlot(busy: Array<{ start: string; end: string }>, from: string, days: number): { start: string; end: string } {
  let cur = from;
  for (const b of [...busy].sort((x, y) => x.start.localeCompare(y.start))) {
    if (b.end < cur) continue;
    if (addDays(cur, days - 1) < b.start) break;
    cur = addDays(b.end, 1);
  }
  return { start: cur, end: addDays(cur, days - 1) };
}

export type Level = 'critical' | 'warning' | 'ok';
export function assess(o: { due: string | null; plannedStart: string | null; plannedEnd: string | null; machineId: string | null; conflict: boolean; shortLines: number | null }, today: string, horizonDays: number) {
  let score = 0; const reasons: string[] = [], actions: string[] = [];
  const scheduled = !!(o.plannedStart && o.plannedEnd && o.machineId);
  const slack = o.due && o.plannedEnd ? diffDays(o.due, o.plannedEnd) : null;
  const dueIn = o.due ? diffDays(o.due, today) : null;
  if (dueIn !== null && dueIn < 0) { score += 100; reasons.push(`وعد التسليم فات منذ ${-dueIn} يوم`); actions.push('تواصل مع العميل وحدّد وعدًا جديدًا مسجَّلًا بالسبب'); }
  if (slack !== null && slack < 0) { score += 60 + Math.min(30, -slack); reasons.push(`الانتهاء المجدول بعد الوعد بـ ${-slack} يوم`); actions.push('قدّم الأمر أو انقله لماكينة أقل حملًا أو أعد التفاوض على الوعد'); }
  else if (slack !== null && slack <= 3) { score += 30; reasons.push(`فسحة ${slack} يوم فقط قبل الوعد`); }
  if (o.shortLines !== null && o.shortLines > 0) { score += 25; reasons.push(`عجز في ${o.shortLines} خيط من وصفة الأمر`); actions.push('اطلب الخيوط الناقصة أو بدّل وصفة معتمدة'); }
  if (o.conflict) { score += 15; reasons.push('تعارض في جدولة الماكينة'); actions.push('أعد جدولة أحد الأمرين (انظر الفترة المقترحة)'); }
  if (o.plannedStart && o.plannedStart < today) { score += 15; reasons.push(`كان مقررًا أن يبدأ في ${o.plannedStart} ولم يُرحَّل`); actions.push('ابدأ الأمر أو حدّث تواريخه'); }
  if (!scheduled && dueIn !== null && dueIn <= horizonDays) { score += 20; reasons.push(`بلا جدولة كاملة والوعد خلال ${dueIn} يوم`); actions.push('حدّد الماكينة والتواريخ'); }
  const level: Level = score >= 60 ? 'critical' : score >= 30 ? 'warning' : 'ok';
  return { score, level, reasons, actions: [...new Set(actions)], slackDays: slack, dueInDays: dueIn };
}

export async function criticalOrders(ctx: RequestContext, q: { asOf?: string; horizonDays?: number; level?: Level; checkMaterials?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.schedule.view');
  const today = q.asOf ?? new Date().toISOString().slice(0, 10), horizon = q.horizonDays ?? 14;
  const rows = (await pool.query(
    `SELECT o.id, o.document_number, o.machine_id, m.code AS machine_code, o.planned_start, o.planned_end, o.planned_output_quantity, o.blend_recipe_id,
            i.name_ar AS item_name, sol.promised_date, sol.requested_date, cu.name_ar AS customer_name, so.document_number AS sales_order_no
     FROM production_orders o
     LEFT JOIN machines m ON m.id=o.machine_id AND m.company_id=o.company_id
     LEFT JOIN items i ON i.id=o.output_item_id AND i.company_id=o.company_id
     LEFT JOIN sales_order_lines sol ON sol.id=o.sales_order_line_id AND sol.company_id=o.company_id
     LEFT JOIN sales_orders so ON so.id=sol.sales_order_id AND so.company_id=sol.company_id
     LEFT JOIN customers cu ON cu.id=so.customer_id AND cu.company_id=so.company_id
     WHERE o.company_id=$1 AND o.status='draft' AND ($2::uuid[] IS NULL OR o.branch_id = ANY($2))`, [ctx.companyId, ctx.visibleBranchIds()])).rows;
  const ords = rows.map((r) => ({ ...r, start: d10(r.planned_start), end: d10(r.planned_end), due: d10(r.promised_date) ?? d10(r.requested_date) }));
  const sched = ords.filter((o) => o.machine_id && o.start && o.end);
  const conflictOf = (o: (typeof ords)[number]) => !!(o.machine_id && o.start && o.end) && sched.some((b) => b.id !== o.id && b.machine_id === o.machine_id && b.start! <= o.end! && o.start! <= b.end!);
  const warnings: string[] = []; const out = [];
  for (const o of ords) {
    let shortLines: number | null = null; let shortages: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (q.checkMaterials !== 'false' && o.blend_recipe_id) {
      try { const av = await orderAvailability(ctx, o.id); shortages = av.lines.filter((l: any) => !l.ok); shortLines = shortages.length; } catch { warnings.push(`تعذّر فحص خامات ${o.document_number}`); } // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    const conflict = conflictOf(o);
    const a = assess({ due: o.due, plannedStart: o.start, plannedEnd: o.end, machineId: o.machine_id, conflict, shortLines }, today, horizon);
    let suggestedSlot: { start: string; end: string } | null = null;
    if (o.machine_id && o.start && o.end && (conflict || a.level !== 'ok')) {
      const days = diffDays(o.end, o.start) + 1;
      suggestedSlot = findFreeSlot(sched.filter((b) => b.machine_id === o.machine_id && b.id !== o.id).map((b) => ({ start: b.start!, end: b.end! })), today > o.start ? today : o.start, days);
      if (suggestedSlot.start === o.start && !conflict) suggestedSlot = null;
    }
    out.push({ orderId: o.id, orderNo: o.document_number, itemName: o.item_name, quantity: Number(o.planned_output_quantity), customerName: o.customer_name, salesOrderNo: o.sales_order_no, machineCode: o.machine_code,
      dueDate: o.due, plannedStart: o.start, plannedEnd: o.end, ...a, materialShortages: shortages, machineConflict: conflict, suggestedSlot });
  }
  out.sort((x, y) => y.score - x.score || (x.dueDate ?? '9').localeCompare(y.dueDate ?? '9'));
  const filtered = q.level ? out.filter((x) => x.level === q.level) : out;
  return { asOf: today, horizonDays: horizon, summary: { critical: out.filter((x) => x.level === 'critical').length, warning: out.filter((x) => x.level === 'warning').length, ok: out.filter((x) => x.level === 'ok').length }, orders: filtered, warnings };
}
