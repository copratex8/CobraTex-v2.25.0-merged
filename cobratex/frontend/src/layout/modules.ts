import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { NavGroup } from '@/layout/nav';

/** وحدات الشركة الفعّالة (يحدّدها المطوّر حسب نشاطها). الخادم هو المُنفِّذ؛ هنا إخفاء للقائمة فقط. */
export interface ModulesInfo { profile: string; profileName: string; modules: Record<string, boolean>; rules: Array<[string, string]> }

export function useModules() {
  return useQuery({ queryKey: ['modules-me'], queryFn: async () => (await apiClient.get<ModulesInfo>('/modules/me')).data, staleTime: 60_000, retry: false });
}

/** مسارات الواجهة ← الوحدة (مسارات الواجهة تختلف عن مسارات الخادم). مسار بلا قاعدة أو بقاعدة فارغة = نواة غير مقيَّدة. */
export const UI_RULES: Array<[string, string]> = [
  ['/textile/fibers', 'fibers'], ['/textile/weaving', 'weaving'], ['/textile/dyeing', 'dyeing'], ['/textile/rolls', 'rolls_quality'], ['/textile/defects', 'rolls_quality'], ['/textile/fabric-stock', 'rolls_quality'], ['/textile/quality', 'rolls_quality'],
  ['/textile/toll', 'toll'], ['/textile/subcontract', 'subcontract'], ['/textile/schedule', 'planning'], ['/textile/critical', 'planning'], ['/textile/sales-tracking', 'sales_link'],
  ['/textile/delivery', 'delivery'], ['/textile/labels', 'delivery'], ['/textile/utilities', 'utilities'], ['/textile/blend', 'blend'], ['/textile/trace', 'trace'], ['/textile/claims', 'claims'],
  ['/textile/cost-card', 'costing'], ['/textile/profitability', 'costing'], ['/textile/cost-rates', 'costing'], ['/textile/production-reports', 'costing'], ['/textile/simulator', 'simulator'],
  ['/textile/attendance', 'hr'], ['/textile/payroll', 'hr'], ['/textile/workforce', 'hr'], ['/textile/maintenance', 'maintenance'],
  ['/textile/lots', ''], ['/textile/price-deviation', ''], ['/textile/sales-payment', ''], ['/textile/currencies', ''],
  ['/textile', 'mfg_core'], ['/manufacturing', 'mfg_core'],
];

/** أول بادئة مطابقة (مقطعًا كاملًا). */
export function moduleForPath(path: string, rules: Array<[string, string]>): string | null {
  for (const [p, m] of rules) if (path === p || path.startsWith(p + '/')) return m || null;
  return null;
}

/** يزيل عناصر القائمة التي وحدتها معطَّلة، وأي مجموعة فرغت. عند غياب المعلومة (خطأ/تحميل) لا يُخفى شيء. */
export function filterNav(groups: NavGroup[], info: ModulesInfo | undefined): NavGroup[] {
  if (!info) return groups;
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => { const m = moduleForPath(i.to, UI_RULES); return !m || info.modules?.[m] !== false; }) })).filter((g) => g.items.length > 0);
}

/** مسار القائمة ← كود الصلاحية المطلوب لرؤيته. المسار غير المذكور يظهر دائمًا (الخادم يمنع الوصول الفعلي). */
export const NAV_PERMS: Array<[string, string]> = [
  ['/customers', 'sales.customer.view'], ['/sales/invoices', 'sales.invoice.view'], ['/sales/payments', 'sales.payment.view'], ['/sales/returns', 'sales.return.view'],
  ['/suppliers', 'purchasing.supplier.view'], ['/purchasing/receipts', 'purchasing.receipt.view'], ['/purchasing/invoices', 'purchasing.invoice.view'], ['/purchasing/payments', 'purchasing.payment.view'], ['/purchasing/returns', 'purchasing.return.view'],
  ['/items', 'items.item.view'], ['/inventory/stocktakes', 'inventory.stocktake.view'], ['/manufacturing', 'manufacturing.order.view'],
  ['/treasury', 'treasury.safe.view'], ['/accounting/closing', 'accounting.fiscal_period.view'], ['/accounting/wht', 'wht.view'], ['/landed-costs', 'landed.view'], ['/assets', 'assets.view'],
  ['/textile/fibers', 'textile.fiber.view'], ['/textile/dyeing', 'textile.dyeing.view'], ['/textile/lots', 'textile.lots.view'], ['/textile/payroll', 'textile.payroll.view'], ['/textile/attendance', 'textile.hr.view'], ['/textile/maintenance', 'textile.maintenance.view'], ['/textile/quality', 'textile.quality.view'],
  ['/settings/users', 'admin.users.manage'],
];

/** يخفي عناصر القائمة التي لا يملك المستخدم صلاحية عرضها. عند غياب الصلاحيات من التوكن (جلسة قديمة) لا يُخفى شيء. */
export function filterNavByPerms(groups: NavGroup[], can: (code: string) => boolean, hasPerms: boolean): NavGroup[] {
  if (!hasPerms) return groups;
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => { const r = NAV_PERMS.find(([p]) => i.to === p || i.to.startsWith(p + '/')); return !r || can(r[1]); }) })).filter((g) => g.items.length > 0);
}
