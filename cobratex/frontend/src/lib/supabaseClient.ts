import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * وضع المصادقة (يُحدَّد وقت البناء):
 *  - 'legacy'   (الافتراضي): الدخول عبر API الخادم نفسه (/auth/login + refresh) — يعمل مع أي PostgreSQL ومع نسخة سطح المكتب غير المتصلة.
 *                Supabase اختياري هنا ويُستخدم لـ Realtime فقط (توكن قصير يصدره الخادم).
 *  - 'supabase': الدخول عبر Supabase Auth؛ الخادم يقبل توكنه ويحمّل الصلاحيات حيّة من القاعدة. يتطلب VITE_SUPABASE_URL/ANON_KEY.
 * ضبط VITE_AUTH_MODE=supabase بلا مفاتيح Supabase يعود تلقائيًا إلى legacy (مع تحذير في الـconsole).
 */
const wantsSupabaseAuth = import.meta.env.VITE_AUTH_MODE === 'supabase';

/** null إن لم تُضبط VITE_SUPABASE_* ⇒ الواجهة تعمل بلا Supabase إطلاقًا (لا Realtime، لا حالة منصة عبر RPC). */
export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, {
      auth: { persistSession: wantsSupabaseAuth, autoRefreshToken: wantsSupabaseAuth, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;

if (wantsSupabaseAuth && !supabase) {
  // eslint-disable-next-line no-console
  console.warn('VITE_AUTH_MODE=supabase لكن VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY غير مضبوطين — يُستخدم الدخول legacy.');
}

export const AUTH_MODE: 'legacy' | 'supabase' = wantsSupabaseAuth && supabase ? 'supabase' : 'legacy';

/**
 * مفتاح anon عام بطبيعته — الأمان من سياسات RLS (supabase/migrations). لا تضع service_role في أي VITE_*.
 * وضع legacy + Realtime: يمرّر توكن Realtime القصير الذي يصدره الخادم (GET /api/realtime/token).
 */
export function setRealtimeToken(jwt: string | null) {
  if (supabase && jwt) supabase.realtime.setAuth(jwt);
}
