import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { fetchScopedById, assertBranchScope } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface CreateSafeOrBankInput {
  branchId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: 'safe' | 'bank';
  currencyCode: string;
  bankName?: string;
  accountNumber?: string;
  iban?: string;
}

/**
 * ينشئ خزينة أو بنكًا وحسابه الفرعي معًا ذريًا (نفس مبدأ createCustomer/createSupplier تمامًا):
 * فشل إدراج الخزينة (كود مكرر) يُلغي إدراج الحساب معه — لا حساب يتيم.
 */
export async function createSafeOrBank(ctx: RequestContext, input: CreateSafeOrBankInput) {
  ctx.assertPermission('treasury.safe.create', input.branchId);

  return withTransaction(async (client) => {
    const account = await client.query(
      `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type, currency_code)
       VALUES ($1,$2,$3,$4,'asset',$5) RETURNING id`,
      [ctx.companyId, `TR-${input.code}`, `خزينة/بنك - ${input.nameAr}`, `Treasury - ${input.nameEn}`, input.currencyCode],
    );

    let safe;
    try {
      safe = await client.query(
        `INSERT INTO safe_or_banks(
          company_id, branch_id, code, name_ar, name_en, kind, linked_account_id, bank_name, account_number, iban, currency_code, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          ctx.companyId, input.branchId, input.code, input.nameAr, input.nameEn, input.kind, account.rows[0].id,
          input.bankName ?? null, input.accountNumber ?? null, input.iban ?? null, input.currencyCode, ctx.userId,
        ],
      );
    } catch (e) {
      const pgErr = e as { code?: string };
      if (pgErr.code === '23505') throw new ConflictError(`كود الخزينة/البنك مستخدم بالفعل: ${input.code}`);
      throw e;
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'safe_or_bank', entityId: safe.rows[0].id, action: 'create',
      afterJson: { code: input.code, kind: input.kind, linkedAccountId: account.rows[0].id },
    });
    return safe.rows[0];
  });
}

export async function getSafeOrBankById(ctx: RequestContext, id: string) {
  ctx.assertPermission('treasury.safe.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('safe_or_banks', id, ctx, {
    notFoundMessage: 'الخزينة/البنك غير موجود',
  });
}

export async function listSafeOrBanks(ctx: RequestContext, page = 1, pageSize = 20) {
  ctx.assertPermission('treasury.safe.view');
  // عزل الفرع الآن على مستوى SQL نفسه (WHERE branch_id = ANY(...)) داخل paginatedList، لا فلترة بعد
  // الجلب — الفرق الجوهري عن النسخة السابقة: لا يجلب الجدول كاملًا لتصفيته في الذاكرة.
  return paginatedList<unknown>(ctx, 'safe_or_banks', { page, pageSize });
}

/** يُستخدم داخليًا من خدمات أخرى (سندات القبض/الصرف، التحويلات) لجلب الخزينة دون تكرار كود التحقق. */
export async function getSafeOrBankForPosting(ctx: RequestContext, id: string) {
  const row = await fetchScopedById<{ id: string; company_id: string; branch_id: string; linked_account_id: string; currency_code: string }>(
    'safe_or_banks', id, ctx, { notFoundMessage: 'الخزينة/البنك غير موجود' },
  );
  assertBranchScope(ctx, row.branch_id);
  return row;
}
