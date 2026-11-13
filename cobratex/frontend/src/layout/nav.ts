/**
 * خريطة التنقل — مجموعات على نسق شريط الهدى الجانبي (nav-group + nav-item)، وعناصرها هي نفس مسارات
 * جي تك بلا أي تغيير (المعرّفات والمسارات ثابتة). الإضافات تُلحَق ديناميكيًا (انظر AppLayout).
 */
export interface NavItem { to: string; label: string; icon: string; end?: boolean }
export interface NavGroup { id: string; label: string; items: NavItem[] }

export const NAV_GROUPS: NavGroup[] = [
  { id: 'main', label: 'الرئيسية', items: [{ to: '/', label: 'لوحة التحكم', icon: '📊', end: true }] },
  {
    id: 'sales',
    label: 'المبيعات',
    items: [
      { to: '/customers', label: 'العملاء', icon: '👥' },
      { to: '/sales/invoices', label: 'فواتير البيع', icon: '🧾' },
      { to: '/sales/payments', label: 'دفعات العملاء', icon: '💰' },
      { to: '/sales/returns', label: 'مرتجعات البيع', icon: '↩️' },
    ],
  },
  {
    id: 'purchasing',
    label: 'المشتريات',
    items: [
      { to: '/suppliers', label: 'الموردون', icon: '🏭' },
      { to: '/purchasing/receipts', label: 'استلامات المخزون', icon: '📥' },
      { to: '/purchasing/invoices', label: 'فواتير الشراء', icon: '🧾' },
      { to: '/purchasing/payments', label: 'دفعات الموردين', icon: '💸' },
      { to: '/purchasing/returns', label: 'مرتجعات الشراء', icon: '↪️' },
    ],
  },
  {
    id: 'inventory',
    label: 'المخزون والتصنيع',
    items: [
      { to: '/items', label: 'الأصناف', icon: '🏷️' },
      { to: '/inventory/stocktakes', label: 'الجرد المخزني', icon: '📋' },
      { to: '/manufacturing', label: 'التصنيع', icon: '⚙️' },
    ],
  },
  {
    id: 'textile',
    label: 'الغزل والنسيج',
    items: [
      { to: '/textile', label: 'لوحة المصنع', icon: '🧵', end: true },
      { to: '/textile/setup', label: 'المراحل والهوالك', icon: '♻️' },
      { to: '/textile/machines', label: 'الماكينات والورديات', icon: '🏭' },
      { to: '/textile/fibers', label: 'الألياف وخطط الخلط', icon: '🌱' },
      { to: '/textile/weaving', label: 'السدى والتعبئة', icon: '🧶' },
      { to: '/textile/dyeing', label: 'الصباغة', icon: '🎨' },
      { to: '/textile/rolls', label: 'فحص الرولات', icon: '📏' },
      { to: '/textile/toll', label: 'التشغيل للغير', icon: '🤝' },
      { to: '/textile/subcontract', label: 'التصنيع لدى الغير', icon: '🔁' },
      { to: '/textile/schedule', label: 'جدولة الإنتاج', icon: '🗓️' },
      { to: '/textile/sales-tracking', label: 'متابعة أوامر البيع', icon: '📦' },
      { to: '/textile/defects', label: 'العيوب وفحص الرولات', icon: '🔍' },
      { to: '/textile/specs', label: 'مواصفات الأصناف', icon: '🧵' },
      { to: '/textile/delivery', label: 'إذن التسليم', icon: '🚚' },
      { to: '/textile/utilities', label: 'المرافق', icon: '⚡' },
      { to: '/textile/blend', label: 'نسب الخيوط', icon: '🧶' },
      { to: '/textile/trace', label: 'تتبّع الدفعات', icon: '🔎' },
      { to: '/textile/claims', label: 'مطالبات العملاء', icon: '📣' },
      { to: '/textile/fabric-stock', label: 'مخزون الأقمشة', icon: '📦' },
      { to: '/textile/cost-card', label: 'بطاقة التكلفة', icon: '💰' },
      { to: '/textile/profitability', label: 'الربحية', icon: '📈' },
      { to: '/textile/lot-issue', label: 'صرف الخامات بالدفعة', icon: '🧶' },
      { to: '/textile/sales-payment', label: 'البيع حسب نوع الدفع', icon: '💳' },
      { to: '/textile/lots', label: 'اللوتات وكارت اللوط', icon: '🧾' },
      { to: '/textile/yarn-ledger', label: 'دفتر لوطات الخيوط والهالك', icon: '🧶' },
      { to: '/textile/price-deviation', label: 'انحراف الأسعار', icon: '⚖️' },
      { to: '/textile/critical', label: 'الأوامر الحرجة', icon: '🚨' },
      { to: '/textile/currencies', label: 'العملات والصرف', icon: '💱' },
      { to: '/textile/simulator', label: 'محاكي الاختناق', icon: '🧮' },
      { to: '/textile/attendance', label: 'الحضور والأجور', icon: '🕒' },
      { to: '/textile/payroll', label: 'كشف الرواتب', icon: '💵' },
      { to: '/textile/workforce', label: 'العمالة والحوافز', icon: '👷' },
      { to: '/textile/labels', label: 'ملصقات الباركود', icon: '🏷️' },
      { to: '/textile/quality', label: 'الجودة المعملية', icon: '🔬' },
      { to: '/textile/maintenance', label: 'الصيانة', icon: '🛠️' },
      { to: '/textile/production-reports', label: 'تقارير الإنتاج والتكلفة', icon: '📊' },
      { to: '/textile/cost-rates', label: 'معدّلات التحويل', icon: '💲' },
      { to: '/textile/reports', label: 'تقارير الغزل والنسيج', icon: '📉' },
      { to: '/textile/tools', label: 'حاسبات', icon: '🧮' },
    ],
  },
  {
    id: 'finance',
    label: 'المالية',
    items: [
      { to: '/treasury', label: 'الخزينة', icon: '🏦' },
      { to: '/accounting/closing', label: 'إقفال الفترات والسنة', icon: '🔒' },
      { to: '/accounting/wht', label: 'ضريبة الخصم والإضافة', icon: '🧾' },
      { to: '/landed-costs', label: 'التكاليف الإضافية', icon: '🚢' },
      { to: '/assets', label: 'الأصول الثابتة', icon: '🏭' },
      { to: '/reports', label: 'التقارير', icon: '📈' },
    ],
  },
  {
    id: 'system',
    label: 'النظام',
    items: [
      { to: '/notifications', label: 'الإشعارات', icon: '🔔' },
      { to: '/plugins', label: 'الإضافات', icon: '🔌' },
      { to: '/backup', label: 'النسخ الاحتياطي', icon: '💾' },
      { to: '/settings/users', label: 'المستخدمون والصلاحيات', icon: '🔐' },
      { to: '/settings', label: 'الإعدادات', icon: '⚙️', end: true },
    ],
  },
];

/** عنوان الصفحة للشريط العلوي: أطول مسار مطابق في الخريطة (الصفحات الفرعية ترث عنوان قسمها). */
export function titleForPath(pathname: string, groups: NavGroup[]): string | null {
  let best: { len: number; label: string } | null = null;
  for (const g of groups) {
    for (const item of g.items) {
      const match = item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(item.to + '/');
      if (match && (!best || item.to.length > best.len)) best = { len: item.to.length, label: item.label };
    }
  }
  return best?.label ?? null;
}
