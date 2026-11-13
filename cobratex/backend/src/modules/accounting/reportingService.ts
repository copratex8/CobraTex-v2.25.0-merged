import { z } from 'zod';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';

export const trialBalanceQuerySchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOfDate يجب أن يكون بصيغة YYYY-MM-DD'),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  onlyWithActivity: z.coerce.boolean().optional().default(false),
});

/**
 * ميزان المراجعة: إجمالي مدين/دائن لكل حساب من القيود المرحَّلة (posted) فقط، حتى تاريخ معيّن
 * (وابتداءً من تاريخ اختياري لحصر فترة بدل التراكم منذ البداية). يُبنى مباشرة من journal_lines —
 * مصدر الحقيقة الوحيد — لا من جداول المستندات الفرعية، فهو يعكس ما رُحِّل فعليًا بصرف النظر عن
 * حالة المستند الأصلي. عزل الفرع يُطبَّق تلقائيًا عبر ctx.visibleBranchIds() إن لم يكن المستخدم
 * all_branches — يرى فقط أثر القيود المرتبطة بفروعه.
 */
export async function getTrialBalance(
  ctx: RequestContext,
  asOfDate: string,
  fromDate?: string,
  onlyWithActivity = false,
) {
  ctx.assertPermission('accounting.journal.view');
  if (fromDate && fromDate > asOfDate) throw new ValidationError('fromDate يجب أن يسبق asOfDate');

  const visible = ctx.visibleBranchIds();
  const subParams: unknown[] = [ctx.companyId, asOfDate];
  let subWhere = `je.status = 'posted' AND je.company_id = $1 AND je.entry_date <= $2`;
  if (fromDate) {
    subParams.push(fromDate);
    subWhere += ` AND je.entry_date >= $${subParams.length}`;
  }
  if (visible !== null) {
    subParams.push(visible);
    subWhere += ` AND je.branch_id = ANY($${subParams.length})`;
  }

  const havingClause = onlyWithActivity ? 'HAVING COALESCE(SUM(x.debit), 0) <> 0 OR COALESCE(SUM(x.credit), 0) <> 0' : '';

  const { rows } = await pool.query(
    `SELECT a.id, a.code, a.name_ar, a.name_en, a.account_type,
            COALESCE(SUM(x.debit), 0)::numeric(18,4) AS total_debit,
            COALESCE(SUM(x.credit), 0)::numeric(18,4) AS total_credit
     FROM accounts a
     LEFT JOIN (
       SELECT jl.account_id, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE ${subWhere}
     ) x ON x.account_id = a.id
     WHERE a.company_id = $1
     GROUP BY a.id, a.code, a.name_ar, a.name_en, a.account_type
     ${havingClause}
     ORDER BY a.code`,
    subParams,
  );

  const totals = rows.reduce(
    (acc, r) => ({ debit: acc.debit + Number(r.total_debit), credit: acc.credit + Number(r.total_credit) }),
    { debit: 0, credit: 0 },
  );
  return { asOfDate, fromDate: fromDate ?? null, accounts: rows, totals };
}

export const inventoryValuationQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  onlyWithStock: z.coerce.boolean().optional().default(true),
});

/**
 * تقرير تقييم المخزون: الكمية المتاحة والقيمة (بمتوسط التكلفة المرجَّح) لكل صنف/مخزن، من
 * stock_balances مباشرة — نفس الجدول الذي تُبنى منه كل عمليات الصرف فعليًا (مصدر الحقيقة
 * التشغيلي، لا إعادة حساب من الحركات). عزل الفرع تلقائي عبر ربط warehouses.branch_id.
 */
export async function getInventoryValuationReport(
  ctx: RequestContext,
  warehouseId?: string,
  onlyWithStock = true,
) {
  ctx.assertPermission('inventory.balance.view');
  const visible = ctx.visibleBranchIds();
  const conditions = ['sb.company_id = $1'];
  const params: unknown[] = [ctx.companyId];

  if (warehouseId) { params.push(warehouseId); conditions.push(`sb.warehouse_id = $${params.length}`); }
  if (visible !== null) { params.push(visible); conditions.push(`w.branch_id = ANY($${params.length})`); }
  if (onlyWithStock) conditions.push('sb.quantity_on_hand <> 0');

  const { rows } = await pool.query(
    `SELECT sb.warehouse_id, w.name_ar AS warehouse_name_ar, w.name_en AS warehouse_name_en,
            sb.item_id, i.code AS item_code, i.name_ar AS item_name_ar, i.name_en AS item_name_en,
            sb.batch_id, sb.quantity_on_hand, sb.quantity_reserved, sb.weighted_average_cost,
            (sb.quantity_on_hand * sb.weighted_average_cost)::numeric(18,4) AS stock_value
     FROM stock_balances sb
     JOIN warehouses w ON w.id = sb.warehouse_id
     JOIN items i ON i.id = sb.item_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY w.name_ar, i.code`,
    params,
  );
  const totalValue = rows.reduce((s, r) => s + Number(r.stock_value), 0);
  return { warehouseId: warehouseId ?? null, lines: rows, totalValue: totalValue.toFixed(4) };
}

export const salesSummaryQuerySchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupBy: z.enum(['item', 'customer', 'day']).optional().default('item'),
});

/**
 * تقرير مبيعات مُلخَّص لفترة، من sales_invoices/sales_invoice_lines المرحَّلة فقط (لا مسودات).
 * التجميع (صنف/عميل/يوم) يتم في SQL نفسه — لا في التطبيق — لأداء أفضل مع كميات بيانات أكبر.
 */
export async function getSalesSummaryReport(
  ctx: RequestContext,
  fromDate: string,
  toDate: string,
  groupBy: 'item' | 'customer' | 'day' = 'item',
) {
  ctx.assertPermission('sales.invoice.view');
  if (fromDate > toDate) throw new ValidationError('fromDate يجب أن يسبق toDate أو يساويه');
  const visible = ctx.visibleBranchIds();
  const params: unknown[] = [ctx.companyId, fromDate, toDate];
  let where = `si.company_id = $1 AND si.status = 'posted' AND si.invoice_date BETWEEN $2 AND $3`;
  if (visible !== null) { params.push(visible); where += ` AND si.branch_id = ANY($${params.length})`; }

  let selectCols: string;
  let groupCols: string;
  if (groupBy === 'item') {
    selectCols = 'sil.item_id, i.code AS item_code, i.name_ar AS item_name_ar, i.name_en AS item_name_en';
    groupCols = 'sil.item_id, i.code, i.name_ar, i.name_en';
  } else if (groupBy === 'customer') {
    selectCols = 'si.customer_id, c.code AS customer_code, c.name_ar AS customer_name_ar, c.name_en AS customer_name_en';
    groupCols = 'si.customer_id, c.code, c.name_ar, c.name_en';
  } else {
    selectCols = 'si.invoice_date AS day';
    groupCols = 'si.invoice_date';
  }

  const joins = groupBy === 'item' ? 'JOIN items i ON i.id = sil.item_id' : groupBy === 'customer' ? 'JOIN customers c ON c.id = si.customer_id' : '';
  const { rows } = await pool.query(
    `SELECT ${selectCols},
            COUNT(DISTINCT si.id)::int AS invoice_count,
            COALESCE(SUM(sil.quantity), 0)::numeric(18,4) AS total_quantity,
            COALESCE(SUM(sil.line_total), 0)::numeric(18,4) AS total_sales
     FROM sales_invoices si
     JOIN sales_invoice_lines sil ON sil.sales_invoice_id = si.id
     ${joins}
     WHERE ${where}
     GROUP BY ${groupCols}
     ORDER BY total_sales DESC`,
    params,
  );
  const grandTotal = rows.reduce((s, r) => s + Number(r.total_sales), 0);
  return { fromDate, toDate, groupBy, lines: rows, grandTotal: grandTotal.toFixed(4) };
}

export const purchaseSummaryQuerySchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupBy: z.enum(['item', 'supplier', 'day']).optional().default('item'),
});

/**
 * تقرير مشتريات مُلخَّص لفترة — مرآة تامة لـ getSalesSummaryReport أعلاه، من supplier_invoices/
 * supplier_invoice_lines المرحَّلة فقط. أُضيف عند بناء لوحة المؤشرات (Dashboard) في الواجهة، التي
 * كانت تحتاج إجمالي مشتريات فعلي لفترة ولم يوجد له أي مسار من قبل (كان الموجود فقط ملخَّص المبيعات).
 */
export async function getPurchaseSummaryReport(
  ctx: RequestContext,
  fromDate: string,
  toDate: string,
  groupBy: 'item' | 'supplier' | 'day' = 'item',
) {
  ctx.assertPermission('purchasing.invoice.view');
  if (fromDate > toDate) throw new ValidationError('fromDate يجب أن يسبق toDate أو يساويه');
  const visible = ctx.visibleBranchIds();
  const params: unknown[] = [ctx.companyId, fromDate, toDate];
  let where = `pi.company_id = $1 AND pi.status = 'posted' AND pi.invoice_date BETWEEN $2 AND $3`;
  if (visible !== null) { params.push(visible); where += ` AND pi.branch_id = ANY($${params.length})`; }

  let selectCols: string;
  let groupCols: string;
  if (groupBy === 'item') {
    selectCols = 'pil.item_id, i.code AS item_code, i.name_ar AS item_name_ar, i.name_en AS item_name_en';
    groupCols = 'pil.item_id, i.code, i.name_ar, i.name_en';
  } else if (groupBy === 'supplier') {
    selectCols = 'pi.supplier_id, s.code AS supplier_code, s.name_ar AS supplier_name_ar, s.name_en AS supplier_name_en';
    groupCols = 'pi.supplier_id, s.code, s.name_ar, s.name_en';
  } else {
    selectCols = 'pi.invoice_date AS day';
    groupCols = 'pi.invoice_date';
  }

  const joins = groupBy === 'item' ? 'JOIN items i ON i.id = pil.item_id' : groupBy === 'supplier' ? 'JOIN suppliers s ON s.id = pi.supplier_id' : '';
  const { rows } = await pool.query(
    `SELECT ${selectCols},
            COUNT(DISTINCT pi.id)::int AS invoice_count,
            COALESCE(SUM(pil.quantity), 0)::numeric(18,4) AS total_quantity,
            COALESCE(SUM(pil.line_total), 0)::numeric(18,4) AS total_purchases
     FROM supplier_invoices pi
     JOIN supplier_invoice_lines pil ON pil.supplier_invoice_id = pi.id
     ${joins}
     WHERE ${where}
     GROUP BY ${groupCols}
     ORDER BY total_purchases DESC`,
    params,
  );
  const grandTotal = rows.reduce((s, r) => s + Number(r.total_purchases), 0);
  return { fromDate, toDate, groupBy, lines: rows, grandTotal: grandTotal.toFixed(4) };
}
