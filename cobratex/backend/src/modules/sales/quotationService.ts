import { withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface QuotationLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
}

export interface CreateQuotationInput {
  branchId: string;
  customerId: string;
  currencyCode: string;
  quotationDate: string;
  validUntil?: string;
  lines: QuotationLineInput[];
}

/** لا يُنشئ أي قيد محاسبي ولا حركة مخزون — مجرد التقاط نية تسعير. */
export async function createQuotation(ctx: RequestContext, input: CreateQuotationInput) {
  ctx.assertPermission('sales.quotation.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('عرض السعر يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'QUOTATION', prefix: 'QUO-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO quotations(company_id, branch_id, customer_id, document_number, currency_code, quotation_date, valid_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ctx.companyId, input.branchId, input.customerId, documentNumber, input.currencyCode, input.quotationDate, input.validUntil ?? null, ctx.userId],
    );
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO quotation_lines(quotation_id, company_id, item_id, uom_id, quantity, unit_price, discount_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [header.rows[0].id, ctx.companyId, line.itemId, line.uomId, line.quantity, line.unitPrice, line.discountPercent ?? '0'],
      );
    }
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'quotation', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
const TRANSITIONS: Record<string, QuotationStatus[]> = {
  draft: ['sent', 'cancelled'],
  sent: ['accepted', 'rejected', 'expired', 'cancelled'],
};

export async function transitionQuotationStatus(ctx: RequestContext, quotationId: string, target: QuotationStatus) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM quotations WHERE id=$1 AND company_id=$2 FOR UPDATE`, [quotationId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('عرض السعر غير موجود');
    const quotation = found.rows[0];
    ctx.assertPermission('sales.quotation.transition', quotation.branch_id);

    const allowed = TRANSITIONS[quotation.status] ?? [];
    if (!allowed.includes(target)) {
      throw new ValidationError(`انتقال حالة غير مسموح: ${quotation.status} → ${target}`);
    }
    await client.query(`UPDATE quotations SET status=$2 WHERE id=$1`, [quotationId, target]);
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'quotation', entityId: quotationId, action: 'update',
      beforeJson: { status: quotation.status }, afterJson: { status: target },
    });
    return { id: quotationId, status: target };
  });
}

export async function getQuotationById(ctx: RequestContext, id: string) {
  ctx.assertPermission('sales.quotation.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('quotations', id, ctx, {
    notFoundMessage: 'عرض السعر غير موجود',
  });
}

export async function listQuotations(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('sales.quotation.view');
  return paginatedList<unknown>(ctx, 'quotations', { page, pageSize, status });
}
