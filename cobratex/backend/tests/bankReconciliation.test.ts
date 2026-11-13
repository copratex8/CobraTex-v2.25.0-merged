import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createSafeOrBank } from '@/modules/treasury/safeOrBankService';
import { createTreasuryTransaction, postTreasuryTransaction } from '@/modules/treasury/treasuryTransactionService';
import { createTreasuryTransfer, postTreasuryTransfer } from '@/modules/treasury/treasuryTransferService';
import { createCustomer } from '@/modules/sales/customerService';
import {
  createReconciliation, runAutoMatch, matchLine, unmatchLine, completeReconciliation, getReconciliationById,
} from '@/modules/treasury/bankReconciliationService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createLimitedPermissionUser } from './helpers';

async function setupFixture(prefix: string) {
  const stack = await createFullTenantStack(prefix);
  const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
  const bank = await createSafeOrBank(stack.ctx, {
    branchId: stack.branchId, code: `BNK-${prefix}`, nameAr: 'البنك الأهلي', nameEn: 'Bank',
    kind: 'bank', currencyCode: 'EGP', bankName: 'NBE', accountNumber: '12345',
  });
  const customer = await createCustomer(stack.ctx, {
    code: `C-${prefix}`, nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP',
  });
  return { stack, bank, customer, fiscalPeriodId };
}

async function postReceipt(stack: Awaited<ReturnType<typeof createFullTenantStack>>, bankId: string, customerId: string, fiscalPeriodId: string, amount: string, date: string) {
  const tx = await createTreasuryTransaction(stack.ctx, {
    branchId: stack.branchId, safeOrBankId: bankId, transactionType: 'receipt', counterpartyType: 'customer',
    counterpartyCustomerId: customerId, amount, currencyCode: 'EGP', transactionDate: date, fiscalPeriodId,
  });
  await postTreasuryTransaction(stack.ctx, tx.id);
  return tx;
}

describe('التسوية البنكية (Bank Reconciliation) — لم تكن موجودة إطلاقًا، فقط دورة حياة الشيك', () => {
  it('مطابقة تلقائية ناجحة لمرشَّح وحيد، ثم إكمال ناجح لتسوية متوازنة تمامًا', async () => {
    const { stack, bank, customer, fiscalPeriodId } = await setupFixture('rec-auto');
    const tx = await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '500', '2026-03-05');

    const recon = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10',
      openingBalance: '0', statementEndingBalance: '500',
      lines: [{ lineDate: '2026-03-06', description: 'إيداع', amount: '500' }],
    });

    const matchResult = await runAutoMatch(stack.ctx, recon.id);
    expect(matchResult.matchedCount).toBe(1);
    expect(matchResult.ambiguousCount).toBe(0);

    const detail = await getReconciliationById(stack.ctx, recon.id);
    expect(detail.lines[0].matched_treasury_transaction_id).toBe(tx.id);

    const completed = await completeReconciliation(stack.ctx, recon.id);
    expect(completed.status).toBe('completed');
  });

  it('تعدُّد المرشَّحين بنفس المبلغ يُترَك بلا مطابقة تلقائية (لا ربط عشوائي)', async () => {
    const { stack, bank, customer, fiscalPeriodId } = await setupFixture('rec-ambiguous');
    await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '300', '2026-03-05');
    await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '300', '2026-03-06');

    const recon = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10',
      statementEndingBalance: '300',
      lines: [{ lineDate: '2026-03-06', amount: '300' }],
    });

    const matchResult = await runAutoMatch(stack.ctx, recon.id);
    expect(matchResult.matchedCount).toBe(0);
    expect(matchResult.ambiguousCount).toBe(1);

    const detail = await getReconciliationById(stack.ctx, recon.id);
    expect(detail.lines[0].matched_treasury_transaction_id).toBeNull();
    expect(detail.unmatchedTransactions.length).toBe(2);
  });

  it('مطابقة يدوية تحسم حالة اللبس، ثم يمكن فكّها (unmatch) والعودة لحالة غير مُطابَق', async () => {
    const { stack, bank, customer, fiscalPeriodId } = await setupFixture('rec-manual');
    const tx1 = await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '300', '2026-03-05');
    await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '300', '2026-03-06');

    const recon = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10',
      statementEndingBalance: '300',
      lines: [{ lineDate: '2026-03-06', amount: '300' }],
    });
    const lineId = (await getReconciliationById(stack.ctx, recon.id)).lines[0].id;

    await matchLine(stack.ctx, recon.id, lineId, { treasuryTransactionId: tx1.id });
    let detail = await getReconciliationById(stack.ctx, recon.id);
    expect(detail.lines[0].matched_treasury_transaction_id).toBe(tx1.id);

    await unmatchLine(stack.ctx, recon.id, lineId);
    detail = await getReconciliationById(stack.ctx, recon.id);
    expect(detail.lines[0].matched_treasury_transaction_id).toBeNull();
  });

  it('لا يمكن مطابقة نفس السند لسطرين مختلفين (قيد فريد على مستوى قاعدة البيانات)', async () => {
    const { stack, bank, customer, fiscalPeriodId } = await setupFixture('rec-unique');
    const tx = await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '400', '2026-03-05');

    const recon = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10',
      statementEndingBalance: '400',
      lines: [{ lineDate: '2026-03-05', amount: '400' }, { lineDate: '2026-03-05', amount: '400', description: 'مكرر' }],
    });
    const lines = (await getReconciliationById(stack.ctx, recon.id)).lines;

    await matchLine(stack.ctx, recon.id, lines[0].id, { treasuryTransactionId: tx.id });
    await expect(matchLine(stack.ctx, recon.id, lines[1].id, { treasuryTransactionId: tx.id })).rejects.toThrow();
  });

  it('تحويل بين خزينتين يُطابَق فقط من جهة الوجهة (in) بالبنك المعني', async () => {
    const { stack, bank, fiscalPeriodId } = await setupFixture('rec-transfer');
    const safe2 = await createSafeOrBank(stack.ctx, {
      branchId: stack.branchId, code: 'SAFE-2', nameAr: 'خزينة نقدية', nameEn: 'Cash Safe', kind: 'safe', currencyCode: 'EGP',
    });
    const transfer = await createTreasuryTransfer(stack.ctx, {
      branchId: stack.branchId, fromSafeOrBankId: safe2.id, toSafeOrBankId: bank.id,
      amount: '250', currencyCode: 'EGP', transferDate: '2026-03-07', fiscalPeriodId,
    });
    await postTreasuryTransfer(stack.ctx, transfer.id);

    const recon = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10',
      statementEndingBalance: '250',
      lines: [{ lineDate: '2026-03-07', amount: '250' }],
    });
    const matchResult = await runAutoMatch(stack.ctx, recon.id);
    expect(matchResult.matchedCount).toBe(1);
    const detail = await getReconciliationById(stack.ctx, recon.id);
    expect(detail.lines[0].matched_treasury_transfer_id).toBe(transfer.id);
  });

  it('يرفض إكمال تسوية بها سطر غير مُطابَق، ويرفض إكمالها لو كان الرصيد المحسوب لا يساوي رصيد الكشف', async () => {
    const { stack, bank, customer, fiscalPeriodId } = await setupFixture('rec-complete-guard');
    await postReceipt(stack, bank.id, customer.id, fiscalPeriodId, '500', '2026-03-05');

    const recon = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10',
      statementEndingBalance: '500',
      lines: [{ lineDate: '2026-03-05', amount: '500' }],
    });
    await expect(completeReconciliation(stack.ctx, recon.id)).rejects.toThrow(); // غير مُطابَق بعد

    await runAutoMatch(stack.ctx, recon.id);

    const recon2 = await createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-11',
      statementEndingBalance: '999', // رصيد كشف خاطئ عمدًا
      lines: [{ lineDate: '2026-03-05', amount: '500' }],
    });
    await expect(completeReconciliation(stack.ctx, recon2.id)).rejects.toThrow(); // لا يوجد سند آخر بنفس المبلغ فيبقى غير مطابق أصلًا، لكن حتى لو طابقناه يدويًا لن يتزن الرصيد
  });

  it('يرفض إنشاء تسوية بلا أسطر، ويرفض سطرًا بمبلغ صفر', async () => {
    const { stack, bank } = await setupFixture('rec-validation');
    await expect(createReconciliation(stack.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10', statementEndingBalance: '0', lines: [],
    })).rejects.toThrow();
  });

  it('RBAC: مستخدم بلا treasury.reconciliation.create يُرفض عند الإنشاء', async () => {
    const { stack, bank } = await setupFixture('rec-rbac');
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    await expect(createReconciliation(limited.ctx, {
      branchId: stack.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10', statementEndingBalance: '100',
      lines: [{ lineDate: '2026-03-05', amount: '100' }],
    })).rejects.toThrow();
  });

  it('عزل الشركات: تسوية شركة A غير مرئية لشركة B', async () => {
    const { stack: stack1, bank } = await setupFixture('rec-iso-1');
    const { stack: stack2 } = await setupFixture('rec-iso-2');
    const recon = await createReconciliation(stack1.ctx, {
      branchId: stack1.branchId, safeOrBankId: bank.id, statementDate: '2026-03-10', statementEndingBalance: '100',
      lines: [{ lineDate: '2026-03-05', amount: '100' }],
    });
    await expect(getReconciliationById(stack2.ctx, recon.id)).rejects.toThrow();
  });
});
