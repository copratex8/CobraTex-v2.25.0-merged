import type { PlatformAnnouncement } from '@/platform/usePlatformStatus';

const STYLES: Record<PlatformAnnouncement['severity'], { bg: string; border: string; color: string; icon: string }> = {
  info: { bg: '#eaf4fd', border: '#3498db', color: '#1f5f8b', icon: 'ℹ️' },
  success: { bg: '#e8f6ee', border: '#1a6b3c', color: '#14532d', icon: '✅' },
  warning: { bg: '#fff6e0', border: '#e0a100', color: '#7a5600', icon: '⚠️' },
  critical: { bg: '#fdecea', border: '#e74c3c', color: '#8e2a20', icon: '🚨' },
};

/** إشعارات المطوّر على شاشة الدخول. */
export default function AnnouncementList({ items }: { items: PlatformAnnouncement[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4 space-y-2" data-testid="login-announcements">
      {items.map((a) => {
        const s = STYLES[a.severity] ?? STYLES.info;
        return (
          <div key={a.id} role="alert" className="rounded-lg px-3 py-2 text-sm" style={{ background: s.bg, borderInlineStart: `4px solid ${s.border}`, color: s.color }}>
            <p className="font-bold">{s.icon} {a.title}</p>
            {a.body && <p className="mt-0.5 whitespace-pre-line text-[0.8rem] leading-6">{a.body}</p>}
          </div>
        );
      })}
    </div>
  );
}
