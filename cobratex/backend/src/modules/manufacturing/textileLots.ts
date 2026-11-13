import { z } from 'zod';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { NotFoundError, ValidationError } from '@/shared/errors';
import { findRate } from '@/modules/accounting/fxRatesService';

/** كارت اللوط وأرصدة اللوتات (2.8.0، تحليلي): تاريخ حركات الدفعة برصيد جارٍ وقيمة، وملخص رصيد وقيمة كل لوط. */
const uuid = z.uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const lotCardSchema = z.object({ itemId: uuid, batchNo: z.string().min(1).max(60), warehouseId: uuid.optional() });
export const lotsSchema = z.object({ itemId: uuid.optional(), warehouseId: uuid.optional(), includeZero: z.enum(['true', 'false']).optional() });
export const priceDevSchema = z.object({ from: date.optional(), to: date.optional(), customerId: uuid.optional(), minPercent: z.coerce.number().min(0).max(100).optional() });
const SIGN: Record<string, number> = { opening: 1, in: 1, transfer_in: 1, adjustment_in: 1, out: -1, transfer_out: -1, adjustment_out: -1, loss: -1, production_output: 1, production_consume: -1 };
export const MOVE_LABEL: Record<string, string> = { opening: 'رصيد افتتاحي', in: 'وارد', out: 'صادر', transfer_in: 'تحويل وارد', transfer_out: 'تحويل صادر', adjustment_in: 'تسوية زيادة', adjustment_out: 'تسوية عجز', loss: 'هالك', production_consume: 'صرف للتصنيع', production_output: 'إنتاج تصنيع' };
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const d10 = (v: unknown) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

/** رصيد جارٍ للحركات بترتيبها بتكلفة كل حركة كما سجّلتها خدمة المخزون (المتوسط المتحرك عند غيابها). */
export function runLedger(moves: Array<{ type: string; qty: number; unitCost: number | null }>) {
  let bal = 0, value = 0; const out = [];
  for (const m of moves) {
    const s = SIGN[m.type] ?? 0; const avg = bal > 0 ? value / bal : 0;
    const cost = m.unitCost ?? avg; // التكلفة المسجَّلة على الحركة هي المرجع؛ المتوسط عند غيابها فقط
    bal = r4(bal + s * m.qty); value = r4(value + s * m.qty * cost);
    if (bal <= 0) { value = bal === 0 ? 0 : value; }
    out.push({ balance: bal, value, avgCost: bal > 0 ? r4(value / bal) : 0, cost: r4(cost) });
  }
  return out;
}

export async function lotCard(ctx: RequestContext, q: { itemId: string; batchNo: string; warehouseId?: string }) {
  ctx.assertPermission('textile.log.view');
  const b = (await pool.query(`SELECT b.id, b.batch_no, b.production_date, b.expiry_date, it.code, it.name_ar, s.name_ar AS supplier FROM batches b JOIN items it ON it.id=b.item_id AND it.company_id=b.company_id LEFT JOIN suppliers s ON s.id=b.supplier_id AND s.company_id=b.company_id WHERE b.company_id=$1 AND b.item_id=$2 AND b.batch_no=$3`, [ctx.companyId, q.itemId, q.batchNo])).rows[0];
  if (!b) throw new NotFoundError('اللوط غير موجود لهذا الصنف');
  const mv = (await pool.query(
    `SELECT m.id, m.effective_date, m.movement_type, m.quantity, m.unit_cost, m.source_document_type, m.source_document_id, w.name_ar AS warehouse
     FROM stock_movements m JOIN warehouses w ON w.id=m.warehouse_id AND w.company_id=m.company_id
     WHERE m.company_id=$1 AND m.batch_id=$2 AND m.status='posted' AND ($3::uuid IS NULL OR m.warehouse_id=$3) ORDER BY m.effective_date, m.created_at, m.id`, [ctx.companyId, b.id, q.warehouseId ?? null])).rows;
  const led = runLedger(mv.map((m) => ({ type: m.movement_type, qty: Number(m.quantity), unitCost: m.unit_cost === null ? null : Number(m.unit_cost) })));
  const rows = mv.map((m, i) => ({ date: d10(m.effective_date), type: m.movement_type, label: MOVE_LABEL[m.movement_type] ?? m.movement_type, warehouse: m.warehouse, quantity: Number(m.quantity), sign: SIGN[m.movement_type] ?? 0, unitCost: led[i].cost, source: m.source_document_type, sourceId: m.source_document_id, ...led[i] }));
  const last = led.at(-1);
  const sum = (t: number) => r4(mv.filter((m) => (SIGN[m.movement_type] ?? 0) === t).reduce((s, m) => s + Number(m.quantity), 0));
  return { lot: { batchNo: b.batch_no, itemCode: b.code, itemName: b.name_ar, supplier: b.supplier, productionDate: d10(b.production_date), expiryDate: d10(b.expiry_date) }, movements: rows,
    totals: { received: sum(1), issued: sum(-1), balance: last?.balance ?? 0, value: last?.value ?? 0, avgCost: last?.avgCost ?? 0 } };
}

export async function lotsSummary(ctx: RequestContext, q: { itemId?: string; warehouseId?: string; includeZero?: string }) {
  ctx.assertPermission('textile.log.view');
  const rows = (await pool.query(
    `SELECT b.id AS batch_id, b.batch_no, b.item_id, it.code, it.name_ar, s.name_ar AS supplier, m.warehouse_id, w.name_ar AS warehouse, m.movement_type, m.quantity, m.unit_cost, m.effective_date, m.created_at
     FROM stock_movements m JOIN batches b ON b.id=m.batch_id AND b.company_id=m.company_id JOIN items it ON it.id=b.item_id AND it.company_id=b.company_id
     JOIN warehouses w ON w.id=m.warehouse_id AND w.company_id=m.company_id LEFT JOIN suppliers s ON s.id=b.supplier_id AND s.company_id=b.company_id
     WHERE m.company_id=$1 AND m.status='posted' AND ($2::uuid IS NULL OR b.item_id=$2) AND ($3::uuid IS NULL OR m.warehouse_id=$3) ORDER BY m.effective_date, m.created_at, m.id`, [ctx.companyId, q.itemId ?? null, q.warehouseId ?? null])).rows;
  const groups = new Map<string, any[]>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of rows) { const k = `${r.batch_id}|${r.warehouse_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  const lots = [...groups.values()].map((g) => { const led = runLedger(g.map((m) => ({ type: m.movement_type, qty: Number(m.quantity), unitCost: m.unit_cost === null ? null : Number(m.unit_cost) }))); const l = led.at(-1)!;
    return { batchNo: g[0].batch_no, itemId: g[0].item_id, itemCode: g[0].code, itemName: g[0].name_ar, supplier: g[0].supplier, warehouse: g[0].warehouse, balance: l.balance, avgCost: l.avgCost, value: l.value, lastMove: d10(g.at(-1).effective_date) }; })
    .filter((l) => q.includeZero === 'true' || l.balance > 0).sort((a, b) => b.value - a.value);
  return { lots, totals: { lots: lots.length, quantity: r4(lots.reduce((s, l) => s + l.balance, 0)), value: r4(lots.reduce((s, l) => s + l.value, 0)) } };
}

/**
 * انحراف أسعار البيع عن قائمة الأسعار: لكل سطر فاتورة مرحَّلة، سعر القائمة = قائمة العميل وإلا الافتراضية الفعّالة بتاريخ الفاتورة،
 * بأعلى حدّ كمية ≤ كمية السطر. يُقارَن بعملة الفاتورة (تُحوَّل قائمة بعملة أخرى عبر أسعار الصرف المسجَّلة).
 * الأثر = (السعر الفعلي − سعر القائمة) × الكمية بعملة الأساس بسعر الفاتورة (سالب = خصم/بيع بأقل من القائمة).
 */
export async function priceDeviation(ctx: RequestContext, q: { from?: string; to?: string; customerId?: string; minPercent?: number }) {
  ctx.assertPermission('textile.log.view');
  const lines = (await pool.query(
    `SELECT i.id AS invoice_id, i.document_number, i.invoice_date, i.currency_code, i.exchange_rate, i.customer_id, c.name_ar AS customer_name, c.price_list_id,
            l.item_id, it.name_ar AS item_name, l.quantity, l.unit_price
     FROM sales_invoice_lines l JOIN sales_invoices i ON i.id=l.sales_invoice_id AND i.company_id=l.company_id JOIN customers c ON c.id=i.customer_id AND c.company_id=i.company_id JOIN items it ON it.id=l.item_id AND it.company_id=l.company_id
     WHERE i.company_id=$1 AND i.status='posted' AND ($2::date IS NULL OR i.invoice_date>=$2) AND ($3::date IS NULL OR i.invoice_date<=$3) AND ($4::uuid IS NULL OR i.customer_id=$4) ORDER BY i.invoice_date, i.document_number LIMIT 5000`,
    [ctx.companyId, q.from ?? null, q.to ?? null, q.customerId ?? null])).rows;
  const lists = (await pool.query(`SELECT id, currency_code, is_default, effective_from, effective_to FROM price_lists WHERE company_id=$1 AND is_active`, [ctx.companyId])).rows;
  const plines = (await pool.query(`SELECT price_list_id, item_id, min_quantity, unit_price FROM price_list_lines WHERE company_id=$1`, [ctx.companyId])).rows;
  const warnings: string[] = []; const out: any[] = []; let noList = 0, noRate = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
  const minPct = q.minPercent ?? 0;
  for (const l of lines) {
    const dt = d10(l.invoice_date)!;
    const eff = (p: any) => d10(p.effective_from)! <= dt && (!p.effective_to || d10(p.effective_to)! >= dt); // eslint-disable-line @typescript-eslint/no-explicit-any
    const list = (l.price_list_id ? lists.find((p) => p.id === l.price_list_id && eff(p)) : undefined) ?? lists.find((p) => p.is_default && eff(p));
    if (!list) { noList++; continue; }
    const cand = plines.filter((p) => p.price_list_id === list.id && p.item_id === l.item_id && Number(p.min_quantity) <= Number(l.quantity)).sort((a, b) => Number(b.min_quantity) - Number(a.min_quantity))[0];
    if (!cand) { noList++; continue; }
    let listPrice = Number(cand.unit_price);
    if (list.currency_code !== l.currency_code) {
      const a = await findRate(pool, ctx.companyId, list.currency_code, dt, 'sell'), b = await findRate(pool, ctx.companyId, l.currency_code, dt, 'sell');
      if (!a || !b) { noRate++; continue; } listPrice = (listPrice * a.rate) / b.rate;
    }
    const sold = Number(l.unit_price), diff = sold - listPrice, pct = listPrice > 0 ? (diff / listPrice) * 100 : 0;
    if (Math.abs(pct) < minPct || Math.abs(pct) < 0.005) continue;
    out.push({ invoiceNo: l.document_number, date: dt, customerId: l.customer_id, customerName: l.customer_name, itemId: l.item_id, itemName: l.item_name, quantity: Number(l.quantity), currency: l.currency_code, listPrice: r4(listPrice), soldPrice: r4(sold), diff: r4(diff), diffPercent: Math.round(pct * 100) / 100, impactBase: r4(diff * Number(l.quantity) * Number(l.exchange_rate)) });
  }
  if (noList) warnings.push(`${noList} سطر بلا سعر في قائمة الأسعار الفعّالة — لم تُقارَن.`);
  if (noRate) warnings.push(`${noRate} سطر بقائمة بعملة مختلفة وبلا سعر صرف — لم تُقارَن.`);
  out.sort((a, b) => a.impactBase - b.impactBase);
  const grp = (key: 'customerName' | 'itemName') => { const m = new Map<string, { name: string; lines: number; impact: number }>(); for (const r of out) { const e = m.get(r[key]) ?? { name: r[key], lines: 0, impact: 0 }; e.lines++; e.impact = r4(e.impact + r.impactBase); m.set(r[key], e); } return [...m.values()].sort((a, b) => a.impact - b.impact); };
  return { lines: out, byCustomer: grp('customerName'), byItem: grp('itemName'), totals: { deviatedLines: out.length, discounts: r4(out.filter((r) => r.impactBase < 0).reduce((s, r) => s + r.impactBase, 0)), premiums: r4(out.filter((r) => r.impactBase > 0).reduce((s, r) => s + r.impactBase, 0)), net: r4(out.reduce((s, r) => s + r.impactBase, 0)) }, warnings };
}

export const payTypeSchema = z.object({ from: date.optional(), to: date.optional(), customerId: uuid.optional() });
export const PAY_LABEL: Record<string, string> = { cash: 'نقدي', credit: 'آجل', cheque: 'شيك', transfer: 'تحويل', unspecified: 'غير محدد' };
/** البيع حسب نوع الدفع: فواتير مرحَّلة، الإيراد قبل الضريبة بعملة الأساس (بسعر الفاتورة)، مع نسبة كل نوع وتفصيل العملاء. */
export async function salesByPaymentType(ctx: RequestContext, q: { from?: string; to?: string; customerId?: string }) {
  ctx.assertPermission('textile.log.view');
  const rows = (await pool.query(
    `SELECT COALESCE(i.payment_type,'unspecified') AS pt, i.customer_id, c.name_ar AS customer_name, i.id AS invoice_id, SUM(l.subtotal) * i.exchange_rate AS revenue, SUM(l.tax_amount) * i.exchange_rate AS tax
     FROM sales_invoices i JOIN sales_invoice_lines l ON l.sales_invoice_id=i.id AND l.company_id=i.company_id JOIN customers c ON c.id=i.customer_id AND c.company_id=i.company_id
     WHERE i.company_id=$1 AND i.status='posted' AND ($2::date IS NULL OR i.invoice_date>=$2) AND ($3::date IS NULL OR i.invoice_date<=$3) AND ($4::uuid IS NULL OR i.customer_id=$4)
     GROUP BY i.id, i.payment_type, i.customer_id, c.name_ar, i.exchange_rate`, [ctx.companyId, q.from ?? null, q.to ?? null, q.customerId ?? null])).rows;
  const total = rows.reduce((s, r) => s + Number(r.revenue), 0);
  const by = new Map<string, { type: string; label: string; invoices: number; revenue: number; tax: number }>();
  const cust = new Map<string, Record<string, any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of rows) {
    const e = by.get(r.pt) ?? { type: r.pt, label: PAY_LABEL[r.pt] ?? r.pt, invoices: 0, revenue: 0, tax: 0 }; e.invoices++; e.revenue += Number(r.revenue); e.tax += Number(r.tax); by.set(r.pt, e);
    const c = cust.get(r.customer_id) ?? { customerId: r.customer_id, customerName: r.customer_name, total: 0 }; c[r.pt] = r4((c[r.pt] ?? 0) + Number(r.revenue)); c.total = r4(c.total + Number(r.revenue)); cust.set(r.customer_id, c);
  }
  const order = ['cash', 'credit', 'cheque', 'transfer', 'unspecified'];
  const types = [...by.values()].map((e) => ({ ...e, revenue: r4(e.revenue), tax: r4(e.tax), percent: total > 0 ? Math.round((e.revenue / total) * 1000) / 10 : 0 })).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return { types, customers: [...cust.values()].sort((a, b) => b.total - a.total), totals: { invoices: rows.length, revenue: r4(total) }, note: types.some((t) => t.type === 'unspecified') ? 'فواتير بلا نوع دفع (قبل 2.9.0 أو لم يُحدَّد) مجمّعة تحت «غير محدد».' : null };
}
