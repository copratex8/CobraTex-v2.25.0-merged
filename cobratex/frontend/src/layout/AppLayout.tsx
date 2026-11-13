import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { useBrand } from '@/brand/BrandProvider';
import { BrandLogo, DeveloperCredit } from '@/brand/BrandParts';
import { useCompany } from '@/features/catalog/api';
import NotificationBell from '@/notifications/NotificationBell';
import { CLOUD_LABELS, checkCloud, useCloudStatus } from '@/cloud/cloudStatus';
import { APP_VERSION, LicenseGate, UpdateBars } from '@/cloud/updates';
import { LicenseBanner } from '@/cloud/LicenseBanner';
import InstallAppButton from '@/pwa/InstallAppButton';
import PwaPrompts from '@/pwa/PwaPrompts';
import TableCards from '@/pwa/TableCards';
import RealtimeBridge from '@/realtime/RealtimeBridge';
import PlatformWatcher from '@/platform/PlatformWatcher';
import RemoteNotices from '@/platform/RemoteNotices';
import { usePluginManifest } from '@/plugins/api';
import { useFrontendPlugins } from '@/plugins/registry';
import { NAV_GROUPS, titleForPath, type NavGroup } from '@/layout/nav';
import { filterNav, filterNavByPerms, useModules } from '@/layout/modules';
import { ToastHost } from '@/ui/toast';
import PageTools, { PrintHeader } from '@/ui/PageTools';

export default function AppLayout() {
  const auth = useAuth();
  const { logout } = auth;
  const brand = useBrand();
  const location = useLocation();
  const cloud = useCloudStatus();
  const { data: company } = useCompany();
  const { data: backendPlugins } = usePluginManifest();
  const frontendPlugins = useFrontendPlugins();
  const [open, setOpen] = useState(false);
  const { data: modulesInfo } = useModules();

  // دمج المجموعات الثابتة مع إضافات الواجهة (public/plugins) وإضافات الخادم (backend/plugins) — كلها ديناميكية.
  const groups = useMemo<NavGroup[]>(() => {
    const result: NavGroup[] = NAV_GROUPS.map((g) => ({ ...g, items: [...g.items] }));
    const ensure = (id: string, label: string) => {
      let g = result.find((x) => x.id === id);
      if (!g) {
        g = { id, label, items: [] };
        // مجموعة "النظام" تبقى الأخيرة دائمًا.
        const systemIdx = result.findIndex((x) => x.id === 'system');
        result.splice(systemIdx === -1 ? result.length : systemIdx, 0, g);
      }
      return g;
    };
    for (const p of frontendPlugins) {
      const gid = p.section?.group ?? 'extensions';
      const g = ensure(gid, p.section?.groupLabel ?? 'الإضافات');
      g.items.push({ to: `/ext/${p.id}`, label: p.section?.name ?? p.name, icon: p.section?.icon ?? '🔌' });
    }
    for (const p of backendPlugins ?? []) {
      if (!p.navLabel) continue;
      ensure('extensions', 'الإضافات').items.push({ to: `/plugins/${p.name}`, label: p.navLabel, icon: '🧩' });
    }
    return filterNavByPerms(filterNav(result, modulesInfo), auth.can, auth.user ? auth.user.permissions.length > 0 : false);
  }, [frontendPlugins, backendPlugins, modulesInfo, auth]);

  const title = titleForPath(location.pathname, groups) ?? brand.appName;
  const displayName = company?.display_name ?? brand.companyName;

  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="flex min-h-screen bg-slate-50">
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}

      <aside
        className={`ct-sidebar ct-no-print fixed inset-y-0 start-0 z-50 flex w-[260px] flex-col transition-transform duration-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col items-center gap-2 border-b px-3.5 pb-4 pt-5" style={{ borderColor: 'color-mix(in srgb, var(--gold) 20%, transparent)' }}>
          <BrandLogo size={68} className="ct-logo-ring" />
          <h2 className="text-lg font-extrabold tracking-wide" style={{ color: 'var(--gold)', fontFamily: 'Tajawal, var(--font-sans)' }}>
            {brand.appName}
          </h2>
          <p className="text-center text-[0.65rem] text-white/40">{brand.tagline}</p>
        </div>

        <nav className="ct-scroll flex-1 overflow-y-auto py-2">
          {groups.map((g) => (
            <div key={g.id} className="mb-1">
              <div className="ct-nav-label">{g.label}</div>
              {g.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `ct-nav-item ${isActive ? 'active' : ''}`}>
                  <span className="ct-nav-icon">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t p-3" style={{ borderColor: 'color-mix(in srgb, var(--gold) 15%, transparent)' }}>
          <InstallAppButton variant="sidebar" />
          <button onClick={logout} className="w-full rounded-lg px-3 py-2 text-start text-sm font-medium text-white/70 hover:bg-white/5 hover:text-white">
            ⎋ تسجيل الخروج
          </button>
          <DeveloperCredit className="mt-2 text-center text-[0.65rem] leading-5 text-white/40" />
        </div>
      </aside>

      <div className="ct-main-wrap flex min-w-0 flex-1 flex-col">
        <RealtimeBridge />
        <PlatformWatcher />
        <PwaPrompts />
        <RemoteNotices />
        <TableCards />
        <LicenseBanner />
        <UpdateBars />
        <header className="ct-topbar sticky top-0 z-30 flex h-[60px] items-center justify-between bg-white px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <button className="rounded-lg p-2 text-xl text-slate-900 lg:hidden" onClick={() => setOpen(true)} aria-label="القائمة">☰</button>
            <h1 className="text-[1.05rem] font-bold text-slate-900" style={{ fontFamily: 'Tajawal, var(--font-sans)' }}>{title}</h1>
          </div>
          <div className="flex items-center gap-2.5">
            <InstallAppButton variant="icon" />
            <button
              onClick={() => void checkCloud()}
              title={`${CLOUD_LABELS[cloud.state]}${cloud.latencyMs ? ` — ${cloud.latencyMs}ms` : ''} (اضغط لإعادة الفحص)`}
              className="flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600"
            >
              <span className={`ct-cloud-dot ${cloud.state}`} />
              <span className="hidden sm:inline">السحابة</span>
            </button>
            <PageTools title={title} company={displayName} />
            <NotificationBell />
            <div className="flex items-center gap-2 rounded-full bg-slate-50 py-1 pe-3 ps-1.5" title={displayName}>
              <span className="ct-avatar flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold">{displayName.charAt(0)}</span>
              <span className="hidden max-w-[160px] truncate text-[0.8rem] font-semibold text-slate-700 sm:inline">{displayName}</span>
            </div>
          </div>
        </header>

        <main className="ct-main flex-1 overflow-x-auto p-4 lg:p-6">
          <PrintHeader title={title} company={displayName} />
          <Outlet />
        </main>

        <footer className="ct-no-print border-t border-slate-200 bg-white px-6 py-3 text-center text-xs text-slate-500">
          <span className="font-semibold text-slate-700">{brand.appName}</span> · v{APP_VERSION}
          {brand.developer.showCredit && ' · '}
          <DeveloperCredit className="inline" />
        </footer>
      </div>

      <ToastHost />
      <LicenseGate />
    </div>
  );
}
