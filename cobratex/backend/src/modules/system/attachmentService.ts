import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertBranchScope } from '@/shared/scope';
import { randomUUID } from 'crypto';
import { storageEnabled, putObject, getObject, removeObject, objectPath } from '@/modules/system/attachmentStorage';

/**
 * قائمة الكيانات المسموح إرفاق ملفات بها + جدولها الفعلي، للتحقق أن entity_id مذكور فعلًا ينتمي
 * لهذه الشركة قبل قبول الرفع (حماية ضد إرفاق ملف بمعرّف عشوائي/كيان شركة أخرى، حتى لو كانت
 * القراءة أصلًا مُصفَّاة بـ company_id ولا يمكن لهذا التسريب أن يُقرَأ لاحقًا).
 */
const ENTITY_TABLES: Record<string, string> = {
  sales_invoice: 'sales_invoices',
  supplier_invoice: 'supplier_invoices',
  item: 'items',
  customer: 'customers',
  supplier: 'suppliers',
  treasury_transaction: 'treasury_transactions',
  check: 'checks',
  stocktake: 'stocktakes',
  bank_reconciliation: 'bank_reconciliations',
};

export const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — راجع تعليق النطاق في migration 0032

/** يطابق الامتداد المُعلَن مع بصمة الملف الفعلية (لا نثق بـ Content-Type القادم من العميل). */
export function matchesMagic(mime: string, b: Buffer): boolean {
  const s = (n: number, str: string) => b.length >= n + str.length && b.subarray(n, n + str.length).toString('latin1') === str;
  switch (mime) {
    case 'image/jpeg': return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.length > 8 && b[0] === 0x89 && s(1, 'PNG');
    case 'image/gif': return s(0, 'GIF87a') || s(0, 'GIF89a');
    case 'image/webp': return s(0, 'RIFF') && s(8, 'WEBP');
    case 'application/pdf': return s(0, '%PDF-');
    default: return false;
  }
}

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
]);

export interface UploadAttachmentInput {
  branchId: string;
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType: string;
  fileData: Buffer;
}

export async function uploadAttachment(ctx: RequestContext, input: UploadAttachmentInput) {
  ctx.assertPermission('attachments.upload', input.branchId);
  assertBranchScope(ctx, input.branchId);

  const table = ENTITY_TABLES[input.entityType];
  if (!table) throw new ValidationError(`نوع كيان غير مدعوم للمرفقات: ${input.entityType}`);
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new ValidationError('نوع الملف غير مدعوم — المسموح: صور (JPEG/PNG/WEBP/GIF) أو PDF فقط');
  }
  if (input.fileData.length === 0) throw new ValidationError('الملف فارغ');
  if (!matchesMagic(input.mimeType, input.fileData)) throw new ValidationError('محتوى الملف لا يطابق نوعه المُعلَن');
  if (input.fileData.length > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new ValidationError(`حجم الملف يتجاوز الحد المسموح (${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)}MB)`);
  }

  const entityCheck = await pool.query(`SELECT id FROM ${table} WHERE id=$1 AND company_id=$2`, [input.entityId, ctx.companyId]);
  if (entityCheck.rows.length === 0) throw new NotFoundError('الكيان المُراد إرفاق الملف به غير موجود');

  // مع Supabase Storage: يُرفع الملف أولًا ثم يُسجَّل الصف (لو فشل التسجيل يُحذف الكائن)؛ بدونه يبقى BYTEA كما كان.
  const id = randomUUID();
  const path = storageEnabled() ? objectPath(ctx.companyId, input.entityType, id, input.mimeType) : null;
  if (path) await putObject(path, input.fileData, input.mimeType);
  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO attachments(id, company_id, branch_id, entity_type, entity_id, file_name, mime_type, file_size, file_data, storage_path, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, company_id, branch_id, entity_type, entity_id, file_name, mime_type, file_size, uploaded_by, created_at`,
      [id, ctx.companyId, input.branchId, input.entityType, input.entityId, input.fileName, input.mimeType, input.fileData.length, path ? null : input.fileData, path, ctx.userId],
    ));
  } catch (e) { if (path) await removeObject(path).catch(() => undefined); throw e; }

  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'attachment', entityId: rows[0].id, action: 'create',
    afterJson: { entityType: input.entityType, entityId: input.entityId, fileName: input.fileName, fileSize: input.fileData.length },
  });
  return rows[0];
}

/** قائمة مرفقات كيان معيَّن (بيانات وصفية فقط، بلا محتوى الملف — لتفادي جلب BYTEA ثقيل لكل عنصر قائمة). */
export async function listAttachments(ctx: RequestContext, entityType: string, entityId: string) {
  ctx.assertPermission('attachments.view');
  const { rows } = await pool.query(
    `SELECT id, company_id, branch_id, entity_type, entity_id, file_name, mime_type, file_size, uploaded_by, created_at
     FROM attachments WHERE company_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY created_at DESC`,
    [ctx.companyId, entityType, entityId],
  );
  return rows;
}

/** يُعيد الملف كاملًا (بما فيه BYTEA) — يُستخدَم فقط من مسار التنزيل، لا من أي قائمة. */
export async function getAttachmentFile(ctx: RequestContext, id: string) {
  ctx.assertPermission('attachments.view');
  const { rows } = await pool.query(
    `SELECT id, company_id, file_name, mime_type, file_data, storage_path FROM attachments WHERE id=$1 AND company_id=$2`,
    [id, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('المرفق غير موجود');
  const row = rows[0];
  if (row.storage_path) row.file_data = await getObject(row.storage_path); // التنزيل يمرّ بالـAPI فتبقى الصلاحيات والعزل بالشركة
  return row;
}

export async function deleteAttachment(ctx: RequestContext, id: string) {
  const found = await pool.query(`SELECT * FROM attachments WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  if (found.rows.length === 0) throw new NotFoundError('المرفق غير موجود');
  const attachment = found.rows[0];
  ctx.assertPermission('attachments.delete', attachment.branch_id);

  await pool.query(`DELETE FROM attachments WHERE id=$1`, [id]);
  if (attachment.storage_path) await removeObject(attachment.storage_path).catch(() => undefined); // فشل حذف الكائن لا يُفشل الطلب (يتيم قابل للتنظيف)
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'attachment', entityId: id, action: 'delete',
    beforeJson: { fileName: attachment.file_name, entityType: attachment.entity_type, entityId: attachment.entity_id },
  });
  return { id, deleted: true };
}
