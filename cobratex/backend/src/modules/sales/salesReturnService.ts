import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { getActiveTaxRate, computeLineAmounts } from '@/modules/accounting/taxService';
import { buildJournalPreview, createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { recordInMovement, recordOutMovement } from '@/modules/inventory/stockService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface SalesReturnLineInput {
  salesInvoiceLineId: string;
  quantity: string;
}

export interface CreateSalesReturnInput {
  branchId: string;
  warehouseId: string;
  salesInvoiceId: string;
  fiscalPeriodId: string;
  returnDate: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: SalesReturnLineInput[];
}

/**
 * ينشئ مرتجع بيع جزئي مستقل: كل سطر يشير لسطر فاتورة أصلي، ويُتحقَّق أن الكمية المرتجعة
 * (مضافًا إليها ما أُرجِع سابقًا لنفس السطر عبر مرتجعات أخرى، مُحجوزة فورًا هنا لمنع تجاوز
 * تراكمي عبر مرتجعين متزامنين) لا تتجاوز الكمية المباعة أصلًا. العملة وسعر الصرف يُشتَقان
 * إلزاميًا من الفاتورة الأصلية (لا يُقبلان من الطلب) لضمان اتساق العملة الأجنبية دون تعارض.
 * المبالغ (سعر/خصم/ضريبة) تُحسَب بنفس شروط الفاتورة الأصلية (نفس نسبة الضريبة السارية وقت
 * تاريخ الفاتورة الأصلية، لا تاريخ اليوم).
 */
export async function createSalesReturn(ctx: RequestContext, input: CreateSalesReturnInput) {
  ctx.assertPermission('sales.return.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('المرتجع يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const invoice = await client.query(
      `SELECT * FROM sales_invoices WHERE id=$1 AND company_id=$2 AND status='posted'`,
      [input.salesInvoiceId, ctx.companyId],
    );
    if (invoice.rows.length === 0) throw new NotFoundError('فاتورة البيع غير موجودة أو غير مرحّلة');
    const inv = invoice.rows[0];

    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'SALES_RETURN', prefix: 'SRET-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO sales_returns(
        company_id, branch_id, warehouse_id, customer_id, sales_invoice_id, fiscal_period_id, document_number,
        currency_code, exchange_rate, return_date, created_by, activity_id, project_id, cost_center_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.warehouseId, inv.customer_id, input.salesInvoiceId, input.fiscalPeriodId,
        documentNumber, inv.currency_code, inv.exchange_rate, input.returnDate, ctx.userId,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );

    for (const line of input.lines) {
      const originalLine = await client.query(
        `SELECT * FROM sales_invoice_lines WHERE id=$1 AND company_id=$2 AND sales_invoice_id=$3 FOR UPDATE`,
        [line.salesInvoiceLineId, ctx.companyId, input.salesInvoiceId],
      );
      if (originalLine.rows.length === 0) throw new NotFoundError(`سطر الفاتورة غير موجود: ${line.salesInvoiceLineId}`);
      const ol = originalLine.rows[0];

      const remaining = new Decimal(ol.quantity).minus(new Decimal(ol.returned_quantity));
      const returnQty = new Decimal(line.quantity);
      if (returnQty.greaterThan(remaining)) {
        throw new ValidationError(
          `الكمية المرتجعة (${returnQty.toFixed(4)}) تتجاوز الكمية القابلة للإرجاع من هذا السطر (${remaining.toFixed(4)})`,
        );
      }

      const taxRate = ol.tax_type_id ? await getActiveTaxRate(ctx.companyId, ol.tax_type_id, inv.invoice_date) : undefined;
      const amounts = computeLineAmounts(line.quantity, ol.unit_price, ol.discount_percent, taxRate);
      const unitCogs = new Decimal(ol.cost_of_goods).dividedBy(new Decimal(ol.quantity));
      const returnCogs = unitCogs.times(returnQty);

      await client.query(
        `INSERT INTO sales_return_lines(sales_return_id, company_id, sales_invoice_line_id, item_id, quantity, subtotal, tax_amount, line_total, cost_of_goods)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [header.rows[0].id, ctx.companyId, line.salesInvoiceLineId, ol.item_id, line.quantity, amounts.subtotal, amounts.taxAmount, amounts.total, returnCogs.toFixed(4)],
      );

      // حجز فوري (حتى بحالة draft) يمنع مرتجعين متزامنين من تجاوز نفس المتبقي معًا،
      // بفضل قفل الصف (FOR UPDATE) أعلاه على سطر الفاتورة نفسه.
      await client.query(
        `UPDATE sales_invoice_lines SET returned_quantity = returned_quantity + $1 WHERE id=$2`,
        [line.quantity, line.salesInvoiceLineId],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_return', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/** ترحيل المرتجع: حركة وارد مخزون (استعادة) لكل سطر + قيد عكسي (إيراد/ضريبة/ذمم عميل/تكلفة مبيعات). */
export async function postSalesReturn(ctx: RequestContext, returnId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM sales_returns WHERE id=$1 AND company_id=$2 FOR UPDATE`, [returnId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('المرتجع غير موجود');
    const ret = found.rows[0];
    ctx.assertPermission('sales.return.post', ret.branch_id);
    if (ret.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل مرتجع بحالة ${ret.status}؛ يجب أن يكون draft`);

    const lines = await client.query(
      `SELECT srl.*, i.category_id FROM sales_return_lines srl
       JOIN items i ON i.id = srl.item_id AND i.company_id = srl.company_id
       WHERE srl.sales_return_id = $1`,
      [returnId],
    );
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل مرتجع بلا أسطر');

    let totalRevenue = new Decimal(0);
    let totalTax = new Decimal(0);
    const cogsLegs: { itemCategoryId: string; amount: string }[] = [];

    for (const line of lines.rows) {
      if (!line.category_id) throw new ValidationError('الصنف بلا مجموعة صنف — لا يمكن تحديد حسابات المخزون/التكلفة');
      const unitCost = new Decimal(line.cost_of_goods).dividedBy(new Decimal(line.quantity));
      const movement = await recordInMovement(ctx, {
        branchId: ret.branch_id, warehouseId: ret.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, unitCost: unitCost.toFixed(4), movementDate: ret.return_date,
        movementType: 'adjustment_in', sourceDocumentType: 'sales_return', sourceDocumentId: returnId,
        activityId: ret.activity_id ?? undefined, projectId: ret.project_id ?? undefined,
      });
      await client.query(`UPDATE sales_return_lines SET stock_movement_id=$1 WHERE id=$2`, [movement.movementId, line.id]);

      cogsLegs.push({ itemCategoryId: line.category_id, amount: line.cost_of_goods });
      totalRevenue = totalRevenue.plus(new Decimal(line.subtotal));
      totalTax = totalTax.plus(new Decimal(line.tax_amount));
    }

    const legs = [
      { operationType: 'sales_return_revenue', amount: totalRevenue.toFixed(4), customerId: ret.customer_id },
      ...(totalTax.greaterThan(0)
        ? [{ operationType: 'sales_return_tax', amount: totalTax.toFixed(4), customerId: ret.customer_id }]
        : []),
      ...cogsLegs.map((l) => ({ operationType: 'sales_return_cogs', amount: l.amount, itemCategoryId: l.itemCategoryId })),
    ];

    const preview = await buildJournalPreview(ctx, legs, client);
    const linesWithCostCenter = ret.cost_center_id
      ? preview.lines.map((l) => ({ ...l, costCenterId: l.costCenterId ?? ret.cost_center_id }))
      : preview.lines;
    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: ret.branch_id, fiscalPeriodId: ret.fiscal_period_id, entryDate: ret.return_date,
      currencyCode: ret.currency_code, exchangeRate: ret.exchange_rate,
      activityId: ret.activity_id ?? undefined, projectId: ret.project_id ?? undefined,
      sourceDocumentType: 'sales_return', sourceDocumentId: returnId, lines: linesWithCostCenter,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE sales_returns SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [returnId, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_return', entityId: returnId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, totalRevenue: totalRevenue.toFixed(4), totalTax: totalTax.toFixed(4) },
    });
    return { id: returnId, journalEntryId: draftEntry.id, totalRevenue: totalRevenue.toFixed(4), totalTax: totalTax.toFixed(4) };
  });
}

/**
 * عكس مرتجع مرحّل: يُصرَف المخزون المُستعاد مجددًا (حركة صرف مقابلة فعلية — وليس مجرد تحرير
 * الكمية المحجوزة كما كان يحدث سابقًا)، ويُعكس القيد، وتُحرَّر الكمية على سطر الفاتورة الأصلي
 * فتصبح قابلة للإرجاع مجددًا لاحقًا.
 */
export async function reverseSalesReturn(ctx: RequestContext, returnId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM sales_returns WHERE id=$1 AND company_id=$2 FOR UPDATE`, [returnId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('المرتجع غير موجود');
    const ret = found.rows[0];
    ctx.assertPermission('sales.return.reverse', ret.branch_id);
    if (ret.status !== 'posted') throw new ValidationError('يجب أن يكون المرتجع مرحّلًا لعكسه');

    const lines = await client.query(`SELECT * FROM sales_return_lines WHERE sales_return_id=$1`, [returnId]);
    for (const line of lines.rows) {
      // نعكس استعادة المخزون فعليًا (نصرفها مجددًا خارج المخزن) — لا مجرد تحرير رقم الكمية
      await recordOutMovement(ctx, {
        branchId: ret.branch_id, warehouseId: ret.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, movementDate: ret.return_date, movementType: 'adjustment_out',
        sourceDocumentType: 'sales_return_reversal', sourceDocumentId: returnId,
        activityId: ret.activity_id ?? undefined, projectId: ret.project_id ?? undefined,
      });
      await client.query(
        `UPDATE sales_invoice_lines SET returned_quantity = returned_quantity - $1 WHERE id=$2`,
        [line.quantity, line.sales_invoice_line_id],
      );
    }
    await reverseJournalEntry(ctx, ret.journal_entry_id, reason);

    await client.query(
      `UPDATE sales_returns SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [returnId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_return', entityId: returnId, action: 'reverse', reason,
    });
    return { id: returnId, status: 'reversed' };
  });
}

export async function getSalesReturnById(ctx: RequestContext, id: string) {
  ctx.assertPermission('sales.return.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('sales_returns', id, ctx, {
    notFoundMessage: 'المرتجع غير موجود',
  });
  const lines = await pool.query(`SELECT * FROM sales_return_lines WHERE sales_return_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listSalesReturns(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('sales.return.view');
  return paginatedList<unknown>(ctx, 'sales_returns', { page, pageSize, status });
}
