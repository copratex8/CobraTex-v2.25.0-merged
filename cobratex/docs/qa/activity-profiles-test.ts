import * as am from '@/modules/platform/activityModules';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const CO = Z('0000000000c1');
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
const hit = (path: string, company: string | null = CO) => new Promise<{ next: boolean; status?: number; body?: any }>((resolve) => {
  const req: any = { path, headers: company ? { 'x-test-company': company } : {} };
  const res: any = { status(c: number) { this.s = c; return this; }, json(b: any) { resolve({ next: false, status: this.s, body: b }); } };
  am.moduleGuard(req, res, (e?: any) => resolve({ next: !e, ...(e ? { status: -1 } : {}) }));
});
(async () => {
  // قواعد المسارات
  ok(am.moduleForPath('/textile/blend-recipes/x') === 'blend' && am.moduleForPath('/textile/dyeing') === 'dyeing', 'path → module');
  ok(am.moduleForPath('/textile/reports/critical-orders') === 'planning' && am.moduleForPath('/textile/reports/profitability') === 'costing', 'specific report rules win over /textile');
  ok(am.moduleForPath('/textile/lots') === null && am.moduleForPath('/textile/reports/price-deviation') === null, 'commercial core (lots, price deviation) never gated');
  ok(am.moduleForPath('/textile/dashboard') === 'mfg_core' && am.moduleForPath('/manufacturing/orders') === 'mfg_core', 'generic textile/manufacturing → mfg_core');
  ok(am.moduleForPath('/sales/invoices') === null && am.moduleForPath('/fx/rates') === null && am.moduleForPath('/textile/blendX') === 'mfg_core', 'core untouched; prefix match is segment-exact');
  // لكل المسارات المسجَّلة وحدة معرَّفة
  ok(am.RULES.every(([, m]) => m === '' || am.MODULES.some((x) => x.key === m)), 'every rule points to a real module');
  // الملفات
  const all = am.effective('integrated', {}); ok(Object.values(all).every(Boolean), 'integrated = all modules');
  const tr = am.effective('trading', {}); ok(Object.values(tr).every((v) => !v), 'trading = no textile modules');
  const dy = am.effective('dyeing', {}); ok(dy.dyeing && dy.toll && dy.rolls_quality && !dy.weaving && !dy.fibers && !dy.blend, 'dyeing profile: dyeing/toll yes; weaving/fibers/blend no');
  const sp = am.effective('spinning', {}); ok(sp.fibers && sp.blend && !sp.dyeing && !sp.weaving, 'spinning profile');
  const wv = am.effective('weaving', {}); ok(wv.weaving && wv.blend && !wv.dyeing && !wv.fibers, 'weaving profile');
  const fn = am.effective('finishing', {}); ok(fn.rolls_quality && fn.toll && !fn.dyeing && !fn.weaving, 'finishing profile');
  const df = am.effective('dyeing_finishing', {}); ok(df.dyeing && df.rolls_quality && df.toll, 'dyeing+finishing');
  ok(am.effective('trading', { dyeing: true }).dyeing === false, 'no textile module survives without mfg_core (override ignored)');
  ok(am.effective('trading', { mfg_core: true, dyeing: true }).dyeing === true && am.effective('trading', { mfg_core: true }).weaving === false, 'override on: needs mfg_core, others stay off');
  ok(am.effective('weaving', { weaving: false }).weaving === false && am.effective('dyeing', { weaving: true }).weaving === true, 'overrides both directions');
  ok(am.PROFILES.every((p) => p.modules.every((m) => am.MODULES.some((x) => x.key === m))), 'profiles reference real modules');

  // قاعدة حقيقية
  ok((await am.getCompanyModules(CO)).profile === 'integrated', 'existing company defaults to integrated (nothing changes)');
  ok((await hit('/textile/dyeing/batches')).next === true, 'integrated: dyeing allowed');
  const r1 = await am.setCompanyActivity(CO, { profile: 'trading' });
  ok(r1.profile === 'trading' && r1.modules.mfg_core === false, 'set trading');
  ok((await q(`SELECT manufacturing_enabled FROM companies WHERE id=$1`, [CO])).rows[0].manufacturing_enabled === false, 'manufacturing_enabled synced to false');
  const b1 = await hit('/textile/dyeing/batches'); ok(b1.status === 403 && b1.body.code === 'MODULE_DISABLED' && b1.body.module === 'dyeing' && /الصباغة/.test(b1.body.error), 'trading: dyeing → 403 MODULE_DISABLED with Arabic name');
  ok((await hit('/manufacturing/orders')).status === 403, 'trading: manufacturing blocked');
  ok((await hit('/sales/invoices')).next === true && (await hit('/textile/lots')).next === true && (await hit('/textile/reports/price-deviation')).next === true, 'trading: sales + lots + price deviation open');
  ok((await hit('/textile/dyeing/x', null)).status === -1, 'no token on gated path → auth error (not leaked)');
  const r2 = await am.setCompanyActivity(CO, { profile: 'dyeing_finishing' });
  ok(r2.modules.dyeing && !r2.modules.weaving, 'switch to dyeing_finishing');
  ok((await hit('/textile/dyeing/batches')).next === true && (await hit('/textile/beams')).status === 403, 'guard follows profile (cache invalidated)');
  ok((await q(`SELECT manufacturing_enabled FROM companies WHERE id=$1`, [CO])).rows[0].manufacturing_enabled === true, 'manufacturing_enabled back to true');
  const r3 = await am.setCompanyActivity(CO, { overrides: { weaving: true, dyeing: false } });
  ok(r3.modules.weaving === true && r3.modules.dyeing === false && r3.profile === 'dyeing_finishing', 'overrides applied on top of the profile');
  ok((await hit('/textile/beams')).next === true && (await hit('/textile/dyeing/x')).status === 403, 'overrides enforced');
  const r4 = await am.setCompanyActivity(CO, { overrides: { weaving: null } }); ok(r4.modules.weaving === false && r4.modules.dyeing === false, 'null removes a single override');
  const r5 = await am.setCompanyActivity(CO, { profile: 'weaving' }); ok(r5.modules.dyeing === false && r5.modules.weaving === true && (await q(`SELECT 1 FROM company_modules`)).rows.length === 0, 'changing the profile resets overrides');
  await am.setCompanyActivity(CO, { profile: 'weaving', overrides: { dyeing: true } }); ok((await am.getCompanyModules(CO)).modules.dyeing === true, 'profile + overrides together keep the override');
  await am.setCompanyActivity(CO, { resetOverrides: true }); ok((await q(`SELECT 1 FROM company_modules`)).rows.length === 0, 'resetOverrides');
  await rej(() => am.setCompanyActivity(CO, { profile: 'zzz' }), /غير معروف/, 'unknown profile'); await rej(() => am.setCompanyActivity(CO, { overrides: { nope: true } }), /وحدة غير معروفة/, 'unknown module');
  await rej(() => am.setCompanyActivity(Z('0000000000ff'), { profile: 'trading' }), /غير موجودة/, 'unknown company');
  const ls = await am.listCompaniesActivity(); ok(ls.length >= 1 && ls[0].profile === 'weaving' && ls[0].modules.weaving === true, 'developer listing');
  ok((await q(`SELECT COUNT(*)::int AS n FROM platform_audit WHERE action='company.activity'`)).rows[0].n >= 7, 'every change audited in platform_audit');
  console.log(`ACTIVITY: ${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
