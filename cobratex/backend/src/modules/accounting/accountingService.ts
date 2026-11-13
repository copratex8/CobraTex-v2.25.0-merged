import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, ConflictError, NotFoundError, AppError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { paginatedList } from '@/shared/pagination';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export async function createAccount(
  ctx: RequestContext,
  input: { code: string; nameAr: string; nameEn: string; accountType: AccountType; currencyCode?: string },
) {
  ctx.assertPermission('accounting.account.create');
  const { rows } = await pool.query(
    `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type, currency_code)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [ctx.companyId, input.code, input.nameAr, input.nameEn, input.accountType, input.currencyCode ?? null],
  );
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'account', entityId: rows[0].id, action: 'create', afterJson: rows[0],
  });
  return rows[0];
}

export async function createFiscalPeriod(ctx: RequestContext, startDate: string, endDate: string) {
  ctx.assertPermission('accounting.fiscal_period.create');
  const { rows } = await pool.query(
    `INSERT INTO fiscal_periods(company_id, start_date, end_date) VALUES ($1,$2,$3) RETURNING *`,
    [ctx.companyId, startDate, endDate],
  );
  return rows[0];
}

/* ============================== PostingRule (محرك الترحيل القابل للتهيئة) ============================== */

export type AccountSourceType =
  | 'FIXED_ACCOUNT' | 'CUSTOMER_RECEIVABLE' | 'SUPPLIER_PAYABLE'
  | 'ITEM_CATEGORY_INVENTORY' | 'ITEM_CATEGORY_COGS' | 'TAX_ACCOUNT' | 'BANK_SAFE_ACCOUNT' | 'COST_CENTER_DEFAULT';

const NOT_YET_SUPPORTED_SOURCES: AccountSourceType[] = [
  'TAX_ACCOUNT', 'BANK_SAFE_ACCOUNT', 'COST_CENTER_DEFAULT',
];

export interface CreatePostingRuleInput {
  operationType: string;
  debitAccountSourceType: AccountSourceType;
  debitFixedAccountId?: string;
  creditAccountSourceType: AccountSourceType;
  creditFixedAccountId?: string;
}

function validatePostingRuleInput(input: CreatePostingRuleInput) {
  if (input.debitAccountSourceType === 'FIXED_ACCOUNT' && !input.debitFixedAccountId) {
    throw new ValidationError('قاعدة ترحيل ناقصة: FIXED_ACCOUNT للمدين يتطلب debitFixedAccountId');
  }
  if (input.creditAccountSourceType === 'FIXED_ACCOUNT' && !input.creditFixedAccountId) {
    throw new ValidationError('قاعدة ترحيل ناقصة: FIXED_ACCOUNT للدائن يتطلب creditFixedAccountId');
  }
  if (!input.operationType?.trim()) {
    throw new ValidationError('operationType إلزامي');
  }
}

/**
 * ينشئ قاعدة ترحيل Typed. يرفض القواعد الناقصة (FIXED_ACCOUNT بلا معرّف حساب)، ويرفض تعارض
 * قاعدتين نشطتين لنفس العملية (قيد Unique جزئي في قاعدة البيانات — migration 0009).
 */
export async function createPostingRule(ctx: RequestContext, input: CreatePostingRuleInput) {
  ctx.assertPermission('accounting.posting_rule.manage');
  validatePostingRuleInput(input);
  try {
    const { rows } = await pool.query(
      `INSERT INTO posting_rules(
        company_id, operation_type, debit_account_source_type, debit_fixed_account_id,
        credit_account_source_type, credit_fixed_account_id
      ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        ctx.companyId, input.operationType, input.debitAccountSourceType, input.debitFixedAccountId ?? null,
        input.creditAccountSourceType, input.creditFixedAccountId ?? null,
      ],
    );
    await writeAuditLog(pool, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'posting_rule', entityId: rows[0].id, action: 'create', afterJson: rows[0],
    });
    return rows[0];
  } catch (e) {
    const pgErr = e as { code?: string };
    if (pgErr.code === '23505') {
      throw new ConflictError(`توجد بالفعل قاعدة ترحيل نشطة متعارضة للعملية: ${input.operationType}`);
    }
    throw e;
  }
}

async function resolveAccount(
  client: PoolClient,
  companyId: string,
  sourceType: AccountSourceType,
  fixedAccountId: string | null,
  legContext?: { itemCategoryId?: string; customerId?: string; supplierId?: string },
): Promise<string> {
  if (sourceType === 'FIXED_ACCOUNT') return fixedAccountId as string;

  if (sourceType === 'ITEM_CATEGORY_INVENTORY' || sourceType === 'ITEM_CATEGORY_COGS') {
    if (!legContext?.itemCategoryId) {
      throw new ValidationError(`تحتاج هذه القاعدة (${sourceType}) إلى itemCategoryId في سياق العملية`);
    }
    const column = sourceType === 'ITEM_CATEGORY_INVENTORY' ? 'default_inventory_account_id' : 'default_cogs_account_id';
    const { rows } = await client.query(
      `SELECT ${column} AS account_id FROM item_categories WHERE id = $1 AND company_id = $2`,
      [legContext.itemCategoryId, companyId],
    );
    if (rows.length === 0) throw new NotFoundError('مجموعة الصنف غير موجودة');
    if (!rows[0].account_id) {
      throw new ValidationError(`مجموعة الصنف بلا حساب ${sourceType === 'ITEM_CATEGORY_INVENTORY' ? 'مخزون' : 'تكلفة مبيعات'} افتراضي مُعرَّف`);
    }
    return rows[0].account_id;
  }

  if (sourceType === 'CUSTOMER_RECEIVABLE') {
    if (!legContext?.customerId) throw new ValidationError('تحتاج هذه القاعدة (CUSTOMER_RECEIVABLE) إلى customerId في سياق العملية');
    const { rows } = await client.query(
      `SELECT linked_account_id FROM customers WHERE id=$1 AND company_id=$2`, [legContext.customerId, companyId],
    );
    if (rows.length === 0) throw new NotFoundError('العميل غير موجود');
    return rows[0].linked_account_id;
  }

  if (sourceType === 'SUPPLIER_PAYABLE') {
    if (!legContext?.supplierId) throw new ValidationError('تحتاج هذه القاعدة (SUPPLIER_PAYABLE) إلى supplierId في سياق العملية');
    const { rows } = await client.query(
      `SELECT linked_account_id FROM suppliers WHERE id=$1 AND company_id=$2`, [legContext.supplierId, companyId],
    );
    if (rows.length === 0) throw new NotFoundError('المورد غير موجود');
    return rows[0].linked_account_id;
  }

  if (NOT_YET_SUPPORTED_SOURCES.includes(sourceType)) {
    throw new AppError(
      `مصدر الحساب ${sourceType} يتطلب وحدة الضرائب/الخزائن الكاملة (مرحلة لاحقة) — غير مدعوم بعد`,
      501,
    );
  }
  throw new ValidationError(`نوع مصدر حساب غير معروف: ${sourceType}`);
}

export interface PostingLegRequest {
  /** operation_type كما هو مسجَّل في posting_rules، مثال: sales_invoice_revenue */
  operationType: string;
  amount: string;
  itemCategoryId?: string;
  customerId?: string;
  supplierId?: string;
  description?: string;
}

export interface JournalLineInput {
  accountId: string;
  debit: string;
  credit: string;
  costCenterId?: string;
  description?: string;
}

export interface JournalPreview {
  lines: JournalLineInput[];
  totalDebit: string;
  totalCredit: string;
  isBalanced: boolean;
}

/**
 * يبني معاينة قيد من مجموعة "أرجل" (Legs) عملياتية، كل رِجل تُستخرج حساباتها من posting_rules.
 * لا يكتب أي شيء في قاعدة البيانات — معاينة صرفة، تُستخدم قبل أي ترحيل فعلي.
 * يرفض بوضوح أي رِجل ليس لها قاعدة ترحيل نشطة (بدل تخمين حساب افتراضي بصمت).
 */
export async function buildJournalPreview(
  ctx: RequestContext,
  legs: PostingLegRequest[],
  client?: PoolClient,
): Promise<JournalPreview> {
  if (!Array.isArray(legs) || legs.length === 0) throw new ValidationError('لا يمكن بناء معاينة قيد من قائمة عمليات فارغة');
  const runner = client ?? pool;
  const lines: JournalLineInput[] = [];
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  for (const leg of legs) {
    const amount = new Decimal(leg.amount);
    if (amount.lessThanOrEqualTo(0)) throw new ValidationError(`مبلغ غير صالح لعملية ${leg.operationType}`);

    const { rows } = await runner.query(
      `SELECT * FROM posting_rules WHERE company_id = $1 AND operation_type = $2 AND is_active = true`,
      [ctx.companyId, leg.operationType],
    );
    if (rows.length === 0) {
      throw new ValidationError(`لا توجد قاعدة ترحيل نشطة للعملية: ${leg.operationType}`);
    }
    const rule = rows[0];

    const debitAccountId = await resolveAccount(
      runner as PoolClient, ctx.companyId, rule.debit_account_source_type, rule.debit_fixed_account_id,
      { itemCategoryId: leg.itemCategoryId, customerId: leg.customerId, supplierId: leg.supplierId },
    );
    const creditAccountId = await resolveAccount(
      runner as PoolClient, ctx.companyId, rule.credit_account_source_type, rule.credit_fixed_account_id,
      { itemCategoryId: leg.itemCategoryId, customerId: leg.customerId, supplierId: leg.supplierId },
    );

    lines.push({ accountId: debitAccountId, debit: amount.toFixed(4), credit: '0', description: leg.description ?? leg.operationType });
    lines.push({ accountId: creditAccountId, debit: '0', credit: amount.toFixed(4), description: leg.description ?? leg.operationType });
    totalDebit = totalDebit.plus(amount);
    totalCredit = totalCredit.plus(amount);
  }

  return {
    lines,
    totalDebit: totalDebit.toFixed(4),
    totalCredit: totalCredit.toFixed(4),
    isBalanced: totalDebit.equals(totalCredit),
  };
}

/* ============================== دورة حياة القيد (Document Lifecycle) ============================== */

export interface CreateJournalEntryInput {
  branchId: string;
  fiscalPeriodId: string;
  entryDate: string;
  currencyCode: string;
  exchangeRate?: string;
  sourceDocumentType: string;
  sourceDocumentId?: string;
  activityId?: string;
  projectId?: string;
  lines: JournalLineInput[];
}

/** ينشئ قيدًا بحالة draft. لا يُشترط توازن الأسطر في هذه الحالة (يُسمح بالتحرير التدريجي). */
export async function createDraftJournalEntry(
  ctx: RequestContext,
  input: CreateJournalEntryInput,
  client?: PoolClient,
) {
  ctx.assertPermission('accounting.journal.create', input.branchId);
  const run = async (c: PoolClient) => {
    const entry = await c.query(
      `INSERT INTO journal_entries(
        company_id, branch_id, activity_id, project_id, fiscal_period_id, entry_date, currency_code, exchange_rate,
        status, source_document_type, source_document_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11) RETURNING id`,
      [
        ctx.companyId, input.branchId, input.activityId ?? null, input.projectId ?? null, input.fiscalPeriodId,
        input.entryDate, input.currencyCode, input.exchangeRate ?? '1',
        input.sourceDocumentType, input.sourceDocumentId ?? null, ctx.userId,
      ],
    );
    const entryId = entry.rows[0].id;
    // توحيد تحويل العملة: نقطة مركزية واحدة تخدم كل الوحدات (فواتير بيع/شراء/مرتجعات/دفعات/مصروفات) —
    // القيمة المُمرَّرة من كل خدمة (line.debit/line.credit) هي دائمًا بعملة المستند الأصلية (Face Value)؛
    // هنا فقط تُحوَّل لعملة الأساس عبر exchange_rate الخاص بهذا القيد قبل التخزين في journal_lines،
    // التي تبقى دائمًا بعملة الأساس فقط (لا قيمة أجنبية مباشرة فيها) — هذا يطابق الممارسة المحاسبية
    // القياسية: دفتر الأستاذ العام بعملة واحدة، بينما السجلات الفرعية (فواتير/دفعات/تخصيصات) تبقى
    // بعملتها الأصلية لأن مطابقة التخصيص (allocation) تقارن مبالغ بنفس العملة دائمًا، لا تتأثر بهذا.
    // الضرب بنفس المعامل على كل الأسطر يحافظ على توازن القيد تلقائيًا (خاصية الضرب الخطي)، ولا يغيّر
    // شيئًا عمليًا للقيود بعملة الأساس (exchange_rate = 1 افتراضيًا، وهي كل الاختبارات الحالية).
    const rate = new Decimal(input.exchangeRate ?? '1');
    for (const line of input.lines) {
      const debitBase = new Decimal(line.debit ?? '0').times(rate).toFixed(4);
      const creditBase = new Decimal(line.credit ?? '0').times(rate).toFixed(4);
      await c.query(
        `INSERT INTO journal_lines(journal_entry_id, company_id, account_id, cost_center_id, debit, credit, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [entryId, ctx.companyId, line.accountId, line.costCenterId ?? null, debitBase, creditBase, line.description ?? null],
      );
    }
    await writeAuditLog(c, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'journal_entry', entityId: entryId, action: 'create', afterJson: { status: 'draft' },
    });
    return { id: entryId };
  };
  return client ? run(client) : withTransaction(run);
}

type TransitionTarget = 'pending_review' | 'approved' | 'rejected' | 'posted' | 'draft' | 'cancelled';

const TRANSITIONS: Record<string, Partial<Record<TransitionTarget, string>>> = {
  draft: { pending_review: 'accounting.journal.submit', cancelled: 'accounting.journal.cancel' },
  pending_review: {
    approved: 'accounting.journal.approve',
    rejected: 'accounting.journal.reject',
    draft: 'accounting.journal.reject',
  },
  approved: { posted: 'accounting.journal.post', draft: 'accounting.journal.reject' },
};

const AUDIT_ACTION_FOR_TARGET: Record<TransitionTarget, 'submit' | 'approve' | 'reject' | 'post' | 'cancel' | 'send_back'> = {
  pending_review: 'submit',
  approved: 'approve',
  rejected: 'reject',
  posted: 'post',
  cancelled: 'cancel',
  draft: 'send_back',
};

/**
 * ينقل قيدًا بين الحالات وفق جدول انتقالات صريح (لا قفز غير مسموح). يتحقق من الصلاحية المطابقة
 * للانتقال المطلوب وبنطاق فرع القيد. عند الانتقال لـ posted يُعاد فحص التوازن بـ Decimal (دفاع
 * تطبيقي مبكر)، إضافة لحماية قاعدة البيانات (Deferred Trigger). الرفض/الإلغاء يتطلبان سببًا.
 */
export async function transitionJournalEntryStatus(
  ctx: RequestContext,
  entryId: string,
  target: TransitionTarget,
  reason?: string,
  client?: PoolClient,
) {
  const run = async (c: PoolClient) => {
    const found = await c.query(
      `SELECT * FROM journal_entries WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [entryId, ctx.companyId],
    );
    if (found.rows.length === 0) throw new NotFoundError('القيد غير موجود');
    const entry = found.rows[0];

    const allowed = TRANSITIONS[entry.status];
    const permissionCode = allowed?.[target];
    if (!permissionCode) {
      throw new ValidationError(`انتقال حالة غير مسموح: ${entry.status} → ${target}`);
    }
    ctx.assertPermission(permissionCode, entry.branch_id);

    if (target === 'posted') {
      const lines = await c.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id = $1`, [entryId]);
      if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل قيد بلا أسطر');
      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);
      for (const l of lines.rows) {
        totalDebit = totalDebit.plus(new Decimal(l.debit));
        totalCredit = totalCredit.plus(new Decimal(l.credit));
      }
      if (!totalDebit.equals(totalCredit)) {
        throw new ValidationError(`القيد غير متوازن: إجمالي المدين ${totalDebit.toFixed(4)} لا يساوي إجمالي الدائن ${totalCredit.toFixed(4)}`);
      }
      await c.query(
        `UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=now() WHERE id=$1`,
        [entryId, ctx.userId],
      );
    } else if (target === 'cancelled' || target === 'rejected') {
      if (!reason?.trim()) throw new ValidationError('السبب إلزامي عند الرفض أو الإلغاء');
      await c.query(
        `UPDATE journal_entries SET status=$2, cancelled_reason=$3, cancelled_by=$4, cancelled_at=now() WHERE id=$1`,
        [entryId, target, reason, ctx.userId],
      );
    } else {
      await c.query(`UPDATE journal_entries SET status=$2 WHERE id=$1`, [entryId, target]);
    }

    await writeAuditLog(c, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'journal_entry', entityId: entryId, action: AUDIT_ACTION_FOR_TARGET[target],
      beforeJson: { status: entry.status }, afterJson: { status: target }, reason,
    });

    return { id: entryId, status: target };
  };
  return client ? run(client) : withTransaction(run);
}

/**
 * مسار مختصر (Convenience) يُنشئ قيدًا ويُرحِّله فورًا عبر دورة الحياة الكاملة ضمن معاملة واحدة
 * (draft → pending_review → approved → posted). يتطلب من المستخدم امتلاك كل صلاحيات هذه الخطوات
 * معًا (عادة دور Owner/محاسب رئيسي) — الاستخدام العادي متعدد المستخدمين يستدعي الخطوات منفصلة عبر
 * transitionJournalEntryStatus بدلًا من هذا المسار.
 */
export async function postJournalEntry(ctx: RequestContext, input: CreateJournalEntryInput) {
  if (input.lines.length === 0) throw new ValidationError('لا يمكن ترحيل قيد بلا أسطر');
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  for (const line of input.lines) {
    const debit = new Decimal(line.debit);
    const credit = new Decimal(line.credit);
    if (debit.isNegative() || credit.isNegative()) throw new ValidationError('لا يجوز أن يكون المدين أو الدائن سالبًا');
    if (debit.greaterThan(0) && credit.greaterThan(0)) throw new ValidationError('سطر القيد لا يكون مدينًا ودائنًا في آن واحد');
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
  }
  if (!totalDebit.equals(totalCredit)) {
    throw new ValidationError(`القيد غير متوازن: إجمالي المدين ${totalDebit.toFixed(4)} لا يساوي إجمالي الدائن ${totalCredit.toFixed(4)}`);
  }

  return withTransaction(async (client) => {
    const draft = await createDraftJournalEntry(ctx, input, client);
    await transitionJournalEntryStatus(ctx, draft.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draft.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draft.id, 'posted', undefined, client);
    return { id: draft.id, totalDebit: totalDebit.toFixed(4), totalCredit: totalCredit.toFixed(4) };
  });
}

/**
 * يعكس قيدًا مرحّلًا: ينشئ قيدًا جديدًا مرحّلًا بأسطر معكوسة (مدين↔دائن) مرتبطًا عبر
 * reversal_of_entry_id، ثم يحوّل حالة القيد الأصلي إلى reversed — وهو الانتقال الوحيد المسموح
 * لقيد مرحّل، ولا يُقبل بنيويًا في قاعدة البيانات إلا بعد وجود هذا القيد العكسي فعلًا (migration 0010).
 */
export async function reverseJournalEntry(ctx: RequestContext, entryId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');

  return withTransaction(async (client) => {
    const found = await client.query(
      `SELECT * FROM journal_entries WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [entryId, ctx.companyId],
    );
    if (found.rows.length === 0) throw new NotFoundError('القيد غير موجود');
    const original = found.rows[0];
    if (original.status !== 'posted') {
      throw new ValidationError(`لا يمكن عكس قيد بحالة ${original.status}؛ يجب أن يكون مرحّلًا (posted)`);
    }
    ctx.assertPermission('accounting.journal.reverse', original.branch_id);

    const originalLines = await client.query(
      `SELECT account_id, cost_center_id, debit, credit, description FROM journal_lines WHERE journal_entry_id = $1`,
      [entryId],
    );

    const reversal = await client.query(
      `INSERT INTO journal_entries(
        company_id, branch_id, activity_id, project_id, fiscal_period_id, entry_date, currency_code, exchange_rate,
        status, source_document_type, source_document_id, reversal_of_entry_id, created_by, posted_by, posted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'posted',$9,$10,$11,$12,$12, now())
      RETURNING id`,
      [
        original.company_id, original.branch_id, original.activity_id, original.project_id, original.fiscal_period_id,
        original.entry_date, original.currency_code, original.exchange_rate,
        `reversal_of:${original.source_document_type}`, original.id, original.id, ctx.userId,
      ],
    );
    const reversalId = reversal.rows[0].id;

    for (const line of originalLines.rows) {
      await client.query(
        `INSERT INTO journal_lines(journal_entry_id, company_id, account_id, cost_center_id, debit, credit, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [reversalId, ctx.companyId, line.account_id, line.cost_center_id, line.credit, line.debit, `عكس: ${line.description ?? ''}`],
      );
    }

    await client.query(
      `UPDATE journal_entries SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [entryId, reason, ctx.userId],
    );

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'journal_entry', entityId: entryId, action: 'reverse',
      beforeJson: { status: 'posted' }, afterJson: { status: 'reversed', reversalEntryId: reversalId }, reason,
    });

    return { originalEntryId: entryId, reversalEntryId: reversalId };
  });
}

/** يُستخدم في الاختبارات فقط لإثبات أن طبقة قاعدة البيانات ترفض قيدًا غير متوازن حتى لو تجاوزنا الخدمة عمدًا. */
export async function postJournalEntryBypassingAppCheck(
  ctx: RequestContext,
  input: CreateJournalEntryInput,
) {
  return withTransaction(async (client: PoolClient) => {
    const entry = await client.query(
      `INSERT INTO journal_entries(
        company_id, branch_id, fiscal_period_id, entry_date, currency_code, status, source_document_type
      ) VALUES ($1,$2,$3,$4,$5,'posted',$6) RETURNING id`,
      [ctx.companyId, input.branchId, input.fiscalPeriodId, input.entryDate, input.currencyCode, input.sourceDocumentType],
    );
    const entryId = entry.rows[0].id;
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO journal_lines(journal_entry_id, company_id, account_id, debit, credit)
         VALUES ($1,$2,$3,$4,$5)`,
        [entryId, ctx.companyId, line.accountId, line.debit, line.credit],
      );
    }
    return { id: entryId };
  });
}

export async function listJournalEntries(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('accounting.journal.view');
  return paginatedList<unknown>(ctx, 'journal_entries', { page, pageSize, status });
}

/**
 * قائمة كاملة بلا صفحات (دليل الحسابات لكل شركة صغير نسبيًا — عشرات إلى بضع مئات كحد أقصى،
 * ولا عمود branch_id في accounts أصلًا فهو دليل موحَّد على مستوى الشركة). أُضيفت هذه الدالة
 * كفجوة مُكتشَفة عند بناء واجهة الخزينة: سند القبض/الصرف بطرف مقابل 'other' يحتاج اختيار
 * contraAccountId من قائمة حسابات حقيقية، ولم يكن لهذا أي مسار قراءة من قبل.
 */
export async function listAccounts(ctx: RequestContext) {
  ctx.assertPermission('accounting.account.view');
  const { rows } = await pool.query(
    `SELECT * FROM accounts WHERE company_id=$1 ORDER BY code ASC`,
    [ctx.companyId],
  );
  return rows;
}

/** قائمة كاملة بلا صفحات (عدد الفترات المالية لكل شركة صغير عادةً — سنوي/ربع سنوي). */
export async function listFiscalPeriods(ctx: RequestContext) {
  ctx.assertPermission('accounting.fiscal_period.view');
  const { rows } = await pool.query(
    `SELECT * FROM fiscal_periods WHERE company_id=$1 ORDER BY start_date DESC`,
    [ctx.companyId],
  );
  return rows;
}
