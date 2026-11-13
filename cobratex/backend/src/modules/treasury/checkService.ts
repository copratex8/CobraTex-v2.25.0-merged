import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { fetchScopedById } from '@/shared/scope';
import { getSafeOrBankForPosting } from './safeOrBankService';
import { createTreasuryTransaction, postTreasuryTransaction } from './treasuryTransactionService';
import { paginatedList } from '@/shared/pagination';

export interface RegisterCheckInput {
  branchId: string;
  safeOrBankId: string;
  checkType: 'incoming' | 'outgoing';
  checkNumber: string;
  checkDate: string;
  dueDate: string;
  amount: string;
  currencyCode: string;
  counterpartyCustomerId?: string;
  counterpartySupplierId?: string;
  notes?: string;
}

/**
 * تسجيل شيك: مجرد توثيق (لا أثر محاسبي بعد). الشيك الوارد يجب أن يرتبط بعميل، والصادر بمورد
 * (يُفرض بقيد CHECK في قاعدة البيانات، لا بمنطق تطبيقي فقط).
 */
export async function registerCheck(ctx: RequestContext, input: RegisterCheckInput) {
  ctx.assertPermission('treasury.check.create', input.branchId);
  if (input.checkType === 'incoming' && !input.counterpartyCustomerId) {
    throw new ValidationError('الشيك الوارد يتطلب counterpartyCustomerId');
  }
  if (input.checkType === 'outgoing' && !input.counterpartySupplierId) {
    throw new ValidationError('الشيك الصادر يتطلب counterpartySupplierId');
  }
  await getSafeOrBankForPosting(ctx, input.safeOrBankId);

  const row = await pool.query(
    `INSERT INTO checks(
      company_id, branch_id, safe_or_bank_id, check_type, check_number, check_date, due_date, amount,
      currency_code, counterparty_customer_id, counterparty_supplier_id, notes, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      ctx.companyId, input.branchId, input.safeOrBankId, input.checkType, input.checkNumber, input.checkDate,
      input.dueDate, input.amount, input.currencyCode, input.counterpartyCustomerId ?? null,
      input.counterpartySupplierId ?? null, input.notes ?? null, ctx.userId,
    ],
  );
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'check', entityId: row.rows[0].id, action: 'create',
    afterJson: { checkNumber: input.checkNumber, checkType: input.checkType, amount: input.amount },
  });
  return row.rows[0];
}

type CheckStatus = 'pending' | 'deposited' | 'cleared' | 'bounced' | 'cancelled';
const TRANSITIONS: Record<string, CheckStatus[]> = {
  pending: ['deposited', 'cancelled'],
  deposited: ['cleared', 'bounced'],
};

export interface TransitionCheckOptions {
  reason?: string; // إلزامي لـ bounced/cancelled
  fiscalPeriodId?: string; // إلزامي لـ cleared (تُنشأ عندها معاملة خزينة فعلية)
  clearDate?: string;
}

/**
 * ينقل حالة الشيك وفق جدول انتقالات صريح. الأثر المحاسبي الفعلي يحدث فقط عند الوصول لـ
 * 'cleared': تُنشأ تلقائيًا معاملة خزينة (سند قبض للوارد، سند صرف للصادر) وتُرحَّل فورًا، ويُربط
 * معرّفها بالشيك. الحالات الأخرى (pending/deposited/bounced/cancelled) توثيقية بحتة بلا أثر مالي.
 */
export async function transitionCheckStatus(
  ctx: RequestContext, checkId: string, target: CheckStatus, options: TransitionCheckOptions = {},
) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM checks WHERE id=$1 AND company_id=$2 FOR UPDATE`, [checkId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الشيك غير موجود');
    const check = found.rows[0];
    ctx.assertPermission('treasury.check.transition', check.branch_id);

    const allowed = TRANSITIONS[check.status] ?? [];
    if (!allowed.includes(target)) {
      throw new ValidationError(`انتقال حالة غير مسموح: ${check.status} → ${target}`);
    }

    if (target === 'bounced' || target === 'cancelled') {
      if (!options.reason?.trim()) throw new ValidationError('السبب إلزامي عند الارتداد أو الإلغاء');
      await client.query(
        `UPDATE checks SET status=$2 WHERE id=$1`, [checkId, target],
      );
      await writeAuditLog(client, {
        tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
        entityType: 'check', entityId: checkId, action: 'update',
        beforeJson: { status: check.status }, afterJson: { status: target }, reason: options.reason,
      });
      return { id: checkId, status: target };
    }

    if (target === 'cleared') {
      if (!options.fiscalPeriodId) throw new ValidationError('fiscalPeriodId إلزامي عند تحصيل/صرف الشيك (cleared)');
      // نُمرِّر client الحالي صراحة لضمان أن إنشاء وترحيل معاملة الخزينة يشتركان في نفس معاملة
      // قاعدة البيانات مع تحديث حالة الشيك — إما ينجح كل شيء معًا أو يتراجع كل شيء معًا (Atomic).
      const treasuryTx = await createTreasuryTransaction(ctx, {
        branchId: check.branch_id,
        safeOrBankId: check.safe_or_bank_id,
        transactionType: check.check_type === 'incoming' ? 'receipt' : 'payment',
        counterpartyType: check.check_type === 'incoming' ? 'customer' : 'supplier',
        counterpartyCustomerId: check.counterparty_customer_id ?? undefined,
        counterpartySupplierId: check.counterparty_supplier_id ?? undefined,
        amount: check.amount,
        currencyCode: check.currency_code,
        transactionDate: options.clearDate ?? check.due_date,
        fiscalPeriodId: options.fiscalPeriodId,
        description: `تحصيل/صرف شيك رقم ${check.check_number}`,
      }, client);
      await postTreasuryTransaction(ctx, treasuryTx.id, client);

      await client.query(
        `UPDATE checks SET status='cleared', treasury_transaction_id=$2 WHERE id=$1`,
        [checkId, treasuryTx.id],
      );
      await writeAuditLog(client, {
        tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
        entityType: 'check', entityId: checkId, action: 'post',
        beforeJson: { status: check.status }, afterJson: { status: 'cleared', treasuryTransactionId: treasuryTx.id },
      });
      return { id: checkId, status: 'cleared', treasuryTransactionId: treasuryTx.id };
    }

    // target === 'deposited'
    await client.query(`UPDATE checks SET status='deposited' WHERE id=$1`, [checkId]);
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'check', entityId: checkId, action: 'update',
      beforeJson: { status: check.status }, afterJson: { status: 'deposited' },
    });
    return { id: checkId, status: 'deposited' };
  });
}

export async function getCheckById(ctx: RequestContext, id: string) {
  ctx.assertPermission('treasury.check.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('checks', id, ctx, {
    notFoundMessage: 'الشيك غير موجود',
  });
}

export async function listChecks(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('treasury.check.view');
  return paginatedList<unknown>(ctx, 'checks', { page, pageSize, status });
}
