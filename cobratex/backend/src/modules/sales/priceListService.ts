import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';

export interface CreatePriceListInput {
  name: string;
  currencyCode: string;
  isDefault?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export async function createPriceList(ctx: RequestContext, input: CreatePriceListInput) {
  ctx.assertPermission('sales.pricelist.manage');
  const { rows } = await pool.query(
    `INSERT INTO price_lists(company_id, name, currency_code, is_default, effective_from, effective_to)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      ctx.companyId, input.name, input.currencyCode, input.isDefault ?? false,
      input.effectiveFrom ?? new Date().toISOString().slice(0, 10), input.effectiveTo ?? null,
    ],
  );
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'price_list', entityId: rows[0].id, action: 'create', afterJson: rows[0],
  });
  return rows[0];
}

export async function addPriceListLine(
  ctx: RequestContext,
  input: { priceListId: string; itemId: string; uomId?: string; minQuantity?: string; unitPrice: string },
) {
  ctx.assertPermission('sales.pricelist.manage');
  const { rows } = await pool.query(
    `INSERT INTO price_list_lines(price_list_id, company_id, item_id, uom_id, min_quantity, unit_price)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.priceListId, ctx.companyId, input.itemId, input.uomId ?? null, input.minQuantity ?? '0', input.unitPrice],
  );
  return rows[0];
}

export interface ResolvePriceInput {
  customerId?: string;
  itemId: string;
  quantity: string;
  asOfDate?: string;
}

export interface ResolvedPrice {
  unitPrice: string;
  priceListId: string;
  priceListName: string;
  matchedMinQuantity: string;
}

/**
 * أولوية اختيار السعر (قابلة للاختبار بمعزل):
 * 1) قائمة الأسعار المخصَّصة للعميل (customers.price_list_id) إن وُجدت ونشطة وسارية بالتاريخ.
 * 2) وإلا: قائمة الأسعار الافتراضية للشركة (is_default = true) إن نشطة وسارية.
 * 3) داخل القائمة المُختارة: أعلى شريحة كمية (min_quantity) لا تتجاوز الكمية المطلوبة (تسعير متدرّج).
 * يرمي خطأً واضحًا عند غياب قائمة قابلة للتطبيق أو غياب سعر للصنف، بدل افتراض صفر أو تخمين.
 */
export async function resolveUnitPrice(ctx: RequestContext, input: ResolvePriceInput): Promise<ResolvedPrice> {
  ctx.assertPermission('sales.invoice.create');
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);

  let priceListId: string | null = null;
  if (input.customerId) {
    const customerPriceList = await pool.query(
      `SELECT pl.id, pl.name FROM customers c
       JOIN price_lists pl ON pl.id = c.price_list_id AND pl.company_id = c.company_id
       WHERE c.id = $1 AND c.company_id = $2 AND pl.is_active = true
         AND pl.effective_from <= $3 AND (pl.effective_to IS NULL OR pl.effective_to >= $3)`,
      [input.customerId, ctx.companyId, asOfDate],
    );
    if (customerPriceList.rows.length > 0) priceListId = customerPriceList.rows[0].id;
  }

  let priceListRow;
  if (priceListId) {
    priceListRow = { id: priceListId };
  } else {
    const defaultPriceList = await pool.query(
      `SELECT id, name FROM price_lists
       WHERE company_id = $1 AND is_default = true AND is_active = true
         AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)`,
      [ctx.companyId, asOfDate],
    );
    if (defaultPriceList.rows.length === 0) {
      throw new ValidationError('لا توجد قائمة أسعار قابلة للتطبيق (لا للعميل ولا افتراضي الشركة) — أدخل السعر يدويًا');
    }
    priceListRow = defaultPriceList.rows[0];
  }

  const line = await pool.query(
    `SELECT unit_price, min_quantity FROM price_list_lines
     WHERE price_list_id = $1 AND item_id = $2 AND min_quantity <= $3
     ORDER BY min_quantity DESC LIMIT 1`,
    [priceListRow.id, input.itemId, input.quantity],
  );
  if (line.rows.length === 0) {
    throw new ValidationError('لا يوجد سعر معرَّف لهذا الصنف في قائمة الأسعار المطبَّقة لهذه الكمية');
  }

  const nameRow = await pool.query(`SELECT name FROM price_lists WHERE id=$1`, [priceListRow.id]);

  return {
    unitPrice: line.rows[0].unit_price,
    priceListId: priceListRow.id,
    priceListName: nameRow.rows[0].name,
    matchedMinQuantity: line.rows[0].min_quantity,
  };
}
