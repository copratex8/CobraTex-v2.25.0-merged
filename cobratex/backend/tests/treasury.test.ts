import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createSupplier } from '@/modules/purchasing/supplierService';
import { createSafeOrBank } from '@/modules/treasury/safeOrBankService';
import {
  createTreasuryTransaction, postTreasuryTransaction, reverseTreasuryTransaction,
} from '@/modules/treasury/treasuryTransactionService';
import {
  createTreasuryTransfer, postTreasuryTransfer,
} from '@/modules/treasury/treasuryTransferService';
import { registerCheck, transitionCheckStatus } from '@/modules/treasury/checkService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createLimitedPermissionUser } from './helpers';

const app = createApp();

async function setupTreasuryFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { fiscalPeriodId, revenueAccountId } = await createAccountAndFiscalPeriod(stack.companyId);
  const safe = await createSafeOrBank(stack.ctx, {
    branchId: stack.branchId, code: `SAFE-${prefix}`, nameAr: 'الخزينة الرئيسية', nameEn: 'Main Safe',
    kind: 'safe', currencyCode: 'EGP',
  });
  const bank = await createSafeOrBank(stack.ctx, {
    branchId: stack.branchId, code: `BANK-${prefix}`, nameAr: 'بنك مصر', nameEn: 'Bank Misr',
    kind: 'bank', currencyCode: 'EGP', bankName: 'Bank Misr', accountNumber: '123456789',
  });
  return { stack, fiscalPeriodId, revenueAccountId, safe, bank };
}

describe('الخزائن والبنوك — إنشاء ذري بحساب فرعي', () => {
  it('إنشاء خزينة ينشئ حسابًا فرعيًا (TR-<code>) مرتبطًا فعليًا في نفس المعاملة', async () => {
    const f = await setupTreasuryFixture('safe-atomic');
    const account = await pool.query(`SELECT code, account_type FROM accounts WHERE id=$1`, [f.safe.linked_account_id]);
    expect(account.rows[0].code).toBe(`TR-SAFE-safe-atomic`);
    expect(account.rows[0].account_type).toBe('asset');
  });

  it('البنك يتطلب bank_name وaccount_number (قيد CHECK في قاعدة البيانات)', async () => {
    const stack = await createFullTenantStack('bank-required-fields');
    await expect(
      createSafeOrBank(stack.ctx, {
        branchId: stack.branchId, code: 'BANK-BAD', nameAr: 'بنك', nameEn: 'Bank', kind: 'bank', currencyCode: 'EGP',
      }),
    ).rejects.toThrow();
  });

  it('كود مكرر يُرفض (409) ولا يُترك حساب يتيم', async () => {
    const f = await setupTreasuryFixture('safe-dup');
    const before = await pool.query(`SELECT count(*) FROM accounts WHERE company_id=$1`, [f.stack.companyId]);
    await expect(
      createSafeOrBank(f.stack.ctx, {
        branchId: f.stack.branchId, code: `SAFE-safe-dup`, nameAr: 'تكرار', nameEn: 'Dup', kind: 'safe', currencyCode: 'EGP',
      }),
    ).rejects.toThrow();
    const after = await pool.query(`SELECT count(*) FROM accounts WHERE company_id=$1`, [f.stack.companyId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});

describe('سندات القبض والصرف', () => {
  it('سند قبض من عميل: مدين الخزينة، دائن حساب العميل، قيد متوازن', async () => {
    const f = await setupTreasuryFixture('rv-customer');
    const customer = await createCustomer(f.stack.ctx, { code: 'RVC-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });

    const voucher = await createTreasuryTransaction(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'customer',
      counterpartyCustomerId: customer.id, amount: '500', currencyCode: 'EGP', transactionDate: '2026-03-01',
      fiscalPeriodId: f.fiscalPeriodId,
    });
    expect(voucher.document_number).toMatch(/^RV-/);

    const result = await postTreasuryTransaction(f.stack.ctx, voucher.id);
    const lines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    expect(lines.rows).toHaveLength(2);
    const safeLine = lines.rows.find((l) => l.account_id === f.safe.linked_account_id);
    expect(safeLine.debit).toBe('500.0000');
    const custLine = lines.rows.find((l) => l.account_id !== f.safe.linked_account_id);
    expect(custLine.credit).toBe('500.0000');
  });

  it('سند صرف لمورد: مدين حساب المورد، دائن البنك', async () => {
    const f = await setupTreasuryFixture('pv-supplier');
    const supplier = await createSupplier(f.stack.ctx, { code: 'PVS-1', nameAr: 'م', nameEn: 'S', currencyCode: 'EGP' });

    const voucher = await createTreasuryTransaction(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.bank.id, transactionType: 'payment', counterpartyType: 'supplier',
      counterpartySupplierId: supplier.id, amount: '300', currencyCode: 'EGP', transactionDate: '2026-03-01',
      fiscalPeriodId: f.fiscalPeriodId,
    });
    expect(voucher.document_number).toMatch(/^PV-/);
    const result = await postTreasuryTransaction(f.stack.ctx, voucher.id);
    const lines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    const bankLine = lines.rows.find((l) => l.account_id === f.bank.linked_account_id);
    expect(bankLine.credit).toBe('300.0000');
  });

  it('سند قبض "أخرى" (other) بحساب مقابل ثابت (مثال: إيراد متنوع)', async () => {
    const f = await setupTreasuryFixture('rv-other');
    const voucher = await createTreasuryTransaction(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'other',
      contraAccountId: f.revenueAccountId, amount: '150', currencyCode: 'EGP', transactionDate: '2026-03-01',
      fiscalPeriodId: f.fiscalPeriodId,
    });
    const result = await postTreasuryTransaction(f.stack.ctx, voucher.id);
    const lines = await pool.query(`SELECT account_id, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    const revLine = lines.rows.find((l) => l.account_id === f.revenueAccountId);
    expect(revLine.credit).toBe('150.0000');
  });

  it('يرفض إنشاء سند "عميل" بلا counterpartyCustomerId', async () => {
    const f = await setupTreasuryFixture('rv-invalid');
    await expect(
      createTreasuryTransaction(f.stack.ctx, {
        branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'customer',
        amount: '100', currencyCode: 'EGP', transactionDate: '2026-03-01', fiscalPeriodId: f.fiscalPeriodId,
      }),
    ).rejects.toThrow(/counterpartyCustomerId إلزامي/);
  });

  it('عكس السند: يعكس القيد، ولا يمكن ترحيله مجددًا', async () => {
    const f = await setupTreasuryFixture('rv-reverse');
    const customer = await createCustomer(f.stack.ctx, { code: 'RVR-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const voucher = await createTreasuryTransaction(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'customer',
      counterpartyCustomerId: customer.id, amount: '200', currencyCode: 'EGP', transactionDate: '2026-03-01',
      fiscalPeriodId: f.fiscalPeriodId,
    });
    await postTreasuryTransaction(f.stack.ctx, voucher.id);
    const reversed = await reverseTreasuryTransaction(f.stack.ctx, voucher.id, 'خطأ في السند');
    expect(reversed.status).toBe('reversed');

    await expect(postTreasuryTransaction(f.stack.ctx, voucher.id)).rejects.toThrow(/يجب أن يكون draft/);
  });

  it('Idempotent عبر HTTP لترحيل السند', async () => {
    const f = await setupTreasuryFixture('rv-idem');
    const customer = await createCustomer(f.stack.ctx, { code: 'RVI-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const voucher = await createTreasuryTransaction(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'customer',
      counterpartyCustomerId: customer.id, amount: '100', currencyCode: 'EGP', transactionDate: '2026-03-01',
      fiscalPeriodId: f.fiscalPeriodId,
    });
    const key = 'voucher-post-key';
    const first = await request(app).post(`/api/treasury/transactions/${voucher.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    const second = await request(app).post(`/api/treasury/transactions/${voucher.id}/post`).set('Authorization', `Bearer ${f.stack.token}`).set('Idempotency-Key', key).send({});
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const entries = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1 AND source_document_id=$2`, [f.stack.companyId, voucher.id]);
    expect(Number(entries.rows[0].count)).toBe(1);
  });

  it('RBAC: 403 لمستخدم بلا treasury.transaction.create', async () => {
    const f = await setupTreasuryFixture('rv-rbac');
    const customer = await createCustomer(f.stack.ctx, { code: 'RVRBAC-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const limited = await createLimitedPermissionUser(f.stack.tenantId, f.stack.companyId, f.stack.branchId, []);
    await expect(
      createTreasuryTransaction(limited.ctx, {
        branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'customer',
        counterpartyCustomerId: customer.id, amount: '10', currencyCode: 'EGP', transactionDate: '2026-03-01',
        fiscalPeriodId: f.fiscalPeriodId,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('عزل المؤسسات: شركة أخرى لا ترى سند شركة أخرى (404)', async () => {
    const f = await setupTreasuryFixture('rv-iso-a');
    const other = await createFullTenantStack('rv-iso-b');
    const customer = await createCustomer(f.stack.ctx, { code: 'RVISO-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const voucher = await createTreasuryTransaction(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.safe.id, transactionType: 'receipt', counterpartyType: 'customer',
      counterpartyCustomerId: customer.id, amount: '10', currencyCode: 'EGP', transactionDate: '2026-03-01',
      fiscalPeriodId: f.fiscalPeriodId,
    });
    const res = await request(app).get(`/api/treasury/transactions/${voucher.id}`).set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(404);
  });
});

describe('التحويل بين خزينتين/بنكين', () => {
  it('تحويل من الخزينة إلى البنك: مدين البنك، دائن الخزينة، قيد متوازن', async () => {
    const f = await setupTreasuryFixture('transfer-happy');
    const transfer = await createTreasuryTransfer(f.stack.ctx, {
      branchId: f.stack.branchId, fromSafeOrBankId: f.safe.id, toSafeOrBankId: f.bank.id,
      amount: '1000', currencyCode: 'EGP', transferDate: '2026-03-01', fiscalPeriodId: f.fiscalPeriodId,
    });
    const result = await postTreasuryTransfer(f.stack.ctx, transfer.id);
    const lines = await pool.query(`SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    const bankLine = lines.rows.find((l) => l.account_id === f.bank.linked_account_id);
    const safeLine = lines.rows.find((l) => l.account_id === f.safe.linked_account_id);
    expect(bankLine.debit).toBe('1000.0000');
    expect(safeLine.credit).toBe('1000.0000');
  });

  it('يرفض التحويل من خزينة إلى نفسها', async () => {
    const f = await setupTreasuryFixture('transfer-self');
    await expect(
      createTreasuryTransfer(f.stack.ctx, {
        branchId: f.stack.branchId, fromSafeOrBankId: f.safe.id, toSafeOrBankId: f.safe.id,
        amount: '100', currencyCode: 'EGP', transferDate: '2026-03-01', fiscalPeriodId: f.fiscalPeriodId,
      }),
    ).rejects.toThrow(/لا يمكن التحويل من خزينة\/بنك إلى نفسه/);
  });
});

describe('دورة حياة الشيك (pending → deposited → cleared/bounced)', () => {
  it('شيك وارد: يُسجَّل بلا أثر مالي، ثم يُودَع، ثم يُحصَّل فيُنشئ ويُرحِّل سند قبض تلقائيًا', async () => {
    const f = await setupTreasuryFixture('check-incoming-happy');
    const customer = await createCustomer(f.stack.ctx, { code: 'CHK-C1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });

    const entriesBefore = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1`, [f.stack.companyId]);
    const check = await registerCheck(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.bank.id, checkType: 'incoming', checkNumber: 'CHK-1001',
      checkDate: '2026-03-01', dueDate: '2026-03-15', amount: '750', currencyCode: 'EGP', counterpartyCustomerId: customer.id,
    });
    expect(check.status).toBe('pending');
    const entriesAfterRegister = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1`, [f.stack.companyId]);
    expect(entriesAfterRegister.rows[0].count).toBe(entriesBefore.rows[0].count); // لا أثر مالي عند التسجيل

    const deposited = await transitionCheckStatus(f.stack.ctx, check.id, 'deposited');
    expect(deposited.status).toBe('deposited');
    const entriesAfterDeposit = await pool.query(`SELECT count(*) FROM journal_entries WHERE company_id=$1`, [f.stack.companyId]);
    expect(entriesAfterDeposit.rows[0].count).toBe(entriesBefore.rows[0].count); // لا أثر مالي عند الإيداع أيضًا

    const cleared = await transitionCheckStatus(f.stack.ctx, check.id, 'cleared', { fiscalPeriodId: f.fiscalPeriodId, clearDate: '2026-03-16' });
    expect(cleared.status).toBe('cleared');
    expect(cleared.treasuryTransactionId).toBeTruthy();

    const journalLines = await pool.query(
      `SELECT jl.debit, jl.credit, jl.account_id FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE je.source_document_type='treasury_transaction' AND je.source_document_id=$1`,
      [cleared.treasuryTransactionId],
    );
    const bankLine = journalLines.rows.find((l) => l.account_id === f.bank.linked_account_id);
    expect(bankLine.debit).toBe('750.0000');

    const checkRow = await pool.query(`SELECT status, treasury_transaction_id FROM checks WHERE id=$1`, [check.id]);
    expect(checkRow.rows[0].status).toBe('cleared');
    expect(checkRow.rows[0].treasury_transaction_id).toBe(cleared.treasuryTransactionId);
  });

  it('شيك صادر يرتدّ (bounced) بعد الإيداع: بسبب إلزامي، بلا أثر مالي', async () => {
    const f = await setupTreasuryFixture('check-outgoing-bounce');
    const supplier = await createSupplier(f.stack.ctx, { code: 'CHK-S1', nameAr: 'م', nameEn: 'S', currencyCode: 'EGP' });
    const check = await registerCheck(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.bank.id, checkType: 'outgoing', checkNumber: 'CHK-2001',
      checkDate: '2026-03-01', dueDate: '2026-03-15', amount: '400', currencyCode: 'EGP', counterpartySupplierId: supplier.id,
    });
    await transitionCheckStatus(f.stack.ctx, check.id, 'deposited');

    await expect(transitionCheckStatus(f.stack.ctx, check.id, 'bounced')).rejects.toThrow(/السبب إلزامي/);

    const bounced = await transitionCheckStatus(f.stack.ctx, check.id, 'bounced', { reason: 'رصيد غير كافٍ' });
    expect(bounced.status).toBe('bounced');

    const txCount = await pool.query(`SELECT count(*) FROM treasury_transactions WHERE company_id=$1`, [f.stack.companyId]);
    expect(Number(txCount.rows[0].count)).toBe(0); // لا معاملة خزينة أُنشئت لشيك مرتدّ
  });

  it('يرفض القفز غير المسموح: pending مباشرة إلى cleared', async () => {
    const f = await setupTreasuryFixture('check-jump');
    const customer = await createCustomer(f.stack.ctx, { code: 'CHK-J1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const check = await registerCheck(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.bank.id, checkType: 'incoming', checkNumber: 'CHK-3001',
      checkDate: '2026-03-01', dueDate: '2026-03-15', amount: '100', currencyCode: 'EGP', counterpartyCustomerId: customer.id,
    });
    await expect(
      transitionCheckStatus(f.stack.ctx, check.id, 'cleared', { fiscalPeriodId: f.fiscalPeriodId }),
    ).rejects.toThrow(/انتقال حالة غير مسموح: pending → cleared/);
  });

  it('يرفض تسجيل شيك وارد بلا counterpartyCustomerId، وشيك صادر بلا counterpartySupplierId', async () => {
    const f = await setupTreasuryFixture('check-invalid');
    await expect(
      registerCheck(f.stack.ctx, {
        branchId: f.stack.branchId, safeOrBankId: f.bank.id, checkType: 'incoming', checkNumber: 'CHK-BAD-1',
        checkDate: '2026-03-01', dueDate: '2026-03-15', amount: '100', currencyCode: 'EGP',
      }),
    ).rejects.toThrow(/الشيك الوارد يتطلب/);
  });

  it('إلغاء شيك من pending مباشرة (لم يُودَع بعد) بسبب إلزامي', async () => {
    const f = await setupTreasuryFixture('check-cancel');
    const customer = await createCustomer(f.stack.ctx, { code: 'CHK-CNL-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const check = await registerCheck(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.bank.id, checkType: 'incoming', checkNumber: 'CHK-4001',
      checkDate: '2026-03-01', dueDate: '2026-03-15', amount: '50', currencyCode: 'EGP', counterpartyCustomerId: customer.id,
    });
    const cancelled = await transitionCheckStatus(f.stack.ctx, check.id, 'cancelled', { reason: 'خطأ في الإدخال' });
    expect(cancelled.status).toBe('cancelled');
  });

  it('يسجّل كل انتقالات الشيك في سجل التدقيق', async () => {
    const f = await setupTreasuryFixture('check-audit');
    const customer = await createCustomer(f.stack.ctx, { code: 'CHK-AUD-1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const check = await registerCheck(f.stack.ctx, {
      branchId: f.stack.branchId, safeOrBankId: f.bank.id, checkType: 'incoming', checkNumber: 'CHK-5001',
      checkDate: '2026-03-01', dueDate: '2026-03-15', amount: '80', currencyCode: 'EGP', counterpartyCustomerId: customer.id,
    });
    await transitionCheckStatus(f.stack.ctx, check.id, 'deposited');
    await transitionCheckStatus(f.stack.ctx, check.id, 'cleared', { fiscalPeriodId: f.fiscalPeriodId });

    const logs = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_type='check' AND entity_id=$1 ORDER BY created_at ASC`, [check.id],
    );
    expect(logs.rows.map((r) => r.action)).toEqual(['create', 'update', 'post']);
  });
});
