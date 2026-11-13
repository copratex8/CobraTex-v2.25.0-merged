import { z } from 'zod';

/** UUID v4-ish (يقبل أي UUID قياسي) بحقل id فقط — .strict() يرفض أي مفتاح إضافي في params. */
export const idParamSchema = z.strictObject({
  id: z.uuid('معرّف غير صالح'),
});

export const uuid = z.uuid('معرّف غير صالح');
export const optionalUuid = uuid.optional();

/**
 * استعلام رصيد المخزون: warehouseId وitemId إلزاميان (UUID)، batchId اختياري. .strict() يرفض
 * أي حقل غير متوقع في الاستعلام — تحديدًا يمنع تمرير company_id/branch_id/tenant_id كـ query
 * param وتوهُّم أنه يوسّع النطاق الأمني (لا يُقرأ أبدًا من هنا في الكود أصلًا، لكن الرفض الصريح
 * يمنع حتى محاولة الإرسال من المرور بصمت).
 */
export const stockBalanceQuerySchema = z.strictObject({
  warehouseId: uuid,
  itemId: uuid,
  batchId: optionalUuid,
});

/**
 * تعطيل/تفعيل كيان مرجعي (عميل/مورد/صنف) — راجع تعليق migration 0029. ليس حذفًا: فقط قلب
 * is_active. مشتركة بين الثلاثة لتطابق الشكل تمامًا (لا داعٍ لثلاث نسخ متطابقة).
 */
export const toggleActiveBodySchema = z.strictObject({
  isActive: z.boolean(),
});

// ===== أدوات مشتركة لتحقق أجسام POST (Zod على body، لا على query/params فقط) =====

/** رقم عشري كنص (متوافق مع decimal.js في كل الخدمات) — لا يقبل NaN/فراغ/سالب افتراضيًا. */
const decimalStringPositive = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'يجب أن يكون رقمًا عشريًا موجبًا صالحًا')
  .refine((v) => Number(v) > 0 && Number(v) < 1e12, 'قيمة خارج النطاق المسموح');

/** نفس الشيء لكن يسمح بصفر (مثل نسبة خصم 0). */
const decimalStringNonNegative = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'يجب أن يكون رقمًا عشريًا صالحًا')
  .refine((v) => Number(v) >= 0 && Number(v) < 1e12, 'قيمة خارج النطاق المسموح');

/** رقم عشري مُوقَّع (موجب أو سالب) بلا صفر — لسطر كشف حساب بنكي (موجب=إيداع، سالب=سحب). */
const decimalStringSignedNonZero = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'يجب أن يكون رقمًا عشريًا صالحًا (موجب أو سالب)')
  .refine((v) => Number(v) !== 0 && Math.abs(Number(v)) < 1e12, 'قيمة خارج النطاق المسموح أو صفر');

const percentString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'يجب أن تكون نسبة رقمية صالحة')
  .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'النسبة يجب أن تكون بين 0 و100');

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD');
const currencyCodeSchema = z.string().length(3, 'رمز العملة يجب أن يكون 3 أحرف').toUpperCase();
const exchangeRateSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'سعر الصرف يجب أن يكون رقمًا صالحًا')
  .refine((v) => Number(v) > 0 && Number(v) < 1e9, 'سعر صرف خارج النطاق المعقول')
  .optional();

export const createCustomerBodySchema = z.strictObject({
  code: z.string().min(1).max(50),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().min(1).max(200),
  taxNumber: z.string().max(50).optional(),
  creditLimit: decimalStringNonNegative.optional(),
  paymentTermDays: z.number().int().min(0).max(3650).optional(),
  currencyCode: currencyCodeSchema,
  branchId: optionalUuid,
  effectiveFrom: dateStringSchema.optional(),
  effectiveTo: dateStringSchema.optional(),
});

export const createSupplierBodySchema = z.strictObject({
  code: z.string().min(1).max(50),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().min(1).max(200),
  taxNumber: z.string().max(50).optional(),
  paymentTermDays: z.number().int().min(0).max(3650).optional(),
  currencyCode: currencyCodeSchema,
  branchId: optionalUuid,
  effectiveFrom: dateStringSchema.optional(),
  effectiveTo: dateStringSchema.optional(),
});

const salesInvoiceLineBodySchema = z.strictObject({
  itemId: uuid,
  uomId: uuid,
  quantity: decimalStringPositive,
  unitPrice: decimalStringNonNegative,
  discountPercent: percentString.optional(),
  taxTypeId: optionalUuid,
});
export const createSalesInvoiceBodySchema = z.strictObject({
  branchId: uuid,
  warehouseId: uuid,
  customerId: uuid,
  salesOrderId: optionalUuid,
  fiscalPeriodId: uuid,
  currencyCode: currencyCodeSchema,
  exchangeRate: exchangeRateSchema,
  invoiceDate: dateStringSchema,
  paymentType: z.enum(['cash', 'credit', 'cheque', 'transfer']).optional(),
  activityId: optionalUuid,
  projectId: optionalUuid,
  costCenterId: optionalUuid,
  lines: z.array(salesInvoiceLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

const supplierInvoiceLineBodySchema = z.strictObject({
  goodsReceiptLineId: uuid,
  quantity: decimalStringPositive,
  unitCost: decimalStringNonNegative,
  taxTypeId: optionalUuid,
});
export const createSupplierInvoiceBodySchema = z.strictObject({
  branchId: uuid,
  supplierId: uuid,
  fiscalPeriodId: uuid,
  currencyCode: currencyCodeSchema,
  exchangeRate: exchangeRateSchema,
  invoiceDate: dateStringSchema,
  activityId: optionalUuid,
  projectId: optionalUuid,
  costCenterId: optionalUuid,
  lines: z.array(supplierInvoiceLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

const paymentAllocationBodySchema = z.strictObject({ salesInvoiceId: uuid, amount: decimalStringPositive });
export const createCustomerPaymentBodySchema = z.strictObject({
  branchId: uuid,
  customerId: uuid,
  fiscalPeriodId: uuid,
  currencyCode: currencyCodeSchema,
  exchangeRate: exchangeRateSchema,
  paymentDate: dateStringSchema,
  amount: decimalStringPositive,
  receiptAccountId: uuid,
  allocations: z.array(paymentAllocationBodySchema).optional(),
});

const supplierPaymentAllocationBodySchema = z.strictObject({ supplierInvoiceId: uuid, amount: decimalStringPositive });
export const createSupplierPaymentBodySchema = z.strictObject({
  branchId: uuid,
  supplierId: uuid,
  fiscalPeriodId: uuid,
  currencyCode: currencyCodeSchema,
  exchangeRate: exchangeRateSchema,
  paymentDate: dateStringSchema,
  amount: decimalStringPositive,
  paymentAccountId: uuid,
  allocations: z.array(supplierPaymentAllocationBodySchema).optional(),
});

export const allocateCustomerAdvanceBodySchema = z.strictObject({
  allocations: z.array(paymentAllocationBodySchema).min(1, 'قائمة التخصيصات لا يمكن أن تكون فارغة'),
});
export const allocateSupplierAdvanceBodySchema = z.strictObject({
  allocations: z.array(supplierPaymentAllocationBodySchema).min(1, 'قائمة التخصيصات لا يمكن أن تكون فارغة'),
});

const expenseInvoiceLineBodySchema = z.strictObject({
  expenseAccountId: uuid,
  description: z.string().min(1).max(500),
  amount: decimalStringPositive,
  discountPercent: percentString.optional(),
  taxTypeId: optionalUuid,
});
export const createExpenseInvoiceBodySchema = z
  .strictObject({
    branchId: uuid,
    supplierId: optionalUuid,
    paidFromAccountId: optionalUuid,
    fiscalPeriodId: uuid,
    currencyCode: currencyCodeSchema,
    exchangeRate: exchangeRateSchema,
    invoiceDate: dateStringSchema,
    description: z.string().max(500).optional(),
    activityId: optionalUuid,
    projectId: optionalUuid,
    costCenterId: optionalUuid,
    lines: z.array(expenseInvoiceLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
  })
  .refine((v) => Boolean(v.supplierId) !== Boolean(v.paidFromAccountId), {
    message: 'حدِّد إما supplierId أو paidFromAccountId، وليس كليهما أو لا شيء',
  });

const salesReturnLineBodySchema = z.strictObject({ salesInvoiceLineId: uuid, quantity: decimalStringPositive });
export const createSalesReturnBodySchema = z.strictObject({
  branchId: uuid,
  warehouseId: uuid,
  salesInvoiceId: uuid,
  fiscalPeriodId: uuid,
  returnDate: dateStringSchema,
  activityId: optionalUuid,
  projectId: optionalUuid,
  costCenterId: optionalUuid,
  lines: z.array(salesReturnLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

const purchaseReturnLineBodySchema = z.strictObject({ supplierInvoiceLineId: uuid, quantity: decimalStringPositive });
export const createPurchaseReturnBodySchema = z.strictObject({
  branchId: uuid,
  warehouseId: uuid,
  supplierInvoiceId: uuid,
  fiscalPeriodId: uuid,
  returnDate: dateStringSchema,
  activityId: optionalUuid,
  projectId: optionalUuid,
  costCenterId: optionalUuid,
  lines: z.array(purchaseReturnLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

export const reverseDocumentBodySchema = z.strictObject({
  reason: z.string().min(1, 'سبب العكس إلزامي').max(500),
});

/**
 * لم يكن لخدمة الجرد (stocktakeService.ts، منطق كامل: إنشاء/ترحيل/عكس/عرض) أي مخطط تحقق ولا مسار
 * HTTP إطلاقًا — فجوة مُكتشَفة أثناء ربطها بمسارات فعلية. batchId اختياري (صنف بلا دفعات يُطابَق
 * بـ IS NULL في الخدمة نفسها).
 */
const stocktakeLineBodySchema = z.strictObject({
  itemId: uuid,
  batchId: optionalUuid,
  countedQuantity: decimalStringNonNegative,
});
export const createStocktakeBodySchema = z.strictObject({
  branchId: uuid,
  warehouseId: uuid,
  fiscalPeriodId: uuid,
  countDate: dateStringSchema,
  activityId: optionalUuid,
  projectId: optionalUuid,
  costCenterId: optionalUuid,
  lines: z.array(stocktakeLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

// ===== المرحلة 5: بقية مخططات POST (عروض أسعار، أوامر، استلامات، خزينة) =====

const quotationLineBodySchema = z.strictObject({
  itemId: uuid, uomId: uuid, quantity: decimalStringPositive, unitPrice: decimalStringNonNegative,
  discountPercent: percentString.optional(),
});
export const createQuotationBodySchema = z.strictObject({
  branchId: uuid, customerId: uuid, currencyCode: currencyCodeSchema, quotationDate: dateStringSchema,
  validUntil: dateStringSchema.optional(), lines: z.array(quotationLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

const salesOrderLineBodySchema = z.strictObject({
  itemId: uuid, uomId: uuid, quantity: decimalStringPositive, unitPrice: decimalStringNonNegative,
  discountPercent: percentString.optional(),
});
export const createSalesOrderBodySchema = z.strictObject({
  branchId: uuid, customerId: uuid, currencyCode: currencyCodeSchema, orderDate: dateStringSchema,
  sourceQuotationId: optionalUuid, activityId: optionalUuid, projectId: optionalUuid, costCenterId: optionalUuid,
  lines: z.array(salesOrderLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

const purchaseOrderLineBodySchema = z.strictObject({ itemId: uuid, uomId: uuid, quantity: decimalStringPositive, unitPrice: decimalStringNonNegative });
export const createPurchaseOrderBodySchema = z.strictObject({
  branchId: uuid, supplierId: uuid, currencyCode: currencyCodeSchema, orderDate: dateStringSchema,
  activityId: optionalUuid, projectId: optionalUuid, costCenterId: optionalUuid,
  lines: z.array(purchaseOrderLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

const goodsReceiptLineBodySchema = z.strictObject({
  itemId: uuid, uomId: uuid, quantity: decimalStringPositive, unitCost: decimalStringNonNegative, purchaseOrderLineId: optionalUuid,
});
export const createGoodsReceiptBodySchema = z.strictObject({
  branchId: uuid, warehouseId: uuid, supplierId: uuid, purchaseOrderId: optionalUuid, receiptDate: dateStringSchema,
  activityId: optionalUuid, projectId: optionalUuid, costCenterId: optionalUuid,
  lines: z.array(goodsReceiptLineBodySchema).min(1, 'يجب سطر واحد على الأقل'),
});

export const transitionStatusBodySchema = z.strictObject({
  target: z.string().min(1).max(50),
});

export const createSafeOrBankBodySchema = z.strictObject({
  branchId: uuid,
  code: z.string().min(1).max(50),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().min(1).max(200),
  kind: z.enum(['safe', 'bank']),
  currencyCode: currencyCodeSchema,
  bankName: z.string().max(200).optional(),
  accountNumber: z.string().max(100).optional(),
  iban: z.string().max(50).optional(),
});

export const createTreasuryTransactionBodySchema = z.strictObject({
  branchId: uuid,
  safeOrBankId: uuid,
  transactionType: z.enum(['receipt', 'payment']),
  counterpartyType: z.enum(['customer', 'supplier', 'other']),
  counterpartyCustomerId: optionalUuid,
  counterpartySupplierId: optionalUuid,
  contraAccountId: optionalUuid,
  amount: decimalStringPositive,
  currencyCode: currencyCodeSchema,
  exchangeRate: exchangeRateSchema,
  transactionDate: dateStringSchema,
  fiscalPeriodId: uuid,
});

export const createTreasuryTransferBodySchema = z
  .strictObject({
    branchId: uuid,
    fromSafeOrBankId: uuid,
    toSafeOrBankId: uuid,
    amount: decimalStringPositive,
    currencyCode: currencyCodeSchema,
    exchangeRate: exchangeRateSchema,
    transferDate: dateStringSchema,
    fiscalPeriodId: uuid,
  })
  .refine((v) => v.fromSafeOrBankId !== v.toSafeOrBankId, { message: 'لا يمكن التحويل من وإلى نفس الخزينة/الحساب' });

export const registerCheckBodySchema = z.strictObject({
  branchId: uuid,
  safeOrBankId: uuid,
  checkType: z.enum(['incoming', 'outgoing']),
  checkNumber: z.string().min(1).max(50),
  checkDate: dateStringSchema,
  dueDate: dateStringSchema,
  amount: decimalStringPositive,
  currencyCode: currencyCodeSchema,
  counterpartyCustomerId: optionalUuid,
  counterpartySupplierId: optionalUuid,
  notes: z.string().max(500).optional(),
});

export const transitionCheckBodySchema = z.strictObject({
  target: z.string().min(1).max(50),
  reason: z.string().max(500).optional(),
  fiscalPeriodId: optionalUuid,
  clearDate: dateStringSchema.optional(),
});

/* ============================== التسوية البنكية ============================== */

const bankStatementLineBodySchema = z.strictObject({
  lineDate: dateStringSchema,
  description: z.string().max(500).optional(),
  amount: decimalStringSignedNonZero,
  reference: z.string().max(100).optional(),
});

export const createReconciliationBodySchema = z.strictObject({
  branchId: uuid,
  safeOrBankId: uuid,
  statementDate: dateStringSchema,
  openingBalance: z.string().regex(/^-?\d+(\.\d+)?$/, 'يجب أن يكون رقمًا عشريًا صالحًا').optional(),
  statementEndingBalance: z.string().regex(/^-?\d+(\.\d+)?$/, 'يجب أن يكون رقمًا عشريًا صالحًا'),
  lines: z.array(bankStatementLineBodySchema).min(1, 'سطر واحد على الأقل مطلوب'),
});

export const updateManufacturingEnabledBodySchema = z.strictObject({
  enabled: z.boolean(),
});

export const matchLineBodySchema = z.strictObject({
  treasuryTransactionId: optionalUuid,
  treasuryTransferId: optionalUuid,
});

/* ============================== التصنيع (Manufacturing) ============================== */

const bomLineBodySchema = z.strictObject({
  componentItemId: uuid,
  quantity: decimalStringPositive,
  wastePercent: z.string().regex(/^\d+(\.\d+)?$/, 'يجب أن يكون رقمًا عشريًا صالحًا').optional(),
  isMainMaterial: z.boolean().optional(),
});

const bomOperationBodySchema = z.strictObject({
  name: z.string().min(1).max(200),
  costType: z.enum(['labor', 'overhead', 'other']),
  costAmount: decimalStringNonNegative,
});

export const createBomBodySchema = z.strictObject({
  code: z.string().min(1).max(50),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().min(1).max(200),
  outputItemId: uuid,
  outputQuantity: decimalStringPositive.optional(),
  activityId: optionalUuid,
  stageId: optionalUuid,
  lines: z.array(bomLineBodySchema).min(1, 'قائمة المواد يجب أن تحتوي مكوّنًا واحدًا على الأقل'),
  operations: z.array(bomOperationBodySchema).optional(),
});

export const updateOperationCostsBodySchema = z.strictObject({
  operations: z.array(z.strictObject({ operationId: uuid, actualCost: decimalStringNonNegative })).min(1),
});

export const createProductionOrderBodySchema = z.strictObject({
  branchId: uuid,
  warehouseId: uuid,
  bomId: uuid,
  fiscalPeriodId: uuid,
  orderDate: dateStringSchema,
  plannedOutputQuantity: decimalStringPositive,
  activityId: optionalUuid,
});
