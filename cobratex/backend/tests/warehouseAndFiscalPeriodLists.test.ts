import { describe, it, expect } from 'vitest';
import { createFullTenantStack, createAccountAndFiscalPeriod } from './helpers';
import { createWarehouse, listWarehouses } from '@/modules/inventory/warehouseService';
import { listFiscalPeriods } from '@/modules/accounting/accountingService';

describe('المخازن والفترات المالية — كانتا بلا أي مسار عرض/إنشاء إطلاقًا', () => {
  it('createWarehouse ثم listWarehouses: يُظهر المخزن الافتراضي (من bootstrap) + الجديد', async () => {
    const stack = await createFullTenantStack('wh-list');
    const before = await listWarehouses(stack.ctx);
    await createWarehouse(stack.ctx, { branchId: stack.branchId, nameAr: 'مخزن إضافي', nameEn: 'Extra Warehouse' });
    const after = await listWarehouses(stack.ctx);
    expect(after.length).toBe(before.length + 1);
  });

  it('listFiscalPeriods: يُظهر الفترة المُنشأة فعليًا لهذه الشركة فقط', async () => {
    const stack1 = await createFullTenantStack('fp-list-1');
    const stack2 = await createFullTenantStack('fp-list-2');
    await createAccountAndFiscalPeriod(stack1.companyId);
    const list1 = await listFiscalPeriods(stack1.ctx);
    const list2 = await listFiscalPeriods(stack2.ctx);
    expect(list1.length).toBeGreaterThan(0);
    expect(list2.length).toBe(0);
  });
});
