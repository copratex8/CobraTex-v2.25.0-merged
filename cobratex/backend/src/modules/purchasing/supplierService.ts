import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ConflictError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { paginatedList } from '@/shared/pagination';

export interface CreateSupplierInput {
  code: string;
  nameAr: string;
  nameEn: string;
  taxNumber?: string;
  paymentTermDays?: number;
  currencyCode: string;
  branchId?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

/** ينشئ موردًا وحسابه الفرعي (التزام/Liability) معًا ضمن معاملة واحدة — نفس مبدأ createCustomer. */
export async function createSupplier(ctx: RequestContext, input: CreateSupplierInput) {
  ctx.assertPermission('purchasing.supplier.create');

  return withTransaction(async (client) => {
    const account = await client.query(
      `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type, currency_code)
       VALUES ($1,$2,$3,$4,'liability',$5) RETURNING id`,
      [ctx.companyId, `AP-${input.code}`, `مورد - ${input.nameAr}`, `Supplier - ${input.nameEn}`, input.currencyCode],
    );

    let supplier;
    try {
      supplier = await client.query(
        `INSERT INTO suppliers(
          company_id, code, name_ar, name_en, tax_number, payment_term_days,
          currency_code, linked_account_id, branch_id, effective_from, effective_to, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          ctx.companyId, input.code, input.nameAr, input.nameEn, input.taxNumber ?? null,
          input.paymentTermDays ?? 0, input.currencyCode, account.rows[0].id,
          input.branchId ?? null, input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
          input.effectiveTo ?? null, ctx.userId,
        ],
      );
    } catch (e) {
      const pgErr = e as { code?: string };
      if (pgErr.code === '23505') {
        throw new ConflictError(`كود المورد مستخدم بالفعل داخل هذه الشركة: ${input.code}`);
      }
      throw e;
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier', entityId: supplier.rows[0].id, action: 'create',
      afterJson: { code: input.code, linkedAccountId: account.rows[0].id },
    });

    return supplier.rows[0];
  });
}

export async function getSupplierById(ctx: RequestContext, supplierId: string) {
  ctx.assertPermission('purchasing.supplier.view');
  const { rows } = await pool.query(
    `SELECT * FROM suppliers WHERE id = $1 AND company_id = $2`,
    [supplierId, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('المورد غير موجود');
  return rows[0];
}

/** راجع تعليق updateCustomerStatus في customerService.ts — نفس المنطق بالضبط. */
export async function updateSupplierStatus(ctx: RequestContext, supplierId: string, isActive: boolean) {
  ctx.assertPermission('purchasing.supplier.update');
  const { rows } = await pool.query(
    `UPDATE suppliers SET is_active = $1 WHERE id = $2 AND company_id = $3 RETURNING *`,
    [isActive, supplierId, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('المورد غير موجود');
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'supplier', entityId: supplierId, action: 'update', afterJson: { isActive },
  });
  return rows[0];
}

export async function listSuppliers(ctx: RequestContext, page = 1, pageSize = 20) {
  ctx.assertPermission('purchasing.supplier.view');
  return paginatedList<unknown>(ctx, 'suppliers', { page, pageSize, hasBranchColumn: false });
}

export interface StatementQuery { fromDate?: string; toDate?: string; }

/** كشف حساب المورد — مرآة تامة لـ getCustomerStatement في customerService.ts (راجع تعليقها). */
export async function getSupplierStatement(ctx: RequestContext, supplierId: string, query: StatementQuery = {}) {
  ctx.assertPermission('purchasing.supplier.view');
  const supplier = await pool.query(`SELECT linked_account_id FROM suppliers WHERE id=$1 AND company_id=$2`, [supplierId, ctx.companyId]);
  if (supplier.rows.length === 0) throw new NotFoundError('المورد غير موجود');
  const accountId = supplier.rows[0].linked_account_id;

  const params: unknown[] = [accountId, ctx.companyId];
  let where = `jl.account_id = $1 AND je.status = 'posted' AND je.company_id = $2`;
  if (query.fromDate) { params.push(query.fromDate); where += ` AND je.entry_date >= $${params.length}`; }
  if (query.toDate) { params.push(query.toDate); where += ` AND je.entry_date <= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT je.id AS journal_entry_id, je.entry_date, je.source_document_type, je.source_document_id,
            jl.debit, jl.credit, jl.description,
            SUM(jl.credit - jl.debit) OVER (ORDER BY je.entry_date, je.id ROWS UNBOUNDED PRECEDING) AS running_balance
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE ${where}
     ORDER BY je.entry_date, je.id`,
    params,
  );
  return { supplierId, accountId, lines: rows, closingBalance: rows.length > 0 ? rows[rows.length - 1].running_balance : '0.0000' };
}
