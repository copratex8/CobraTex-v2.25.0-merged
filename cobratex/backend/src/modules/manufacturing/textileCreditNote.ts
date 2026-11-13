import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { reverseJournalEntry } from '@/modules/accounting/accountingService';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';

/**
 * إشعار دائن لمطالبة جودة مسوّاة بحل «credit_note» (2.7.0). القيد: مدين حساب مسموحات المبيعات ← دائن حساب العميل، بعملة الأساس.
 * يخفض رصيد العميل في الأستاذ كرصيد دائن على الحساب (لا يُخصَّص تلقائيًا على فاتورة بعينها؛ الفاتورة المرجعية للتوثيق).
 * ضريبة القيمة المضافة غير مُعالَجة هنا: المبلغ إجمالي كما سُوّيت به المطالبة؛ تسويتها الضريبية قرار المحاسب.
 */
const uuid = z.uuid(); const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const issueSchema = z.strictObject({ salesInvoiceId: uuid.optional(), noteDate: date.optional(), allowanceAccountId: uuid.optional(), reason: z.string().max(300).optional() });
export const reverseSchema = z.strictObject({ reason: z.string().min(3).max(300) });
export const noteQuerySchema = z.object({ claimId: uuid.optional(), customerId: uuid.optional() });
const today = () => new Date().toISOString().slice(0, 10);

export async function issueCreditNote(ctx: RequestContext, claimId: string, b: z.infer<typeof issueSchema>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.credit');
  return withTransaction(async (client) => {
    const c = (await client.query(`SELECT id, claim_no, branch_id, customer_id, status, resolution, settled_value FROM quality_claims WHERE id=$1 AND company_id=$2 FOR UPDATE`, [claimId, ctx.companyId])).rows[0];
    if (!c) throw new NotFoundError('المطالبة غير موجودة');
    if (c.status !== 'settled') throw new ConflictError('الإشعار الدائن لمطالبة مسوّاة فقط');
    if (c.resolution !== 'credit_note') throw new ValidationError('حل المطالبة ليس «إشعار دائن»');
    const amount = Number(c.settled_value ?? 0); if (!(amount > 0)) throw new ValidationError('قيمة التسوية صفر');
    if ((await client.query(`SELECT 1 FROM claim_credit_notes WHERE claim_id=$1 AND status='posted'`, [claimId])).rows.length) throw new ConflictError('صدر إشعار دائن لهذه المطالبة بالفعل — اعكسه أولًا لإصدار بديل');
    if (b.salesInvoiceId) {
      const inv = (await client.query(`SELECT customer_id, status FROM sales_invoices WHERE id=$1 AND company_id=$2`, [b.salesInvoiceId, ctx.companyId])).rows[0];
      if (!inv || inv.customer_id !== c.customer_id) throw new ValidationError('الفاتورة غير موجودة أو لعميل آخر');
      if (inv.status !== 'posted') throw new ValidationError('الفاتورة المرجعية غير مرحَّلة');
    }
    const co = (await client.query(`SELECT sales_allowance_account_id FROM companies WHERE id=$1`, [ctx.companyId])).rows[0];
    const accId = b.allowanceAccountId ?? co.sales_allowance_account_id;
    if (!accId) throw new ValidationError('حدّد حساب مسموحات المبيعات (في الطلب أو من إعدادات الشركة) قبل إصدار الإشعار');
    if (!(await client.query(`SELECT 1 FROM accounts WHERE id=$1 AND company_id=$2`, [accId, ctx.companyId])).rows.length) throw new ValidationError('حساب المسموحات غير موجود');
    const cust = (await client.query(`SELECT linked_account_id FROM customers WHERE id=$1 AND company_id=$2`, [c.customer_id, ctx.companyId])).rows[0];
    if (!cust?.linked_account_id) throw new ValidationError('العميل بلا حساب ذمم مربوط');
    const d = b.noteDate ?? today();
    const noteNo = await getNextDocumentNumber({ companyId: ctx.companyId, branchId: c.branch_id, documentType: 'CLAIM_CREDIT_NOTE', prefix: 'CN-' }, client);
    const amt = amount.toFixed(4);
    const je = await postBaseEntry(ctx, client, { branchId: c.branch_id, date: d, sourceType: 'claim_credit_note', sourceId: claimId, lines: [
      { accountId: accId, debit: amt, credit: '0', description: `إشعار دائن ${noteNo} — مطالبة ${c.claim_no}` },
      { accountId: cust.linked_account_id, debit: '0', credit: amt, description: `إشعار دائن ${noteNo} — مطالبة ${c.claim_no}` }] });
    const row = (await client.query(
      `INSERT INTO claim_credit_notes(company_id,branch_id,note_no,claim_id,customer_id,sales_invoice_id,note_date,amount,reason,journal_entry_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ctx.companyId, c.branch_id, noteNo, claimId, c.customer_id, b.salesInvoiceId ?? null, d, amt, b.reason ?? null, je, ctx.userId])).rows[0];
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'claim_credit_note', entityId: row.id, afterJson: { noteNo, claimId, amount: amt, journalEntryId: je } });
    return row;
  });
}

export async function reverseCreditNote(ctx: RequestContext, id: string, b: z.infer<typeof reverseSchema>) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.credit');
  const n = (await pool.query(`SELECT id, status, journal_entry_id FROM claim_credit_notes WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!n) throw new NotFoundError('الإشعار غير موجود'); if (n.status !== 'posted') throw new ConflictError('الإشعار معكوس بالفعل');
  const r = await reverseJournalEntry(ctx, n.journal_entry_id, b.reason);
  const row = (await pool.query(`UPDATE claim_credit_notes SET status='reversed', reversal_entry_id=$2, reversed_at=now(), reverse_reason=$3 WHERE id=$1 AND status='posted' RETURNING *`, [id, r.reversalEntryId, b.reason])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'claim_credit_note', entityId: id, afterJson: { status: 'reversed', reason: b.reason } });
  return row;
}

export async function listCreditNotes(ctx: RequestContext, q: { claimId?: string; customerId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.claims.view');
  return (await pool.query(
    `SELECT n.*, c.claim_no, cu.name_ar AS customer_name FROM claim_credit_notes n JOIN quality_claims c ON c.id=n.claim_id JOIN customers cu ON cu.id=n.customer_id AND cu.company_id=n.company_id
     WHERE n.company_id=$1 AND ($2::uuid IS NULL OR n.claim_id=$2) AND ($3::uuid IS NULL OR n.customer_id=$3) ORDER BY n.note_date DESC, n.note_no DESC LIMIT 500`, [ctx.companyId, q.claimId ?? null, q.customerId ?? null])).rows;
}
