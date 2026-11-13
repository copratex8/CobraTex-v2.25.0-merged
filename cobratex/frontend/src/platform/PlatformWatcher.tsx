import { useEffect } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { markSuspended } from '@/platform/suspension';
import { usePlatformStatus } from '@/platform/usePlatformStatus';

/**
 * عند الاعتماد على Supabase للقراءة/Realtime لا يوجد خطأ 503 يلتقطه axios عند إيقاف الخدمة (ترجع الاستعلامات فارغة بسبب سياسة
 * rls_service_active). هذا المراقب يستعلم حالة المنصة كل دقيقة ويُظهر شاشة الإيقاف نفسها (إيقاف يدوي أو انتهاء ترخيص).
 */
export default function PlatformWatcher() {
  const { user } = useAuth();
  const { data } = usePlatformStatus(user?.tenantId);
  useEffect(() => {
    if (data?.status === 'suspended') markSuspended(data.message, data.scope === 'license' ? 'expired' : 'suspended');
  }, [data]);
  return null;
}
