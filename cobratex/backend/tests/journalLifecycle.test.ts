import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import {
  createDraftJournalEntry,
  transitionJournalEntryStatus,
  reverseJournalEntry,
} from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod } from './helpers';

describe('دورة حياة المستند المحاسبي (draft → pending_review → approved → posted)', () => {
  it('يمر بالتسلسل الكامل بنجاح ويسجّل كل انتقال في سجل التدقيق', async () => {
    const stack = await createFullTenantStack('lc-happy');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [
        { accountId: cashAccountId, debit: '50', credit: '0' },
        { accountId: revenueAccountId, debit: '0', credit: '50' },
      ],
    });

    let status = await pool.query(`SELECT status FROM journal_entries WHERE id=$1`, [draft.id]);
    expect(status.rows[0].status).toBe('draft');

    await transitionJournalEntryStatus(stack.ctx, draft.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'posted');

    status = await pool.query(`SELECT status FROM journal_entries WHERE id=$1`, [draft.id]);
    expect(status.rows[0].status).toBe('posted');

    const audit = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_type='journal_entry' AND entity_id=$1 ORDER BY created_at ASC`,
      [draft.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['create', 'submit', 'approve', 'post']);
  });

  it('يرفض القفز غير المسموح: draft مباشرة إلى posted', async () => {
    const stack = await createFullTenantStack('lc-jump');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '10', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '10' }],
    });

    await expect(
      transitionJournalEntryStatus(stack.ctx, draft.id, 'posted'),
    ).rejects.toThrow(/انتقال حالة غير مسموح: draft → posted/);
  });

  it('يرفض القفز غير المسموح: approved مباشرة إلى cancelled (غير معرَّف في جدول الانتقالات)', async () => {
    const stack = await createFullTenantStack('lc-jump2');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '10', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '10' }],
    });
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'approved');

    await expect(
      transitionJournalEntryStatus(stack.ctx, draft.id, 'cancelled'),
    ).rejects.toThrow(/انتقال حالة غير مسموح: approved → cancelled/);
  });

  it('يرفض الرفض/الإلغاء بلا سبب، ويقبله مع سبب ويسجّل من رفض ومتى', async () => {
    const stack = await createFullTenantStack('lc-reject-reason');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '10', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '10' }],
    });
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'pending_review');

    await expect(
      transitionJournalEntryStatus(stack.ctx, draft.id, 'rejected'), // بلا سبب
    ).rejects.toThrow(/السبب إلزامي/);

    const rejected = await transitionJournalEntryStatus(stack.ctx, draft.id, 'rejected', 'مستندات ناقصة');
    expect(rejected.status).toBe('rejected');

    const row = await pool.query(`SELECT cancelled_reason, cancelled_by, cancelled_at FROM journal_entries WHERE id=$1`, [draft.id]);
    expect(row.rows[0].cancelled_reason).toBe('مستندات ناقصة');
    expect(row.rows[0].cancelled_by).toBe(stack.userId);
    expect(row.rows[0].cancelled_at).not.toBeNull();
  });

  it('يمنع تعديل قيد بعد الترحيل (posted) بنيويًا، حتى عبر محاولة انتقال حالة غير مسموحة', async () => {
    const stack = await createFullTenantStack('lc-no-edit-posted');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '10', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '10' }],
    });
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'posted');

    await expect(
      transitionJournalEntryStatus(stack.ctx, draft.id, 'approved'), // posted ليست في TRANSITIONS، فلا يوجد انتقال مسموح
    ).rejects.toThrow(/انتقال حالة غير مسموح: posted → approved/);
  });
});

describe('عكس القيد المرحّل (Reversal)', () => {
  it('ينشئ قيدًا عكسيًا متوازنًا ويربطه عبر reversal_of_entry_id، ويحوّل الأصلي إلى reversed', async () => {
    const stack = await createFullTenantStack('rev-happy');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '300', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '300' }],
    });
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'posted');

    const result = await reverseJournalEntry(stack.ctx, draft.id, 'إلغاء عملية بيع بالخطأ');

    const original = await pool.query(`SELECT status, cancelled_reason FROM journal_entries WHERE id=$1`, [draft.id]);
    expect(original.rows[0].status).toBe('reversed');
    expect(original.rows[0].cancelled_reason).toBe('إلغاء عملية بيع بالخطأ');

    const reversal = await pool.query(`SELECT status, reversal_of_entry_id FROM journal_entries WHERE id=$1`, [result.reversalEntryId]);
    expect(reversal.rows[0].status).toBe('posted');
    expect(reversal.rows[0].reversal_of_entry_id).toBe(draft.id);

    const reversalLines = await pool.query(
      `SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1 ORDER BY debit DESC`,
      [result.reversalEntryId],
    );
    // الأسطر معكوسة: الحساب الذي كان مدينًا أصبح دائنًا وبالعكس
    expect(reversalLines.rows[0].account_id).toBe(revenueAccountId);
    expect(reversalLines.rows[0].debit).toBe('300.0000');
    expect(reversalLines.rows[1].account_id).toBe(cashAccountId);
    expect(reversalLines.rows[1].credit).toBe('300.0000');
  });

  it('يرفض عكس قيد غير مرحّل (draft)', async () => {
    const stack = await createFullTenantStack('rev-not-posted');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '10', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '10' }],
    });

    await expect(reverseJournalEntry(stack.ctx, draft.id, 'سبب')).rejects.toThrow(/يجب أن يكون مرحّلًا/);
  });

  it('يرفض بنيويًا (DB trigger) تحويل قيد إلى reversed مباشرة عبر SQL بلا قيد عكسي فعلي مرتبط', async () => {
    const stack = await createFullTenantStack('rev-db-guard');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const draft = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '10', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '10' }],
    });
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, draft.id, 'posted');

    await expect(
      pool.query(`UPDATE journal_entries SET status='reversed' WHERE id=$1`, [draft.id]),
    ).rejects.toThrow(/بدون قيد عكسي متوازن مرتبط فعليًا/);
  });
});

describe('فحص التوازن عند إعادة تعيين journal_entry_id لسطر (دفاع متعدد الطبقات)', () => {
  it('AFTER trigger يتحقق من توازن القيد القديم والجديد معًا عند نقل سطر بينهما (اختبار معزول للطبقة الثانية)', async () => {
    const stack = await createFullTenantStack('cross-entry-balance');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    // قيدان مرحّلان ومتوازنان بشكل مستقل
    const entryA = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '100', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '100' }],
    });
    await transitionJournalEntryStatus(stack.ctx, entryA.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, entryA.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, entryA.id, 'posted');

    const entryB = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-06', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '50', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '50' }],
    });
    await transitionJournalEntryStatus(stack.ctx, entryB.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, entryB.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, entryB.id, 'posted');

    const lineToMove = await pool.query(
      `SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND debit > 0`, [entryA.id],
    );

    // نعطّل مؤقتًا حارس "منع تعديل سطر قيد مرحّل" (طبقة الدفاع الأولى) داخل هذه المعاملة فقط،
    // لعزل اختبار طبقة الدفاع الثانية (AFTER trigger المؤجَّل الذي يفحص توازن القيدين معًا) —
    // في المسار الطبيعي، الطبقة الأولى تمنع هذه العملية أصلًا قبل وصولنا هنا.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER trg_forbid_posted_journal_line_mutation`);
      // نقل سطر المدين (100) من entryA إلى entryB يجعل entryA غير متوازن (يبقى فيه فقط سطر دائن 100)
      // ويجعل entryB غير متوازن أيضًا (يصبح فيه مدين 100+50=150 مقابل دائن 50 فقط)
      await client.query(`UPDATE journal_lines SET journal_entry_id=$1 WHERE id=$2`, [entryB.id, lineToMove.rows[0].id]);
      await expect(client.query('COMMIT')).rejects.toThrow(/غير متوازن/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER trg_forbid_posted_journal_line_mutation`).catch(() => undefined);
      client.release();
    }
  });

  it('الطبقة الأولى (BEFORE trigger) تمنع نقل سطر من/إلى قيد مرحّل في المسار الطبيعي دون تعطيل أي حارس', async () => {
    const stack = await createFullTenantStack('cross-entry-normal');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const entryA = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '20', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '20' }],
    });
    await transitionJournalEntryStatus(stack.ctx, entryA.id, 'pending_review');
    await transitionJournalEntryStatus(stack.ctx, entryA.id, 'approved');
    await transitionJournalEntryStatus(stack.ctx, entryA.id, 'posted');

    const entryB = await createDraftJournalEntry(stack.ctx, {
      branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-06', currencyCode: 'EGP',
      sourceDocumentType: 'test',
      lines: [{ accountId: cashAccountId, debit: '5', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '5' }],
    });

    const lineToMove = await pool.query(`SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND debit > 0`, [entryA.id]);

    await expect(
      pool.query(`UPDATE journal_lines SET journal_entry_id=$1 WHERE id=$2`, [entryB.id, lineToMove.rows[0].id]),
    ).rejects.toThrow(/لا يمكن تعديل سطر من قيد مرحّل/);
  });
});
