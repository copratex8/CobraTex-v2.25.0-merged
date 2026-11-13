import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { costCard } from '@/modules/manufacturing/textileCostCard';
import { z } from 'zod';
import { uuid } from '@/shared/zodSchemas';

/**
 * ربحية العميل والصنف (تحليلية، بلا ترحيل): الإيراد من فواتير مرحَّلة (قبل الضريبة وبعد الخصم)،
 * وتكلفة دفترية من cost_of_goods المسجَّل عند الترحيل، وتكلفة تحليلية للمصنع من أذون التسليم المربوطة بالفاتورة × تكلفة كجم أمر المصدر،
 * وخصم المطالبات المسوّاة كتسرّب. تغطية التسعير التحليلي تُعلَن (ما لم يُسعَّر لا يُخمَّن).
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const profitQuerySchema = z.object({ from: date.optional(), to: date.optional(), customerId: uuid.optional() });
const r2 = (n: number) => Math.round(n * 100) / 100;
export const pct = (margin: number, revenue: number) => (revenue > 0 ? Math.round((margin / revenue) * 10000) / 100 : null);

export async function profitability(ctx: RequestContext, q: { from?: string; to?: string; customerId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.log.view');
  const args = [ctx.companyId, q.from ?? null, q.to ?? null, q.customerId ?? null];
  const lines = (await pool.query(
    `SELECT i.id AS invoice_id, i.customer_id, c.name_ar AS customer_name, l.item_id, it.name_ar AS item_name, l.quantity, l.subtotal * i.exchange_rate AS subtotal, l.cost_of_goods
     FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.sales_invoice_id AND i.company_id=l.company_id JOIN customers c ON c.id=i.customer_id AND c.company_id=i.company_id JOIN items it ON it.id=l.item_id AND it.company_id=l.company_id
     WHERE i.company_id=$1 AND i.status='posted' AND ($2::date IS NULL OR i.invoice_date>=$2) AND ($3::date IS NULL OR i.invoice_date<=$3) AND ($4::uuid IS NULL OR i.customer_id=$4)`, args)).rows;
  const warnings: string[] = [];
  const cust = new Map<string, any>(); const item = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  let missingCogs = 0;
  for (const l of lines) {
    const rev = Number(l.subtotal), cogs = l.cost_of_goods === null ? null : Number(l.cost_of_goods); if (cogs === null) missingCogs++;
    const c = cust.get(l.customer_id) ?? { customerId: l.customer_id, customerName: l.customer_name, revenue: 0, bookCogs: 0, invoices: new Set<string>(), analyticalCost: 0, analyticalKg: 0, pricedKg: 0, unpricedKg: 0, claimsSettled: 0 };
    c.revenue += rev; c.bookCogs += cogs ?? 0; c.invoices.add(l.invoice_id); cust.set(l.customer_id, c);
    const t = item.get(l.item_id) ?? { itemId: l.item_id, itemName: l.item_name, revenue: 0, quantity: 0, bookCogs: 0 };
    t.revenue += rev; t.quantity += Number(l.quantity); t.bookCogs += cogs ?? 0; item.set(l.item_id, t);
  }
  if (missingCogs) warnings.push(`${missingCogs} سطر فاتورة بلا تكلفة بضاعة مسجَّلة: عُدَّت صفرًا (الهامش الدفتري مبالغ فيه لها).`);
  // تكلفة تحليلية للمصنع من أذون التسليم المربوطة بالفواتير
  const invIds = [...new Set(lines.map((l) => l.invoice_id))];
  const orderCostKg = new Map<string, number | null>();
  const costKgOf = async (orderId: string) => { if (!orderCostKg.has(orderId)) { try { orderCostKg.set(orderId, (await costCard(ctx, orderId)).costPerKg); } catch { orderCostKg.set(orderId, null); } } return orderCostKg.get(orderId) ?? null; };
  if (invIds.length) {
    const dn = (await pool.query(
      `SELECT n.sales_invoice_id AS invoice_id, n.customer_id, p.production_order_id AS p_order, p.net_kg, r.production_order_id AS r_order, r.weight_kg
       FROM delivery_notes n JOIN delivery_note_lines dl ON dl.delivery_note_id=n.id LEFT JOIN packing_units p ON p.id=dl.packing_unit_id LEFT JOIN fabric_rolls r ON r.id=dl.fabric_roll_id
       WHERE n.company_id=$1 AND n.status='issued' AND n.sales_invoice_id = ANY($2::uuid[])`, [ctx.companyId, invIds])).rows;
    for (const d of dn) {
      const c = cust.get(d.customer_id); if (!c) continue;
      const kg = Number(d.net_kg ?? d.weight_kg ?? 0), order = d.p_order ?? d.r_order;
      c.analyticalKg += kg;
      const ck = order ? await costKgOf(order) : null;
      if (ck === null) c.unpricedKg += kg; else { c.analyticalCost += kg * ck; c.pricedKg += kg; }
    }
  }
  const claims = (await pool.query(`SELECT customer_id, COALESCE(SUM(settled_value),0) AS v FROM quality_claims WHERE company_id=$1 AND status='settled' AND ($2::date IS NULL OR claim_date>=$2) AND ($3::date IS NULL OR claim_date<=$3) GROUP BY customer_id`, [ctx.companyId, q.from ?? null, q.to ?? null])).rows;
  for (const k of claims) { const c = cust.get(k.customer_id); if (c) c.claimsSettled = Number(k.v); }
  const customers = [...cust.values()].map((c) => {
    const bookMargin = c.revenue - c.bookCogs; const hasAn = c.pricedKg > 0;
    const anMargin = hasAn ? c.revenue - c.analyticalCost : null;
    return { customerId: c.customerId, customerName: c.customerName, invoices: c.invoices.size, revenue: r2(c.revenue), bookCogs: r2(c.bookCogs), bookMargin: r2(bookMargin), bookMarginPercent: pct(bookMargin, c.revenue),
      analyticalCost: hasAn ? r2(c.analyticalCost) : null, analyticalMargin: anMargin === null ? null : r2(anMargin), analyticalCoveragePercent: c.analyticalKg > 0 ? Math.round((c.pricedKg / c.analyticalKg) * 1000) / 10 : null,
      claimsSettled: r2(c.claimsSettled), netMarginAfterClaims: r2(bookMargin - c.claimsSettled), netMarginPercent: pct(bookMargin - c.claimsSettled, c.revenue) };
  }).sort((a, b) => b.netMarginAfterClaims - a.netMarginAfterClaims);
  const items = [...item.values()].map((t) => ({ ...t, revenue: r2(t.revenue), quantity: Math.round(t.quantity * 1000) / 1000, bookCogs: r2(t.bookCogs), margin: r2(t.revenue - t.bookCogs), marginPercent: pct(t.revenue - t.bookCogs, t.revenue), avgPrice: t.quantity > 0 ? r2(t.revenue / t.quantity) : null })).sort((a, b) => b.margin - a.margin);
  if (customers.some((c) => c.analyticalCoveragePercent !== null && c.analyticalCoveragePercent < 100)) warnings.push('بعض ما سُلِّم بلا تسعير تحليلي (أمر مصدر غير مرحَّل/بلا إنتاج) — التغطية معلنة لكل عميل.');
  const revenue = r2(customers.reduce((s, c) => s + c.revenue, 0)), margin = r2(customers.reduce((s, c) => s + c.bookMargin, 0));
  return { totals: { revenue, bookMargin: margin, bookMarginPercent: pct(margin, revenue), claimsSettled: r2(customers.reduce((s, c) => s + c.claimsSettled, 0)) }, customers, items, warnings };
}
