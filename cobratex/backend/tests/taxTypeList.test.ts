import { describe, it, expect } from 'vitest';
import { createFullTenantStack } from './helpers';
import { createTaxType, listTaxTypes } from '@/modules/accounting/taxService';

describe('قائمة أنواع الضريبة (كانت مفقودة تمامًا)', () => {
  it('تُظهر النسبة السارية حاليًا لكل نوع ضريبة', async () => {
    const stack = await createFullTenantStack('tax-list');
    await createTaxType(stack.ctx, { nameAr: 'ضريبة', nameEn: 'VAT', initialRatePercent: '14', effectiveFrom: '2026-01-01' });
    const list = await listTaxTypes(stack.ctx);
    expect(list.length).toBeGreaterThan(0);
    expect(Number(list[0].current_rate_percent)).toBe(14);
  });

  it('لا تسريب بين الشركات', async () => {
    const stack1 = await createFullTenantStack('tax-list-iso-1');
    const stack2 = await createFullTenantStack('tax-list-iso-2');
    await createTaxType(stack1.ctx, { nameAr: 'ضريبة1', nameEn: 'VAT1', initialRatePercent: '10', effectiveFrom: '2026-01-01' });
    const list2 = await listTaxTypes(stack2.ctx);
    expect(list2.length).toBe(0);
  });
});
