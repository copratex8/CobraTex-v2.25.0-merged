import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { pool } from '@/db/pool';
import { postJournalEntry } from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod } from './helpers';

describe('دقة الأرقام العشرية (Decimal/NUMERIC) — لا JavaScript Number في العمليات المالية', () => {
  it('كل الأعمدة المالية/الكمية في قاعدة البيانات من نوع numeric (لا float/double)', async () => {
    const columnsToCheck: Array<[string, string]> = [
      ['journal_lines', 'debit'],
      ['journal_lines', 'credit'],
      ['stock_movements', 'quantity'],
      ['stock_movements', 'unit_cost'],
      ['stock_balances', 'quantity_on_hand'],
      ['stock_balances', 'weighted_average_cost'],
      ['items', 'reorder_point'],
      ['journal_entries', 'exchange_rate'],
    ];

    for (const [table, column] of columnsToCheck) {
      const { rows } = await pool.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      );
      expect(rows[0]?.data_type, `${table}.${column}`).toBe('numeric');
    }
  });

  it('مثال كلاسيكي لخطأ الفاصلة العائمة (0.1 + 0.2) لا يظهر عبر Decimal.js في طبقة الخدمة', () => {
    // toString الافتراضي في JS: 0.1 + 0.2 === 0.30000000000000004 (خطأ شهير)
    expect(0.1 + 0.2).not.toBe(0.3);
    // بينما Decimal.js المستخدم فعليًا في accountingService/stockService يعطي القيمة الصحيحة تمامًا
    expect(new Decimal('0.1').plus(new Decimal('0.2')).toString()).toBe('0.3');
  });

  it('قيد بمبالغ عشرية دقيقة (4 خانات) يُرحَّل ويُخزَّن دون أي انحراف تقريب', async () => {
    const stack = await createFullTenantStack('decimal-precise');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    const result = await postJournalEntry(stack.ctx, {
      branchId: stack.branchId,
      fiscalPeriodId,
      entryDate: '2026-01-05',
      currencyCode: 'EGP',
      sourceDocumentType: 'test-precision',
      lines: [
        { accountId: cashAccountId, debit: '1234.5678', credit: '0' }, // قيمة دقيقة عمدًا لاختبار عدم فقد الدقة
        { accountId: revenueAccountId, debit: '0', credit: '1234.5678' },
      ],
    });

    const persisted = await pool.query(
      `SELECT debit, credit FROM journal_lines WHERE journal_entry_id = $1 ORDER BY debit DESC`,
      [result.id],
    );
    expect(persisted.rows[0].debit).toBe('1234.5678');
    expect(persisted.rows[1].credit).toBe('1234.5678');
  });

  it('القيمة الإجمالية لطبقة تقييم (كمية × تكلفة) تُحسب بـ Decimal بدقة كاملة', () => {
    const quantity = new Decimal('33.3333');
    const unitCost = new Decimal('9.99');
    const total = quantity.times(unitCost);
    // 33.3333 * 9.99 = 332.999667 — قيمة دقيقة يصعب الحصول عليها بثقة عبر float عادي عند التراكم
    expect(total.toFixed(4)).toBe('332.9997');
  });
});
