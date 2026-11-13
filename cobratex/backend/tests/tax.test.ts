import { describe, it, expect } from 'vitest';
import { createTaxType, changeTaxRate, getActiveTaxRate, computeLineAmounts } from '@/modules/accounting/taxService';
import { createFullTenantStack } from './helpers';

describe('الضريبة القابلة للتهيئة والتغيير (Versioned Tax Rate)', () => {
  it('ينشئ نوع ضريبة بنسبة أولية، ويمكن استرجاعها كإصدار سارٍ حاليًا', async () => {
    const stack = await createFullTenantStack('tax-create');
    const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة القيمة المضافة', nameEn: 'VAT', initialRatePercent: '14', effectiveFrom: '2026-01-01' });
    const active = await getActiveTaxRate(stack.companyId, tax.id, '2026-06-01');
    expect(active.rate_percent).toBe('14.000');
  });

  it('تغيير النسبة لا يُعدِّل الإصدار القديم — بل يُغلقه بتاريخ وينشئ إصدارًا جديدًا (لا تعديل مباشر)', async () => {
    const stack = await createFullTenantStack('tax-change');
    const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة', nameEn: 'Tax', initialRatePercent: '14', effectiveFrom: '2026-01-01' });

    const newRate = await changeTaxRate(stack.ctx, tax.id, '15', '2026-07-01');
    expect(newRate.rate_percent).toBe('15.000');

    // الفاتورة بتاريخ قبل التغيير تحصل على 14% (تاريخيًا صحيحة)
    const beforeChange = await getActiveTaxRate(stack.companyId, tax.id, '2026-03-01');
    expect(beforeChange.rate_percent).toBe('14.000');
    expect(beforeChange.effective_to.toISOString().slice(0, 10)).toBe('2026-06-30'); // أُغلق يوم قبل السريان الجديد، لم يُحذف

    // الفاتورة بتاريخ بعد التغيير تحصل على 15%
    const afterChange = await getActiveTaxRate(stack.companyId, tax.id, '2026-08-01');
    expect(afterChange.rate_percent).toBe('15.000');
  });

  it('يرفض تغيير النسبة بتاريخ سريان لا يأتي بعد الإصدار الحالي', async () => {
    const stack = await createFullTenantStack('tax-change-invalid');
    const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة', nameEn: 'Tax', initialRatePercent: '14', effectiveFrom: '2026-01-01' });
    await expect(changeTaxRate(stack.ctx, tax.id, '20', '2025-12-01')).rejects.toThrow(/بعد تاريخ سريان النسبة الحالية/);
  });

  it('يمكن تغيير النسبة أكثر من مرة، وكل التاريخ محفوظ بلا فقدان', async () => {
    const stack = await createFullTenantStack('tax-multi-change');
    const tax = await createTaxType(stack.ctx, { nameAr: 'ضريبة', nameEn: 'Tax', initialRatePercent: '10', effectiveFrom: '2026-01-01' });
    await changeTaxRate(stack.ctx, tax.id, '12', '2026-04-01');
    await changeTaxRate(stack.ctx, tax.id, '14', '2026-09-01');

    expect((await getActiveTaxRate(stack.companyId, tax.id, '2026-02-01')).rate_percent).toBe('10.000');
    expect((await getActiveTaxRate(stack.companyId, tax.id, '2026-06-01')).rate_percent).toBe('12.000');
    expect((await getActiveTaxRate(stack.companyId, tax.id, '2026-12-01')).rate_percent).toBe('14.000');
  });
});

describe('حساب مبلغ السطر (خصم ثم ضريبة، شاملة أو مضافة)', () => {
  it('ضريبة مضافة (غير شاملة): السعر × الكمية × (1-خصم) ثم + ضريبة', () => {
    const amounts = computeLineAmounts('10', '100', '10', { rate_percent: '14', is_price_inclusive: false, rounding_mode: 'half_even' });
    // 10*100=1000, بعد خصم 10%=900, ضريبة 14%=126, الإجمالي=1026
    expect(amounts.subtotal).toBe('900.0000');
    expect(amounts.taxAmount).toBe('126.0000');
    expect(amounts.total).toBe('1026.0000');
  });

  it('ضريبة شاملة: السعر شامل الضريبة بالفعل، يُستخرَج الأساس والضريبة منه', () => {
    const amounts = computeLineAmounts('1', '114', '0', { rate_percent: '14', is_price_inclusive: true, rounding_mode: 'half_even' });
    // 114 شامل 14%: الأساس = 114/1.14 = 100.0000، الضريبة = 14.0000
    expect(amounts.subtotal).toBe('100.0000');
    expect(amounts.taxAmount).toBe('14.0000');
    expect(amounts.total).toBe('114.0000');
  });

  it('بلا ضريبة (undefined): المبلغ بعد الخصم فقط، بلا أي ضريبة', () => {
    const amounts = computeLineAmounts('5', '20', '0');
    expect(amounts.subtotal).toBe('100.0000');
    expect(amounts.taxAmount).toBe('0.0000');
    expect(amounts.total).toBe('100.0000');
  });
});
