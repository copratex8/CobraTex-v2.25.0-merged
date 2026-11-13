import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';

export interface CreateTaxTypeInput {
  nameAr: string;
  nameEn: string;
  salesTaxAccountId?: string;
  purchaseTaxAccountId?: string;
  initialRatePercent: string;
  isPriceInclusive?: boolean;
  roundingMode?: 'half_up' | 'half_even';
  effectiveFrom?: string;
}

export async function createTaxType(ctx: RequestContext, input: CreateTaxTypeInput) {
  ctx.assertPermission('accounting.tax.manage');
  return withTransaction(async (client) => {
    const taxType = await client.query(
      `INSERT INTO tax_types(company_id, name_ar, name_en, sales_tax_account_id, purchase_tax_account_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ctx.companyId, input.nameAr, input.nameEn, input.salesTaxAccountId ?? null, input.purchaseTaxAccountId ?? null],
    );
    const rate = await client.query(
      `INSERT INTO tax_rates(tax_type_id, company_id, rate_percent, is_price_inclusive, rounding_mode, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        taxType.rows[0].id, ctx.companyId, input.initialRatePercent, input.isPriceInclusive ?? false,
        input.roundingMode ?? 'half_even', input.effectiveFrom ?? new Date().toISOString().slice(0, 10), ctx.userId,
      ],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'tax_type', entityId: taxType.rows[0].id, action: 'create',
      afterJson: { ...taxType.rows[0], initialRate: rate.rows[0].rate_percent },
    });
    return { ...taxType.rows[0], currentRate: rate.rows[0] };
  });
}

/**
 * "تغيير نسبة الضريبة": لا يُعدِّل الإصدار الحالي — يُغلقه بتاريخ (effective_to = يوم قبل السريان
 * الجديد) وينشئ إصدارًا جديدًا. أي فاتورة سابقة تشير لتاريخها الخاص تبقى محسوبة بالنسبة الصحيحة
 * تاريخيًا (قابلة للاسترجاع دائمًا عبر getActiveTaxRate بتاريخ معيّن).
 */
export async function changeTaxRate(
  ctx: RequestContext,
  taxTypeId: string,
  newRatePercent: string,
  effectiveFrom: string,
  options?: { isPriceInclusive?: boolean; isExempt?: boolean; roundingMode?: 'half_up' | 'half_even' },
) {
  ctx.assertPermission('accounting.tax.manage');
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT * FROM tax_rates WHERE tax_type_id=$1 AND company_id=$2 AND effective_to IS NULL FOR UPDATE`,
      [taxTypeId, ctx.companyId],
    );
    if (current.rows.length === 0) throw new NotFoundError('لا يوجد إصدار ساري حاليًا لهذا النوع من الضريبة');
    const currentEffectiveFrom = new Date(current.rows[0].effective_from).toISOString().slice(0, 10);
    if (currentEffectiveFrom >= effectiveFrom) {
      throw new ValidationError('تاريخ سريان النسبة الجديدة يجب أن يكون بعد تاريخ سريان النسبة الحالية');
    }

    const dayBefore = new Date(effectiveFrom);
    dayBefore.setDate(dayBefore.getDate() - 1);
    await client.query(`UPDATE tax_rates SET effective_to=$2 WHERE id=$1`, [current.rows[0].id, dayBefore.toISOString().slice(0, 10)]);

    const newRate = await client.query(
      `INSERT INTO tax_rates(tax_type_id, company_id, rate_percent, is_price_inclusive, is_exempt, rounding_mode, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        taxTypeId, ctx.companyId, newRatePercent,
        options?.isPriceInclusive ?? current.rows[0].is_price_inclusive,
        options?.isExempt ?? false,
        options?.roundingMode ?? current.rows[0].rounding_mode,
        effectiveFrom, ctx.userId,
      ],
    );

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'tax_rate', entityId: newRate.rows[0].id, action: 'create',
      beforeJson: { previousRateId: current.rows[0].id, previousRatePercent: current.rows[0].rate_percent, closedAt: dayBefore.toISOString().slice(0, 10) },
      afterJson: newRate.rows[0],
    });

    return newRate.rows[0];
  });
}

export async function getActiveTaxRate(companyId: string, taxTypeId: string, asOfDate: string) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_rates WHERE tax_type_id=$1 AND company_id=$2
       AND effective_from <= $3 AND (effective_to IS NULL OR effective_to >= $3)
     ORDER BY effective_from DESC LIMIT 1`,
    [taxTypeId, companyId, asOfDate],
  );
  if (rows.length === 0) throw new ValidationError(`لا يوجد إصدار ضريبة سارٍ للنوع ${taxTypeId} بتاريخ ${asOfDate}`);
  return rows[0];
}

export interface LineAmounts {
  subtotal: string; // بعد الخصم، قبل الضريبة
  taxAmount: string;
  total: string;
}

/** حساب سطر واحد بـ Decimal دقيق: الخصم أولًا، ثم الضريبة (شاملة أو مضافة)، بسياسة تقريب النسبة. */
export function computeLineAmounts(
  quantity: string, unitPrice: string, discountPercent: string, taxRate?: { rate_percent: string; is_price_inclusive: boolean; rounding_mode: string },
): LineAmounts {
  const qty = new Decimal(quantity);
  const price = new Decimal(unitPrice);
  const discount = new Decimal(discountPercent).dividedBy(100);
  const gross = qty.times(price);
  const afterDiscount = gross.times(new Decimal(1).minus(discount));
  const roundMode = taxRate?.rounding_mode === 'half_up' ? Decimal.ROUND_HALF_UP : Decimal.ROUND_HALF_EVEN;

  if (!taxRate || new Decimal(taxRate.rate_percent).equals(0)) {
    const subtotal = afterDiscount.toDecimalPlaces(4, roundMode);
    return { subtotal: subtotal.toFixed(4), taxAmount: '0.0000', total: subtotal.toFixed(4) };
  }

  const rate = new Decimal(taxRate.rate_percent).dividedBy(100);
  if (taxRate.is_price_inclusive) {
    const base = afterDiscount.dividedBy(new Decimal(1).plus(rate)).toDecimalPlaces(4, roundMode);
    const tax = afterDiscount.minus(base).toDecimalPlaces(4, roundMode);
    return { subtotal: base.toFixed(4), taxAmount: tax.toFixed(4), total: afterDiscount.toDecimalPlaces(4, roundMode).toFixed(4) };
  }
  const subtotal = afterDiscount.toDecimalPlaces(4, roundMode);
  const tax = subtotal.times(rate).toDecimalPlaces(4, roundMode);
  return { subtotal: subtotal.toFixed(4), taxAmount: tax.toFixed(4), total: subtotal.plus(tax).toFixed(4) };
}

/** قائمة كاملة بلا صفحات — بلا نسبتها السارية حاليًا مباشرة (join مع tax_rates حيث effective_to IS NULL). */
export async function listTaxTypes(ctx: RequestContext) {
  ctx.assertPermission('accounting.tax.manage');
  const { rows } = await pool.query(
    `SELECT tt.*, tr.rate_percent AS current_rate_percent, tr.is_exempt AS current_is_exempt
     FROM tax_types tt
     LEFT JOIN tax_rates tr ON tr.tax_type_id = tt.id AND tr.effective_to IS NULL
     WHERE tt.company_id=$1 ORDER BY tt.name_ar`,
    [ctx.companyId],
  );
  return rows;
}
