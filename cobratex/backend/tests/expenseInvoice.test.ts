import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createTaxType } from '@/modules/accounting/taxService';
import {
  createExpenseInvoice, postExpenseInvoice, reverseExpenseInvoice, getExpenseInvoiceById,
} from '@/modules/purchasing/expenseInvoiceService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createLimitedPermissionUser } from './helpers';

async function setupExpenseFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

  const rentAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5100','مصروف إيجار','Rent Expense','expense') RETURNING id`,
    [stack.companyId],
  );
  const utilitiesAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5200','مصروف مرافق','Utilities Expense','expense') RETURNING id`,
    [stack.companyId],
  );
  const taxAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1300','ضريبة مشتريات قابلة للخصم','Input Tax','asset') RETURNING id`,
    [stack.companyId],
  );
  const bankAccount = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'1010','البنك','Bank','asset') RETURNING id`,
    [stack.companyId],
  );
  const tax = await createTaxType(stack.ctx, {
    nameAr: 'ضريبة قيمة مضافة', nameEn: 'VAT', initialRatePercent: '14', effectiveFrom: '2026-01-01',
    purchaseTaxAccountId: taxAccount.rows[0].id,
  });
  const supplier = await createSupplier(stack.ctx, { code: `EXPS-${prefix}`, nameAr: 'مورد خدمات', nameEn: 'Service Supplier', currencyCode: 'EGP' });

  return {
    stack, fiscalPeriodId, supplierId: supplier.id,
    rentAccountId: rentAccount.rows[0].id, utilitiesAccountId: utilitiesAccount.rows[0].id,
    taxTypeId: tax.id, bankAccountId: bankAccount.rows[0].id,
  };
}

describe('فواتير المصروفات غير المخزنية (Expense Invoices)', () => {
  it('فاتورة مصروف على مورد (آجلة): تُرحَّل بقيد متوازن — مدين المصروف + الضريبة، دائن حساب المورد', async () => {
    const f = await setupExpenseFixture('exp-supplier');
    const invoice = await createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-01', description: 'إيجار مارس',
      lines: [{ expenseAccountId: f.rentAccountId, description: 'إيجار المحل', amount: '1000', taxTypeId: f.taxTypeId }],
    });
    expect(invoice.status).toBe('draft');

    const result = await postExpenseInvoice(f.stack.ctx, invoice.id);
    const stored = await getExpenseInvoiceById(f.stack.ctx, invoice.id);
    expect(stored.status).toBe('posted');
    expect(stored.lines[0].subtotal).toBe('1000.0000');
    expect(stored.lines[0].tax_amount).toBe('140.0000');
    expect(stored.lines[0].line_total).toBe('1140.0000');

    const lines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1 ORDER BY debit DESC`, [result.journalEntryId]);
    expect(lines.rows).toHaveLength(3); // مصروف + ضريبة + المورد
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = lines.rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(1140, 4);
    expect(totalCredit).toBeCloseTo(1140, 4);

    const supplierAccount = await pool.query(`SELECT linked_account_id FROM suppliers WHERE id=$1`, [f.supplierId]);
    const creditLine = lines.rows.find((r) => r.account_id === supplierAccount.rows[0].linked_account_id);
    expect(creditLine?.credit).toBe('1140.0000');
  });

  it('فاتورة مصروف مدفوعة فورًا (بلا مورد): تُقيَّد على حساب الدفع مباشرة لا على مورد', async () => {
    const f = await setupExpenseFixture('exp-paid');
    const invoice = await createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-02',
      lines: [{ expenseAccountId: f.utilitiesAccountId, description: 'فاتورة كهرباء', amount: '300' }],
    });
    const result = await postExpenseInvoice(f.stack.ctx, invoice.id);
    const lines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    expect(lines.rows).toHaveLength(2);
    const creditLine = lines.rows.find((r) => r.account_id === f.bankAccountId);
    expect(creditLine?.credit).toBe('300.0000');
  });

  it('يرفض إنشاء فاتورة بكل من المورد وحساب الدفع معًا، وكذلك بلا أي منهما', async () => {
    const f = await setupExpenseFixture('exp-both');
    await expect(createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, paidFromAccountId: f.bankAccountId,
      fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [{ expenseAccountId: f.rentAccountId, description: 'x', amount: '100' }],
    })).rejects.toThrow();

    await expect(createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, fiscalPeriodId: f.fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [{ expenseAccountId: f.rentAccountId, description: 'x', amount: '100' }],
    })).rejects.toThrow();
  });

  it('يدعم عدة أسطر بحسابات مصروف مختلفة، ويجمع الضريبة في سطر قيد واحد لنفس حساب الضريبة', async () => {
    const f = await setupExpenseFixture('exp-multi');
    const invoice = await createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, supplierId: f.supplierId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [
        { expenseAccountId: f.rentAccountId, description: 'إيجار', amount: '1000', taxTypeId: f.taxTypeId },
        { expenseAccountId: f.utilitiesAccountId, description: 'مرافق', amount: '500', taxTypeId: f.taxTypeId },
      ],
    });
    const result = await postExpenseInvoice(f.stack.ctx, invoice.id);
    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    // سطرا مصروف + سطر ضريبة مجمَّع واحد (1000*0.14 + 500*0.14 = 210) + سطر دائن واحد = 4 أسطر
    expect(lines.rows).toHaveLength(4);
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    expect(totalDebit).toBeCloseTo(1710, 4); // 1000+500+210
  });

  it('عكس فاتورة مصروف مرحّلة: يعكس القيد فقط، ولا يسمح بتعديل أو ترحيل مزدوج', async () => {
    const f = await setupExpenseFixture('exp-reverse');
    const invoice = await createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [{ expenseAccountId: f.utilitiesAccountId, description: 'صيانة', amount: '200' }],
    });
    await postExpenseInvoice(f.stack.ctx, invoice.id);
    await expect(postExpenseInvoice(f.stack.ctx, invoice.id)).rejects.toThrow(); // لا ترحيل مزدوج

    const reversed = await reverseExpenseInvoice(f.stack.ctx, invoice.id, 'خطأ في المبلغ');
    expect(reversed.status).toBe('reversed');
    await expect(reverseExpenseInvoice(f.stack.ctx, invoice.id, 'مرة أخرى')).rejects.toThrow();
  });

  it('RBAC: مستخدم بلا صلاحية purchasing.expense_invoice.create يُمنع من الإنشاء', async () => {
    const f = await setupExpenseFixture('exp-rbac');
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, ['purchasing.expense_invoice.view']);
    await expect(createExpenseInvoice(limited.ctx, {
      branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [{ expenseAccountId: f.utilitiesAccountId, description: 'x', amount: '100' }],
    })).rejects.toThrow();
  });

  it('عزل الشركة: فاتورة مصروف تابعة لشركة أخرى تُعامَل كغير موجودة (404) لا كخطأ آخر', async () => {
    const f1 = await setupExpenseFixture('exp-iso-1');
    const f2 = await setupExpenseFixture('exp-iso-2');
    const invoice = await createExpenseInvoice(f1.stack.ctx, {
      branchId: f1.stack.branchId, paidFromAccountId: f1.bankAccountId, fiscalPeriodId: f1.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [{ expenseAccountId: f1.utilitiesAccountId, description: 'x', amount: '100' }],
    });
    await expect(getExpenseInvoiceById(f2.stack.ctx, invoice.id)).rejects.toThrow();
  });

  it('خصم على مستوى سطر فاتورة المصروف يُحسَب قبل الضريبة بدقة', async () => {
    const f = await setupExpenseFixture('exp-discount');
    const invoice = await createExpenseInvoice(f.stack.ctx, {
      branchId: f.stack.branchId, paidFromAccountId: f.bankAccountId, fiscalPeriodId: f.fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-03-01',
      lines: [{ expenseAccountId: f.utilitiesAccountId, description: 'صيانة بخصم', amount: '1000', discountPercent: '10', taxTypeId: f.taxTypeId }],
    });
    const stored = await getExpenseInvoiceById(f.stack.ctx, invoice.id);
    // 1000 - 10% = 900 subtotal، ضريبة 14% = 126، الإجمالي 1026
    expect(stored.lines[0].subtotal).toBe('900.0000');
    expect(stored.lines[0].tax_amount).toBe('126.0000');
    expect(stored.lines[0].line_total).toBe('1026.0000');
  });
});
