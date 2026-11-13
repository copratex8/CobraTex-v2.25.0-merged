import webpush from 'web-push';
import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';

/**
 * إشعارات فورية عن بُعد (Remote Push) للمتصفح — عبر بروتوكول Web Push القياسي (RFC 8030) بمفاتيح
 * VAPID ذاتية التوليد. **مجانية بالكامل ولا تتطلب أي حساب أو خدمة طرف ثالث مدفوعة** (لا Firebase
 * ولا OneSignal) — المتصفح نفسه (Chrome/Firefox/Edge) يوصل الإشعار عبر خدمة الدفع الخاصة به
 * مجانًا، والخادم هنا فقط يوقِّع الرسالة بمفتاحه الخاص. تعمل حتى والتطبيق مغلق تمامًا في المتصفح
 * (طالما الجهاز متصل بالإنترنت) — هذا ما يجعلها "عن بُعد" فعليًا لا مجرد إشعار داخل الصفحة.
 */

let vapidConfigured = false;
function ensureVapidConfigured() {
  if (vapidConfigured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!publicKey || !privateKey) return; // غير مُهيَّأ — سنتجاهل الإرسال بصمت (راجع sendPushToUser)
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
}

export interface SaveSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function savePushSubscription(ctx: RequestContext, input: SaveSubscriptionInput) {
  ctx.assertPermission('notifications.push_subscription.manage');
  if (!input.endpoint || !input.keys?.p256dh || !input.keys?.auth) {
    throw new ValidationError('بيانات اشتراك Web Push غير مكتملة');
  }
  const { rows } = await pool.query(
    `INSERT INTO push_subscriptions(company_id, user_id, endpoint, p256dh_key, auth_key)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh_key = EXCLUDED.p256dh_key, auth_key = EXCLUDED.auth_key
     RETURNING id`,
    [ctx.companyId, ctx.userId, input.endpoint, input.keys.p256dh, input.keys.auth],
  );
  return { id: rows[0].id };
}

export async function removePushSubscription(ctx: RequestContext, endpoint: string) {
  ctx.assertPermission('notifications.push_subscription.manage');
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2`, [endpoint, ctx.userId]);
  return { removed: true };
}

/**
 * يرسل إشعار دفع لكل اشتراكات مستخدم مُعيَّن (قد يملك أكثر من جهاز/متصفح). أفضل جهد بالكامل:
 * لا يرمي أي استثناء للمستدعي — اشتراك منتهي الصلاحية (404/410 من خدمة الدفع) يُحذَف تلقائيًا
 * بصمت، وأي خطأ آخر يُسجَّل فقط. عدم ضبط مفاتيح VAPID (بيئة تطوير مثلًا) يجعل الدالة لا تفعل شيئًا.
 */
export async function sendPushToUser(userId: string, payload: { title: string; body: string }) {
  // عند تفعيل Edge Function (supabase/functions/send-push) تتولّى هي الإرسال عبر Database Webhook — نتجنّب الإرسال المزدوج.
  if (process.env.PUSH_VIA_EDGE === 'true') return;
  ensureVapidConfigured();
  if (!vapidConfigured) return;

  const { rows } = await pool.query(`SELECT id, endpoint, p256dh_key, auth_key FROM push_subscriptions WHERE user_id=$1`, [userId]);
  await Promise.all(
    rows.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
          JSON.stringify(payload),
        );
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [sub.id]);
        } else {
          // eslint-disable-next-line no-console
          console.error('[push] فشل إرسال إشعار:', err);
        }
      }
    }),
  );
}
