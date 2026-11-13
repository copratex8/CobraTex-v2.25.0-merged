import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { fetchScopedById } from '@/shared/scope';
import { getSafeOrBankForPosting } from './safeOrBankService';
import { paginatedList } from '@/shared/pagination';

export interface BankStatementLineInput {
  lineDate: string;
  description?: string;
  amount: string; // موجب = إيداع بنكي، سالب = سحب بنكي
  reference?: string;
}

export interface CreateReconciliationInput {
  branchId: string;
  safeOrBankId: string;
  statementDate: string;
  openingBalance?: string;
  statementEndingBalance: string;
  lines: BankStatementLineInput[];
}

/**
 * ينشئ جلسة تسوية بنكية جديدة، ويستورد أسطر كشف الحساب معها دفعة واحدة (إدخال يدوي — لا استيراد
 * ملف CSV/OFX في هذه المرحلة، راجع ملاحظة النطاق في تقرير المرحلة). لا أثر محاسبي إطلاقًا هنا؛
 * هذه أداة مطابقة/تحقق فقط، لا تُنشئ أو تُعدِّل أي قيد أو معاملة خزينة بنفسها.
 */
export async function createReconciliation(ctx: RequestContext, input: CreateReconciliationInput) {
  ctx.assertPermission('treasury.reconciliation.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('يجب إدخال سطر واحد على الأقل من كشف الحساب');
  await getSafeOrBankForPosting(ctx, input.safeOrBankId);

  return withTransaction(async (client) => {
    const header = await client.query(
      `INSERT INTO bank_reconciliations(company_id, branch_id, safe_or_bank_id, statement_date, opening_balance, statement_ending_balance, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.companyId, input.branchId, input.safeOrBankId, input.statementDate, input.openingBalance ?? '0', input.statementEndingBalance, ctx.userId],
    );

    for (const line of input.lines) {
      if (new Decimal(line.amount).isZero()) throw new ValidationError('لا يمكن أن يكون مبلغ سطر الكشف صفرًا');
      await client.query(
        `INSERT INTO bank_statement_lines(reconciliation_id, company_id, line_date, description, amount, reference)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [header.rows[0].id, ctx.companyId, line.lineDate, line.description ?? null, line.amount, line.reference ?? null],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'bank_reconciliation', entityId: header.rows[0].id, action: 'create',
      afterJson: { lineCount: input.lines.length, statementEndingBalance: input.statementEndingBalance },
    });
    return header.rows[0];
  });
}

async function loadReconciliationForUpdate(ctx: RequestContext, client: PoolClient, id: string) {
  const found = await client.query(`SELECT * FROM bank_reconciliations WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId]);
  if (found.rows.length === 0) throw new NotFoundError('التسوية البنكية غير موجودة');
  return found.rows[0];
}

const MATCH_DATE_TOLERANCE_DAYS = 10;

/**
 * مطابقة تلقائية: لكل سطر كشف غير مُطابَق بعد، تُجمَع كل المرشَّحات المحتملة (سندات قبض/صرف مرحَّلة
 * + تحويلات مرحَّلة، لنفس الخزينة/البنك، بنفس المبلغ المُوقَّع، وغير مُطابَقة لسطر آخر) ضمن نافذة
 * زمنية معقولة حول تاريخ السطر. تُربَط تلقائيًا فقط لو كان المرشَّح **وحيدًا بلا لبس**؛ أي تعدُّد
 * مرشَّحين بنفس المبلغ يُترَك للمطابقة اليدوية عمدًا — الربط التلقائي الخاطئ أسوأ من عدم الربط.
 */
export async function runAutoMatch(ctx: RequestContext, reconciliationId: string) {
  return withTransaction(async (client) => {
    const recon = await loadReconciliationForUpdate(ctx, client, reconciliationId);
    ctx.assertPermission('treasury.reconciliation.match', recon.branch_id);
    if (recon.status !== 'in_progress') throw new ValidationError('لا يمكن المطابقة إلا لتسوية قيد التنفيذ');

    const unmatchedLines = await client.query(
      `SELECT * FROM bank_statement_lines
       WHERE reconciliation_id=$1 AND matched_treasury_transaction_id IS NULL AND matched_treasury_transfer_id IS NULL
       ORDER BY line_date ASC`,
      [reconciliationId],
    );

    let matchedCount = 0;
    let ambiguousCount = 0;

    for (const line of unmatchedLines.rows) {
      const lineAmount = new Decimal(line.amount);
      const absAmount = lineAmount.abs().toFixed(4);
      const transactionType = lineAmount.isPositive() ? 'receipt' : 'payment';

      const txCandidates = await client.query(
        `SELECT id, 'transaction' AS kind FROM treasury_transactions
         WHERE company_id=$1 AND safe_or_bank_id=$2 AND status='posted' AND transaction_type=$3 AND amount=$4
           AND transaction_date BETWEEN $5::date - $6::int AND $5::date + $6::int
           AND id NOT IN (SELECT matched_treasury_transaction_id FROM bank_statement_lines WHERE matched_treasury_transaction_id IS NOT NULL)`,
        [ctx.companyId, recon.safe_or_bank_id, transactionType, absAmount, line.line_date, MATCH_DATE_TOLERANCE_DAYS],
      );

      const transferDirectionCol = lineAmount.isPositive() ? 'to_safe_or_bank_id' : 'from_safe_or_bank_id';
      const transferCandidates = await client.query(
        `SELECT id, 'transfer' AS kind FROM treasury_transfers
         WHERE company_id=$1 AND ${transferDirectionCol}=$2 AND status='posted' AND amount=$3
           AND transfer_date BETWEEN $4::date - $5::int AND $4::date + $5::int
           AND id NOT IN (SELECT matched_treasury_transfer_id FROM bank_statement_lines WHERE matched_treasury_transfer_id IS NOT NULL)`,
        [ctx.companyId, recon.safe_or_bank_id, absAmount, line.line_date, MATCH_DATE_TOLERANCE_DAYS],
      );

      const candidates = [...txCandidates.rows, ...transferCandidates.rows];
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (candidate.kind === 'transaction') {
          await client.query(`UPDATE bank_statement_lines SET matched_treasury_transaction_id=$1 WHERE id=$2`, [candidate.id, line.id]);
        } else {
          await client.query(`UPDATE bank_statement_lines SET matched_treasury_transfer_id=$1 WHERE id=$2`, [candidate.id, line.id]);
        }
        matchedCount += 1;
      } else if (candidates.length > 1) {
        ambiguousCount += 1;
      }
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'bank_reconciliation', entityId: reconciliationId, action: 'update',
      afterJson: { autoMatch: true, matchedCount, ambiguousCount },
    });
    return { matchedCount, ambiguousCount, remainingUnmatched: unmatchedLines.rows.length - matchedCount };
  });
}

async function assertCandidateUsable(client: PoolClient, ctx: RequestContext, safeOrBankId: string, kind: 'transaction' | 'transfer', candidateId: string) {
  if (kind === 'transaction') {
    const row = await client.query(
      `SELECT id FROM treasury_transactions WHERE id=$1 AND company_id=$2 AND safe_or_bank_id=$3 AND status='posted'`,
      [candidateId, ctx.companyId, safeOrBankId],
    );
    if (row.rows.length === 0) throw new ValidationError('السند غير موجود، أو غير مرحَّل، أو لا يخص هذه الخزينة/البنك');
  } else {
    const row = await client.query(
      `SELECT id FROM treasury_transfers WHERE id=$1 AND company_id=$2 AND status='posted' AND (from_safe_or_bank_id=$3 OR to_safe_or_bank_id=$3)`,
      [candidateId, ctx.companyId, safeOrBankId],
    );
    if (row.rows.length === 0) throw new ValidationError('التحويل غير موجود، أو غير مرحَّل، أو لا يخص هذه الخزينة/البنك');
  }
}

export interface MatchLineInput {
  treasuryTransactionId?: string;
  treasuryTransferId?: string;
}

/** مطابقة يدوية لسطر واحد — تُستخدَم لحسم الحالات التي تركتها runAutoMatch بلا ربط (تعدُّد مرشَّحين
 * أو مطابقة غير موجودة أصلًا مثل خطأ بنكي أو حركة لم تُسجَّل في النظام بعد). */
export async function matchLine(ctx: RequestContext, reconciliationId: string, lineId: string, input: MatchLineInput) {
  if (!input.treasuryTransactionId && !input.treasuryTransferId) {
    throw new ValidationError('يجب تحديد سند خزينة أو تحويل للمطابقة');
  }
  if (input.treasuryTransactionId && input.treasuryTransferId) {
    throw new ValidationError('لا يمكن مطابقة سطر واحد بسند وتحويل معًا');
  }
  return withTransaction(async (client) => {
    const recon = await loadReconciliationForUpdate(ctx, client, reconciliationId);
    ctx.assertPermission('treasury.reconciliation.match', recon.branch_id);
    if (recon.status !== 'in_progress') throw new ValidationError('لا يمكن المطابقة إلا لتسوية قيد التنفيذ');

    const line = await client.query(`SELECT * FROM bank_statement_lines WHERE id=$1 AND reconciliation_id=$2`, [lineId, reconciliationId]);
    if (line.rows.length === 0) throw new NotFoundError('سطر الكشف غير موجود');

    try {
      if (input.treasuryTransactionId) {
        await assertCandidateUsable(client, ctx, recon.safe_or_bank_id, 'transaction', input.treasuryTransactionId);
        await client.query(`UPDATE bank_statement_lines SET matched_treasury_transaction_id=$1, matched_treasury_transfer_id=NULL WHERE id=$2`, [input.treasuryTransactionId, lineId]);
      } else {
        await assertCandidateUsable(client, ctx, recon.safe_or_bank_id, 'transfer', input.treasuryTransferId!);
        await client.query(`UPDATE bank_statement_lines SET matched_treasury_transfer_id=$1, matched_treasury_transaction_id=NULL WHERE id=$2`, [input.treasuryTransferId, lineId]);
      }
    } catch (e) {
      const pgErr = e as { code?: string };
      if (pgErr.code === '23505') throw new ConflictError('هذا السند/التحويل مُطابَق بالفعل لسطر كشف آخر');
      throw e;
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'bank_reconciliation', entityId: reconciliationId, action: 'update',
      afterJson: { manualMatch: true, lineId, ...input },
    });
    return { id: lineId, matched: true };
  });
}

export async function unmatchLine(ctx: RequestContext, reconciliationId: string, lineId: string) {
  return withTransaction(async (client) => {
    const recon = await loadReconciliationForUpdate(ctx, client, reconciliationId);
    ctx.assertPermission('treasury.reconciliation.match', recon.branch_id);
    if (recon.status !== 'in_progress') throw new ValidationError('لا يمكن التعديل إلا لتسوية قيد التنفيذ');

    const result = await client.query(
      `UPDATE bank_statement_lines SET matched_treasury_transaction_id=NULL, matched_treasury_transfer_id=NULL
       WHERE id=$1 AND reconciliation_id=$2 RETURNING id`,
      [lineId, reconciliationId],
    );
    if (result.rows.length === 0) throw new NotFoundError('سطر الكشف غير موجود');

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'bank_reconciliation', entityId: reconciliationId, action: 'update',
      afterJson: { unmatch: true, lineId },
    });
    return { id: lineId, matched: false };
  });
}

/**
 * إكمال التسوية: يشترط أن كل سطور الكشف مُطابَقة (بلا استثناء — أي فرق غير مُفسَّر يبقى التسوية
 * قيد التنفيذ عمدًا)، وأن الرصيد الافتتاحي + مجموع كل الأسطر المُطابَقة يساوي رصيد الكشف الختامي
 * تمامًا. هذا يعادل معنى "تمّت التسوية" الفعلي: كل حركة في الكشف مُفسَّرة بمستند حقيقي في النظام،
 * والرصيدان متطابقان رقميًا. لا رجوع بعد الإكمال (لا مسار عكس — هذه أداة تحقق لا مستند محاسبي).
 */
export async function completeReconciliation(ctx: RequestContext, reconciliationId: string) {
  return withTransaction(async (client) => {
    const recon = await loadReconciliationForUpdate(ctx, client, reconciliationId);
    ctx.assertPermission('treasury.reconciliation.complete', recon.branch_id);
    if (recon.status !== 'in_progress') throw new ValidationError('التسوية مكتملة بالفعل');

    const lines = await client.query(`SELECT * FROM bank_statement_lines WHERE reconciliation_id=$1`, [reconciliationId]);
    const unmatched = lines.rows.filter((l) => !l.matched_treasury_transaction_id && !l.matched_treasury_transfer_id);
    if (unmatched.length > 0) {
      throw new ValidationError(`لا يمكن إكمال التسوية — ${unmatched.length} سطر/أسطر كشف غير مُطابَقة بعد`);
    }

    const computedEnding = lines.rows.reduce((sum, l) => sum.plus(l.amount), new Decimal(recon.opening_balance));
    const difference = computedEnding.minus(recon.statement_ending_balance);
    if (!difference.isZero()) {
      throw new ValidationError(`لا يمكن إكمال التسوية — فرق قدره ${difference.toFixed(4)} بين الرصيد المحسوب (${computedEnding.toFixed(4)}) ورصيد الكشف (${recon.statement_ending_balance})`);
    }

    await client.query(
      `UPDATE bank_reconciliations SET status='completed', completed_by=$2, completed_at=now() WHERE id=$1`,
      [reconciliationId, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'bank_reconciliation', entityId: reconciliationId, action: 'update',
      afterJson: { completed: true },
    });
    return { id: reconciliationId, status: 'completed' };
  });
}

export async function getReconciliationById(ctx: RequestContext, id: string) {
  ctx.assertPermission('treasury.reconciliation.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string; safe_or_bank_id: string }>(
    'bank_reconciliations', id, ctx, { notFoundMessage: 'التسوية البنكية غير موجودة' },
  );
  const lines = await pool.query(`SELECT * FROM bank_statement_lines WHERE reconciliation_id=$1 ORDER BY line_date ASC`, [id]);

  // مرشَّحون غير مُطابَقين لأي سطر كشف في أي تسوية — للاختيار اليدوي في الواجهة.
  const unmatchedTransactions = await pool.query(
    `SELECT * FROM treasury_transactions
     WHERE company_id=$1 AND safe_or_bank_id=$2 AND status='posted'
       AND id NOT IN (SELECT matched_treasury_transaction_id FROM bank_statement_lines WHERE matched_treasury_transaction_id IS NOT NULL)
     ORDER BY transaction_date DESC LIMIT 100`,
    [ctx.companyId, header.safe_or_bank_id],
  );
  const unmatchedTransfers = await pool.query(
    `SELECT * FROM treasury_transfers
     WHERE company_id=$1 AND (from_safe_or_bank_id=$2 OR to_safe_or_bank_id=$2) AND status='posted'
       AND id NOT IN (SELECT matched_treasury_transfer_id FROM bank_statement_lines WHERE matched_treasury_transfer_id IS NOT NULL)
     ORDER BY transfer_date DESC LIMIT 100`,
    [ctx.companyId, header.safe_or_bank_id],
  );

  return {
    ...header,
    lines: lines.rows,
    unmatchedTransactions: unmatchedTransactions.rows,
    unmatchedTransfers: unmatchedTransfers.rows,
  };
}

export async function listReconciliations(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('treasury.reconciliation.view');
  return paginatedList<unknown>(ctx, 'bank_reconciliations', { page, pageSize, status });
}
