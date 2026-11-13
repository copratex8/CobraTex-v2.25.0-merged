import { pool } from '@/db/pool';

/**
 * فحص «المستخدم ما زال نشطًا» لكل طلب (مع كاش قصير جدًا) كي لا يبقى توكن مستخدم عُطِّل صالحًا 15 دقيقة.
 * التعطيل/إعادة الضبط في نفس العملية يمسح الكاش فورًا؛ وفي بقية الحالات (عدة نسخ خادم) أقصى تأخير TTL ثوانٍ.
 */
const TTL_MS = 10_000;
const cache = new Map<string, { active: boolean; exp: number }>();

export function invalidateActiveUser(userId: string) { cache.delete(userId); }

export async function isUserActive(userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.exp > now) return hit.active;
  const { rows } = await pool.query(`SELECT is_active FROM users WHERE id = $1`, [userId]);
  const active = rows[0]?.is_active === true;
  if (cache.size > 5000) cache.clear();
  cache.set(userId, { active, exp: now + TTL_MS });
  return active;
}
