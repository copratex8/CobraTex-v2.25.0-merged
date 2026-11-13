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

export interface CustomerPaymentAllocationInput {
  salesInvoiceId: string;
  amount: string;
}

export interface CreateCustomerPaymentInput {
  branchId: string;
  customerId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  paymentDate: string;
  amount: string;
  receiptAccountId: string; // حساب الخزينة/البنك المستلِم
  allocations?: CustomerPaymentAllocationInput[]; // فارغة = دفعة مقدمة غير مخصَّصة لفاتورة بعد
}

/** الإجمالي المُخصَّص فعليًا لفاتورة عبر كل الدفعات (بصرف النظر عن حالتها) — تُستخدم لمنع تجاوز التخصيص. */
async function getInvoiceAllocatedTotal(client: PoolClient, invoiceId: string): Promise<Decimal> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(allocated_amount), 0) AS total FROM customer_payment_allocations WHERE sales_invoice_id = $1`,
    [invoiceId],
  );
  return new Decimal(rows[0].total);
}

/**
 * صافي مبلغ الفاتورة المستحق فعلًا = إجمالي أسطر الفاتورة **ناقص** إجمالي أي مرتجعات بيع مرحّلة
 * (posted فقط — المسودة/الملغاة لا تُخفِّض المستحق) مرتبطة بها. هذا يضمن أن "المتبقي المستحق"
 * يعكس أثر المرتجعات الجزئية بعد الدفعات الجزئية بصورة صحيحة، لا إجمالي الفاتورة الأصلي فقط.
 */
async function getSalesInvoiceNetTotal(client: PoolClient, invoiceId: string): Promise<Decimal> {
  const lines = await client.query(`SELECT COALESCE(SUM(line_total),0) AS total FROM sales_invoice_lines WHERE sales_invoice_id=$1`, [invoiceId]);
  const returns = await client.query(
    `SELECT COALESCE(SUM(srl.line_total),0) AS total FROM sales_return_lines srl
     JOIN sales_returns sr ON sr.id = srl.sales_return_id
     WHERE sr.sales_invoice_id = $1 AND sr.status = 'posted'`,
    [invoiceId],
  );
  return new Decimal(lines.rows[0].total).minus(new Decimal(returns.rows[0].total));
}

export async function getSalesInvoiceRemainingBalance(ctx: RequestContext, invoiceId: string): Promise<{ total: string; allocated: string; remaining: string }> {
  ctx.assertPermission('sales.invoice.view');
  const invoice = await pool.query(`SELECT id, branch_id FROM sales_invoices WHERE id=$1 AND company_id=$2 AND status='posted'`, [invoiceId, ctx.companyId]);
  if (invoice.rows.length === 0) throw new NotFoundError('الفاتورة غير موجودة أو غير مرحّلة بعد');
  assertBranchScope(ctx, invoice.rows[0].branch_id);
  const total = await getSalesInvoiceNetTotal(pool as unknown as PoolClient, invoiceId);
  const allocated = await getInvoiceAllocatedTotal(pool as unknown as PoolClient, invoiceId);
  return { total: total.toFixed(4), allocated: allocated.toFixed(4), remaining: total.minus(allocated).toFixed(4) };
}

/**
 * ينشئ دفعة عميل. إن أُرفقت تخصيصات (allocations)، يُحجَز كل تخصيص فورًا (حتى بحالة draft) عبر
 * قفل صف الفاتورة، فيمنع دفعتين متزامنتين من تخصيص نفس الجزء المتبقي من نفس الفاتورة معًا.
 */
export async function createCustomerPayment(ctx: RequestContext, input: CreateCustomerPaymentInput) {
  ctx.assertPermission('sales.payment.create', input.branchId);
  const amount = new Decimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new ValidationError('مبلغ الدفعة يجب أن يكون موجبًا');

  const allocations = input.allocations ?? [];
  const totalAllocated = allocations.reduce((s, a) => s.plus(new Decimal(a.amount)), new Decimal(0));
  if (totalAllocated.greaterThan(amount)) {
    throw new ValidationError(`إجمالي التخصيصات (${totalAllocated.toFixed(4)}) يتجاوز مبلغ الدفعة (${amount.toFixed(4)})`);
  }

  return withTransaction(async (client) => {
    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'CUSTOMER_PAYMENT', prefix: 'RCPT-' },
      client,
    );
    const fxRate = await resolveDocumentRate(ctx, input.currencyCode, input.paymentDate, input.exchangeRate, 'sell', client);
    const header = await client.query(
      `INSERT INTO customer_payments(
        company_id, branch_id, customer_id, fiscal_period_id, document_number, currency_code, exchange_rate,
        payment_date, amount, receipt_account_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.customerId, input.fiscalPeriodId, documentNumber, input.currencyCode,
        fxRate, input.paymentDate, amount.toFixed(4), input.receiptAccountId, ctx.userId,
      ],
    );

    for (const allocation of allocations) {
      const invoiceLock = await client.query(
        `SELECT id FROM sales_invoices WHERE id=$1 AND company_id=$2 AND status='posted' FOR UPDATE`,
        [allocation.salesInvoiceId, ctx.companyId],
      );
      if (invoiceLock.rows.length === 0) throw new NotFoundError(`فاتورة البيع غير موجودة أو غير مرحّلة: ${allocation.salesInvoiceId}`);

      const invoiceTotal = await getSalesInvoiceNetTotal(client, allocation.salesInvoiceId);
      const alreadyAllocated = await getInvoiceAllocatedTotal(client, allocation.salesInvoiceId);
      const remaining = invoiceTotal.minus(alreadyAllocated);
      const allocAmount = new Decimal(allocation.amount);

      if (allocAmount.greaterThan(remaining)) {
        throw new ValidationError(
          `مبلغ التخصيص (${allocAmount.toFixed(4)}) يتجاوز المتبقي غير المُحصَّل من الفاتورة (${remaining.toFixed(4)})`,
        );
      }

      await client.query(
        `INSERT INTO customer_payment_allocations(company_id, customer_payment_id, sales_invoice_id, allocated_amount)
         VALUES ($1,$2,$3,$4)`,
        [ctx.companyId, header.rows[0].id, allocation.salesInvoiceId, allocAmount.toFixed(4)],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'customer_payment', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, amount: amount.toFixed(4), allocationCount: allocations.length },
    });
    return header.rows[0];
  });
}

/** ترحيل الدفعة: قيد واحد (مدين خزينة/بنك، دائن حساب العميل الفرعي) بإجمالي مبلغ الدفعة كاملًا. */
export async function postCustomerPayment(ctx: RequestContext, paymentId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM customer_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`, [paymentId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الدفعة غير موجودة');
    const payment = found.rows[0];
    ctx.assertPermission('sales.payment.post', payment.branch_id);
    if (payment.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل دفعة بحالة ${payment.status}؛ يجب أن تكون draft`);

    const customer = await client.query(`SELECT linked_account_id FROM customers WHERE id=$1 AND company_id=$2`, [payment.customer_id, ctx.companyId]);
    if (customer.rows.length === 0) throw new NotFoundError('العميل غير موجود');

    // قيد التحصيل: مدين الخزينة/البنك، دائن حساب العميل الفرعي (اتجاه معاكس لقيد البيع، وليس
    // رِجل PostingRule عامة — التحصيل عملية بسيطة ذات حسابين معروفين مسبقًا، لا تحتاج محرك القواعد).
    const lines = [
      { accountId: payment.receipt_account_id, debit: payment.amount, credit: '0' },
      { accountId: customer.rows[0].linked_account_id, debit: '0', credit: payment.amount },
    ];

    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: payment.branch_id, fiscalPeriodId: payment.fiscal_period_id, entryDate: payment.payment_date,
      currencyCode: payment.currency_code, exchangeRate: payment.exchange_rate,
      sourceDocumentType: 'customer_payment', sourceDocumentId: paymentId, lines,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE customer_payments SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [paymentId, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'customer_payment', entityId: paymentId, action: 'post', afterJson: { journalEntryId: draftEntry.id },
    });
    return { id: paymentId, journalEntryId: draftEntry.id };
  });
}

export async function reverseCustomerPayment(ctx: RequestContext, paymentId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM customer_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`, [paymentId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الدفعة غير موجودة');
    const payment = found.rows[0];
    ctx.assertPermission('sales.payment.reverse', payment.branch_id);
    if (payment.status !== 'posted') throw new ValidationError('يجب أن تكون الدفعة مرحّلة لعكسها');

    await reverseJournalEntry(ctx, payment.journal_entry_id, reason);
    // تحرير كل التخصيصات المرتبطة بهذه الدفعة، فتصبح الفواتير المعنية قابلة للتحصيل مجددًا
    await client.query(`DELETE FROM customer_payment_allocations WHERE customer_payment_id=$1`, [paymentId]);

    await client.query(
      `UPDATE customer_payments SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [paymentId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'customer_payment', entityId: paymentId, action: 'reverse', reason,
    });
    return { id: paymentId, status: 'reversed' };
  });
}

export interface AllocateAdvancePaymentInput {
  salesInvoiceId: string;
  amount: string;
}

/**
 * يخصِّص جزءًا أو كل دفعة سابقة (مقدمة أو جزئية التخصيص) إلى فاتورة/فواتير بيع لاحقة. الدفعة
 * يجب أن تكون مُرحَّلة بالفعل (posted) — لا يجوز تخصيص مبلغ لم يُحصَّل فعليًا بعد. يقفل صف الدفعة
 * وصف كل فاتورة مستهدفة (FOR UPDATE) لمنع تخصيصين متزامنين يتجاوزان معًا المتبقي المتاح فعليًا،
 * سواء من جهة "المتبقي غير المخصَّص من الدفعة" أو من جهة "المتبقي غير المحصَّل من الفاتورة".
 */
export async function allocateAdvancePayment(ctx: RequestContext, paymentId: string, allocations: AllocateAdvancePaymentInput[]) {
  if (allocations.length === 0) throw new ValidationError('قائمة التخصيصات لا يمكن أن تكون فارغة');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM customer_payments WHERE id=$1 AND company_id=$2 FOR UPDATE`, [paymentId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الدفعة غير موجودة');
    const payment = found.rows[0];
    ctx.assertPermission('sales.payment.allocate', payment.branch_id);
    if (payment.status !== 'posted') throw new ValidationError('يجب أن تكون الدفعة مرحّلة (posted) قبل تخصيصها لفاتورة');

    const currentAllocations = await client.query(
      `SELECT COALESCE(SUM(allocated_amount), 0) AS total FROM customer_payment_allocations WHERE customer_payment_id=$1`,
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
        `SELECT id, branch_id, currency_code, exchange_rate FROM sales_invoices WHERE id=$1 AND company_id=$2 AND status='posted' FOR UPDATE`,
        [allocation.salesInvoiceId, ctx.companyId],
      );
      if (invoiceLock.rows.length === 0) throw new NotFoundError(`فاتورة البيع غير موجودة أو غير مرحّلة: ${allocation.salesInvoiceId}`);
      assertBranchScope(ctx, invoiceLock.rows[0].branch_id);

      const invoiceTotal = await getSalesInvoiceNetTotal(client, allocation.salesInvoiceId);
      const invoiceAllocated = await getInvoiceAllocatedTotal(client, allocation.salesInvoiceId);
      const invoiceRemaining = invoiceTotal.minus(invoiceAllocated);
      const allocAmount = new Decimal(allocation.amount);
      if (allocAmount.lessThanOrEqualTo(0)) throw new ValidationError('مبلغ التخصيص يجب أن يكون موجبًا');
      if (allocAmount.greaterThan(invoiceRemaining)) {
        throw new ValidationError(`مبلغ التخصيص (${allocAmount.toFixed(4)}) يتجاوز المتبقي غير المُحصَّل من الفاتورة (${invoiceRemaining.toFixed(4)})`);
      }

      // فرق العملة: يُحسَب فقط إذا كانت الفاتورة والدفعة بنفس العملة وبسعري صرف مختلفين — الفرق
      // ناتج عن كون الفاتورة سُجِّلت بسعر، والتحصيل تم بسعر آخر لاحقًا. راجع تعليق التصميم في
      // migration 0021 وتقرير المرحلة للتفصيل الكامل لمنطق الإشارة (ربح/خسارة).
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
          const customerAccount = await client.query(`SELECT linked_account_id FROM customers WHERE id=$1`, [payment.customer_id]);
          const receivableAccountId = customerAccount.rows[0].linked_account_id;
          if (fxDifference.greaterThan(0)) { // ربح: حُصِّل أكثر مما كان مسجَّلًا كذمة
            fxLines.push({ accountId: receivableAccountId, debit: fxDifference.toFixed(4), credit: '0', description: 'فرق عملة — ربح تحصيل' });
            fxLines.push({ accountId: fxAccountId, debit: '0', credit: fxDifference.toFixed(4), description: 'فرق عملة — ربح تحصيل' });
          } else { // خسارة: حُصِّل أقل مما كان مسجَّلًا كذمة
            fxLines.push({ accountId: fxAccountId, debit: fxDifference.abs().toFixed(4), credit: '0', description: 'فرق عملة — خسارة تحصيل' });
            fxLines.push({ accountId: receivableAccountId, debit: '0', credit: fxDifference.abs().toFixed(4), description: 'فرق عملة — خسارة تحصيل' });
          }
        }
      }

      const row = await client.query(
        `INSERT INTO customer_payment_allocations(company_id, customer_payment_id, sales_invoice_id, allocated_amount, fx_difference_amount)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (customer_payment_id, sales_invoice_id)
         DO UPDATE SET allocated_amount = customer_payment_allocations.allocated_amount + EXCLUDED.allocated_amount,
                        fx_difference_amount = customer_payment_allocations.fx_difference_amount + EXCLUDED.fx_difference_amount
         RETURNING *`,
        [ctx.companyId, paymentId, allocation.salesInvoiceId, allocAmount.toFixed(4), fxDifference.toFixed(4)],
      );
      created.push(row.rows[0]);
    }

    let fxJournalEntryId: string | undefined;
    if (fxLines.length > 0) {
      const company = await client.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId]);
      const fxEntry = await createDraftJournalEntry(ctx, {
        branchId: payment.branch_id, fiscalPeriodId: payment.fiscal_period_id, entryDate: payment.payment_date,
        currencyCode: company.rows[0].base_currency_code, exchangeRate: '1',
        sourceDocumentType: 'customer_payment_fx_difference', sourceDocumentId: paymentId, lines: fxLines,
      }, client);
      await transitionJournalEntryStatus(ctx, fxEntry.id, 'pending_review', undefined, client);
      await transitionJournalEntryStatus(ctx, fxEntry.id, 'approved', undefined, client);
      await transitionJournalEntryStatus(ctx, fxEntry.id, 'posted', undefined, client);
      fxJournalEntryId = fxEntry.id;
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'customer_payment', entityId: paymentId, action: 'update',
      afterJson: { action: 'allocate_advance', allocations: allocations.map((a) => ({ salesInvoiceId: a.salesInvoiceId, amount: a.amount })), fxJournalEntryId },
    });
    return { paymentId, allocations: created, fxJournalEntryId };
  });
}

export async function getCustomerPaymentById(ctx: RequestContext, id: string) {
  ctx.assertPermission('sales.payment.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('customer_payments', id, ctx, {
    notFoundMessage: 'الدفعة غير موجودة',
  });
  const allocations = await pool.query(`SELECT * FROM customer_payment_allocations WHERE customer_payment_id=$1`, [id]);
  return { ...header, allocations: allocations.rows };
}

export async function listCustomerPayments(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('sales.payment.view');
  return paginatedList<unknown>(ctx, 'customer_payments', { page, pageSize, status });
}
