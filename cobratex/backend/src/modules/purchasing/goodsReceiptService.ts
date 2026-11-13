import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface GoodsReceiptLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitCost: string;
  purchaseOrderLineId?: string;
}

export interface CreateGoodsReceiptInput {
  branchId: string;
  warehouseId: string;
  supplierId: string;
  purchaseOrderId?: string;
  receiptDate: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: GoodsReceiptLineInput[];
}

export async function createGoodsReceipt(ctx: RequestContext, input: CreateGoodsReceiptInput) {
  ctx.assertPermission('purchasing.receipt.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('الاستلام يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'GOODS_RECEIPT', prefix: 'GR-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO goods_receipts(company_id, branch_id, warehouse_id, supplier_id, purchase_order_id, document_number, receipt_date, created_by, activity_id, project_id, cost_center_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.warehouseId, input.supplierId, input.purchaseOrderId ?? null,
        documentNumber, input.receiptDate, ctx.userId, input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO goods_receipt_lines(goods_receipt_id, company_id, item_id, uom_id, purchase_order_line_id, quantity, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [header.rows[0].id, ctx.companyId, line.itemId, line.uomId, line.purchaseOrderLineId ?? null, line.quantity, line.unitCost],
      );
    }
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'goods_receipt', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/**
 * ترحيل الاستلام: حركة وارد مخزون فقط لكل سطر (متوسط مرجح) — **لا قيد محاسبي هنا إطلاقًا**.
 * إن كان مرتبطًا بأمر شراء، يُحدَّث received_quantity، ويُغلَق الأمر تلقائيًا (received) إذا اكتمل.
 */
export async function postGoodsReceipt(ctx: RequestContext, receiptId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM goods_receipts WHERE id=$1 AND company_id=$2 FOR UPDATE`, [receiptId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الاستلام غير موجود');
    const receipt = found.rows[0];
    ctx.assertPermission('purchasing.receipt.post', receipt.branch_id);
    if (receipt.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل استلام بحالة ${receipt.status}؛ يجب أن يكون draft`);

    const lines = await client.query(`SELECT * FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [receiptId]);
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل استلام بلا أسطر');

    for (const line of lines.rows) {
      const movement = await recordInMovement(ctx, {
        branchId: receipt.branch_id, warehouseId: receipt.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, unitCost: line.unit_cost, movementDate: receipt.receipt_date,
        sourceDocumentType: 'goods_receipt', sourceDocumentId: receiptId,
        activityId: receipt.activity_id ?? undefined, projectId: receipt.project_id ?? undefined,
      });
      await client.query(`UPDATE goods_receipt_lines SET stock_movement_id=$1 WHERE id=$2`, [movement.movementId, line.id]);

      if (line.purchase_order_line_id) {
        await client.query(
          `UPDATE purchase_order_lines SET received_quantity = received_quantity + $1 WHERE id=$2`,
          [line.quantity, line.purchase_order_line_id],
        );
      }
    }

    if (receipt.purchase_order_id) {
      const remaining = await client.query(
        `SELECT count(*) FROM purchase_order_lines WHERE purchase_order_id=$1 AND received_quantity < quantity`,
        [receipt.purchase_order_id],
      );
      if (Number(remaining.rows[0].count) === 0) {
        // 'received' يُضبط داخليًا فقط هنا (لا مسار عام يصل إليه) — راجع purchaseOrderService.ts
        await client.query(`UPDATE purchase_orders SET status='received' WHERE id=$1 AND status='confirmed'`, [receipt.purchase_order_id]);
      }
    }

    await client.query(`UPDATE goods_receipts SET status='posted', posted_by=$2, posted_at=now() WHERE id=$1`, [receiptId, ctx.userId]);
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'goods_receipt', entityId: receiptId, action: 'post',
    });
    return { id: receiptId, status: 'posted' };
  });
}

export async function getGoodsReceiptById(ctx: RequestContext, id: string) {
  ctx.assertPermission('purchasing.receipt.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('goods_receipts', id, ctx, {
    notFoundMessage: 'الاستلام غير موجود',
  });
  const lines = await pool.query(`SELECT * FROM goods_receipt_lines WHERE goods_receipt_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listGoodsReceipts(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('purchasing.receipt.view');
  return paginatedList<unknown>(ctx, 'goods_receipts', { page, pageSize, status });
}
