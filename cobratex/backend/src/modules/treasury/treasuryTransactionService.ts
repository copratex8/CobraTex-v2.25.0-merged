import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { fetchScopedById } from '@/shared/scope';
import { getSafeOrBankForPosting } from './safeOrBankService';
import { paginatedList } from '@/shared/pagination';

export type CounterpartyType = 'customer' | 'supplier' | 'other';

export interface CreateTreasuryTransactionInput {
  branchId: string;
  safeOrBankId: string;
  transactionType: 'receipt' | 'payment';
  counterpartyType: CounterpartyType;
  counterpartyCustomerId?: string;
  counterpartySupplierId?: string;
  contraAccountId?: string;
  amount: string;
  currencyCode: string;
  exchangeRate?: string;
  transactionDate: string;
  fiscalPeriodId: string;
  description?: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
}

function validateCounterparty(input: CreateTreasuryTransactionInput) {
  if (input.counterpartyType === 'customer' && !input.counterpartyCustomerId) {
    throw new ValidationError('counterpartyCustomerId إلزامي عندما counterpartyType=customer');
  }
  if (input.counterpartyType === 'supplier' && !input.counterpartySupplierId) {
    throw new ValidationError('counterpartySupplierId إلزامي عندما counterpartyType=supplier');
  }
  if (input.counterpartyType === 'other' && !input.contraAccountId) {
    throw new ValidationError('contraAccountId إلزامي عندما counterpartyType=other');
  }
}

/** ينشئ سند قبض/صرف بحالة draft فقط — بلا أثر محاسبي بعد. يقبل client خارجي للمشاركة في معاملة أكبر (مثل تحصيل شيك). */
export async function createTreasuryTransaction(ctx: RequestContext, input: CreateTreasuryTransactionInput, externalClient?: PoolClient) {
  ctx.assertPermission('treasury.transaction.create', input.branchId);
  validateCounterparty(input);
  await getSafeOrBankForPosting(ctx, input.safeOrBankId);

  const run = async (client: PoolClient) => {
    const documentNumber = await getNextDocumentNumber(
      {
        companyId: ctx.companyId, branchId: input.branchId,
        documentType: input.transactionType === 'receipt' ? 'RECEIPT_VOUCHER' : 'PAYMENT_VOUCHER',
        prefix: input.transactionType === 'receipt' ? 'RV-' : 'PV-',
      },
      client,
    );
    const row = await client.query(
      `INSERT INTO treasury_transactions(
        company_id, branch_id, safe_or_bank_id, document_number, transaction_type, counterparty_type,
        counterparty_customer_id, counterparty_supplier_id, contra_account_id, amount, currency_code, exchange_rate,
        transaction_date, fiscal_period_id, description, activity_id, project_id, cost_center_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.safeOrBankId, documentNumber, input.transactionType, input.counterpartyType,
        input.counterpartyCustomerId ?? null, input.counterpartySupplierId ?? null, input.contraAccountId ?? null,
        input.amount, input.currencyCode, input.exchangeRate ?? '1', input.transactionDate, input.fiscalPeriodId,
        input.description ?? null, input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null, ctx.userId,
      ],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'treasury_transaction', entityId: row.rows[0].id, action: 'create',
      afterJson: { documentNumber, transactionType: input.transactionType, amount: input.amount },
    });
    return row.rows[0];
  };
  return externalClient ? run(externalClient) : withTransaction(run);
}

/**
 * ترحيل السند: قيد بسطرين فقط —
 * قبض: مدين حساب الخزينة/البنك، دائن حساب الطرف الآخر (عميل/مورد/حساب مقابل).
 * صرف: مدين حساب الطرف الآخر، دائن حساب الخزينة/البنك.
 */
export async function postTreasuryTransaction(ctx: RequestContext, id: string, externalClient?: PoolClient) {
  const run = async (client: PoolClient) => {
    const found = await client.query(`SELECT * FROM treasury_transactions WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('السند غير موجود');
    const tx = found.rows[0];
    ctx.assertPermission('treasury.transaction.post', tx.branch_id);
    if (tx.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل سند بحالة ${tx.status}؛ يجب أن يكون draft`);

    const safe = await client.query(`SELECT linked_account_id FROM safe_or_banks WHERE id=$1`, [tx.safe_or_bank_id]);
    let counterpartyAccountId: string;
    if (tx.counterparty_type === 'customer') {
      const c = await client.query(`SELECT linked_account_id FROM customers WHERE id=$1`, [tx.counterparty_customer_id]);
      counterpartyAccountId = c.rows[0].linked_account_id;
    } else if (tx.counterparty_type === 'supplier') {
      const s = await client.query(`SELECT linked_account_id FROM suppliers WHERE id=$1`, [tx.counterparty_supplier_id]);
      counterpartyAccountId = s.rows[0].linked_account_id;
    } else {
      counterpartyAccountId = tx.contra_account_id;
    }

    const amount = new Decimal(tx.amount).toFixed(4);
    const lines = tx.transaction_type === 'receipt'
      ? [
          { accountId: safe.rows[0].linked_account_id, debit: amount, credit: '0', description: tx.description },
          { accountId: counterpartyAccountId, debit: '0', credit: amount, description: tx.description },
        ]
      : [
          { accountId: counterpartyAccountId, debit: amount, credit: '0', description: tx.description },
          { accountId: safe.rows[0].linked_account_id, debit: '0', credit: amount, description: tx.description },
        ];

    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: tx.branch_id, fiscalPeriodId: tx.fiscal_period_id, entryDate: tx.transaction_date,
      currencyCode: tx.currency_code, exchangeRate: tx.exchange_rate,
      activityId: tx.activity_id ?? undefined, projectId: tx.project_id ?? undefined,
      sourceDocumentType: 'treasury_transaction', sourceDocumentId: id,
      lines: lines.map((l) => ({ ...l, costCenterId: tx.cost_center_id ?? undefined })),
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE treasury_transactions SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [id, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'treasury_transaction', entityId: id, action: 'post', afterJson: { journalEntryId: draftEntry.id },
    });
    return { id, journalEntryId: draftEntry.id };
  };
  return externalClient ? run(externalClient) : withTransaction(run);
}

export async function reverseTreasuryTransaction(ctx: RequestContext, id: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM treasury_transactions WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('السند غير موجود');
    const tx = found.rows[0];
    ctx.assertPermission('treasury.transaction.reverse', tx.branch_id);
    if (tx.status !== 'posted') throw new ValidationError('يجب أن يكون السند مرحّلًا لعكسه');

    await reverseJournalEntry(ctx, tx.journal_entry_id, reason);
    await client.query(
      `UPDATE treasury_transactions SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [id, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'treasury_transaction', entityId: id, action: 'reverse', reason,
    });
    return { id, status: 'reversed' };
  });
}

export async function getTreasuryTransactionById(ctx: RequestContext, id: string) {
  ctx.assertPermission('treasury.transaction.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('treasury_transactions', id, ctx, {
    notFoundMessage: 'السند غير موجود',
  });
}

export async function listTreasuryTransactions(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('treasury.transaction.view');
  return paginatedList<unknown>(ctx, 'treasury_transactions', { page, pageSize, status });
}
