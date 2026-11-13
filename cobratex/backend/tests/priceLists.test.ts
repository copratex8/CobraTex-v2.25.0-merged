import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createPriceList, addPriceListLine, resolveUnitPrice } from '@/modules/sales/priceListService';
import { createCustomer } from '@/modules/sales/customerService';
import { createFullTenantStack, createBaseItem } from './helpers';

describe('أولوية اختيار السعر (Price List Priority)', () => {
  it('يستخدم قائمة السعر الافتراضية للشركة إن لم يكن للعميل قائمة مخصَّصة', async () => {
    const stack = await createFullTenantStack('price-default');
    const { itemId } = await createBaseItem(stack.companyId);
    const defaultList = await createPriceList(stack.ctx, { name: 'الافتراضية', currencyCode: 'EGP', isDefault: true });
    await addPriceListLine(stack.ctx, { priceListId: defaultList.id, itemId, unitPrice: '50' });

    const customer = await createCustomer(stack.ctx, { code: 'PC-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });

    const resolved = await resolveUnitPrice(stack.ctx, { customerId: customer.id, itemId, quantity: '1' });
    expect(resolved.unitPrice).toBe('50.0000');
    expect(resolved.priceListId).toBe(defaultList.id);
  });

  it('يفضّل قائمة سعر العميل المخصَّصة على قائمة الشركة الافتراضية', async () => {
    const stack = await createFullTenantStack('price-customer');
    const { itemId } = await createBaseItem(stack.companyId);
    const defaultList = await createPriceList(stack.ctx, { name: 'الافتراضية', currencyCode: 'EGP', isDefault: true });
    await addPriceListLine(stack.ctx, { priceListId: defaultList.id, itemId, unitPrice: '50' });

    const vipList = await createPriceList(stack.ctx, { name: 'VIP', currencyCode: 'EGP' });
    await addPriceListLine(stack.ctx, { priceListId: vipList.id, itemId, unitPrice: '40' });

    const customer = await createCustomer(stack.ctx, { code: 'PC-2', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    await pool.query(`UPDATE customers SET price_list_id=$1 WHERE id=$2`, [vipList.id, customer.id]);

    const resolved = await resolveUnitPrice(stack.ctx, { customerId: customer.id, itemId, quantity: '1' });
    expect(resolved.unitPrice).toBe('40.0000');
    expect(resolved.priceListId).toBe(vipList.id);
  });

  it('يختار أعلى شريحة كمية لا تتجاوز الكمية المطلوبة (تسعير متدرّج)', async () => {
    const stack = await createFullTenantStack('price-tier');
    const { itemId } = await createBaseItem(stack.companyId);
    const list = await createPriceList(stack.ctx, { name: 'متدرّج', currencyCode: 'EGP', isDefault: true });
    await addPriceListLine(stack.ctx, { priceListId: list.id, itemId, unitPrice: '100', minQuantity: '0' });
    await addPriceListLine(stack.ctx, { priceListId: list.id, itemId, unitPrice: '90', minQuantity: '10' });
    await addPriceListLine(stack.ctx, { priceListId: list.id, itemId, unitPrice: '80', minQuantity: '50' });

    const low = await resolveUnitPrice(stack.ctx, { itemId, quantity: '5' });
    expect(low.unitPrice).toBe('100.0000');

    const mid = await resolveUnitPrice(stack.ctx, { itemId, quantity: '20' });
    expect(mid.unitPrice).toBe('90.0000');
    expect(mid.matchedMinQuantity).toBe('10.0000');

    const high = await resolveUnitPrice(stack.ctx, { itemId, quantity: '100' });
    expect(high.unitPrice).toBe('80.0000');
  });

  it('يرمي خطأً واضحًا عند عدم وجود قائمة أسعار قابلة للتطبيق إطلاقًا', async () => {
    const stack = await createFullTenantStack('price-none');
    const { itemId } = await createBaseItem(stack.companyId);
    await expect(resolveUnitPrice(stack.ctx, { itemId, quantity: '1' })).rejects.toThrow(/لا توجد قائمة أسعار/);
  });

  it('يرمي خطأً واضحًا عند وجود قائمة لكن بلا سعر لهذا الصنف تحديدًا', async () => {
    const stack = await createFullTenantStack('price-item-missing');
    const { itemId: itemWithPrice } = await createBaseItem(stack.companyId);
    const { itemId: itemWithoutPrice } = await createBaseItem(stack.companyId);
    const list = await createPriceList(stack.ctx, { name: 'الافتراضية', currencyCode: 'EGP', isDefault: true });
    await addPriceListLine(stack.ctx, { priceListId: list.id, itemId: itemWithPrice, unitPrice: '10' });

    await expect(resolveUnitPrice(stack.ctx, { itemId: itemWithoutPrice, quantity: '1' })).rejects.toThrow(/لا يوجد سعر معرَّف/);
  });

  it('قيد Unique يمنع أكثر من قائمة أسعار افتراضية واحدة لكل شركة', async () => {
    const stack = await createFullTenantStack('price-dup-default');
    await createPriceList(stack.ctx, { name: 'أ', currencyCode: 'EGP', isDefault: true });
    await expect(
      createPriceList(stack.ctx, { name: 'ب', currencyCode: 'EGP', isDefault: true }),
    ).rejects.toThrow();
  });
});
