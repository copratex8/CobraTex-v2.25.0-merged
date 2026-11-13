import { withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface PurchaseOrderLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitPrice: string;
}

export interface CreatePurchaseOrderInput {
  branchId: string;
  supplierId: string;
  currencyCode: string;
  orderDate: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: PurchaseOrderLineInput[];
}

/** لا يؤثر في المخزون ولا يُنشئ التزامًا محاسبيًا — الأثر يبدأ من الاستلام (مخزون) والفاتورة (التزام) منفصلين. */
export async function createPurchaseOrder(ctx: RequestContext, input: CreatePurchaseOrderInput) {
  ctx.assertPermission('purchasing.order.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('أمر الشراء يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'PURCHASE_ORDER', prefix: 'PO-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO purchase_orders(company_id, branch_id, supplier_id, document_number, currency_code, order_date, created_by, activity_id, project_id, cost_center_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.supplierId, documentNumber, input.currencyCode, input.orderDate, ctx.userId,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO purchase_order_lines(purchase_order_id, company_id, item_id, uom_id, quantity, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [header.rows[0].id, ctx.companyId, line.itemId, line.uomId, line.quantity, line.unitPrice],
      );
    }
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'purchase_order', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

type PurchaseOrderStatus = 'draft' | 'confirmed' | 'cancelled' | 'received';
/** 'received' غير قابل للوصول عبر هذه الدالة عمدًا — يُضبط داخليًا فقط من خدمة الاستلام لاحقًا. */
const TRANSITIONS: Record<string, PurchaseOrderStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['cancelled'],
};

export async function transitionPurchaseOrderStatus(ctx: RequestContext, orderId: string, target: PurchaseOrderStatus) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM purchase_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('أمر الشراء غير موجود');
    const order = found.rows[0];
    ctx.assertPermission('purchasing.order.transition', order.branch_id);

    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(target)) {
      throw new ValidationError(`انتقال حالة غير مسموح: ${order.status} → ${target}`);
    }
    await client.query(`UPDATE purchase_orders SET status=$2 WHERE id=$1`, [orderId, target]);
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'purchase_order', entityId: orderId, action: 'update',
      beforeJson: { status: order.status }, afterJson: { status: target },
    });
    return { id: orderId, status: target };
  });
}

export async function getPurchaseOrderById(ctx: RequestContext, id: string) {
  ctx.assertPermission('purchasing.order.view');
  return fetchScopedById<{ id: string; company_id: string; branch_id: string }>('purchase_orders', id, ctx, {
    notFoundMessage: 'أمر الشراء غير موجود',
  });
}

export async function listPurchaseOrders(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('purchasing.order.view');
  return paginatedList<unknown>(ctx, 'purchase_orders', { page, pageSize, status });
}
