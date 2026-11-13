import { pool } from '@/db/pool';
import { ValidationError } from '@/shared/errors';
import { sendPushToUser } from '@/modules/notifications/pushService';
import * as svc from '@/modules/platform/platformService';

/**
 * التحكم عن بُعد (المطوّر فقط): إشعارات/تذكيرات موجَّهة (داخل النظام + Web Push) وتشغيل تذكيرات انتهاء الترخيص.
 * الترخيص نفسه (تواريخ/سماح/وضع القراءة أو الحجب) يُدار في licenseService؛ وهنا فقط ما يخص التواصل مع العملاء.
 * كل أمر يُسجَّل في platform_audit.
 */
async function pushAll(items: { userId: string; title: string; body: string }[]) {
  // PUSH_VIA_EDGE=true: pushService يتجاهل الإرسال لأن Database Webhook هو من يرسل عند إدراج الصف.
  const queue = [...items];
  await Promise.all(Array.from({ length: 10 }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) await sendPushToUser(it.userId, { title: it.title, body: it.body }).catch(() => undefined);
  }));
}

export interface BroadcastInput { tenantId?: unknown; audience?: unknown; title?: unknown; body?: unknown; severity?: unknown; alsoAnnouncement?: unknown }
const MAX_RECIPIENTS = 5000;

export async function broadcast(input: BroadcastInput) {
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
  if (!title) throw new ValidationError('عنوان الإشعار مطلوب');
  const body = typeof input.body === 'string' ? input.body.trim().slice(0, 1000) : '';
  const audience = input.audience === 'all' ? 'all' : 'owners';
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (tenantId && !svc.isUuid(tenantId)) throw new ValidationError('معرّف العميل غير صالح');

  const recipientsSql = `
    SELECT DISTINCT u.id AS user_id, u.company_id FROM users u
    ${audience === 'owners' ? `JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.name = 'Owner' AND r.is_system_role` : ''}
    WHERE u.is_active AND u.company_id IS NOT NULL AND ($1::uuid IS NULL OR u.tenant_id = $1::uuid)`;
  const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM (${recipientsSql}) x`, [tenantId])).rows[0].n as number;
  if (count === 0) throw new ValidationError('لا يوجد مستلمون مطابقون');
  if (count > MAX_RECIPIENTS) throw new ValidationError(`عدد المستلمين (${count}) يتجاوز الحد ${MAX_RECIPIENTS} — وجّه الإشعار لعميل بعينه`);

  const inserted = await pool.query(
    `INSERT INTO notifications(company_id, user_id, type, title, body)
     SELECT x.company_id, x.user_id, 'platform_message', $2, $3 FROM (${recipientsSql}) x RETURNING user_id`,
    [tenantId, title, body]);
  await pushAll(inserted.rows.map((r) => ({ userId: r.user_id as string, title, body })));

  if (input.alsoAnnouncement === true) {
    await svc.createAnnouncement({ tenantId, title, body, severity: input.severity ?? 'info' });
  }
  await svc.audit('notify.broadcast', { tenantId, audience, recipients: inserted.rowCount, title });
  return { recipients: inserted.rowCount ?? 0 };
}

/** يستدعيه Vercel Cron يوميًا (أو زر في لوحة المطور). آمن للتكرار: العتبات لا تُرسل مرتين. */
export async function runReminders() {
  const { rows } = await pool.query(`SELECT out_user_id, out_title, out_body FROM send_license_reminders()`);
  await pushAll(rows.map((r) => ({ userId: r.out_user_id as string, title: r.out_title as string, body: r.out_body as string })));
  await svc.audit('license.reminders', { sent: rows.length });
  return { sent: rows.length };
}
