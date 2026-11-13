import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { createSupplierPayment, postSupplierPayment, reverseSupplierPayment } from '@/modules/purchasing/supplierPaymentService';
import { createCustomerPayment, postCustomerPayment, reverseCustomerPayment } from '@/modules/sales/customerPaymentService';

/**
 * ضريبة الخصم والإضافة (2.17.0). الاتجاهان:
 *  - payable: نخصمها من مورد عند السداد ⇒ Dr حساب المورد / Cr «ضريبة خصم مستحقة» ويُسدَّد الباقي نقدًا؛ نُسدِّد المستحق للمصلحة لاحقًا (remit).
 *  - receivable: يخصمها عميل منا ⇒ Dr «ضريبة خصم مدينة» / Cr حساب العميل (تُستردّ من الضريبة المستحقة بشهادة الخصم).
 * التنفيذ بدفعة نظامية عبر خدمات الدفع الأصلية دون تعديلها (الحساب المقابل = حساب الضريبة بدل الخزينة) فتبقى التخصيصات والأرصدة سليمة.
 * النسب أدناه افتراضات شائعة قابلة للتعديل لكل شركة — راجع محاسبك/مصلحة الضرائب قبل الاعتماد عليها.
 */
const uuid = z.uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD');
export const DEFAULT_CATEGORIES = [{ code: 'SUPPLY', name: 'توريدات (أنشطة تجارية)', rate: 1 }, { code: 'SERVICE', name: 'خدمات', rate: 3 }, { code: 'RENT', name: 'إيجارات', rate: 3 }, { code: 'PROFESSIONAL', name: 'أتعاب مهن حرة', rate: 5 }, { code: 'COMMISSION', name: 'عمولات وسمسرة', rate: 5 }];
export const settingsSchema = z.strictObject({ isEnabled: z.boolean().optional(), payableAccountId: uuid.nullable().optional(), receivableAccountId: uuid.nullable().optional(), exemptThreshold: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(), baseIncludesVat: z.boolean().optional() });
export const categorySchema = z.strictObject({ code: z.string().min(1).max(30), nameAr: z.string().min(1), ratePercent: z.number().gt(0).lte(100), isActive: z.boolean().optional() });
export const applySchema = z.strictObject({ direction: z.enum(['payable', 'receivable']), invoiceId: uuid, categoryId: uuid, deductionDate: date, certificateNo: z.string().optional() });
export const reverseSchema = z.strictObject({ reason: z.string().min(3) });
export const reportSchema = z.object({ from: date, to: date, direction: z.enum(['payable', 'receivable']).default('payable') });
export const remitSchema = z.strictObject({ from: date, to: date, bankAccountId: uuid, remitDate: date });
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function getSettings(ctx: RequestContext) {
  ctx.assertPermission('wht.view');
  const r = (await pool.query(`SELECT * FROM wht_settings WHERE company_id=$1`, [ctx.companyId])).rows[0];
  return r ?? { company_id: ctx.companyId, is_enabled: false, payable_account_id: null, receivable_account_id: null, exempt_threshold: '0', base_includes_vat: false };
}
export async function saveSettings(ctx: RequestContext, raw: z.input<typeof settingsSchema>) {
  ctx.assertPermission('wht.settings'); const b = settingsSchema.parse(raw); const cur = await getSettings(ctx);
  const chk = async (id: string | null | undefined, types: string[], label: string) => { if (!id) return; const a = (await pool.query(`SELECT account_type FROM accounts WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0]; if (!a) throw new ValidationError(`${label}: الحساب غير موجود`); if (!types.includes(a.account_type)) throw new ValidationError(`${label}: نوع الحساب غير مناسب (${a.account_type})`); };
  await chk(b.payableAccountId, ['liability'], 'حساب ضريبة الخصم المستحقة'); await chk(b.receivableAccountId, ['asset'], 'حساب ضريبة الخصم المدينة');
  const row = (await pool.query(`INSERT INTO wht_settings(company_id,is_enabled,payable_account_id,receivable_account_id,exempt_threshold,base_includes_vat) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (company_id) DO UPDATE SET is_enabled=EXCLUDED.is_enabled, payable_account_id=EXCLUDED.payable_account_id, receivable_account_id=EXCLUDED.receivable_account_id, exempt_threshold=EXCLUDED.exempt_threshold, base_includes_vat=EXCLUDED.base_includes_vat, updated_at=now() RETURNING *`,
    [ctx.companyId, b.isEnabled ?? cur.is_enabled, 'payableAccountId' in b ? b.payableAccountId ?? null : cur.payable_account_id, 'receivableAccountId' in b ? b.receivableAccountId ?? null : cur.receivable_account_id, b.exemptThreshold ?? cur.exempt_threshold, b.baseIncludesVat ?? cur.base_includes_vat])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'wht_settings', entityId: ctx.companyId, afterJson: b });
  return row;
}

/** الفئات: عند أول قراءة تُزرَع الافتراضيات الشائعة (مرة واحدة) ثم تُعدَّل بحرية. */
export async function listCategories(ctx: RequestContext) {
  ctx.assertPermission('wht.view');
  const n = (await pool.query(`SELECT count(*)::int AS n FROM wht_categories WHERE company_id=$1`, [ctx.companyId])).rows[0].n;
  if (n === 0) for (const c of DEFAULT_CATEGORIES) await pool.query(`INSERT INTO wht_categories(company_id,code,name_ar,rate_percent) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.companyId, c.code, c.name, c.rate]);
  return (await pool.query(`SELECT * FROM wht_categories WHERE company_id=$1 ORDER BY code`, [ctx.companyId])).rows;
}
export async function saveCategory(ctx: RequestContext, raw: z.input<typeof categorySchema>) {
  ctx.assertPermission('wht.settings'); const b = categorySchema.parse(raw);
  return (await pool.query(`INSERT INTO wht_categories(company_id,code,name_ar,rate_percent,is_active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id,code) DO UPDATE SET name_ar=EXCLUDED.name_ar, rate_percent=EXCLUDED.rate_percent, is_active=EXCLUDED.is_active RETURNING *`, [ctx.companyId, b.code, b.nameAr, b.ratePercent, b.isActive ?? true])).rows[0];
}

type Dir = 'payable' | 'receivable';
async function invoiceFacts(ctx: RequestContext, dir: Dir, id: string, includeVat: boolean) {
  const rec = dir === 'receivable';
  const inv = (await pool.query(rec ? `SELECT i.id, i.branch_id, i.customer_id AS party_id, i.fiscal_period_id, i.currency_code, i.exchange_rate, i.document_number FROM sales_invoices i WHERE i.id=$1 AND i.company_id=$2 AND i.status='posted'` : `SELECT i.id, i.branch_id, i.supplier_id AS party_id, i.fiscal_period_id, i.currency_code, i.exchange_rate, i.document_number FROM supplier_invoices i WHERE i.id=$1 AND i.company_id=$2 AND i.status='posted'`, [id, ctx.companyId])).rows[0];
  if (!inv) throw new NotFoundError('الفاتورة غير موجودة أو غير مرحّلة');
  const col = includeVat ? 'line_total' : 'subtotal';
  const lines = rec ? `sales_invoice_lines WHERE sales_invoice_id=$1` : `supplier_invoice_lines WHERE supplier_invoice_id=$1`;
  const gross = Number((await pool.query(`SELECT COALESCE(SUM(${col}),0) AS tot FROM ${lines}`, [id])).rows[0].tot);
  const ret = Number((await pool.query(rec ? `SELECT COALESCE(SUM(l.${col}),0) AS tot FROM sales_return_lines l JOIN sales_returns r ON r.id=l.sales_return_id WHERE r.sales_invoice_id=$1 AND r.status='posted'` : `SELECT COALESCE(SUM(l.${col}),0) AS tot FROM purchase_return_lines l JOIN purchase_returns r ON r.id=l.purchase_return_id WHERE r.supplier_invoice_id=$1 AND r.status='posted'`, [id])).rows[0].tot);
  const total = Number((await pool.query(rec ? `SELECT COALESCE(SUM(line_total),0) AS tot FROM sales_invoice_lines WHERE sales_invoice_id=$1` : `SELECT COALESCE(SUM(line_total),0) AS tot FROM supplier_invoice_lines WHERE supplier_invoice_id=$1`, [id])).rows[0].tot);
  const alloc = Number((await pool.query(rec ? `SELECT COALESCE(SUM(allocated_amount),0) AS tot FROM customer_payment_allocations WHERE sales_invoice_id=$1` : `SELECT COALESCE(SUM(allocated_amount),0) AS tot FROM supplier_payment_allocations WHERE supplier_invoice_id=$1`, [id])).rows[0].tot);
  const retTotal = Number((await pool.query(rec ? `SELECT COALESCE(SUM(l.line_total),0) AS tot FROM sales_return_lines l JOIN sales_returns r ON r.id=l.sales_return_id WHERE r.sales_invoice_id=$1 AND r.status='posted'` : `SELECT COALESCE(SUM(l.line_total),0) AS tot FROM purchase_return_lines l JOIN purchase_returns r ON r.id=l.purchase_return_id WHERE r.supplier_invoice_id=$1 AND r.status='posted'`, [id])).rows[0].tot);
  return { inv, base: r2(gross - ret), remaining: r2(total - retTotal - alloc) };
}

/** معاينة: الوعاء والنسبة والمبلغ المخصوم وصافي المطلوب سداده/تحصيله. */
export async function preview(ctx: RequestContext, raw: { direction: Dir; invoiceId: string; categoryId: string }) {
  ctx.assertPermission('wht.view'); const st = await getSettings(ctx);
  const cat = (await pool.query(`SELECT * FROM wht_categories WHERE id=$1 AND company_id=$2`, [raw.categoryId, ctx.companyId])).rows[0]; if (!cat) throw new NotFoundError('فئة الخصم غير موجودة'); if (!cat.is_active) throw new ValidationError('الفئة غير مفعّلة');
  const f = await invoiceFacts(ctx, raw.direction, raw.invoiceId, st.base_includes_vat);
  const exempt = f.base < Number(st.exempt_threshold); const wht = exempt ? 0 : r2((f.base * Number(cat.rate_percent)) / 100);
  return { direction: raw.direction, invoice: f.inv.document_number, currency: f.inv.currency_code, base: f.base, ratePercent: Number(cat.rate_percent), wht, exempt, remaining: f.remaining, netToSettle: r2(f.remaining - wht), threshold: Number(st.exempt_threshold), baseIncludesVat: st.base_includes_vat };
}

export async function apply(ctx: RequestContext, raw: z.input<typeof applySchema>) {
  ctx.assertPermission('wht.apply'); const b = applySchema.parse(raw); const st = await getSettings(ctx);
  if (!st.is_enabled) throw new ValidationError('ضريبة الخصم غير مفعّلة لهذه الشركة');
  const acct = b.direction === 'payable' ? st.payable_account_id : st.receivable_account_id;
  if (!acct) throw new ValidationError(b.direction === 'payable' ? 'حدّد حساب ضريبة الخصم المستحقة في الإعدادات' : 'حدّد حساب ضريبة الخصم المدينة في الإعدادات');
  const p = await preview(ctx, { direction: b.direction, invoiceId: b.invoiceId, categoryId: b.categoryId });
  if (p.exempt) throw new ValidationError(`وعاء العملية ${p.base} أقل من حد الإعفاء ${p.threshold}`);
  if (p.wht <= 0) throw new ValidationError('مبلغ الخصم صفر');
  if (p.wht > p.remaining + 0.005) throw new ValidationError(`مبلغ الخصم ${p.wht} يتجاوز المتبقي من الفاتورة ${p.remaining}`);
  const f = await invoiceFacts(ctx, b.direction, b.invoiceId, st.base_includes_vat); const cat = (await pool.query(`SELECT code, rate_percent FROM wht_categories WHERE id=$1`, [b.categoryId])).rows[0];
  const dup = (await pool.query(b.direction === 'payable' ? `SELECT 1 FROM wht_deductions WHERE supplier_invoice_id=$1 AND status='posted'` : `SELECT 1 FROM wht_deductions WHERE sales_invoice_id=$1 AND status='posted'`, [b.invoiceId])).rows.length;
  if (dup) throw new ConflictError('طُبِّق خصم على هذه الفاتورة بالفعل — اعكسه أولًا');
  const base = { branchId: f.inv.branch_id, fiscalPeriodId: f.inv.fiscal_period_id, currencyCode: f.inv.currency_code, paymentDate: b.deductionDate, amount: p.wht.toFixed(4) };
  let paymentId: string;
  if (b.direction === 'payable') {
    const pay = await createSupplierPayment(ctx, { ...base, supplierId: f.inv.party_id, paymentAccountId: acct, allocations: [{ supplierInvoiceId: b.invoiceId, amount: p.wht.toFixed(4) }] }); paymentId = pay.id;
    try { await postSupplierPayment(ctx, paymentId); } catch (e) { await reverseSupplierPayment(ctx, paymentId, 'فشل ترحيل خصم الضريبة').catch(() => undefined); throw e; }
  } else {
    const pay = await createCustomerPayment(ctx, { ...base, customerId: f.inv.party_id, receiptAccountId: acct, allocations: [{ salesInvoiceId: b.invoiceId, amount: p.wht.toFixed(4) }] }); paymentId = pay.id;
    try { await postCustomerPayment(ctx, paymentId); } catch (e) { await reverseCustomerPayment(ctx, paymentId, 'فشل ترحيل خصم الضريبة').catch(() => undefined); throw e; }
  }
  const row = (await pool.query(`INSERT INTO wht_deductions(company_id,branch_id,direction,supplier_invoice_id,sales_invoice_id,party_id,category_id,category_code,rate_percent,base_amount,wht_amount,currency_code,deduction_date,certificate_no,payment_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [ctx.companyId, f.inv.branch_id, b.direction, b.direction === 'payable' ? b.invoiceId : null, b.direction === 'receivable' ? b.invoiceId : null, f.inv.party_id, b.categoryId, cat.code, cat.rate_percent, p.base, p.wht, f.inv.currency_code, b.deductionDate, b.certificateNo ?? null, paymentId, ctx.userId])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'wht_deduction', entityId: row.id, afterJson: { direction: b.direction, wht: p.wht } });
  return { ...row, netToSettle: p.netToSettle };
}

export async function reverse(ctx: RequestContext, id: string, raw: z.input<typeof reverseSchema>) {
  ctx.assertPermission('wht.reverse'); const b = reverseSchema.parse(raw);
  const d = (await pool.query(`SELECT * FROM wht_deductions WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!d) throw new NotFoundError('الخصم غير موجود'); if (d.status !== 'posted') throw new ConflictError('معكوس بالفعل'); if (d.remittance_entry_id) throw new ConflictError('سُدِّد للمصلحة — لا يُعكس');
  if (d.direction === 'payable') await reverseSupplierPayment(ctx, d.payment_id, b.reason); else await reverseCustomerPayment(ctx, d.payment_id, b.reason);
  const row = (await pool.query(`UPDATE wht_deductions SET status='reversed', reverse_reason=$2, reversed_at=now() WHERE id=$1 RETURNING *`, [id, b.reason])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'wht_deduction', entityId: id, afterJson: { reversed: true, reason: b.reason } });
  return row;
}

/** كشف الخصم للفترة (أساس نموذج الخصم الشهري وشهادات الخصم): بالطرف والفئة. */
export async function report(ctx: RequestContext, raw: z.input<typeof reportSchema>) {
  ctx.assertPermission('wht.view'); const q = reportSchema.parse(raw);
  const rows = (await pool.query(`SELECT d.*, d.deduction_date::text AS dd, COALESCE(cu.name_ar, su.name_ar) AS party_name, COALESCE(cu.tax_number, su.tax_number) AS tax_no,
      COALESCE(si.document_number, pi.document_number) AS invoice_no
    FROM wht_deductions d LEFT JOIN customers cu ON d.direction='receivable' AND cu.id=d.party_id LEFT JOIN suppliers su ON d.direction='payable' AND su.id=d.party_id
    LEFT JOIN sales_invoices si ON si.id=d.sales_invoice_id LEFT JOIN supplier_invoices pi ON pi.id=d.supplier_invoice_id
    WHERE d.company_id=$1 AND d.direction=$2 AND d.status='posted' AND d.deduction_date BETWEEN $3 AND $4 ORDER BY d.deduction_date, d.created_at`, [ctx.companyId, q.direction, q.from, q.to])).rows;
  const items = rows.map((r) => ({ id: r.id, date: r.dd, party: r.party_name, taxNumber: r.tax_no, invoiceNo: r.invoice_no, category: r.category_code, ratePercent: Number(r.rate_percent), base: Number(r.base_amount), wht: Number(r.wht_amount), currency: r.currency_code, certificateNo: r.certificate_no, remitted: !!r.remitted_at }));
  const group = (key: 'party' | 'category') => { const m = new Map<string, { name: string; base: number; wht: number; count: number }>(); for (const i of items) { const k = i[key] ?? '—'; const e = m.get(k) ?? { name: k, base: 0, wht: 0, count: 0 }; e.base = r2(e.base + i.base); e.wht = r2(e.wht + i.wht); e.count++; m.set(k, e); } return [...m.values()].sort((a, b) => b.wht - a.wht); };
  const foreign = items.filter((i) => i.currency !== undefined).length; // الأرقام بعملة المستند
  return { from: q.from, to: q.to, direction: q.direction, items, byParty: group('party'), byCategory: group('category'), totals: { base: r2(items.reduce((s, i) => s + i.base, 0)), wht: r2(items.reduce((s, i) => s + i.wht, 0)), count: items.length, unremitted: r2(items.filter((i) => !i.remitted).reduce((s, i) => s + i.wht, 0)) }, missingCertificates: items.filter((i) => !i.certificateNo).length, note: foreign ? 'المبالغ بعملة كل مستند؛ حوِّل الأجنبي يدويًا عند إعداد النموذج.' : '' };
}

/** سداد المخصوم من الموردين للمصلحة: Dr ضريبة خصم مستحقة / Cr البنك، لما لم يُسدَّد من الفترة. (عملة الأساس فقط). */
export async function remit(ctx: RequestContext, raw: z.input<typeof remitSchema>) {
  ctx.assertPermission('wht.remit'); const b = remitSchema.parse(raw); const st = await getSettings(ctx);
  if (!st.payable_account_id) throw new ValidationError('حدّد حساب ضريبة الخصم المستحقة');
  const base = (await pool.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId])).rows[0].base_currency_code;
  const bank = (await pool.query(`SELECT account_type FROM accounts WHERE id=$1 AND company_id=$2`, [b.bankAccountId, ctx.companyId])).rows[0]; if (!bank || bank.account_type !== 'asset') throw new ValidationError('حساب البنك/الخزينة غير صالح');
  return withTransaction(async (client) => {
    const ds = (await client.query(`SELECT id, wht_amount, currency_code, branch_id FROM wht_deductions WHERE company_id=$1 AND direction='payable' AND status='posted' AND remittance_entry_id IS NULL AND deduction_date BETWEEN $2 AND $3 FOR UPDATE`, [ctx.companyId, b.from, b.to])).rows;
    if (!ds.length) throw new ValidationError('لا خصومات غير مسدَّدة في الفترة');
    if (ds.some((d) => d.currency_code !== base)) throw new ValidationError('يوجد خصم بعملة أجنبية — يُسدَّد يدويًا (القيد بعملة الأساس فقط)');
    const total = r2(ds.reduce((s, d) => s + Number(d.wht_amount), 0));
    const je = await postBaseEntry(ctx, client, { branchId: ds[0].branch_id, date: b.remitDate, sourceType: 'wht_remittance', lines: [{ accountId: st.payable_account_id, debit: total.toFixed(4), credit: '0', description: `سداد ضريبة خصم ${b.from}→${b.to}` }, { accountId: b.bankAccountId, debit: '0', credit: total.toFixed(4), description: 'سداد ضريبة خصم للمصلحة' }] });
    await client.query(`UPDATE wht_deductions SET remitted_at=$2, remittance_entry_id=$3 WHERE id = ANY($1::uuid[])`, [ds.map((d) => d.id), b.remitDate, je]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'wht_remittance', entityId: je, afterJson: { total, count: ds.length } });
    return { total, count: ds.length, journalEntryId: je };
  });
}
