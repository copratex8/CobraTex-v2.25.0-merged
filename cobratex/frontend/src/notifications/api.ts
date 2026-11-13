import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  source_document_type: string | null;
  source_document_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationsPage {
  data: AppNotification[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  unreadCount: number;
}

/** يُحدَّث كل 30 ثانية — Polling بسيط، لا WebSocket بعد (فجوة موثَّقة: تحديث فوري حقيقي يحتاج
 * قناة حية، الإشعار البعيد الفوري الحقيقي الوحيد المُنفَّذ فعليًا حاليًا هو عبر Web Push). */
export function useNotifications(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['notifications', page, pageSize],
    queryFn: async () => (await apiClient.get<NotificationsPage>('/notifications', { params: { page, pageSize } })).data,
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/notifications/${id}/read`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await apiClient.post('/notifications/read-all')).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * يطلب إذن الإشعارات من المتصفح، يُسجِّل عامل الخدمة، يشترك في Web Push بمفتاح VAPID العام
 * (يُجلَب من الخادم، لا يُثبَّت في الكود)، ويحفظ الاشتراك في الباك إند. أفضل جهد بالكامل — أي
 * فشل (متصفح غير داعم، رفض المستخدم للإذن، VAPID غير مُهيَّأ على الخادم) يُرجع false بهدوء.
 */
export async function subscribeToPushNotifications(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const { data } = await apiClient.get<{ publicKey: string | null }>('/notifications/vapid-public-key');
    if (!data.publicKey) return false;

    const registration = await navigator.serviceWorker.register('/sw.js');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource,
    });

    const json = subscription.toJSON();
    await apiClient.post('/notifications/push-subscriptions', {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    });
    return true;
  } catch {
    return false;
  }
}
