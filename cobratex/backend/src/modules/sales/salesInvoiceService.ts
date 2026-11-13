import { PoolClient } from 'pg';
import { resolveDocumentRate } from '@/modules/accounting/fxRatesService';
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
import { createNotification } from '@/modules/notifications/notificationService';

export interface SalesInvoiceLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
  taxTypeId?: string;
}

export interface CreateSalesInvoiceInput {
  branchId: string;
  warehouseId: string;
  customerId: string;
  salesOrderId?: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  invoiceDate: string;
  /** نوع الدفع (نقدي/آجل/شيك/تحويل) لتقارير البيع حسب نوع الدفع — اختياري. */
  paymentType?: 'cash' | 'credit' | 'cheque' | 'transfer';
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: SalesInvoiceLineInput[];
}

/** ينشئ فاتورة draft فقط (بلا أثر مخزني أو محاسبي بعد) — الأثر الفعلي في postSalesInvoice. */
export async function createSalesInvoice(ctx: RequestContext, input: CreateSalesInvoiceInput) {
  ctx.assertPermission('sales.invoice.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('الفاتورة يجب أن تحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'SALES_INVOICE', prefix: 'SINV-' },
      client,
    );
    const fxRate = await resolveDocumentRate(ctx, input.currencyCode, input.invoiceDate, input.exchangeRate, 'sell', client);
    const header = await client.query(
      `INSERT INTO sales_invoices(
        company_id, branch_id, warehouse_id, customer_id, sales_order_id, fiscal_period_id, document_number,
        currency_code, exchange_rate, invoice_date, created_by, activity_id, project_id, cost_center_id, payment_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.warehouseId, input.customerId, input.salesOrderId ?? null,
        input.fiscalPeriodId, documentNumber, input.currencyCode, fxRate, input.invoiceDate, ctx.userId,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null, input.paymentType ?? null,
      ],
    );

    for (const line of input.lines) {
      const taxRate = line.taxTypeId ? await getActiveTaxRate(ctx.companyId, line.taxTypeId, input.invoiceDate) : undefined;
      const amounts = computeLineAmounts(line.quantity, line.unitPrice, line.discountPercent ?? '0', taxRate);
      await client.query(
        `INSERT INTO sales_invoice_lines(
          sales_invoice_id, company_id, item_id, uom_id, quantity, unit_price, discount_percent, tax_type_id,
          subtotal, tax_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          header.rows[0].id, ctx.companyId, line.itemId, line.uomId, line.quantity, line.unitPrice,
          line.discountPercent ?? '0', line.taxTypeId ?? null, amounts.subtotal, amounts.taxAmount, amounts.total,
        ],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_invoice', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/**
 * ترحيل الفاتورة: يُنفَّذ ضمن معاملة واحدة كل مما يلي معًا (atomic):
 * 1) لكل سطر: حركة صرف مخزون (recordOutMovement، متوسط مرجح) → تُعطي تكلفة البضاعة الفعلية.
 * 2) قيد محاسبي متوازن عبر PostingRule: مدين العميل (إيراد+ضريبة)، دائن الإيراد، دائن ضريبة
 *    المبيعات (إن وُجدت)، مدين تكلفة المبيعات/دائن المخزون لكل سطر (حسب مجموعة صنفه).
 * فشل أي خطوة (رصيد مخزون غير كافٍ، قاعدة ترحيل مفقودة، ...) يُلغي كل شيء معًا.
 */
export async function postSalesInvoice(ctx: RequestContext, invoiceId: string) {
  return withTransaction(async (client: PoolClient) => {
    const found = await client.query(`SELECT * FROM sales_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الفاتورة غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('sales.invoice.post', invoice.branch_id);
    if (invoice.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل فاتورة بحالة ${invoice.status}؛ يجب أن تكون draft`);

    const lines = await client.query(
      `SELECT sil.*, i.category_id, i.item_kind FROM sales_invoice_lines sil
       JOIN items i ON i.id = sil.item_id AND i.company_id = sil.company_id
       WHERE sil.sales_invoice_id = $1`,
      [invoiceId],
    );
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل فاتورة بلا أسطر');

    let totalRevenue = new Decimal(0);
    let totalTax = new Decimal(0);
    const cogsLegs: { itemCategoryId: string; amount: string }[] = [];

    for (const line of lines.rows) {
      if (!line.category_id) {
        throw new ValidationError(`الصنف في السطر بلا مجموعة صنف (category) — لا يمكن تحديد حسابات المخزون/التكلفة`);
      }
      const movement = await recordOutMovement(ctx, {
        branchId: invoice.branch_id, warehouseId: invoice.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, movementDate: invoice.invoice_date, sourceDocumentType: 'sales_invoice', sourceDocumentId: invoiceId,
        activityId: invoice.activity_id ?? undefined, projectId: invoice.project_id ?? undefined,
      });
      await client.query(
        `UPDATE sales_invoice_lines SET cost_of_goods=$1, stock_movement_id=$2 WHERE id=$3`,
        [movement.costOfGoodsConsumed, movement.movementId, line.id],
      );
      cogsLegs.push({ itemCategoryId: line.category_id, amount: movement.costOfGoodsConsumed });
      totalRevenue = totalRevenue.plus(new Decimal(line.subtotal));
      totalTax = totalTax.plus(new Decimal(line.tax_amount));
    }

    const legs = [
      { operationType: 'sales_invoice_revenue', amount: totalRevenue.toFixed(4), customerId: invoice.customer_id },
      ...(totalTax.greaterThan(0)
        ? [{ operationType: 'sales_invoice_tax', amount: totalTax.toFixed(4), customerId: invoice.customer_id }]
        : []),
      ...cogsLegs.map((l) => ({ operationType: 'sales_invoice_cogs', amount: l.amount, itemCategoryId: l.itemCategoryId })),
    ];

    const preview = await buildJournalPreview(ctx, legs, client);
    // نطبِّق مركز التكلفة (إن وُجد على الفاتورة) على كل أسطر القيد الناتجة، ما لم يكن السطر يحمل
    // مركز تكلفة أدقّ مُحدَّدًا مسبقًا (لا يوجد حاليًا في preview.lines، لذا يُطبَّق دائمًا هنا).
    const linesWithCostCenter = invoice.cost_center_id
      ? preview.lines.map((l) => ({ ...l, costCenterId: l.costCenterId ?? invoice.cost_center_id }))
      : preview.lines;
    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: invoice.branch_id, fiscalPeriodId: invoice.fiscal_period_id, entryDate: invoice.invoice_date,
      currencyCode: invoice.currency_code, exchangeRate: invoice.exchange_rate,
      activityId: invoice.activity_id ?? undefined, projectId: invoice.project_id ?? undefined,
      sourceDocumentType: 'sales_invoice', sourceDocumentId: invoiceId, lines: linesWithCostCenter,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE sales_invoices SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [invoiceId, draftEntry.id, ctx.userId],
    );
    if (invoice.sales_order_id) {
      await client.query(`UPDATE sales_orders SET status='invoiced' WHERE id=$1`, [invoice.sales_order_id]);
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_invoice', entityId: invoiceId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, totalRevenue: totalRevenue.toFixed(4), totalTax: totalTax.toFixed(4) },
    });

    // مثال حي لربط الإشعارات بحدث أعمال حقيقي: يُشعَر من رحّل الفاتورة فعليًا (داخل الفرع/التطبيق
    // وعن بُعد عبر Web Push إن كان مشتركًا) — أفضل جهد، لا يُفشل الترحيل نفسه أبدًا إن فشل الإشعار.
    await createNotification({
      companyId: ctx.companyId, userId: ctx.userId, type: 'sales_invoice_posted',
      title: `تم ترحيل فاتورة البيع ${invoice.document_number}`,
      body: `الإجمالي: ${totalRevenue.plus(totalTax).toFixed(4)} ${invoice.currency_code}`,
      sourceDocumentType: 'sales_invoice', sourceDocumentId: invoiceId,
    }, client);

    return { id: invoiceId, journalEntryId: draftEntry.id, totalRevenue: totalRevenue.toFixed(4), totalTax: totalTax.toFixed(4) };
  });
}

/** يعكس فاتورة مرحّلة: يعيد المخزون (حركة وارد بنفس التكلفة) ويعكس القيد، دون حذف أي أثر تاريخي. */
export async function reverseSalesInvoice(ctx: RequestContext, invoiceId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM sales_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الفاتورة غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('sales.invoice.reverse', invoice.branch_id);
    if (invoice.status !== 'posted') throw new ValidationError(`لا يمكن عكس فاتورة بحالة ${invoice.status}؛ يجب أن تكون مرحّلة`);

    const lines = await client.query(`SELECT * FROM sales_invoice_lines WHERE sales_invoice_id=$1`, [invoiceId]);
    for (const line of lines.rows) {
      await recordInMovement(ctx, {
        branchId: invoice.branch_id, warehouseId: invoice.warehouse_id, itemId: line.item_id,
        quantity: line.quantity, unitCost: new Decimal(line.cost_of_goods).dividedBy(new Decimal(line.quantity)).toFixed(4),
        movementDate: invoice.invoice_date, movementType: 'adjustment_in',
        sourceDocumentType: 'sales_invoice_reversal', sourceDocumentId: invoiceId,
      });
    }

    await reverseJournalEntry(ctx, invoice.journal_entry_id, reason);

    await client.query(
      `UPDATE sales_invoices SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [invoiceId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_invoice', entityId: invoiceId, action: 'reverse', reason,
    });
    return { id: invoiceId, status: 'reversed' };
  });
}

export async function cancelDraftSalesInvoice(ctx: RequestContext, invoiceId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب الإلغاء إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM sales_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الفاتورة غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('sales.invoice.cancel', invoice.branch_id);
    if (invoice.status !== 'draft') throw new ValidationError('لا يمكن إلغاء فاتورة إلا بحالة draft (استخدم العكس للفواتير المرحّلة)');
    await client.query(
      `UPDATE sales_invoices SET status='cancelled', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [invoiceId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'sales_invoice', entityId: invoiceId, action: 'cancel', reason,
    });
    return { id: invoiceId, status: 'cancelled' };
  });
}

export async function getSalesInvoiceById(ctx: RequestContext, id: string) {
  ctx.assertPermission('sales.invoice.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('sales_invoices', id, ctx, {
    notFoundMessage: 'الفاتورة غير موجودة',
  });
  const lines = await pool.query(`SELECT * FROM sales_invoice_lines WHERE sales_invoice_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listSalesInvoices(ctx: RequestContext, page = 1, pageSize = 20, status?: string, customerId?: string) {
  ctx.assertPermission('sales.invoice.view');
  return paginatedList<unknown>(ctx, 'sales_invoices', { page, pageSize, status, equals: [{ column: 'customer_id', value: customerId }] });
}
