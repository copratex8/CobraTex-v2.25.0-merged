import { withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface SalesOrderLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
}

export interface CreateSalesOrderInput {
  branchId: string;
  customerId: string;
  currencyCode: string;
  orderDate: string;
  sourceQuotationId?: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: SalesOrderLineInput[];
}

/** لا يحجز مخزونًا ولا يُنشئ قيدًا — التقاط التزام بيع فقط. الأثر الفعلي يبدأ من الفاتورة. */
export async function createSalesOrder(ctx: RequestContext, input: CreateSalesOrderInput) {
  ctx.assertPermission('sales.order.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('أمر البيع يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'SALES_ORDER', prefix: 'SO-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO sales_orders(company_id, branch_id, customer_id, document_number, currency_code, order_date, source_quotation_id, created_by, activity_id, project_id, cost_center_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.customerId, documentNumber, input.currencyCode, input.orderDate,
        input.sourceQuotationId ?? null, ctx.userId, input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO sales_order_lines(sales_order_id, company_id, item_id, uom_id, quantity, unit_price, discount_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [header.rows[0].id, ctx.companyId, line.itemId, line.uomId, line.quantity, line.unitPrice, line.discountPercent ?? '0'],
      );
    }
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_order', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

type SalesOrderStatus = 'draft' | 'confirmed' | 'cancelled' | 'invoiced';
/** 'invoiced' غير قابل للوصول عبر هذه الدالة عمدًا — يُضبط داخليًا فقط من خدمة الفاتورة لاحقًا. */
const TRANSITIONS: Record<string, SalesOrderStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['cancelled'],
};

export async function transitionSalesOrderStatus(ctx: RequestContext, orderId: string, target: SalesOrderStatus) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM sales_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('أمر البيع غير موجود');
    const order = found.rows[0];
    ctx.assertPermission('sales.order.transition', order.branch_id);

    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(target)) {
      throw new ValidationError(`انتقال حالة غير مسموح: ${order.status} → ${target}`);
    }
    await client.query(`UPDATE sales_orders SET status=$2 WHERE id=$1`, [orderId, target]);
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_order', entityId: orderId, action: 'update',
      beforeJson: { status: order.status }, afterJson: { status: target },
    });
    return { id: orderId, status: target };
  });
}

export async function getSalesOrderById(ctx: RequestContext, id: string) {
  ctx.assertPermission('sales.order.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('sales_orders', id, ctx, {
    notFoundMessage: 'أمر البيع غير موجود',
  });
}

export async function listSalesOrders(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('sales.order.view');
  return paginatedList<unknown>(ctx, 'sales_orders', { page, pageSize, status });
}
