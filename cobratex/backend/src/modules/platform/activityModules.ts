import type { Request, Response, NextFunction } from 'express';
import { pool } from '@/db/pool';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { authMiddleware } from '@/middleware/authMiddleware';

/**
 * ملفات النشاط والوحدات (2.9.0): كل شركة لها «ملف نشاط» يحدّد الوحدات المتاحة (تصنيع، مبيعات فقط، صباغة، تجهيز، مراحل مختلفة…)،
 * ويتحكم المطوّر وحده بالملف وبتجاوز أي وحدة. الإنفاذ من الخادم (403 MODULE_DISABLED) لا إخفاء واجهة فقط.
 * النواة (مبيعات، مشتريات، مخزون، محاسبة، عملات، لوتات، انحراف أسعار) غير مقيَّدة في أي ملف.
 */
export interface ModuleDef { key: string; name: string; desc: string }
export const MODULES: ModuleDef[] = [
  { key: 'mfg_core', name: 'التصنيع الأساسي', desc: 'المراحل والماكينات وأوامر التصنيع وقوائم المواد والهوالك' },
  { key: 'planning', name: 'الجدولة والتخطيط', desc: 'جدولة الإنتاج والأوامر الحرجة وتخطيط المتطلبات' },
  { key: 'fibers', name: 'الألياف والخلط', desc: 'لوتات الألياف وخطط الخلط' },
  { key: 'blend', name: 'نسب الخيوط', desc: 'وصفات النسب لكل صنف وماكينة' },
  { key: 'weaving', name: 'السدى والأنوال', desc: 'عمود السدى والتحميل على الأنوال' },
  { key: 'dyeing', name: 'الصباغة', desc: 'دفعات الصباغة والوصفات والألوان' },
  { key: 'rolls_quality', name: 'الرولات والجودة', desc: 'فحص الرولات والعيوب والمعمل ومخزون الأقمشة' },
  { key: 'toll', name: 'التشغيل للغير', desc: 'أوامر تشغيل خامات العملاء' },
  { key: 'subcontract', name: 'التصنيع لدى الغير', desc: 'إرسال خامات لمصانع أخرى ومتابعة الخسارة' },
  { key: 'delivery', name: 'التسليم والتعبئة', desc: 'أذونات التسليم والتعبئة والملصقات' },
  { key: 'sales_link', name: 'ربط المبيعات بالإنتاج', desc: 'وعود التسليم ومتابعة أوامر البيع' },
  { key: 'costing', name: 'التكلفة والربحية', desc: 'بطاقة التكلفة ومعدلات التحويل وربحية العملاء' },
  { key: 'trace', name: 'التتبع', desc: 'تتبع الدفعات للأمام والخلف' },
  { key: 'claims', name: 'المطالبات والإشعارات الدائنة', desc: 'مطالبات الجودة وتسويتها' },
  { key: 'hr', name: 'العمالة والأجور', desc: 'الحضور والرواتب والحوافز' },
  { key: 'utilities', name: 'المرافق', desc: 'فواتير الكهرباء والمياه والغاز وتوزيعها' },
  { key: 'maintenance', name: 'الصيانة', desc: 'الصيانة الوقائية والأعطال' },
  { key: 'simulator', name: 'محاكي الاختناق', desc: 'تحليل الطاقة والاختناقات' },
];
const ALL = MODULES.map((m) => m.key);
const without = (...k: string[]) => ALL.filter((x) => !k.includes(x));
const SUPPORT = ['hr', 'utilities', 'maintenance', 'costing', 'planning', 'trace', 'claims', 'sales_link', 'delivery'];
export interface ProfileDef { code: string; name: string; desc: string; modules: string[] }
export const PROFILES: ProfileDef[] = [
  { code: 'integrated', name: 'مصنع متكامل (مراحل مختلفة)', desc: 'غزل ونسيج وصباغة وتجهيز — كل الوحدات', modules: ALL },
  { code: 'trading', name: 'مبيعات فقط (تجارة)', desc: 'بيع وشراء ومخزون ومحاسبة بلا تصنيع', modules: [] },
  { code: 'spinning', name: 'مصنع غزل', desc: 'ألياف وخلط ونسب خيوط', modules: ['mfg_core', 'fibers', 'blend', 'subcontract', 'rolls_quality', 'simulator', ...SUPPORT] },
  { code: 'weaving', name: 'مصنع نسيج', desc: 'سدى وأنوال ونسب ورولات', modules: ['mfg_core', 'blend', 'weaving', 'rolls_quality', 'subcontract', 'toll', 'simulator', ...SUPPORT] },
  { code: 'knitting', name: 'مصنع تريكو/حياكة', desc: 'ماكينات حياكة ونسب ورولات', modules: ['mfg_core', 'blend', 'rolls_quality', 'subcontract', 'toll', 'simulator', ...SUPPORT] },
  { code: 'dyeing', name: 'مصبغة', desc: 'صباغة وتشغيل للغير', modules: ['mfg_core', 'dyeing', 'toll', 'rolls_quality', 'subcontract', 'simulator', ...SUPPORT] },
  { code: 'finishing', name: 'تجهيز (تجهيز أقمشة)', desc: 'تجهيز وفحص رولات وتشغيل للغير', modules: ['mfg_core', 'rolls_quality', 'toll', 'subcontract', ...SUPPORT] },
  { code: 'dyeing_finishing', name: 'صباغة وتجهيز', desc: 'مصبغة وتجهيز معًا', modules: ['mfg_core', 'dyeing', 'toll', 'rolls_quality', 'subcontract', 'simulator', ...SUPPORT] },
  { code: 'custom', name: 'مخصَّص', desc: 'يحدّد المطوّر الوحدات واحدةً واحدة', modules: without('simulator') },
];
export const profileOf = (code: string) => PROFILES.find((p) => p.code === code);

/** أول بادئة مطابقة تحسم الوحدة (الأخصّ أولًا). مسار بلا قاعدة = نواة غير مقيَّدة. */
export const RULES: Array<[string, string]> = [
  ['/textile/reports/critical-orders', 'planning'], ['/textile/reports/profitability', 'costing'], ['/textile/reports/order-costs', 'costing'], ['/textile/reports/roll-stock', 'rolls_quality'],
  ['/textile/blend-recipes', 'blend'], ['/textile/fiber-lots', 'fibers'], ['/textile/mixing-plans', 'fibers'], ['/textile/beams', 'weaving'], ['/textile/dyeing', 'dyeing'],
  ['/textile/fabric-rolls', 'rolls_quality'], ['/textile/defect-types', 'rolls_quality'], ['/textile/rolls-with-defects', 'rolls_quality'], ['/textile/quality', 'rolls_quality'], ['/textile/convert', 'rolls_quality'],
  ['/textile/toll-jobs', 'toll'], ['/textile/subcontract-jobs', 'subcontract'],
  ['/textile/delivery-notes', 'delivery'], ['/textile/packing', 'delivery'], ['/textile/shippable', 'delivery'], ['/textile/labels', 'delivery'],
  ['/textile/sales-lines', 'sales_link'], ['/textile/sales-tracking', 'sales_link'],
  ['/textile/cost-rates', 'costing'], ['/textile/trace', 'trace'], ['/textile/material-lots', 'trace'],
  ['/textile/claims', 'claims'], ['/textile/credit-notes', 'claims'],
  ['/textile/payroll', 'hr'], ['/textile/attendance', 'hr'], ['/textile/leave-balance', 'hr'], ['/textile/workers', 'hr'], ['/textile/worker-logs', 'hr'], ['/textile/incentive-rates', 'hr'],
  ['/textile/utility-bills', 'utilities'], ['/textile/maintenance', 'maintenance'], ['/textile/simulator', 'simulator'],
  ['/textile/schedule', 'planning'], ['/textile/planning', 'planning'],
  ['/textile/lots', ''], ['/textile/reports/price-deviation', ''], ['/textile/reports/sales-by-payment', ''], // نواة تجارية: مفتوحة لكل الملفات
  ['/textile', 'mfg_core'], ['/manufacturing', 'mfg_core'],
];
export function moduleForPath(path: string): string | null {
  for (const [p, m] of RULES) if (path === p || path.startsWith(p + '/')) return m || null;
  return null;
}

export function effective(profile: string, overrides: Record<string, boolean>): Record<string, boolean> {
  const base = new Set(profileOf(profile)?.modules ?? ALL);
  const out: Record<string, boolean> = {};
  for (const k of ALL) out[k] = k in overrides ? overrides[k] : base.has(k);
  if (!out.mfg_core) for (const k of ALL) if (k !== 'mfg_core') out[k] = false; // لا وحدة تصنيعية بلا التصنيع الأساسي
  return out;
}

type Entry = { profile: string; modules: Record<string, boolean>; at: number };
const cache = new Map<string, Entry>();
export const invalidateModuleCache = (companyId?: string) => (companyId ? cache.delete(companyId) : cache.clear());

export async function getCompanyModules(companyId: string): Promise<Omit<Entry, 'at'>> {
  const hit = cache.get(companyId); if (hit && Date.now() - hit.at < 30_000) return hit;
  const c = (await pool.query(`SELECT activity_profile FROM companies WHERE id=$1`, [companyId])).rows[0];
  if (!c) throw new NotFoundError('الشركة غير موجودة');
  const ov: Record<string, boolean> = {};
  for (const r of (await pool.query(`SELECT module_key, enabled FROM company_modules WHERE company_id=$1`, [companyId])).rows) ov[r.module_key] = r.enabled;
  const e = { profile: c.activity_profile as string, modules: effective(c.activity_profile, ov), at: Date.now() };
  cache.set(companyId, e); return e;
}

/** يُنفَّذ من لوحة المطوّر: يضبط الملف وتجاوزات الوحدات (null يزيل التجاوز) ويزامن manufacturing_enabled مع الوحدة الأساسية. */
export async function setCompanyActivity(companyId: string, input: { profile?: string; overrides?: Record<string, boolean | null>; resetOverrides?: boolean }) {
  const co = (await pool.query(`SELECT id FROM companies WHERE id=$1`, [companyId])).rows[0];
  if (!co) throw new NotFoundError('الشركة غير موجودة');
  if (input.profile !== undefined && !profileOf(input.profile)) throw new ValidationError(`ملف نشاط غير معروف: ${input.profile}`);
  for (const k of Object.keys(input.overrides ?? {})) if (!ALL.includes(k)) throw new ValidationError(`وحدة غير معروفة: ${k}`);
  if (input.profile !== undefined) await pool.query(`UPDATE companies SET activity_profile=$2 WHERE id=$1`, [companyId, input.profile]);
  if (input.resetOverrides || (input.profile !== undefined && input.overrides === undefined)) await pool.query(`DELETE FROM company_modules WHERE company_id=$1`, [companyId]); // تغيير الملف يعيد التجاوزات لافتراضه ما لم تُرسَل صراحةً
  for (const [k, v] of Object.entries(input.overrides ?? {})) {
    if (v === null) await pool.query(`DELETE FROM company_modules WHERE company_id=$1 AND module_key=$2`, [companyId, k]);
    else await pool.query(`INSERT INTO company_modules(company_id,module_key,enabled) VALUES ($1,$2,$3) ON CONFLICT (company_id,module_key) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [companyId, k, v]);
  }
  invalidateModuleCache(companyId);
  const eff = await getCompanyModules(companyId);
  await pool.query(`UPDATE companies SET manufacturing_enabled=$2 WHERE id=$1`, [companyId, eff.modules.mfg_core]);
  await pool.query(`INSERT INTO platform_audit(action, detail) VALUES ('company.activity', $1)`, [JSON.stringify({ companyId, profile: eff.profile, enabled: Object.keys(eff.modules).filter((k) => eff.modules[k]).length, overrides: input.overrides ?? null })]);
  return { companyId, ...eff };
}

export async function listCompaniesActivity() {
  const cos = (await pool.query(`SELECT c.id, c.display_name, c.activity_profile, c.tenant_id, t.name AS tenant_name FROM companies c JOIN tenants t ON t.id=c.tenant_id ORDER BY c.created_at DESC`)).rows;
  const ovs = (await pool.query(`SELECT company_id, module_key, enabled FROM company_modules`)).rows;
  return cos.map((c) => { const ov: Record<string, boolean> = {}; for (const r of ovs) if (r.company_id === c.id) ov[r.module_key] = r.enabled;
    return { companyId: c.id, name: c.display_name, tenant: c.tenant_name, profile: c.activity_profile, overrides: ov, modules: effective(c.activity_profile, ov) }; });
}

/** حارس الوحدات: يمرّ كل ما لا قاعدة له. عطل القراءة يفتح الباب (كحارس المنصة) كي لا تُعطِّل الطبقة الخدمة. */
export function moduleGuard(req: Request, res: Response, next: NextFunction) {
  const mod = moduleForPath(req.path); if (!mod) return next();
  authMiddleware(req, res, async (err?: unknown) => {
    if (err) return next(err);
    try {
      const m = await getCompanyModules(req.ctx.companyId);
      if (m.modules[mod]) return next();
      const def = MODULES.find((x) => x.key === mod);
      return res.status(403).json({ error: `وحدة «${def?.name ?? mod}» غير متاحة في نشاط شركتك. للتفعيل تواصل مع مزوّد الخدمة.`, code: 'MODULE_DISABLED', module: mod });
    } catch { return next(); }
  });
}
