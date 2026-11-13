import { describe, it, expect } from 'vitest';
import { createFullTenantStack, createBaseItem } from './helpers';
import { listItems, listUoms, listItemCategories } from '@/modules/items/itemService';

describe('قوائم الأصناف ووحدات القياس والفئات (كانت مفقودة تمامًا)', () => {
  it('listItems: مُصفَّحة، تعكس الأصناف المُنشأة فعليًا', async () => {
    const stack = await createFullTenantStack('items-list');
    await createBaseItem(stack.companyId);
    await createBaseItem(stack.companyId);
    const result = await listItems(stack.ctx, 1, 10);
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.data.length).toBeGreaterThanOrEqual(2);
  });

  it('listUoms: تُرجع وحدات القياس المُنشأة ضمن الشركة فقط', async () => {
    const stack = await createFullTenantStack('uoms-list');
    await createBaseItem(stack.companyId); // ينشئ وحدة قياس ضمنيًا
    const result = await listUoms(stack.ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('listItemCategories: تُرجع فئات الشركة فقط، بلا تسريب بين الشركات', async () => {
    const stack1 = await createFullTenantStack('cat-list-1');
    const stack2 = await createFullTenantStack('cat-list-2');
    const cat = await import('@/modules/items/itemService').then((m) =>
      m.createItemCategory(stack1.ctx, { nameAr: 'فئة1', nameEn: 'Cat1', itemKind: 'generic' }),
    );
    const list1 = await listItemCategories(stack1.ctx);
    const list2 = await listItemCategories(stack2.ctx);
    expect(list1.some((c: any) => c.id === cat.id)).toBe(true);
    expect(list2.some((c: any) => c.id === cat.id)).toBe(false);
  });
});
