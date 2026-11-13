import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { updateCustomerStatus } from '@/modules/sales/customerService';
import { updateSupplierStatus } from '@/modules/purchasing/supplierService';
import { updateItemStatus } from '@/modules/items/itemService';
import { createCustomer } from '@/modules/sales/customerService';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createFullTenantStack, createBaseItem, createLimitedPermissionUser } from './helpers';

const app = createApp();

describe('تعطيل/تفعيل العميل/المورد/الصنف (Soft Toggle) — لم يكن له أي مسار رغم وجود is_active', () => {
  it('updateCustomerStatus: يعطِّل ثم يعيد التفعيل، بلا أي حذف مادي', async () => {
    const stack = await createFullTenantStack('toggle-customer');
    const customer = await createCustomer(stack.ctx, { code: 'C-1', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });
    const disabled = await updateCustomerStatus(stack.ctx, customer.id, false);
    expect(disabled.is_active).toBe(false);
    const reenabled = await updateCustomerStatus(stack.ctx, customer.id, true);
    expect(reenabled.is_active).toBe(true);
  });

  it('updateSupplierStatus: نفس السلوك للمورد', async () => {
    const stack = await createFullTenantStack('toggle-supplier');
    const supplier = await createSupplier(stack.ctx, { code: 'S-1', nameAr: 'مورد', nameEn: 'Supplier', currencyCode: 'EGP' });
    const disabled = await updateSupplierStatus(stack.ctx, supplier.id, false);
    expect(disabled.is_active).toBe(false);
  });

  it('updateItemStatus: نفس السلوك للصنف', async () => {
    const stack = await createFullTenantStack('toggle-item');
    const { itemId } = await createBaseItem(stack.companyId);
    const disabled = await updateItemStatus(stack.ctx, itemId, false);
    expect(disabled.is_active).toBe(false);
  });

  it('تعطيل عميل لا يمسّ تاريخه: العميل يبقى قابلًا للقراءة بكل بياناته القديمة', async () => {
    const stack = await createFullTenantStack('toggle-history');
    const customer = await createCustomer(stack.ctx, { code: 'C-2', nameAr: 'عميل قديم', nameEn: 'Old Customer', currencyCode: 'EGP' });
    await updateCustomerStatus(stack.ctx, customer.id, false);
    const res = await request(app).get(`/api/customers/${customer.id}`).set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.name_ar).toBe('عميل قديم');
    expect(res.body.is_active).toBe(false);
  });

  it('تعطيل عميل غير موجود يُرجع NotFoundError', async () => {
    const stack = await createFullTenantStack('toggle-404');
    await expect(updateCustomerStatus(stack.ctx, '00000000-0000-0000-0000-000000000000', false)).rejects.toThrow();
  });

  it('عزل الشركات: لا يمكن تعطيل عميل شركة أخرى (NotFoundError عبر تصفية company_id)', async () => {
    const stack1 = await createFullTenantStack('toggle-iso-1');
    const stack2 = await createFullTenantStack('toggle-iso-2');
    const customer = await createCustomer(stack1.ctx, { code: 'C-3', nameAr: 'عميل1', nameEn: 'Customer1', currencyCode: 'EGP' });
    await expect(updateCustomerStatus(stack2.ctx, customer.id, false)).rejects.toThrow();
  });

  it('RBAC: مستخدم بلا sales.customer.update يُرفض', async () => {
    const stack = await createFullTenantStack('toggle-rbac');
    const customer = await createCustomer(stack.ctx, { code: 'C-4', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    await expect(updateCustomerStatus(limited.ctx, customer.id, false)).rejects.toThrow();
  });

  it('PATCH /customers/:id عبر HTTP: يعطِّل فعليًا ويُعيد is_active الجديد', async () => {
    const stack = await createFullTenantStack('toggle-http-customer');
    const customer = await createCustomer(stack.ctx, { code: 'C-5', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });
    const res = await request(app)
      .patch(`/api/customers/${customer.id}`)
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it('PATCH /suppliers/:id وPATCH /items/:id عبر HTTP يعملان بنفس السلوك', async () => {
    const stack = await createFullTenantStack('toggle-http-others');
    const supplier = await createSupplier(stack.ctx, { code: 'S-2', nameAr: 'مورد', nameEn: 'Supplier', currencyCode: 'EGP' });
    const { itemId } = await createBaseItem(stack.companyId);

    const supplierRes = await request(app)
      .patch(`/api/suppliers/${supplier.id}`)
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ isActive: false });
    expect(supplierRes.status).toBe(200);
    expect(supplierRes.body.is_active).toBe(false);

    const itemRes = await request(app)
      .patch(`/api/items/${itemId}`)
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ isActive: false });
    expect(itemRes.status).toBe(200);
    expect(itemRes.body.is_active).toBe(false);
  });

  it('PATCH بجسم غير صالح (isActive ليست boolean) يُرفض بـ422', async () => {
    const stack = await createFullTenantStack('toggle-validation');
    const customer = await createCustomer(stack.ctx, { code: 'C-6', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });
    const res = await request(app)
      .patch(`/api/customers/${customer.id}`)
      .set('Authorization', `Bearer ${stack.token}`)
      .send({ isActive: 'nope' });
    expect(res.status).toBe(422);
  });
});
