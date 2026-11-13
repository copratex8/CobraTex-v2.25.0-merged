import Decimal from 'decimal.js';
import { resolveDocumentRate } from '@/modules/accounting/fxRatesService';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { getActiveTaxRate, computeLineAmounts } from '@/modules/accounting/taxService';
import { buildJournalPreview, createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface SupplierInvoiceLineInput {
  goodsReceiptLineId: string;
  quantity: string;
  unitCost: string;
  taxTypeId?: string;
}

export interface CreateSupplierInvoiceInput {
  branchId: string;
  supplierId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  invoiceDate: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: SupplierInvoiceLineInput[];
}

/**
 * ينشئ فاتورة مورد draft: يتحقق أن كل سطر يشير إلى سطر استلام فعلي (goods_receipt_line_id)،
 * وأن الكمية المفوترة لا تتجاوز (الكمية المستلمة - المفوترة سابقًا) لنفس سطر الاستلام —
 * يمنع فوترة كمية أكبر من المستلمة أو تكرار فوترة نفس الكمية مرتين عبر فواتير مختلفة.
 */
export async function createSupplierInvoice(ctx: RequestContext, input: CreateSupplierInvoiceInput) {
  ctx.assertPermission('purchasing.invoice.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('الفاتورة يجب أن تحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'SUPPLIER_INVOICE', prefix: 'PINV-' },
      client,
    );
    const fxRate = await resolveDocumentRate(ctx, input.currencyCode, input.invoiceDate, input.exchangeRate, 'buy', client);
    const header = await client.query(
      `INSERT INTO supplier_invoices(company_id, branch_id, supplier_id, fiscal_period_id, document_number, currency_code, exchange_rate, invoice_date, created_by, activity_id, project_id, cost_center_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.supplierId, input.fiscalPeriodId, documentNumber, input.currencyCode,
        fxRate, input.invoiceDate, ctx.userId,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );

    for (const line of input.lines) {
      const receiptLine = await client.query(
        `SELECT * FROM goods_receipt_lines WHERE id=$1 AND company_id=$2 FOR UPDATE`,
        [line.goodsReceiptLineId, ctx.companyId],
      );
      if (receiptLine.rows.length === 0) throw new NotFoundError(`سطر الاستلام غير موجود: ${line.goodsReceiptLineId}`);
      const rl = receiptLine.rows[0];
      const remaining = new Decimal(rl.quantity).minus(new Decimal(rl.invoiced_quantity));
      const requestedQty = new Decimal(line.quantity);
      if (requestedQty.greaterThan(remaining)) {
        throw new ValidationError(
          `الكمية المفوترة (${requestedQty.toFixed(4)}) تتجاوز الكمية المستلمة غير المفوترة بعد (${remaining.toFixed(4)}) لسطر الاستلام ${line.goodsReceiptLineId}`,
        );
      }

      const taxRate = line.taxTypeId ? await getActiveTaxRate(ctx.companyId, line.taxTypeId, input.invoiceDate) : undefined;
      const amounts = computeLineAmounts(line.quantity, line.unitCost, '0', taxRate);

      await client.query(
        `INSERT INTO supplier_invoice_lines(
          supplier_invoice_id, company_id, goods_receipt_line_id, item_id, quantity, unit_cost, tax_type_id, subtotal, tax_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          header.rows[0].id, ctx.companyId, line.goodsReceiptLineId, rl.item_id, line.quantity, line.unitCost,
          line.taxTypeId ?? null, amounts.subtotal, amounts.taxAmount, amounts.total,
        ],
      );
      // نحجز الكمية فورًا عند الإنشاء (لا فقط عند الترحيل) لمنع فاتورتين مسودّتين متزامنتين من
      // فوترة نفس الكمية المتبقية معًا؛ الحجز مؤقت ضمن حالة draft، ويُتراجع عنه عند الإلغاء.
      await client.query(
        `UPDATE goods_receipt_lines SET invoiced_quantity = invoiced_quantity + $1 WHERE id=$2`,
        [line.quantity, line.goodsReceiptLineId],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_invoice', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/**
 * ترحيل فاتورة المورد: قيد محاسبي فقط (مدين مخزون/مصروف + ضريبة قابلة للخصم، دائن التزام المورد)
 * — **بلا أي حركة مخزون جديدة**، لأن الكمية والتكلفة سُجِّلتا فعليًا عند ترحيل الاستلام.
 */
export async function postSupplierInvoice(ctx: RequestContext, invoiceId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM supplier_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الفاتورة غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('purchasing.invoice.post', invoice.branch_id);
    if (invoice.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل فاتورة بحالة ${invoice.status}؛ يجب أن تكون draft`);

    const lines = await client.query(
      `SELECT sil.*, i.category_id FROM supplier_invoice_lines sil
       JOIN items i ON i.id = sil.item_id AND i.company_id = sil.company_id
       WHERE sil.supplier_invoice_id = $1`,
      [invoiceId],
    );
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل فاتورة بلا أسطر');

    let totalTax = new Decimal(0);
    const inventoryLegs: { itemCategoryId: string; amount: string }[] = [];
    for (const line of lines.rows) {
      if (!line.category_id) throw new ValidationError('الصنف بلا مجموعة صنف — لا يمكن تحديد حساب المخزون');
      inventoryLegs.push({ itemCategoryId: line.category_id, amount: line.subtotal });
      totalTax = totalTax.plus(new Decimal(line.tax_amount));
    }

    const legs = [
      ...inventoryLegs.map((l) => ({ operationType: 'purchase_invoice_inventory', amount: l.amount, itemCategoryId: l.itemCategoryId, supplierId: invoice.supplier_id })),
      ...(totalTax.greaterThan(0)
        ? [{ operationType: 'purchase_invoice_tax', amount: totalTax.toFixed(4), supplierId: invoice.supplier_id }]
        : []),
    ];

    const preview = await buildJournalPreview(ctx, legs, client);
    const linesWithCostCenter = invoice.cost_center_id
      ? preview.lines.map((l) => ({ ...l, costCenterId: l.costCenterId ?? invoice.cost_center_id }))
      : preview.lines;
    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: invoice.branch_id, fiscalPeriodId: invoice.fiscal_period_id, entryDate: invoice.invoice_date,
      currencyCode: invoice.currency_code, exchangeRate: invoice.exchange_rate,
      activityId: invoice.activity_id ?? undefined, projectId: invoice.project_id ?? undefined,
      sourceDocumentType: 'supplier_invoice', sourceDocumentId: invoiceId, lines: linesWithCostCenter,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE supplier_invoices SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [invoiceId, draftEntry.id, ctx.userId],
    );

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_invoice', entityId: invoiceId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, totalTax: totalTax.toFixed(4) },
    });
    return { id: invoiceId, journalEntryId: draftEntry.id };
  });
}

export async function reverseSupplierInvoice(ctx: RequestContext, invoiceId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM supplier_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الفاتورة غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('purchasing.invoice.reverse', invoice.branch_id);
    if (invoice.status !== 'posted') throw new ValidationError('يجب أن تكون الفاتورة مرحّلة لعكسها');

    await reverseJournalEntry(ctx, invoice.journal_entry_id, reason);

    const lines = await client.query(`SELECT * FROM supplier_invoice_lines WHERE supplier_invoice_id=$1`, [invoiceId]);
    for (const line of lines.rows) {
      await client.query(
        `UPDATE goods_receipt_lines SET invoiced_quantity = invoiced_quantity - $1 WHERE id=$2`,
        [line.quantity, line.goods_receipt_line_id],
      ); // تحرير الكمية المحجوزة، بحيث يمكن فوترتها مجددًا لاحقًا
    }

    await client.query(
      `UPDATE supplier_invoices SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [invoiceId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_invoice', entityId: invoiceId, action: 'reverse', reason,
    });
    return { id: invoiceId, status: 'reversed' };
  });
}

export async function getSupplierInvoiceById(ctx: RequestContext, id: string) {
  ctx.assertPermission('purchasing.invoice.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('supplier_invoices', id, ctx, {
    notFoundMessage: 'الفاتورة غير موجودة',
  });
  const lines = await pool.query(`SELECT * FROM supplier_invoice_lines WHERE supplier_invoice_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listSupplierInvoices(ctx: RequestContext, page = 1, pageSize = 20, status?: string, supplierId?: string) {
  ctx.assertPermission('purchasing.invoice.view');
  return paginatedList<unknown>(ctx, 'supplier_invoices', { page, pageSize, status, equals: [{ column: 'supplier_id', value: supplierId }] });
}
