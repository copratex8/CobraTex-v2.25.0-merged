import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications, useMarkNotificationRead, useMarkAllNotificationsRead } from '@/notifications/api';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data } = useNotifications(1, 5);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unreadCount = data?.unreadCount ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-full p-2 text-slate-500 hover:bg-slate-100"
        aria-label="الإشعارات"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -end-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 z-40 mt-2 w-80 rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
            <span className="text-sm font-semibold text-slate-900">الإشعارات</span>
            {unreadCount > 0 && (
              <button onClick={() => markAllRead.mutate()} className="text-xs font-medium text-slate-500 hover:underline">
                تعليم الكل كمقروء
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {data?.data.length === 0 && <p className="p-4 text-center text-sm text-slate-400">لا إشعارات بعد</p>}
            {data?.data.map((n) => (
              <button
                key={n.id}
                onClick={() => !n.read_at && markRead.mutate(n.id)}
                className={`block w-full border-b border-slate-100 px-4 py-3 text-start text-sm last:border-0 hover:bg-slate-50 ${
                  n.read_at ? '' : 'bg-slate-50'
                }`}
              >
                <div className="flex items-start gap-2">
                  {!n.read_at && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-900" />}
                  <div>
                    <p className="font-medium text-slate-900">{n.title}</p>
                    {n.body && <p className="text-xs text-slate-500">{n.body}</p>}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="border-t border-slate-200 px-4 py-2 text-center">
            <Link to="/notifications" onClick={() => setOpen(false)} className="text-xs font-medium text-slate-600 hover:underline">
              عرض كل الإشعارات
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
