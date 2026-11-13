import { withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface CreateTreasuryTransferInput {
  branchId: string;
  fromSafeOrBankId: string;
  toSafeOrBankId: string;
  amount: string;
  currencyCode: string;
  exchangeRate?: string;
  transferDate: string;
  fiscalPeriodId: string;
}

export async function createTreasuryTransfer(ctx: RequestContext, input: CreateTreasuryTransferInput) {
  ctx.assertPermission('treasury.transfer.create', input.branchId);
  if (input.fromSafeOrBankId === input.toSafeOrBankId) {
    throw new ValidationError('لا يمكن التحويل من خزينة/بنك إلى نفسه');
  }

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'TREASURY_TRANSFER', prefix: 'TR-' },
      client,
    );
    const row = await client.query(
      `INSERT INTO treasury_transfers(
        company_id, branch_id, from_safe_or_bank_id, to_safe_or_bank_id, document_number, amount,
        currency_code, exchange_rate, transfer_date, fiscal_period_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.fromSafeOrBankId, input.toSafeOrBankId, documentNumber, input.amount,
        input.currencyCode, input.exchangeRate ?? '1', input.transferDate, input.fiscalPeriodId, ctx.userId,
      ],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'treasury_transfer', entityId: row.rows[0].id, action: 'create',
      afterJson: { documentNumber, amount: input.amount },
    });
    return row.rows[0];
  });
}

/** ترحيل التحويل: مدين حساب الخزينة/البنك الوجهة، دائن حساب الخزينة/البنك المصدر — قيد متوازن بسطرين. */
export async function postTreasuryTransfer(ctx: RequestContext, id: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM treasury_transfers WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('التحويل غير موجود');
    const transfer = found.rows[0];
    ctx.assertPermission('treasury.transfer.post', transfer.branch_id);
    if (transfer.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل تحويل بحالة ${transfer.status}؛ يجب أن يكون draft`);

    const fromSafe = await client.query(`SELECT linked_account_id FROM safe_or_banks WHERE id=$1`, [transfer.from_safe_or_bank_id]);
    const toSafe = await client.query(`SELECT linked_account_id FROM safe_or_banks WHERE id=$1`, [transfer.to_safe_or_bank_id]);

    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: transfer.branch_id, fiscalPeriodId: transfer.fiscal_period_id, entryDate: transfer.transfer_date,
      currencyCode: transfer.currency_code, exchangeRate: transfer.exchange_rate,
      sourceDocumentType: 'treasury_transfer', sourceDocumentId: id,
      lines: [
        { accountId: toSafe.rows[0].linked_account_id, debit: transfer.amount, credit: '0' },
        { accountId: fromSafe.rows[0].linked_account_id, debit: '0', credit: transfer.amount },
      ],
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE treasury_transfers SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [id, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'treasury_transfer', entityId: id, action: 'post', afterJson: { journalEntryId: draftEntry.id },
    });
    return { id, journalEntryId: draftEntry.id };
  });
}

export async function reverseTreasuryTransfer(ctx: RequestContext, id: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM treasury_transfers WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('التحويل غير موجود');
    const transfer = found.rows[0];
    ctx.assertPermission('treasury.transfer.reverse', transfer.branch_id);
    if (transfer.status !== 'posted') throw new ValidationError('يجب أن يكون التحويل مرحّلًا لعكسه');

    await reverseJournalEntry(ctx, transfer.journal_entry_id, reason);
    await client.query(
      `UPDATE treasury_transfers SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [id, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'treasury_transfer', entityId: id, action: 'reverse', reason,
    });
    return { id, status: 'reversed' };
  });
}

export async function getTreasuryTransferById(ctx: RequestContext, id: string) {
  ctx.assertPermission('treasury.transfer.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('treasury_transfers', id, ctx, {
    notFoundMessage: 'التحويل غير موجود',
  });
}

export async function listTreasuryTransfers(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('treasury.transfer.view');
  return paginatedList<unknown>(ctx, 'treasury_transfers', { page, pageSize, status });
}
