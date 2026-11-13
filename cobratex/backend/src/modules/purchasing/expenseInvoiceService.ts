import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { getActiveTaxRate, computeLineAmounts } from '@/modules/accounting/taxService';
import { createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry, JournalLineInput } from '@/modules/accounting/accountingService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface ExpenseInvoiceLineInput {
  expenseAccountId: string;
  description: string;
  amount: string;
  discountPercent?: string;
  taxTypeId?: string;
}

export interface CreateExpenseInvoiceInput {
  branchId: string;
  /** أحدهما إلزامي، والآخر يجب أن يبقى فارغًا — راجع قيد CHECK في المهاجرة. */
  supplierId?: string;
  paidFromAccountId?: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  invoiceDate: string;
  description?: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: ExpenseInvoiceLineInput[];
}

/**
 * فاتورة مصروف غير مخزنية (خدمات، إيجار، رسوم، صيانة...): لا صنف ولا حركة مخزون إطلاقًا —
 * كل سطر يذهب مباشرة لحساب مصروف محدَّد صراحةً بواسطة المستخدم (لا محرك قواعد ترحيل هنا، فحساب
 * المصروف يختلف من سطر لآخر ولا يمكن تخمينه من فئة صنف كما في المخزون).
 */
export async function createExpenseInvoice(ctx: RequestContext, input: CreateExpenseInvoiceInput) {
  ctx.assertPermission('purchasing.expense_invoice.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('فاتورة المصروف يجب أن تحتوي سطرًا واحدًا على الأقل');
  const hasSupplier = !!input.supplierId;
  const hasPaidFrom = !!input.paidFromAccountId;
  if (hasSupplier === hasPaidFrom) {
    throw new ValidationError('حدِّد إما supplierId (فاتورة آجلة على مورد) أو paidFromAccountId (مدفوعة فورًا)، وليس كليهما أو لا شيء');
  }

  return withTransaction(async (client) => {
    if (input.supplierId) {
      const supplier = await client.query(`SELECT id FROM suppliers WHERE id=$1 AND company_id=$2`, [input.supplierId, ctx.companyId]);
      if (supplier.rows.length === 0) throw new NotFoundError('المورد غير موجود');
    }
    if (input.paidFromAccountId) {
      const account = await client.query(`SELECT id FROM accounts WHERE id=$1 AND company_id=$2`, [input.paidFromAccountId, ctx.companyId]);
      if (account.rows.length === 0) throw new NotFoundError('حساب الدفع غير موجود');
    }

    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'EXPENSE_INVOICE', prefix: 'EINV-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO expense_invoices(
        company_id, branch_id, supplier_id, paid_from_account_id, fiscal_period_id, document_number,
        currency_code, exchange_rate, invoice_date, description, activity_id, project_id, cost_center_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.supplierId ?? null, input.paidFromAccountId ?? null, input.fiscalPeriodId,
        documentNumber, input.currencyCode, input.exchangeRate ?? '1', input.invoiceDate, input.description ?? null,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null, ctx.userId,
      ],
    );

    for (const line of input.lines) {
      const account = await client.query(`SELECT id FROM accounts WHERE id=$1 AND company_id=$2`, [line.expenseAccountId, ctx.companyId]);
      if (account.rows.length === 0) throw new NotFoundError(`حساب المصروف غير موجود: ${line.expenseAccountId}`);

      const taxRate = line.taxTypeId ? await getActiveTaxRate(ctx.companyId, line.taxTypeId, input.invoiceDate) : undefined;
      const amounts = computeLineAmounts('1', line.amount, line.discountPercent ?? '0', taxRate);

      await client.query(
        `INSERT INTO expense_invoice_lines(
          expense_invoice_id, company_id, expense_account_id, description, amount, discount_percent,
          tax_type_id, subtotal, tax_amount, line_total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          header.rows[0].id, ctx.companyId, line.expenseAccountId, line.description, line.amount,
          line.discountPercent ?? '0', line.taxTypeId ?? null, amounts.subtotal, amounts.taxAmount, amounts.total,
        ],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'expense_invoice', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/** ترحيل فاتورة المصروف: مدين كل حساب مصروف بقيمته + مدين حساب الضريبة (مجمَّع)، دائن واحد فقط (المورد أو حساب الدفع). */
export async function postExpenseInvoice(ctx: RequestContext, invoiceId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM expense_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('فاتورة المصروف غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('purchasing.expense_invoice.post', invoice.branch_id);
    if (invoice.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل فاتورة بحالة ${invoice.status}؛ يجب أن تكون draft`);

    const lines = await client.query(`SELECT * FROM expense_invoice_lines WHERE expense_invoice_id=$1`, [invoiceId]);
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل فاتورة بلا أسطر');

    const journalLines: JournalLineInput[] = [];
    let totalCredit = new Decimal(0);
    const taxByAccount = new Map<string, Decimal>();

    for (const line of lines.rows) {
      journalLines.push({
        accountId: line.expense_account_id, debit: line.subtotal, credit: '0',
        costCenterId: invoice.cost_center_id ?? undefined, description: line.description,
      });
      totalCredit = totalCredit.plus(new Decimal(line.line_total));

      if (new Decimal(line.tax_amount).greaterThan(0)) {
        if (!line.tax_type_id) throw new ValidationError('سطر بمبلغ ضريبة بلا نوع ضريبة — بيانات غير متسقة');
        const taxType = await client.query(`SELECT purchase_tax_account_id FROM tax_types WHERE id=$1 AND company_id=$2`, [line.tax_type_id, ctx.companyId]);
        if (taxType.rows.length === 0 || !taxType.rows[0].purchase_tax_account_id) {
          throw new ValidationError('نوع الضريبة بلا حساب ضريبة مشتريات مُهيَّأ — لا يمكن الترحيل');
        }
        const acc = taxType.rows[0].purchase_tax_account_id as string;
        taxByAccount.set(acc, (taxByAccount.get(acc) ?? new Decimal(0)).plus(new Decimal(line.tax_amount)));
      }
    }
    for (const [accountId, amount] of taxByAccount.entries()) {
      journalLines.push({ accountId, debit: amount.toFixed(4), credit: '0', description: 'ضريبة مشتريات — فاتورة مصروف' });
    }

    const creditAccountId = invoice.supplier_id
      ? (await client.query(`SELECT linked_account_id FROM suppliers WHERE id=$1 AND company_id=$2`, [invoice.supplier_id, ctx.companyId])).rows[0]?.linked_account_id
      : invoice.paid_from_account_id;
    if (!creditAccountId) throw new NotFoundError('تعذَّر تحديد حساب الدائن (المورد أو حساب الدفع)');
    journalLines.push({ accountId: creditAccountId, debit: '0', credit: totalCredit.toFixed(4), description: 'فاتورة مصروف' });

    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: invoice.branch_id, fiscalPeriodId: invoice.fiscal_period_id, entryDate: invoice.invoice_date,
      currencyCode: invoice.currency_code, exchangeRate: invoice.exchange_rate,
      activityId: invoice.activity_id ?? undefined, projectId: invoice.project_id ?? undefined,
      sourceDocumentType: 'expense_invoice', sourceDocumentId: invoiceId, lines: journalLines,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE expense_invoices SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [invoiceId, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'expense_invoice', entityId: invoiceId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, totalCredit: totalCredit.toFixed(4) },
    });
    return { id: invoiceId, journalEntryId: draftEntry.id };
  });
}

export async function reverseExpenseInvoice(ctx: RequestContext, invoiceId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM expense_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`, [invoiceId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('فاتورة المصروف غير موجودة');
    const invoice = found.rows[0];
    ctx.assertPermission('purchasing.expense_invoice.reverse', invoice.branch_id);
    if (invoice.status !== 'posted') throw new ValidationError('يجب أن تكون الفاتورة مرحّلة لعكسها');

    await reverseJournalEntry(ctx, invoice.journal_entry_id, reason);
    await client.query(
      `UPDATE expense_invoices SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [invoiceId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'expense_invoice', entityId: invoiceId, action: 'reverse', reason,
    });
    return { id: invoiceId, status: 'reversed' };
  });
}

export async function getExpenseInvoiceById(ctx: RequestContext, id: string) {
  ctx.assertPermission('purchasing.expense_invoice.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string; status: string }>('expense_invoices', id, ctx, {
    notFoundMessage: 'فاتورة المصروف غير موجودة',
  });
  const lines = await pool.query(`SELECT * FROM expense_invoice_lines WHERE expense_invoice_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listExpenseInvoices(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('purchasing.expense_invoice.view');
  return paginatedList<unknown>(ctx, 'expense_invoices', { page, pageSize, status });
}
