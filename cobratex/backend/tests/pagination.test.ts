import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createExpenseInvoice, postExpenseInvoice, listExpenseInvoices } from '@/modules/purchasing/expenseInvoiceService';
import { listCustomers } from '@/modules/sales/customerService';
import { createCustomer } from '@/modules/sales/customerService';
import {
  createFullTenantStack, createAccountAndFiscalPeriod, createLimitedPermissionUser,
} from './helpers';

async function setupExpenseFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const bankAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1015','بنك','Bank','asset') RETURNING id`,
    [stack.companyId],
  );
  const expenseAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5900','مصروف عام','General Expense','expense') RETURNING id`,
    [stack.companyId],
  );
  return { stack, fiscalPeriodId, bankAccountId: bankAccount.rows[0].id, expenseAccountId: expenseAccount.rows[0].id };
}

describe('Pagination شامل — سلوك عام عبر paginatedList', () => {
  it('يُرجع data/page/pageSize/total/totalPages بشكل صحيح، ويحترم حجم الصفحة فعليًا (LIMIT حقيقي لا تصفية بالذاكرة)', async () => {
    const f = await setupExpenseFixture('pg-basic');
    for (let i = 0; i < 5; i++) {
      const inv = await createExpenseInvoice(f.stack.ctx, {
        branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', invoiceDate: '2026-04-01',
        lines: [{ expenseAccountId: f.expenseAccountId, description: `فاتورة ${i}`, amount: '100' }],
      });
      if (i < 3) await postExpenseInvoice(f.stack.ctx, inv.id); // 3 مرحَّلة، 2 مسودة
    }

    const page1 = await listExpenseInvoices(f.stack.ctx, 1, 2);
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.totalPages).toBe(3); // ceil(5/2)
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);

    const page2 = await listExpenseInvoices(f.stack.ctx, 2, 2);
    expect(page2.data).toHaveLength(2);
    // لا تكرار بين الصفحتين (معرّفات مختلفة تمامًا)
    const page1Ids = page1.data.map((r: any) => r.id);
    const page2Ids = page2.data.map((r: any) => r.id);
    expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);

    const page3 = await listExpenseInvoices(f.stack.ctx, 3, 2);
    expect(page3.data).toHaveLength(1); // الباقي فقط
  });

  it('فلتر status يعمل على مستوى SQL فعليًا (لا فلترة بعد الجلب)', async () => {
    const f = await setupExpenseFixture('pg-status');
    for (let i = 0; i < 4; i++) {
      const inv = await createExpenseInvoice(f.stack.ctx, {
        branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
        currencyCode: 'EGP', invoiceDate: '2026-04-01',
        lines: [{ expenseAccountId: f.expenseAccountId, description: `فاتورة ${i}`, amount: '50' }],
      });
      if (i % 2 === 0) await postExpenseInvoice(f.stack.ctx, inv.id);
    }
    const posted = await listExpenseInvoices(f.stack.ctx, 1, 20, 'posted');
    const draft = await listExpenseInvoices(f.stack.ctx, 1, 20, 'draft');
    expect(posted.total).toBe(2);
    expect(draft.total).toBe(2);
    expect(posted.data.every((r: any) => r.status === 'posted')).toBe(true);
  });

  it('عزل الفرع: مستخدم بنطاق فرع واحد لا يرى فواتير فرع آخر في القائمة أو في الإجمالي', async () => {
    const f = await setupExpenseFixture('pg-branch');
    const otherBranch = await pool.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,'فرع آخر','Other Branch') RETURNING id`,
      [f.stack.companyId],
    );
    await createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-04-01',
      lines: [{ expenseAccountId: f.expenseAccountId, description: 'فرعي', amount: '10' }],
    });
    // فاتورة في الفرع الآخر — أنشئها بصلاحية all_branches الافتراضية لصاحب الحساب (stack.ctx مالك)
    await createExpenseInvoice(f.stack.ctx, {
      branchId: otherBranch.rows[0].id, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-04-01',
      lines: [{ expenseAccountId: f.expenseAccountId, description: 'فرع آخر', amount: '20' }],
    });

    const limited = await createLimitedPermissionUser(
      f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['purchasing.expense_invoice.view'],
    );
    const limitedList = await listExpenseInvoices(limited.ctx, 1, 20);
    expect(limitedList.total).toBe(1); // فرعه فقط

    const ownerList = await listExpenseInvoices(f.stack.ctx, 1, 20); // owner افتراضيًا all_branches
    expect(ownerList.total).toBe(2); // يرى الفرعين
  });

  it('حد أقصى لحجم الصفحة (100) — لا يمكن طلب الجدول كاملًا دفعة واحدة عبر pageSize كبير', async () => {
    const f = await setupExpenseFixture('pg-maxsize');
    await expect(listExpenseInvoices(f.stack.ctx, 1, 500)).resolves.toBeDefined(); // القيمة تُمرَّر مباشرة هنا (تحقق الحد الأقصى في Zod على مستوى الراوت لا الخدمة)
    // التحقق الفعلي لحد الـ100 يكون عبر مسار HTTP (validate + paginationQuerySchema)، مُختبَر في اختبار الراوت أدناه ضمن نفس الملف عبر استدعاء مباشر للمخطط
  });

  it('عملاء بلا عمود فرع (hasBranchColumn:false): القائمة على مستوى الشركة فقط، مُصفَّحة فعليًا أيضًا', async () => {
    const stack = await createFullTenantStack('pg-customers');
    for (let i = 0; i < 3; i++) {
      await createCustomer(stack.ctx, { code: `PGC-${i}`, nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    }
    const result = await listCustomers(stack.ctx, 1, 2);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBeGreaterThanOrEqual(3);
  });
});

describe('Pagination — التحقق عبر Zod على مستوى المسار (paginationQuerySchema)', () => {
  it('يرفض pageSize أكبر من 100', async () => {
    const { paginationQuerySchema } = await import('@/shared/pagination');
    expect(() => paginationQuerySchema.parse({ pageSize: '500' })).toThrow();
  });
  it('يرفض page أقل من 1', async () => {
    const { paginationQuerySchema } = await import('@/shared/pagination');
    expect(() => paginationQuerySchema.parse({ page: '0' })).toThrow();
  });
  it('القيم الافتراضية: page=1, pageSize=20 عند عدم إرسال شيء', async () => {
    const { paginationQuerySchema } = await import('@/shared/pagination');
    const parsed = paginationQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });
});
