import Decimal from 'decimal.js';
import { resolveDocumentRate } from '@/modules/accounting/fxRatesService';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { fetchScopedById, assertBranchScope } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface SupplierPaymentAllocationInput {
  supplierInvoiceId: string;
  amount: string;
}

export interface CreateSupplierPaymentInput {
  branchId: string;
  supplierId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  paymentDate: string;
  amount: string;
  paymentAccountId: string; // حساب الخزينة/البنك الدافع
  allocations?: SupplierPaymentAllocationInput[];
}

async function getInvoiceAllocatedTotal(client: PoolClient, invoiceId: string): Promise<Decimal> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(allocated_amount), 0) AS total FROM supplier_payment_allocations WHERE supplier_invoice_id = $1`,
    [invoiceId],
  );
  return new Decimal(rows[0].total);
}

/** صافي مستحق فاتورة مورد = إجمالي الأسطر ناقص أي مرتجعات شراء مرحّلة مرتبطة بها. */
async function getSupplierInvoiceNetTotal(client: PoolClient, invoiceId: string): Promise<Decimal> {
  const lines = await client.query(`SELECT COALESCE(SUM(line_total),0) AS total FROM supplier_invoice_lines WHERE supplier_invoice_id=$1`, [invoiceId]);
  const returns = await client.query(
    `SELECT COALESCE(SUM(prl.line_total),0) AS total FROM purchase_return_lines prl
     JOIN purchase_returns pr ON pr.id = prl.purchase_return_id
     WHERE pr.supplier_invoice_id = $1 AND pr.status = 'posted'`,
    [invoiceId],
  );
  return new Decimal(lines.rows[0].total).minus(new Decimal(returns.rows[0].total));
}

export async function getSupplierInvoiceRemainingBalance(ctx: RequestContext, invoiceId: string) {
  ctx.assertPermission('purchasing.invoice.view');
  const invoice = await pool.query(`SELECT id, branch_id FROM supplier_invoices WHERE id=$1 AND company_id=$2 AND status='posted'`, [invoiceId, ctx.companyId]);
  if (invoice.rows.length === 0) throw new NotFoundError('فاتورة المورد غير موجودة أو غير مرحّلة');
  assertBranchScope(ctx, invoice.rows[0].branch_id);
  const total = await getSupplierInvoiceNetTotal(pool as unknown as PoolClient, invoiceId);
  const allocated = await getInvoiceAllocatedTotal(pool as unknown as PoolClient, invoiceId);
  return { total: total.toFixed(4), allocated: allocated.toFixed(4), remaining: total.minus(allocated).toFixed(4) };
}

export async function createSupplierPayment(ctx: RequestContext, input: CreateSupplierPaymentInput) {
  ctx.assertPermission('purchasing.payment.create', input.branchId);
  const amount = new Decimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new ValidationError('مبلغ الدفعة يجب أن يكون موجبًا');

  const allocations = input.allocations ?? [];
  const totalAllocated = allocations.reduce((s, a) => s.plus(new Decimal(a.amount)), new Decimal(0));
  if (totalAllocated.greaterThan(amount)) {
    throw new ValidationError(`إجمالي التخصيصات (${totalAllocated.toFixed(4)}) يتجاوز مبلغ الدفعة (${amount.toFixed(4)})`);
  }

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'SUPPLIER_PAYMENT', prefix: 'PAY-' },
      client,
    );
    const fxRate = await resolveDocumentRate(ctx, input.currencyCode, input.paymentDate, input.exchangeRate, 'buy', client);
    const header = await client.query(
      `INSERT INTO supplier_payments(
        company_id, branch_id, supplier_id, fiscal_period_id, document_number, currency_code, exchange_rate,
        payment_date, amount, payment_account_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.supplierId, input.fiscalPeriodId, documentNumber, input.currencyCode,
        fxRate, input.paymentDate, amount.toFixed(4), input.paymentAccountId, ctx.userId,
      ],
    );

    for (const allocation of allocations) {
      const invoiceLock = await client.query(
        `SELECT id FROM supplier_invoices WHERE id=$1 AND company_id=$2 AND status='posted' FOR UPDATE`,
        [allocation.supplierInvoiceId, ctx.companyId],
      );
      if (invoiceLock.rows.length === 0) throw new NotFoundError(`فاتورة المورد غير موجودة أو غير مرحّلة: ${allocation.supplierInvoiceId}`);

      const invoiceTotal = await getSupplierInvoiceNetTotal(client, allocation.supplierInvoiceId);
      const alreadyAllocated = await getInvoiceAllocatedTotal(client, allocation.supplierInvoiceId);
      const remaining = invoiceTotal.minus(alreadyAllocated);
      const allocAmount = new Decimal(allocation.amount);

      if (allocAmount.greaterThan(remaining)) {
        throw new ValidationError(
          `مبلغ التخصيص (${allocAmount.toFixed(4)}) يتجاوز المتبقي غير المسدَّد من فاتورة المورد (${remaining.toFixed(4)})`,
        );
      }

      await client.query(
        `INSERT INTO supplier_payment_allocations(company_id, supplier_payment_id, supplier_invoice_id, allocated_amount)
         VALUES ($1,$2,$3,$4)`,
        [ctx.companyId, header.rows[0].id, allocation.supplierInvoiceId, allocAmount.toFixed(4)],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_payment', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, amount: amount.toFixed(4), allocationCount: allocations.length },
    });
    return header.rows[0];
  });
}

/** ترحيل الدفعة: قيد واحد (مدين حساب المورد الفرعي، دائن خزينة/بنك). */
export async function postSupplierPayment(ctx: RequestContext, paymentId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM supplier_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`, [paymentId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الدفعة غير موجودة');
    const payment = found.rows[0];
    ctx.assertPermission('purchasing.payment.post', payment.branch_id);
    if (payment.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل دفعة بحالة ${payment.status}؛ يجب أن تكون draft`);

    const supplier = await client.query(`SELECT linked_account_id FROM suppliers WHERE id=$1 AND company_id=$2`, [payment.supplier_id, ctx.companyId]);
    if (supplier.rows.length === 0) throw new NotFoundError('المورد غير موجود');

    const lines = [
      { accountId: supplier.rows[0].linked_account_id, debit: payment.amount, credit: '0' },
      { accountId: payment.payment_account_id, debit: '0', credit: payment.amount },
    ];

    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: payment.branch_id, fiscalPeriodId: payment.fiscal_period_id, entryDate: payment.payment_date,
      currencyCode: payment.currency_code, exchangeRate: payment.exchange_rate,
      sourceDocumentType: 'supplier_payment', sourceDocumentId: paymentId, lines,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE supplier_payments SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [paymentId, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_payment', entityId: paymentId, action: 'post', afterJson: { journalEntryId: draftEntry.id },
    });
    return { id: paymentId, journalEntryId: draftEntry.id };
  });
}

export async function reverseSupplierPayment(ctx: RequestContext, paymentId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM supplier_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`, [paymentId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الدفعة غير موجودة');
    const payment = found.rows[0];
    ctx.assertPermission('purchasing.payment.reverse', payment.branch_id);
    if (payment.status !== 'posted') throw new ValidationError('يجب أن تكون الدفعة مرحّلة لعكسها');

    await reverseJournalEntry(ctx, payment.journal_entry_id, reason);
    await client.query(`DELETE FROM supplier_payment_allocations WHERE supplier_payment_id=$1`, [paymentId]);

    await client.query(
      `UPDATE supplier_payments SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [paymentId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_payment', entityId: paymentId, action: 'reverse', reason,
    });
    return { id: paymentId, status: 'reversed' };
  });
}

export interface AllocateAdvancePaymentInput {
  supplierInvoiceId: string;
  amount: string;
}

/** مرآة تامة لـ allocateAdvancePayment في customerPaymentService.ts، بنفس الضمانات (راجع تعليقها). */
export async function allocateAdvancePayment(ctx: RequestContext, paymentId: string, allocations: AllocateAdvancePaymentInput[]) {
  if (allocations.length === 0) throw new ValidationError('قائمة التخصيصات لا يمكن أن تكون فارغة');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM supplier_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`, [paymentId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الدفعة غير موجودة');
    const payment = found.rows[0];
    ctx.assertPermission('purchasing.payment.allocate', payment.branch_id);
    if (payment.status !== 'posted') throw new ValidationError('يجب أن تكون الدفعة مرحّلة (posted) قبل تخصيصها لفاتورة');

    const currentAllocations = await client.query(
      `SELECT COALESCE(SUM(allocated_amount), 0) AS total FROM supplier_payment_allocations WHERE supplier_payment_id=$1`,
      [paymentId],
    );
    const paymentAllocated = new Decimal(currentAllocations.rows[0].total);
    const paymentRemaining = new Decimal(payment.amount).minus(paymentAllocated);

    const requestedTotal = allocations.reduce((s, a) => s.plus(new Decimal(a.amount)), new Decimal(0));
    if (requestedTotal.greaterThan(paymentRemaining)) {
      throw new ValidationError(`إجمالي التخصيصات الجديدة (${requestedTotal.toFixed(4)}) يتجاوز المتبقي غير المخصَّص من الدفعة (${paymentRemaining.toFixed(4)})`);
    }

    const created: unknown[] = [];
    const fxLines: { accountId: string; debit: string; credit: string; description: string }[] = [];
    let fxAccountId: string | null | undefined;

    for (const allocation of allocations) {
      const invoiceLock = await client.query(
        `SELECT id, branch_id, currency_code, exchange_rate FROM supplier_invoices WHERE id=$1 AND company_id=$2 AND status='posted' FOR UPDATE`,
        [allocation.supplierInvoiceId, ctx.companyId],
      );
      if (invoiceLock.rows.length === 0) throw new NotFoundError(`فاتورة المورد غير موجودة أو غير مرحّلة: ${allocation.supplierInvoiceId}`);
      assertBranchScope(ctx, invoiceLock.rows[0].branch_id);

      const invoiceTotal = await getSupplierInvoiceNetTotal(client, allocation.supplierInvoiceId);
      const invoiceAllocated = await getInvoiceAllocatedTotal(client, allocation.supplierInvoiceId);
      const invoiceRemaining = invoiceTotal.minus(invoiceAllocated);
      const allocAmount = new Decimal(allocation.amount);
      if (allocAmount.lessThanOrEqualTo(0)) throw new ValidationError('مبلغ التخصيص يجب أن يكون موجبًا');
      if (allocAmount.greaterThan(invoiceRemaining)) {
        throw new ValidationError(`مبلغ التخصيص (${allocAmount.toFixed(4)}) يتجاوز المتبقي غير المدفوع من الفاتورة (${invoiceRemaining.toFixed(4)})`);
      }

      // فرق العملة (مرآة لمنطق العملاء بإشارة معكوسة، لأن الحساب هنا التزام/دائن لا ذمة/مدين —
      // راجع تعليق التصميم المفصَّل في customerPaymentService.allocateAdvancePayment).
      let fxDifference = new Decimal(0);
      const invoiceRate = new Decimal(invoiceLock.rows[0].exchange_rate);
      const paymentRate = new Decimal(payment.exchange_rate);
      if (invoiceLock.rows[0].currency_code === payment.currency_code && !invoiceRate.equals(paymentRate)) {
        fxDifference = allocAmount.times(paymentRate.minus(invoiceRate));
        if (!fxDifference.isZero()) {
          if (!fxAccountId) {
            const company = await client.query(`SELECT fx_gain_loss_account_id FROM companies WHERE id=$1`, [ctx.companyId]);
            fxAccountId = company.rows[0]?.fx_gain_loss_account_id;
            if (!fxAccountId) {
              throw new ValidationError(
                'يوجد فرق عملة بين سعر صرف الفاتورة وسعر صرف الدفعة، لكن لم يُحدَّد حساب فرق العملة للشركة بعد — '
                + 'اضبطه عبر PUT /api/company/settings/fx-gain-loss-account قبل التخصيص',
              );
            }
          }
          const supplierAccount = await client.query(`SELECT linked_account_id FROM suppliers WHERE id=$1`, [payment.supplier_id]);
          const payableAccountId = supplierAccount.rows[0].linked_account_id;
          if (fxDifference.greaterThan(0)) { // خسارة: دُفع أكثر مما كان مسجَّلًا كالتزام
            fxLines.push({ accountId: fxAccountId, debit: fxDifference.toFixed(4), credit: '0', description: 'فرق عملة — خسارة سداد' });
            fxLines.push({ accountId: payableAccountId, debit: '0', credit: fxDifference.toFixed(4), description: 'فرق عملة — خسارة سداد' });
          } else { // ربح: دُفع أقل مما كان مسجَّلًا كالتزام
            fxLines.push({ accountId: payableAccountId, debit: fxDifference.abs().toFixed(4), credit: '0', description: 'فرق عملة — ربح سداد' });
            fxLines.push({ accountId: fxAccountId, debit: '0', credit: fxDifference.abs().toFixed(4), description: 'فرق عملة — ربح سداد' });
          }
        }
      }

      const row = await client.query(
        `INSERT INTO supplier_payment_allocations(company_id, supplier_payment_id, supplier_invoice_id, allocated_amount, fx_difference_amount)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (supplier_payment_id, supplier_invoice_id)
         DO UPDATE SET allocated_amount = supplier_payment_allocations.allocated_amount + EXCLUDED.allocated_amount,
                        fx_difference_amount = supplier_payment_allocations.fx_difference_amount + EXCLUDED.fx_difference_amount
         RETURNING *`,
        [ctx.companyId, paymentId, allocation.supplierInvoiceId, allocAmount.toFixed(4), fxDifference.toFixed(4)],
      );
      created.push(row.rows[0]);
    }

    let fxJournalEntryId: string | undefined;
    if (fxLines.length > 0) {
      const company = await client.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId]);
      const fxEntry = await createDraftJournalEntry(ctx, {
        branchId: payment.branch_id, fiscalPeriodId: payment.fiscal_period_id, entryDate: payment.payment_date,
        currencyCode: company.rows[0].base_currency_code, exchangeRate: '1',
        sourceDocumentType: 'supplier_payment_fx_difference', sourceDocumentId: paymentId, lines: fxLines,
      }, client);
      await transitionJournalEntryStatus(ctx, fxEntry.id, 'pending_review', undefined, client);
      await transitionJournalEntryStatus(ctx, fxEntry.id, 'approved', undefined, client);
      await transitionJournalEntryStatus(ctx, fxEntry.id, 'posted', undefined, client);
      fxJournalEntryId = fxEntry.id;
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'supplier_payment', entityId: paymentId, action: 'update',
      afterJson: { action: 'allocate_advance', allocations: allocations.map((a) => ({ supplierInvoiceId: a.supplierInvoiceId, amount: a.amount })), fxJournalEntryId },
    });
    return { paymentId, allocations: created, fxJournalEntryId };
  });
}

export async function getSupplierPaymentById(ctx: RequestContext, id: string) {
  ctx.assertPermission('purchasing.payment.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('supplier_payments', id, ctx, {
    notFoundMessage: 'الدفعة غير موجودة',
  });
  const allocations = await pool.query(`SELECT * FROM supplier_payment_allocations WHERE supplier_payment_id=$1`, [id]);
  return { ...header, allocations: allocations.rows };
}

export async function listSupplierPayments(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('purchasing.payment.view');
  return paginatedList<unknown>(ctx, 'supplier_payments', { page, pageSize, status });
}
