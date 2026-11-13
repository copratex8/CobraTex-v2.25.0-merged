import { useState } from 'react';
import { useNotifications, useMarkNotificationRead, useMarkAllNotificationsRead, subscribeToPushNotifications } from '@/notifications/api';
import PaginationControls from '@/components/PaginationControls';

export default function NotificationsPage() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useNotifications(page, 20);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const [pushStatus, setPushStatus] = useState<'idle' | 'requesting' | 'enabled' | 'failed'>('idle');

  async function handleEnablePush() {
    setPushStatus('requesting');
    const ok = await subscribeToPushNotifications();
    setPushStatus(ok ? 'enabled' : 'failed');
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">الإشعارات</h1>
        <div className="flex gap-2">
          {pushStatus !== 'enabled' && (
            <button
              onClick={handleEnablePush}
              disabled={pushStatus === 'requesting'}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {pushStatus === 'requesting' ? 'جارٍ التفعيل...' : 'تفعيل إشعارات فورية عن بُعد'}
            </button>
          )}
          {pushStatus === 'enabled' && <span className="rounded-lg bg-emerald-50 px-3 py-1.5 text-sm text-emerald-700">✓ مُفعَّلة على هذا الجهاز</span>}
          {(data?.unreadCount ?? 0) > 0 && (
            <button onClick={() => markAllRead.mutate()} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              تعليم الكل كمقروء
            </button>
          )}
        </div>
      </div>

      {pushStatus === 'failed' && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          تعذَّر التفعيل — إما رفض إذن الإشعارات من المتصفح، أو الخادم لم يُهيَّأ بمفاتيح VAPID بعد.
        </p>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {data && (
          <>
            {data.data.length === 0 && <p className="p-8 text-center text-sm text-slate-400">لا إشعارات بعد</p>}
            {data.data.map((n) => (
              <button
                key={n.id}
                onClick={() => !n.read_at && markRead.mutate(n.id)}
                className={`block w-full border-b border-slate-100 px-5 py-4 text-start last:border-0 hover:bg-slate-50 ${n.read_at ? '' : 'bg-slate-50'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-slate-900" />}
                    <div>
                      <p className="text-sm font-medium text-slate-900">{n.title}</p>
                      {n.body && <p className="mt-0.5 text-sm text-slate-500">{n.body}</p>}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">{new Date(n.created_at).toLocaleString('ar-EG')}</span>
                </div>
              </button>
            ))}
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
