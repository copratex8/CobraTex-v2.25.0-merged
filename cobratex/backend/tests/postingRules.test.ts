import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createPostingRule, buildJournalPreview, postJournalEntry } from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts } from './helpers';

describe('محرك الترحيل القابل للتهيئة (PostingRule)', () => {
  it('يرفض قاعدة ناقصة: FIXED_ACCOUNT بلا معرّف حساب', async () => {
    const stack = await createFullTenantStack('pr-incomplete');
    await expect(
      createPostingRule(stack.ctx, {
        operationType: 'sales_invoice_revenue',
        debitAccountSourceType: 'FIXED_ACCOUNT', // بلا debitFixedAccountId
        creditAccountSourceType: 'FIXED_ACCOUNT',
        creditFixedAccountId: undefined,
      }),
    ).rejects.toThrow(/قاعدة ترحيل ناقصة/);
  });

  it('يرفض قاعدتين نشطتين متعارضتين لنفس العملية', async () => {
    const stack = await createFullTenantStack('pr-conflict');
    const { cashAccountId, revenueAccountId } = await createAccountAndFiscalPeriod(stack.companyId);

    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_revenue',
      debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: cashAccountId,
      creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
    });

    await expect(
      createPostingRule(stack.ctx, {
        operationType: 'sales_invoice_revenue', // نفس العملية، قاعدة ثانية نشطة
        debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: cashAccountId,
        creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
      }),
    ).rejects.toThrow(/قاعدة ترحيل نشطة متعارضة/);
  });

  it('يرفض معاينة قيد لعملية بلا قاعدة ترحيل نشطة، برسالة واضحة بدل تخمين حساب', async () => {
    const stack = await createFullTenantStack('pr-missing-rule');
    await expect(
      buildJournalPreview(stack.ctx, [{ operationType: 'no_such_operation', amount: '100' }]),
    ).rejects.toThrow(/لا توجد قاعدة ترحيل نشطة للعملية/);
  });

  it('سيناريو بيع: يبني معاينة قيد متوازنة من رِجلين (إيراد + تكلفة مبيعات) عبر قواعد منفصلة', async () => {
    const stack = await createFullTenantStack('pr-sale');
    const { cashAccountId, revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } =
      await createAccountAndFiscalPeriod(stack.companyId);
    const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);

    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_revenue',
      debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: cashAccountId, // مبسّط: نقدي بدل عميل (العملاء مؤجّلة لمرحلة المبيعات)
      creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
    });
    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_cogs',
      debitAccountSourceType: 'ITEM_CATEGORY_COGS',
      creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    });

    const preview = await buildJournalPreview(stack.ctx, [
      { operationType: 'sales_invoice_revenue', amount: '1000' },
      { operationType: 'sales_invoice_cogs', amount: '600', itemCategoryId: categoryId },
    ]);

    expect(preview.isBalanced).toBe(true);
    expect(preview.totalDebit).toBe('1600.0000');
    expect(preview.totalCredit).toBe('1600.0000');
    expect(preview.lines).toHaveLength(4); // (مدين+دائن) × رِجلين

    const posted = await postJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-10',
      currencyCode: 'EGP', sourceDocumentType: 'sales_invoice_simulated', lines: preview.lines,
    });
    expect(posted.totalDebit).toBe('1600.0000');
  });

  it('سيناريو شراء: يبني معاينة قيد متوازنة (مخزون مدين / التزام مورد دائن) عبر ITEM_CATEGORY_INVENTORY', async () => {
    const stack = await createFullTenantStack('pr-purchase');
    const { payableAccountId, inventoryAccountId, cogsAccountId } = await createAccountAndFiscalPeriod(stack.companyId);
    const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);

    await createPostingRule(stack.ctx, {
      operationType: 'purchase_invoice_inventory',
      debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
      creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: payableAccountId, // مبسّط: حساب موردين ثابت بدل مورد محدد
    });

    const preview = await buildJournalPreview(stack.ctx, [
      { operationType: 'purchase_invoice_inventory', amount: '500', itemCategoryId: categoryId },
    ]);
    expect(preview.isBalanced).toBe(true);
    expect(preview.lines[0].accountId).toBe(inventoryAccountId);
    expect(preview.lines[0].debit).toBe('500.0000');
    expect(preview.lines[1].accountId).toBe(payableAccountId);
    expect(preview.lines[1].credit).toBe('500.0000');
  });

  it('سيناريو مرتجع مبيعات: قاعدة تعيد المخزون وتعكس تكلفة المبيعات', async () => {
    const stack = await createFullTenantStack('pr-sales-return');
    const { inventoryAccountId, cogsAccountId } = await createAccountAndFiscalPeriod(stack.companyId);
    const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);

    await createPostingRule(stack.ctx, {
      operationType: 'sales_return_inventory',
      debitAccountSourceType: 'ITEM_CATEGORY_INVENTORY', // يعود المخزون (مدين)
      creditAccountSourceType: 'ITEM_CATEGORY_COGS', // تنعكس تكلفة المبيعات (دائن)
    });

    const preview = await buildJournalPreview(stack.ctx, [
      { operationType: 'sales_return_inventory', amount: '200', itemCategoryId: categoryId },
    ]);
    expect(preview.isBalanced).toBe(true);
    expect(preview.lines[0].accountId).toBe(inventoryAccountId);
    expect(preview.lines[1].accountId).toBe(cogsAccountId);
  });

  it('سيناريو تسوية مخزون (هالك): مصروف هالك مدين / مخزون دائن', async () => {
    const stack = await createFullTenantStack('pr-adjustment');
    const { inventoryAccountId, cogsAccountId } = await createAccountAndFiscalPeriod(stack.companyId);
    const lossAccount = await pool.query(
      `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,'5100','هالك المخزون','Inventory Loss','expense') RETURNING id`,
      [stack.companyId],
    );
    const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);

    await createPostingRule(stack.ctx, {
      operationType: 'stock_adjustment_loss',
      debitAccountSourceType: 'FIXED_ACCOUNT', debitFixedAccountId: lossAccount.rows[0].id,
      creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    });

    const preview = await buildJournalPreview(stack.ctx, [
      { operationType: 'stock_adjustment_loss', amount: '75.5', itemCategoryId: categoryId },
    ]);
    expect(preview.isBalanced).toBe(true);
    expect(preview.lines[0].accountId).toBe(lossAccount.rows[0].id);
    expect(preview.lines[1].accountId).toBe(inventoryAccountId);
    expect(preview.totalDebit).toBe('75.5000');
  });

  it('مصدر حساب غير مدعوم بعد (TAX_ACCOUNT) يرمي خطأ 501 صريحًا بدل نتيجة خاطئة صامتة', async () => {
    const stack = await createFullTenantStack('pr-not-supported');
    await createPostingRule(stack.ctx, {
      operationType: 'demo_tax_account_operation',
      debitAccountSourceType: 'TAX_ACCOUNT',
      creditAccountSourceType: 'FIXED_ACCOUNT',
      creditFixedAccountId: (await createAccountAndFiscalPeriod(stack.companyId)).revenueAccountId,
    });

    await expect(
      buildJournalPreview(stack.ctx, [{ operationType: 'demo_tax_account_operation', amount: '10' }]),
    ).rejects.toMatchObject({ status: 501 });
  });
});
