import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { getMyCompany, listBranches } from '@/modules/tenancy/tenancyService';
import { createFullTenantStack, createLimitedPermissionUser } from './helpers';

const app = createApp();

describe('بيانات الشركة والفروع — لم يكن لهما أي مسار قراءة إطلاقًا', () => {
  it('getMyCompany تُعيد بيانات الشركة الصحيحة لمالك الشركة (يمتلك owner role كل الصلاحيات)', async () => {
    const stack = await createFullTenantStack('company-view');
    const company = await getMyCompany(stack.ctx);
    expect(company.id).toBe(stack.companyId);
    expect(company.display_name).toBeTruthy();
  });

  it('listBranches تُظهر فرع الشركة (من bootstrap) فقط، بلا تسريب بين الشركات', async () => {
    const stack1 = await createFullTenantStack('branch-list-1');
    const stack2 = await createFullTenantStack('branch-list-2');
    const branches1 = await listBranches(stack1.ctx);
    const branches2 = await listBranches(stack2.ctx);
    expect(branches1.length).toBeGreaterThan(0);
    expect(branches1.every((b) => b.company_id === stack1.companyId)).toBe(true);
    expect(branches2.some((b) => b.company_id === stack1.companyId)).toBe(false);
  });

  it('مستخدم بلا صلاحية tenancy.company.view يُرفض بـForbiddenScopeError', async () => {
    const stack = await createFullTenantStack('company-rbac');
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    await expect(getMyCompany(limited.ctx)).rejects.toThrow();
  });

  it('مستخدم بلا صلاحية tenancy.branch.view يُرفض بـForbiddenScopeError', async () => {
    const stack = await createFullTenantStack('branch-rbac');
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    await expect(listBranches(limited.ctx)).rejects.toThrow();
  });

  it('GET /company وGET /branches عبر HTTP يعملان خلف المصادقة ويُعيدان بيانات صحيحة', async () => {
    const stack = await createFullTenantStack('company-http');

    const companyRes = await request(app).get('/api/company').set('Authorization', `Bearer ${stack.token}`);
    expect(companyRes.status).toBe(200);
    expect(companyRes.body.id).toBe(stack.companyId);

    const branchesRes = await request(app).get('/api/branches').set('Authorization', `Bearer ${stack.token}`);
    expect(branchesRes.status).toBe(200);
    expect(Array.isArray(branchesRes.body)).toBe(true);
    expect(branchesRes.body.length).toBeGreaterThan(0);
  });

  it('GET /company بلا توكن يُرفض بـ401', async () => {
    const res = await request(app).get('/api/company');
    expect(res.status).toBe(401);
  });

  it('GET /branches بتوكن مستخدم محدود الصلاحيات يُرفض بـ403', async () => {
    const stack = await createFullTenantStack('branch-http-rbac');
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    const res = await request(app).get('/api/branches').set('Authorization', `Bearer ${limited.token}`);
    expect(res.status).toBe(403);
  });
});
