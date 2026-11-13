import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ConflictError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { paginatedList } from '@/shared/pagination';

export interface CreateCustomerInput {
  code: string;
  nameAr: string;
  nameEn: string;
  taxNumber?: string;
  creditLimit?: string;
  paymentTermDays?: number;
  currencyCode: string;
  branchId?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

/**
 * ينشئ عميلًا وحسابه الفرعي (Sub-ledger Account) معًا ضمن معاملة واحدة فقط:
 * - إن فشل إدراج العميل (مثلًا كود مكرر) يتراجع إدراج الحساب معه تلقائيًا (لا حساب يتيم).
 * - قيد UNIQUE(company_id, code) يمنع تكرار العميل نفسه عند إعادة المحاولة بنفس الكود.
 * - لإعادة إرسال HTTP الآمنة (retry) يُستخدم middleware الـ Idempotency-Key العام على المسار.
 */
export async function createCustomer(ctx: RequestContext, input: CreateCustomerInput) {
  ctx.assertPermission('sales.customer.create');

  return withTransaction(async (client) => {
    const account = await client.query(
      `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type, currency_code)
       VALUES ($1,$2,$3,$4,'asset',$5) RETURNING id`,
      [ctx.companyId, `AR-${input.code}`, `عميل - ${input.nameAr}`, `Customer - ${input.nameEn}`, input.currencyCode],
    );

    let customer;
    try {
      customer = await client.query(
        `INSERT INTO customers(
          company_id, code, name_ar, name_en, tax_number, credit_limit, payment_term_days,
          currency_code, linked_account_id, branch_id, effective_from, effective_to, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          ctx.companyId, input.code, input.nameAr, input.nameEn, input.taxNumber ?? null,
          input.creditLimit ?? '0', input.paymentTermDays ?? 0, input.currencyCode, account.rows[0].id,
          input.branchId ?? null, input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
          input.effectiveTo ?? null, ctx.userId,
        ],
      );
    } catch (e) {
      const pgErr = e as { code?: string };
      if (pgErr.code === '23505') {
        // كود العميل مكرر: نرمي خطأً يُلغي المعاملة بأكملها (بما فيها إدراج الحساب أعلاه) —
        // لا حساب يتيم يُترك في قاعدة البيانات.
        throw new ConflictError(`كود العميل مستخدم بالفعل داخل هذه الشركة: ${input.code}`);
      }
      throw e;
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'customer', entityId: customer.rows[0].id, action: 'create',
      afterJson: { code: input.code, linkedAccountId: account.rows[0].id },
    });

    return customer.rows[0];
  });
}

export async function getCustomerById(ctx: RequestContext, customerId: string) {
  ctx.assertPermission('sales.customer.view');
  const { rows } = await pool.query(
    `SELECT * FROM customers WHERE id = $1 AND company_id = $2`,
    [customerId, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('العميل غير موجود');
  return rows[0];
}

/**
 * تعطيل/تفعيل — لا حذف مادي إطلاقًا (راجع تعليق migration 0029). العميل المُعطَّل يبقى بكل
 * تاريخه المحاسبي وفواتيره القديمة سليمة تمامًا؛ فقط يختفي من قوائم الاختيار عند إنشاء مستند جديد
 * (الواجهة تُصفِّي is_active=true في قوائم الاختيار، لا في القوائم/التقارير العامة).
 */
export async function updateCustomerStatus(ctx: RequestContext, customerId: string, isActive: boolean) {
  ctx.assertPermission('sales.customer.update');
  const { rows } = await pool.query(
    `UPDATE customers SET is_active = $1 WHERE id = $2 AND company_id = $3 RETURNING *`,
    [isActive, customerId, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('العميل غير موجود');
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'customer', entityId: customerId, action: 'update', afterJson: { isActive },
  });
  return rows[0];
}

export async function listCustomers(ctx: RequestContext, page = 1, pageSize = 20) {
  ctx.assertPermission('sales.customer.view');
  // العملاء كيان على مستوى الشركة لا الفرع (لا عمود branch_id) — hasBranchColumn: false
  return paginatedList<unknown>(ctx, 'customers', { page, pageSize, hasBranchColumn: false });
}

export interface StatementQuery { fromDate?: string; toDate?: string; }

/**
 * كشف حساب العميل: يُبنى مباشرة من journal_lines لحساب العميل الفرعي (linked_account_id) —
 * مصدر الحقيقة الوحيد، برصيد متراكم (running balance) محسوب في SQL نفسه (window function)، لا في
 * التطبيق. مدين = زيادة مديونية العميل (فاتورة)، دائن = تحصيل (دفعة). القيود غير المرحَّلة لا تظهر.
 */
export async function getCustomerStatement(ctx: RequestContext, customerId: string, query: StatementQuery = {}) {
  ctx.assertPermission('sales.customer.view');
  const customer = await pool.query(`SELECT linked_account_id FROM customers WHERE id=$1 AND company_id=$2`, [customerId, ctx.companyId]);
  if (customer.rows.length === 0) throw new NotFoundError('العميل غير موجود');
  const accountId = customer.rows[0].linked_account_id;

  const params: unknown[] = [accountId, ctx.companyId];
  let where = `jl.account_id = $1 AND je.status = 'posted' AND je.company_id = $2`;
  if (query.fromDate) { params.push(query.fromDate); where += ` AND je.entry_date >= $${params.length}`; }
  if (query.toDate) { params.push(query.toDate); where += ` AND je.entry_date <= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT je.id AS journal_entry_id, je.entry_date, je.source_document_type, je.source_document_id,
            jl.debit, jl.credit, jl.description,
            SUM(jl.debit - jl.credit) OVER (ORDER BY je.entry_date, je.id ROWS UNBOUNDED PRECEDING) AS running_balance
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE ${where}
     ORDER BY je.entry_date, je.id`,
    params,
  );
  return { customerId, accountId, lines: rows, closingBalance: rows.length > 0 ? rows[rows.length - 1].running_balance : '0.0000' };
}
