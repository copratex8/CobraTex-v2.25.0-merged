import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { AUTH_MODE, supabase } from '@/lib/supabaseClient';

export interface PlatformAnnouncement { id: string; title: string; body: string; severity: 'info' | 'success' | 'warning' | 'critical' }
export interface LicenseInfo {
  state: 'active' | 'expiring' | 'grace' | 'expired';
  daysLeft: number | null;
  endsAt: string | null;
  graceUntil: string | null;
  plan: string;
}
export interface UpdatePolicy { latestVersion?: string; minVersion?: string; message?: string }
export interface PlatformStatus {
  status: 'active' | 'suspended';
  message: string;
  scope: 'global' | 'tenant' | 'license' | null;
  announcements: PlatformAnnouncement[];
  /** تفاصيل الترخيص تُعرَض فقط للمستخدم المسجَّل التابع لنفس العميل (وضع Supabase). */
  license?: LicenseInfo | null;
  update?: UpdatePolicy;
  serverTime: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * حالة المنصة من لوحة المطور (تعمل بلا مصادقة لشاشة الدخول): الإيقاف، الإشعارات، سياسة التحديث عن بُعد.
 *  - وضع supabase: عبر دالة Postgres `get_platform_status` (تشمل تفاصيل الترخيص للمسجَّل فقط).
 *  - وضع legacy: عبر GET /public/status على الخادم.
 */
export function usePlatformStatus(tenantId?: string) {
  const tenant = tenantId && UUID_RE.test(tenantId) ? tenantId : undefined;
  return useQuery({
    queryKey: ['platform-status', tenant ?? 'global', AUTH_MODE],
    queryFn: async () => {
      if (AUTH_MODE === 'supabase' && supabase) {
        const { data, error } = await supabase.rpc('get_platform_status', { p_tenant_id: tenant ?? null });
        if (error) throw error;
        return data as PlatformStatus;
      }
      return (await apiClient.get<PlatformStatus>('/public/status', { params: tenant ? { tenantId: tenant } : {} })).data;
    },
    refetchInterval: 60_000,
    retry: false,
  });
}
