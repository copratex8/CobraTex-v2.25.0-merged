import jwt from 'jsonwebtoken';
import { pool } from '@/db/pool';
import { config } from '@/config';
import { licenseGuard } from '@/modules/platform/platformGuard';
import * as L from '@/modules/platform/licenseService';
import { createUser } from '@/modules/identity/identityService';
import { createBranch } from '@/modules/tenancy/tenancyService';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const T = Z('0000000000a1'), C = Z('0000000000c1');
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
const NOW = new Date('2026-11-07T12:00:00Z'); const d = (days: number) => new Date(NOW.getTime() + days * 86400000);
const mk = (o: Partial<L.License> = {}): L.License => ({ tenantId: T, planType: 'annual', startsAt: d(-100), expiresAt: d(10), graceDays: 7, expiredMode: 'readonly', bindingMode: 'none', allowedDomains: [], maxDevices: null, maxUsers: null, maxBranches: null, notes: '', ...o });
const M = (o: Partial<L.RequestMeta> = {}): L.RequestMeta => ({ method: 'GET', path: '/items', origin: null, deviceId: null, ...o });
const DEV = (n: number) => 'device-' + String(n).padStart(12, '0');
// طلب/رد وهميان للحارس
async function guard(headers: Record<string, string>, method = 'GET', path = '/items') {
  const token = jwt.sign({ tenantId: T }, config.jwtAccessSecret);
  const h: Record<string, string> = { authorization: 'Bearer ' + token, ...headers };
  const req: any = { path, method, headers: h, body: {}, get: (k: string) => h[k.toLowerCase()] };
  const out: any = { status: 200, body: null, headers: {} };
  const res: any = { status(s: number) { out.status = s; return res; }, json(b: any) { out.body = b; return res; }, set(k: string, v: string) { out.headers[k] = v; return res; } };
  let nexted = false; await licenseGuard(req, res, () => { nexted = true; }); return { ...out, nexted };
}
(async () => {
  await q(`DELETE FROM tenant_licenses`); await q(`DELETE FROM license_devices`);
  // 1) التقييم
  ok(L.evaluateLicense(mk({ expiresAt: null, planType: 'perpetual' }), NOW).state === 'active', 'perpetual active');
  const e1 = L.evaluateLicense(mk(), NOW); ok(e1.state === 'active' && e1.daysLeft === 10, 'annual 10 days left');
  ok(L.evaluateLicense(mk({ expiresAt: d(-3) }), NOW).state === 'grace', 'expired 3d ago = grace(7)');
  ok(L.evaluateLicense(mk({ expiresAt: d(-8) }), NOW).state === 'expired', 'expired 8d ago = expired');
  ok(L.evaluateLicense(mk({ expiresAt: d(-7), graceDays: 7 }), NOW).state === 'grace', 'exactly at grace end still grace');
  ok(L.evaluateLicense(mk({ startsAt: d(2) }), NOW).state === 'not_started', 'not started');
  ok(L.evaluateLicense(mk({ expiresAt: d(-1), graceDays: 0 }), NOW).state === 'expired', 'grace 0 → expired at once');
  // 2) القرار
  ok(L.decide(null, M(), NOW).allow === true, 'no license → allow (legacy)');
  const nl = L.decide(null, M(), NOW, true); ok(!nl.allow && (nl as any).code === 'LICENSE_REQUIRED' && (nl as any).status === 402, 'required & none → 402');
  const exp = mk({ expiresAt: d(-30) });
  ok(L.decide(exp, M({ method: 'GET' }), NOW).allow === true, 'expired readonly: GET ok');
  const w = L.decide(exp, M({ method: 'POST', path: '/sales/invoices' }), NOW); ok(!w.allow && (w as any).code === 'LICENSE_EXPIRED', 'expired readonly: POST blocked');
  ok(L.decide(exp, M({ method: 'POST', path: '/auth/login' }), NOW).allow === true, 'expired readonly: login allowed');
  ok(L.decide(exp, M({ method: 'DELETE', path: '/items/1' }), NOW).allow === false, 'expired readonly: DELETE blocked');
  const bl = L.decide(mk({ expiresAt: d(-30), expiredMode: 'block' }), M(), NOW); ok(!bl.allow && (bl as any).code === 'LICENSE_EXPIRED', 'expired block: GET blocked');
  ok(!L.decide(mk({ expiresAt: d(-30), expiredMode: 'block' }), M({ method: 'POST', path: '/auth/login' }), NOW).allow, 'expired block: login blocked');
  ok(L.decide(mk({ expiresAt: d(-3) }), M({ method: 'POST', path: '/sales/invoices' }), NOW).allow === true, 'grace: full access');
  ok(!L.decide(mk({ startsAt: d(1) }), M(), NOW).allow, 'not started blocked');
  const dom = mk({ bindingMode: 'domain', allowedDomains: ['app.example.com', '*.corp.com'] });
  ok(L.decide(dom, M({ origin: 'https://app.example.com' }), NOW).allow, 'domain exact ok');
  ok(L.decide(dom, M({ origin: 'https://x.y.corp.com/path' }), NOW).allow, 'domain wildcard ok');
  ok(L.decide(dom, M({ origin: 'https://corp.com' }), NOW).allow, 'wildcard matches apex');
  const bad = L.decide(dom, M({ origin: 'https://evil.com' }), NOW); ok(!bad.allow && (bad as any).code === 'LICENSE_DOMAIN' && (bad as any).status === 403, 'foreign domain blocked');
  ok(!L.decide(dom, M({ origin: 'https://notcorp.com' }), NOW).allow, 'suffix trick blocked');
  ok(!L.decide(dom, M({ origin: 'https://app.example.com.evil.com' }), NOW).allow, 'prefix trick blocked');
  ok(L.decide(dom, M({ origin: null }), NOW).allow, 'domain: no origin → allowed (documented limitation)');
  const dv = L.decide(mk({ bindingMode: 'device' }), M(), NOW); ok(!dv.allow && (dv as any).code === 'LICENSE_DEVICE_REQUIRED', 'device mode w/o id blocked');
  const dv2 = L.decide(mk({ bindingMode: 'device' }), M({ deviceId: DEV(1) }), NOW); ok(dv2.allow && (dv2 as any).needsDevice === true, 'device mode with id needs registration');
  // 3) upsert
  await rej(() => L.upsertLicense(T, { planType: 'weird' }), /trial/, 'bad plan');
  await rej(() => L.upsertLicense(T, { planType: 'custom' }), /تاريخ انتهاء/, 'custom needs expiry');
  await rej(() => L.upsertLicense(T, { planType: 'annual', bindingMode: 'domain' }), /نطاق/, 'domain mode needs domains');
  await rej(() => L.upsertLicense(T, { planType: 'annual', bindingMode: 'domain', allowedDomains: ['bad domain!'] }), /غير صالح/, 'bad domain');
  await rej(() => L.upsertLicense(T, { planType: 'annual', expiresAt: '2020-01-01', startsAt: '2026-01-01' }), /يلي/, 'expiry before start');
  await rej(() => L.upsertLicense(T, { planType: 'annual', graceDays: 999 }), /السماح/, 'grace range');
  await rej(() => L.upsertLicense(T, { planType: 'annual', maxUsers: 0 }), /موجب/, 'maxUsers>0');
  await rej(() => L.upsertLicense(Z('999'), { planType: 'annual' }), /غير موجود/, 'unknown tenant');
  const tr = await L.upsertLicense(T, { planType: 'trial' }, NOW); ok(Math.round((tr.expiresAt!.getTime() - NOW.getTime()) / 86400000) === 14, 'trial = 14 days');
  const mo = await L.upsertLicense(T, { planType: 'monthly' }, NOW); ok(mo.expiresAt!.toISOString().startsWith('2026-12-07'), 'monthly = +1 month');
  const an = await L.upsertLicense(T, { planType: 'annual' }, NOW); ok(an.expiresAt!.toISOString().startsWith('2027-11-07'), 'annual = +12 months');
  const pe = await L.upsertLicense(T, { planType: 'perpetual', expiresAt: '2030-01-01' }, NOW); ok(pe.expiresAt === null, 'perpetual ignores expiry');
  const dm = await L.upsertLicense(T, { planType: 'annual', bindingMode: 'domain_device', allowedDomains: ['https://App.Example.com:8080/x', 'app.example.com', '*.Corp.com'], notes: 'n' }, NOW);
  ok(dm.allowedDomains.length === 2 && dm.allowedDomains[0] === 'app.example.com' && dm.allowedDomains[1] === '*.corp.com', 'domains normalized + deduped: ' + dm.allowedDomains);
  ok(dm.maxDevices === 3, 'device binding default maxDevices=3');
  // 4) تمديد
  await L.upsertLicense(T, { planType: 'custom', expiresAt: d(10).toISOString(), startsAt: d(-5).toISOString() }, NOW);
  const ex1 = await L.extendLicense(T, 'months', 1, NOW); ok(ex1.expiresAt!.toISOString().startsWith('2026-12-17'), 'extend from future expiry: ' + ex1.expiresAt!.toISOString());
  await q(`UPDATE tenant_licenses SET expires_at = $1 WHERE tenant_id = $2`, [d(-90), T]); L.invalidateLicenseCache();
  const ex2 = await L.extendLicense(T, 'days', 30, new Date()); ok(ex2.expiresAt!.getTime() > Date.now() + 29 * 86400000 && ex2.expiresAt!.getTime() < Date.now() + 31 * 86400000, 'extend from now when expired');
  await rej(() => L.extendLicense(T, 'weeks', 1), /الوحدة/, 'bad unit'); await rej(() => L.extendLicense(T, 'days', 0), /موجب/, 'bad amount');
  await L.upsertLicense(T, { planType: 'perpetual' }, NOW); await rej(() => L.extendLicense(T, 'days', 5), /الدائم/, 'perpetual no extend');
  // 5) الأجهزة
  await L.upsertLicense(T, { planType: 'perpetual', bindingMode: 'device', maxDevices: 3 }, NOW);
  for (let i = 1; i <= 3; i++) ok((await L.registerDevice(T, DEV(i), 'UA', 3)) === null, 'device ' + i + ' registers');
  const lim = await L.registerDevice(T, DEV(4), 'UA', 3); ok(lim?.code === 'LICENSE_DEVICE_LIMIT', '4th device rejected');
  ok((await L.registerDevice(T, DEV(2), 'UA', 3)) === null, 'known device re-register ok');
  ok((await L.registerDevice(T, 'short', 'UA', 3))?.code === 'LICENSE_DEVICE_REQUIRED', 'invalid device id rejected');
  await L.setDeviceRevoked(T, DEV(1), true);
  ok((await L.registerDevice(T, DEV(1), 'UA', 3))?.code === 'LICENSE_DEVICE_REVOKED', 'revoked device rejected');
  ok((await L.registerDevice(T, DEV(4), 'UA', 3)) === null, 'revoking frees a slot');
  await L.removeDevice(T, DEV(4)); await L.renameDevice(T, DEV(2), 'مكتب المحاسبة');
  ok((await L.listDevices(T)).find((x: any) => x.device_id === DEV(2))?.label === 'مكتب المحاسبة', 'rename device');
  await q(`DELETE FROM license_devices`);
  const par = await Promise.all(Array.from({ length: 8 }, (_, i) => L.registerDevice(T, DEV(50 + i), 'UA', 3)));
  ok(par.filter((x) => x === null).length === 3, 'parallel registration never exceeds limit: ' + par.filter((x) => x === null).length);
  await q(`DELETE FROM license_devices`);
  // 6) الحارس (طلبات كاملة)
  await L.upsertLicense(T, { planType: 'annual', bindingMode: 'domain_device', allowedDomains: ['app.example.com'], maxDevices: 2 }, new Date());
  const g1 = await guard({ origin: 'https://app.example.com', 'x-device-id': DEV(1) }); ok(g1.nexted && g1.headers['X-License-State']?.startsWith('active'), 'guard: valid → next + header');
  const g2 = await guard({ origin: 'https://evil.com', 'x-device-id': DEV(1) }); ok(!g2.nexted && g2.status === 403 && g2.body.code === 'LICENSE_DOMAIN', 'guard: foreign domain 403');
  const g3 = await guard({ origin: 'https://app.example.com' }); ok(!g3.nexted && g3.body.code === 'LICENSE_DEVICE_REQUIRED', 'guard: no device id');
  await guard({ origin: 'https://app.example.com', 'x-device-id': DEV(2) });
  const g4 = await guard({ origin: 'https://app.example.com', 'x-device-id': DEV(3) }); ok(!g4.nexted && g4.body.code === 'LICENSE_DEVICE_LIMIT', 'guard: third device rejected');
  await q(`UPDATE tenant_licenses SET expires_at = now() - interval '60 days', binding_mode='none'`); L.invalidateLicenseCache();
  const g5 = await guard({}, 'POST', '/sales/invoices'); ok(!g5.nexted && g5.status === 402 && g5.body.code === 'LICENSE_EXPIRED', 'guard: expired POST 402');
  const g6 = await guard({}, 'GET', '/sales/invoices'); ok(g6.nexted, 'guard: expired GET allowed (readonly)');
  const g7 = await guard({}, 'GET', '/public/status'); ok(g7.nexted, 'guard: public path exempt');
  // 7) الحدود
  await L.upsertLicense(T, { planType: 'perpetual', maxUsers: 2, maxBranches: 1 }, new Date(Date.now() - 1000));
  const base = await createUser({ tenantId: T, companyId: C, fullName: 'أساسي', email: 'lic-base@t.com', password: 'Passw0rd!x' }); ok(!!base.id, 'first user within limit');
  const u0 = await L.usage(T); ok(u0.users >= 1, 'usage works: ' + JSON.stringify(u0));
  await q(`UPDATE tenant_licenses SET max_users = $1, max_branches = $2`, [Math.max(1, u0.users), Math.max(1, u0.branches)]); L.invalidateLicenseCache();
  await rej(() => createUser({ tenantId: T, companyId: C, fullName: 'x', email: 'lic-x@t.com', password: 'Passw0rd!x' }), /الحد الأقصى للمستخدمين/, 'user seat limit');
  await rej(() => createBranch(C, 'فرع', 'Br'), /الحد الأقصى للفروع/, 'branch seat limit');
  try { await createUser({ tenantId: T, companyId: C, fullName: 'x', email: 'lic-y@t.com', password: 'Passw0rd!x' }); } catch (e: any) { ok(e.code === 'LICENSE_LIMIT' && e.status === 402, 'limit error carries code+402'); }
  await q(`UPDATE tenant_licenses SET max_users = $1, max_branches = $2`, [u0.users + 5, u0.branches + 5]); L.invalidateLicenseCache();
  const nu = await createUser({ tenantId: T, companyId: C, fullName: 'مستخدم جديد', email: 'lic-ok@t.com', password: 'Passw0rd!x' }); ok(!!nu.id, 'under limit: user created');
  const nb = await createBranch(C, 'فرع جديد', 'New'); ok(!!nb.id, 'under limit: branch created');
  await q(`UPDATE users SET is_active=false WHERE id=$1`, [nu.id]); ok((await L.usage(T)).users === u0.users, 'inactive users not counted');
  // 8) عرض
  const list = await L.listLicenses(); const mine = list.find((x: any) => x.tenantId === T); ok(!!mine && mine.license?.planType === 'perpetual' && mine.state === 'active', 'listLicenses row');
  const ps: any = await L.publicSummary(T); ok(ps.licensed === true && ps.state === 'active', 'publicSummary');
  await L.deleteLicense(T); ok((await L.getLicense(T)) === null, 'deleteLicense'); ok((await L.publicSummary(T) as any).licensed === false, 'summary after delete');
  const g8 = await guard({}, 'POST', '/sales/invoices'); ok(g8.nexted, 'no license → unrestricted');
  await q(`DELETE FROM users WHERE email LIKE 'lic-%'`); await q(`DELETE FROM branches WHERE id = $1`, [nb.id]);
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
