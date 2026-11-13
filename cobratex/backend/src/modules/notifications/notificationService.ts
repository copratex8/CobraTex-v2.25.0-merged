import type { Pool, PoolClient } from 'pg';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { NotFoundError } from '@/shared/errors';
import { sendPushToUser } from '@/modules/notifications/pushService';

export interface CreateNotificationInput {
  companyId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  sourceDocumentType?: string;
  sourceDocumentId?: string;
}

/**
 * ينشئ إشعارًا داخل النظام (يظهر في مركز الإشعارات بالواجهة)، ويحاول إرسال دفعة Web Push فورية
 * لنفس المستخدم بأفضل جهد (Best Effort) — فشل الدفع البعيد (مثلًا: لا اشتراك مُسجَّل، أو الجهاز
 * غير متصل) لا يُفشل إنشاء الإشعار نفسه إطلاقًا؛ الإشعار الداخل محفوظ دائمًا بصرف النظر.
 * لا تتطلب صلاحية استدعاء — تُستخدَم داخليًا من منطق الأعمال (مثل ترحيل مستند)، لا من مسار عام.
 */
export async function createNotification(input: CreateNotificationInput, client: Pool | PoolClient = pool) {
  const { rows } = await client.query(
    `INSERT INTO notifications(company_id, user_id, type, title, body, source_document_type, source_document_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.companyId, input.userId, input.type, input.title, input.body ?? null, input.sourceDocumentType ?? null, input.sourceDocumentId ?? null],
  );
  // أفضل جهد — لا ننتظر فشله ليُفشل الإجراء الأصلي (ترحيل فاتورة مثلًا)
  sendPushToUser(input.userId, { title: input.title, body: input.body ?? '' }).catch(() => undefined);
  return rows[0];
}

export async function listNotifications(ctx: RequestContext, page = 1, pageSize = 20, onlyUnread = false) {
  ctx.assertPermission('notifications.view');
  const conditions = ['user_id = $1'];
  const params: unknown[] = [ctx.userId];
  if (onlyUnread) conditions.push('read_at IS NULL');
  const where = conditions.join(' AND ');

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM notifications WHERE ${where}`, params);
  const total = countResult.rows[0].total as number;
  params.push(pageSize, (page - 1) * pageSize);
  const dataResult = await pool.query(
    `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const unreadCountResult = await pool.query(`SELECT COUNT(*)::int AS total FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [ctx.userId]);

  return {
    data: dataResult.rows, page, pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    unreadCount: unreadCountResult.rows[0].total as number,
  };
}

export async function markNotificationRead(ctx: RequestContext, id: string) {
  ctx.assertPermission('notifications.view');
  const { rows } = await pool.query(
    `UPDATE notifications SET read_at = now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL RETURNING *`,
    [id, ctx.userId],
  );
  if (rows.length === 0) {
    const exists = await pool.query(`SELECT id FROM notifications WHERE id=$1 AND user_id=$2`, [id, ctx.userId]);
    if (exists.rows.length === 0) throw new NotFoundError('الإشعار غير موجود');
  }
  return { id, readAt: rows[0]?.read_at ?? null };
}

export async function markAllNotificationsRead(ctx: RequestContext) {
  ctx.assertPermission('notifications.view');
  const { rowCount } = await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id=$1 AND read_at IS NULL`, [ctx.userId]);
  return { markedCount: rowCount };
}
