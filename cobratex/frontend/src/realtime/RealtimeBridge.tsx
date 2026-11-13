import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { AUTH_MODE, supabase, setRealtimeToken } from '@/lib/supabaseClient';
import { useAuth } from '@/auth/AuthContext';

/** جدول القاعدة ← بادئات مفاتيح الاستعلام التي تُبطَل عند تغيّر صف (من أي جهاز). عدّلها مع supabase/migrations/…_realtime.sql. */
const TABLE_QUERY_KEYS: Record<string, string[]> = {
  sales_invoices: ['sales-invoices', 'sales-invoice', 'customer-open-invoices', 'sales-summary'],
  customer_payments: ['customer-payments', 'customer-payment', 'customer-open-invoices'],
  supplier_invoices: ['purchase-invoices', 'purchase-invoice', 'supplier-open-invoices', 'purchase-summary'],
  supplier_payments: ['supplier-payments', 'supplier-payment', 'supplier-open-invoices'],
  treasury_transactions: ['treasury-transactions', 'treasury-transaction', 'safes'],
  checks: ['checks', 'check'],
  goods_receipts: ['goods-receipts', 'goods-receipt'],
  production_orders: ['production-orders', 'production-order'],
  notifications: ['notifications'],
  attachments: ['attachments'],
};

/**
 * قناة واحدة لكل شركة. يُركَّب مرة واحدة داخل التخطيط المصادَق: <RealtimeBridge />
 * الحمولة لا تُستخدم كبيانات — مجرد «نبضة» تُعيد الاستعلامات النشطة عبر الـAPI (فتُفرض الصلاحيات والفروع هناك).
 * RLS تحدد أي أحداث تصل لكل مستخدم. الإبطال مؤجَّل (debounce) لتفادي عاصفة إعادة الجلب.
 *  - وضع supabase: القناة تستعمل جلسة المستخدم نفسها.
 *  - وضع legacy: يُجلب توكن Realtime قصير من الخادم (GET /api/realtime/token) ويُجدَّد قبل انتهائه؛
 *    إن لم يُضبط SUPABASE_JWT_SECRET على الخادم يردّ {enabled:false} فلا يحدث شيء (صامت).
 * بلا VITE_SUPABASE_* لا يفعل المكوّن شيئًا.
 */
export default function RealtimeBridge() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const companyId = user?.companyId;

  useEffect(() => {
    if (!supabase || !companyId) return;
    const sb = supabase;
    let cancelled = false;
    let refresh: number | undefined;
    let channel: ReturnType<typeof sb.channel> | null = null;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const schedule = (table: string) => {
      clearTimeout(timers.get(table));
      timers.set(table, setTimeout(() => {
        for (const key of TABLE_QUERY_KEYS[table]) void queryClient.invalidateQueries({ queryKey: [key] });
      }, 500));
    };

    const subscribe = () => {
      if (channel || cancelled) return;
      channel = sb.channel(`company-${companyId}`);
      for (const table of Object.keys(TABLE_QUERY_KEYS)) {
        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `company_id=eq.${companyId}` }, () => schedule(table));
      }
      channel.subscribe();
    };

    const mintAndSubscribe = async () => {
      const r = (await apiClient.get('/realtime/token')).data as { enabled: boolean; token?: string; expiresIn?: number };
      if (cancelled || !r.enabled || !r.token) return;
      setRealtimeToken(r.token);
      subscribe();
      refresh = window.setTimeout(() => void mintAndSubscribe().catch(() => undefined), Math.max(60, (r.expiresIn ?? 3600) - 600) * 1000);
    };

    if (AUTH_MODE === 'supabase') subscribe();
    else void mintAndSubscribe().catch(() => undefined);

    return () => {
      cancelled = true;
      window.clearTimeout(refresh);
      timers.forEach((t) => clearTimeout(t));
      if (channel) void sb.removeChannel(channel);
    };
  }, [companyId, queryClient]);

  return null;
}
