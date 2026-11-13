import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { getActiveTaxRate, computeLineAmounts } from '@/modules/accounting/taxService';
import { buildJournalPreview, createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { recordOutMovement, recordInMovement } from '@/modules/inventory/stockService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface PurchaseReturnLineInput {
  supplierInvoiceLineId: string;
  quantity: string;
}

export interface CreatePurchaseReturnInput {
  branchId: string;
  warehouseId: string;
  supplierInvoiceId: string;
  fiscalPeriodId: string;
  returnDate: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: PurchaseReturnLineInput[];
}

/**
 * ينشئ مرتجع شراء جزئي مستقل: كل سطر يشير لسطر فاتورة مورد فعلي، ويُتحقَّق أن الكمية المرتجعة
 * (مضافًا إليها ما أُرجِع سابقًا) لا تتجاوز الكمية المفوترة. العملة وسعر الصرف يُشتَقان إلزاميًا
 * من فاتورة المورد الأصلية (لا يُقبلان من الطلب).
 */
export async function createPurchaseReturn(ctx: RequestContext, input: CreatePurchaseReturnInput) {
  ctx.assertPermission('purchasing.return.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('المرتجع يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const invoice = await client.query(
      `SELECT * FROM supplier_invoices WHERE id=$1 AND company_id=$2 AND status='posted'`,
      [input.supplierInvoiceId, ctx.companyId],
    );
    if (invoice.rows.length === 0) throw new NotFoundError('فاتورة المورد غير موجودة أو غير مرحّلة');
    const inv = invoice.rows[0];

    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'PURCHASE_RETURN', prefix: 'PRET-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO purchase_returns(
        company_id, branch_id, warehouse_id, supplier_id, supplier_invoice_id, fiscal_period_id, document_number,
        currency_code, exchange_rate, return_date, created_by, activity_id, project_id, cost_center_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.warehouseId, inv.supplier_id, input.supplierInvoiceId, input.fiscalPeriodId,
        documentNumber, inv.currency_code, inv.exchange_rate, input.returnDate, ctx.userId,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );

    for (const line of input.lines) {
      const originalLine = await client.query(
        `SELECT * FROM supplier_invoice_lines WHERE id=$1 AND company_id=$2 AND supplier_invoice_id=$3 FOR UPDATE`,
        [line.supplierInvoiceLineId, ctx.companyId, input.supplierInvoiceId],
      );
      if (originalLine.rows.length === 0) throw new NotFoundError(`سطر فاتورة المورد غير موجود: ${line.supplierInvoiceLineId}`);
      const ol = originalLine.rows[0];

      const remaining = new Decimal(ol.quantity).minus(new Decimal(ol.returned_quantity));
      const returnQty = new Decimal(line.quantity);
      if (returnQty.greaterThan(remaining)) {
        throw new ValidationError(
          `الكمية المرتجعة (${returnQty.toFixed(4)}) تتجاوز الكمية القابلة للإرجاع من هذا السطر (${remaining.toFixed(4)})`,
        );
      }

      const taxRate = ol.tax_type_id ? await getActiveTaxRate(ctx.companyId, ol.tax_type_id, inv.invoice_date) : undefined;
      const amounts = computeLineAmounts(line.quantity, ol.unit_cost, '0', taxRate);

      await client.query(
        `INSERT INTO purchase_return_lines(purchase_return_id, company_id, supplier_invoice_line_id, item_id, quantity, unit_cost, subtotal, tax_amount, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [header.rows[0].id, ctx.companyId, line.supplierInvoiceLineId, ol.item_id, line.quantity, ol.unit_cost, amounts.subtotal, amounts.taxAmount, amounts.total],
      );

      await client.query(
        `UPDATE supplier_invoice_lines SET returned_quantity = returned_quantity + $1 WHERE id=$2`,
        [line.quantity, line.supplierInvoiceLineId],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'purchase_return', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/** ترحيل المرتجع: حركة صرف مخزون (إعادة للمورد) لكل سطر + قيد (مدين التزام المورد، دائن مخزون/ضريبة). */
export async function postPurchaseReturn(ctx: RequestContext, returnId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM purchase_returns WHERE id=$1 AND company_id=$2 FOR UPDATE`, [returnId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('المرتجع غير موجود');
    const ret = found.rows[0];
    ctx.assertPermission('purchasing.return.post', ret.branch_id);
    if (ret.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل مرتجع بحالة ${ret.status}؛ يجب أن يكون draft`);

    const lines = await client.query(
      `SELECT prl.*, i.category_id FROM purchase_return_lines prl
       JOIN items i ON i.id = prl.item_id AND i.company_id = prl.company_id
       WHERE prl.purchase_return_id = $1`,
      [returnId],
    );
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل مرتجع بلا أسطر');

    let totalTax = new Decimal(0);
    const inventoryLegs: { itemCategoryId: string; amount: string }[] = [];

    for (const line of lines.rows) {
      if (!line.category_id) throw new ValidationError('الصنف بلا مجموعة صنف — لا يمكن تحديد حساب المخزون');
      const movement = await recordOutMovement(ctx, {
        branchId: ret.branch_id, warehouseId: ret.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, movementDate: ret.return_date, movementType: 'adjustment_out',
        sourceDocumentType: 'purchase_return', sourceDocumentId: returnId,
        activityId: ret.activity_id ?? undefined, projectId: ret.project_id ?? undefined,
      });
      await client.query(`UPDATE purchase_return_lines SET stock_movement_id=$1 WHERE id=$2`, [movement.movementId, line.id]);

      inventoryLegs.push({ itemCategoryId: line.category_id, amount: line.subtotal });
      totalTax = totalTax.plus(new Decimal(line.tax_amount));
    }

    const legs = [
      ...inventoryLegs.map((l) => ({ operationType: 'purchase_return_inventory', amount: l.amount, itemCategoryId: l.itemCategoryId, supplierId: ret.supplier_id })),
      ...(totalTax.greaterThan(0)
        ? [{ operationType: 'purchase_return_tax', amount: totalTax.toFixed(4), supplierId: ret.supplier_id }]
        : []),
    ];

    const preview = await buildJournalPreview(ctx, legs, client);
    const linesWithCostCenter = ret.cost_center_id
      ? preview.lines.map((l) => ({ ...l, costCenterId: l.costCenterId ?? ret.cost_center_id }))
      : preview.lines;
    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: ret.branch_id, fiscalPeriodId: ret.fiscal_period_id, entryDate: ret.return_date,
      currencyCode: ret.currency_code, exchangeRate: ret.exchange_rate,
      activityId: ret.activity_id ?? undefined, projectId: ret.project_id ?? undefined,
      sourceDocumentType: 'purchase_return', sourceDocumentId: returnId, lines: linesWithCostCenter,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE purchase_returns SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [returnId, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'purchase_return', entityId: returnId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, totalTax: totalTax.toFixed(4) },
    });
    return { id: returnId, journalEntryId: draftEntry.id, totalTax: totalTax.toFixed(4) };
  });
}

/** عكس مرتجع مرحّل: استعادة المخزون فعليًا (حركة وارد مقابلة) + عكس القيد + تحرير الكمية المحجوزة. */
export async function reversePurchaseReturn(ctx: RequestContext, returnId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM purchase_returns WHERE id=$1 AND company_id=$2 FOR UPDATE`, [returnId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('المرتجع غير موجود');
    const ret = found.rows[0];
    ctx.assertPermission('purchasing.return.reverse', ret.branch_id);
    if (ret.status !== 'posted') throw new ValidationError('يجب أن يكون المرتجع مرحّلًا لعكسه');

    const lines = await client.query(`SELECT * FROM purchase_return_lines WHERE purchase_return_id=$1`, [returnId]);
    for (const line of lines.rows) {
      await recordInMovement(ctx, {
        branchId: ret.branch_id, warehouseId: ret.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, unitCost: line.unit_cost, movementDate: ret.return_date,
        movementType: 'adjustment_in', sourceDocumentType: 'purchase_return_reversal', sourceDocumentId: returnId,
        activityId: ret.activity_id ?? undefined, projectId: ret.project_id ?? undefined,
      });
      await client.query(
        `UPDATE supplier_invoice_lines SET returned_quantity = returned_quantity - $1 WHERE id=$2`,
        [line.quantity, line.supplier_invoice_line_id],
      );
    }
    await reverseJournalEntry(ctx, ret.journal_entry_id, reason);

    await client.query(
      `UPDATE purchase_returns SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [returnId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'purchase_return', entityId: returnId, action: 'reverse', reason,
    });
    return { id: returnId, status: 'reversed' };
  });
}

export async function getPurchaseReturnById(ctx: RequestContext, id: string) {
  ctx.assertPermission('purchasing.return.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('purchase_returns', id, ctx, {
    notFoundMessage: 'المرتجع غير موجود',
  });
  const lines = await pool.query(`SELECT * FROM purchase_return_lines WHERE purchase_return_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listPurchaseReturns(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('purchasing.return.view');
  return paginatedList<unknown>(ctx, 'purchase_returns', { page, pageSize, status });
}
