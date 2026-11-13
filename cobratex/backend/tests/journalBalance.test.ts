import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { postJournalEntry, postJournalEntryBypassingAppCheck } from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod } from './helpers';

describe('توازن القيد المحاسبي (Deferred Constraint Trigger + تحقق تطبيقي)', () => {
  it('طبقة التطبيق: ترفض قيدًا غير متوازن قبل أي INSERT (لا يصل لقاعدة البيانات أصلًا)', async () => {
    const stack = await createFullTenantStack('jbal-app');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    await expect(
      postJournalEntry(stack.ctx, {
        branchId: stack.branchId,
        fiscalPeriodId,
        entryDate: '2026-01-05',
        currencyCode: 'EGP',
        sourceDocumentType: 'test',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '80.00' }, // غير متوازن عمدًا
        ],
      }),
    ).rejects.toThrow(/غير متوازن/);

    const count = await pool.query(
      `SELECT count(*) FROM journal_entries WHERE company_id = $1`,
      [stack.companyId],
    );
    expect(Number(count.rows[0].count)).toBe(0); // لم يُدرَج أي شيء إطلاقًا
  });

  it('طبقة التطبيق: تقبل وتُرحِّل قيدًا متوازنًا بنجاح', async () => {
    const stack = await createFullTenantStack('jbal-ok');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    const result = await postJournalEntry(stack.ctx, {
      branchId: stack.branchId,
      fiscalPeriodId,
      entryDate: '2026-01-05',
      currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [
        { accountId: cashAccountId, debit: '150.5000', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '150.5000' },
      ],
    });

    expect(result.totalDebit).toBe('150.5000');
    expect(result.totalCredit).toBe('150.5000');

    const persisted = await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [result.id]);
    expect(persisted.rows[0].status).toBe('posted');
  });

  it('طبقة قاعدة البيانات (Deferred Constraint Trigger): ترفض COMMIT لقيد غير متوازن حتى لو تجاوزنا تحقق التطبيق عمدًا', async () => {
    const stack = await createFullTenantStack('jbal-db');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    await expect(
      postJournalEntryBypassingAppCheck(stack.ctx, {
        branchId: stack.branchId,
        fiscalPeriodId,
        entryDate: '2026-01-05',
        currencyCode: 'EGP',
        sourceDocumentType: 'test-bypass',
        lines: [
          { accountId: cashAccountId, debit: '100.00', credit: '0' },
          { accountId: revenueAccountId, debit: '0', credit: '99.99' },
        ],
      }),
    ).rejects.toThrow(/غير متوازن/); // رسالة الـ trigger نفسها بالعربية

    const count = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id = $1`, [stack.companyId]);
    expect(Number(count.rows[0].count)).toBe(0); // الـ ROLLBACK ألغى كل شيء، بما فيه رأس القيد
  });

  it('طبقة قاعدة البيانات: تقبل COMMIT لقيد متوازن حتى عبر المسار المتجاوز لتحقق التطبيق', async () => {
    const stack = await createFullTenantStack('jbal-db-ok');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    const result = await postJournalEntryBypassingAppCheck(stack.ctx, {
      branchId: stack.branchId,
      fiscalPeriodId,
      entryDate: '2026-01-05',
      currencyCode: 'EGP',
      sourceDocumentType: 'test-bypass-ok',
      lines: [
        { accountId: cashAccountId, debit: '75.25', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '75.25' },
      ],
    });
    const persisted = await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [result.id]);
    expect(persisted.rows[0].status).toBe('posted');
  });

  it('لا يمكن حذف أو تعديل مبلغ قيد مرحّل مباشرة عبر SQL (trigger منفصل يحمي posted)', async () => {
    const stack = await createFullTenantStack('jbal-immutable');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const result = await postJournalEntry(stack.ctx, {
      branchId: stack.branchId,
      fiscalPeriodId,
      entryDate: '2026-01-05',
      currencyCode: 'EGP',
      sourceDocumentType: 'test-immutable',
      lines: [
        { accountId: cashAccountId, debit: '40', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '40' },
      ],
    });

    await expect(
      pool.query(`DELETE FROM journal_entries WHERE id = $1`, [result.id]),
    ).rejects.toThrow(/لا يمكن حذف قيد مرحّل/);

    await expect(
      pool.query(`UPDATE journal_entries SET currency_code = 'USD' WHERE id = $1`, [result.id]),
    ).rejects.toThrow(/لا يمكن تعديل بيانات قيد مرحّل/);
  });
});
