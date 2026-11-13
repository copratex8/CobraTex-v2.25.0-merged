import { pool } from '@/db/pool';
import { provisionTenant } from '@/modules/tenancy/provisioning';
import { login } from '@/modules/identity/identityService';
import * as B from '@/modules/platform/brandingService';
import * as L from '@/modules/platform/licenseService';
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown> | unknown, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // 1) sanitizeBrand
  const s1: any = B.sanitizeBrand({ appName: ' مصنع النور ', developer: { name: 'hack', showCredit: false }, theme: { navy: '#112233', evil: 'red' }, logoUrl: '/brand/x.png', extra: 1, tagline: '' });
  ok(s1.appName === 'مصنع النور', 'trim'); ok(s1.developer === undefined && s1.extra === undefined, 'unknown/developer keys dropped');
  ok(s1.theme.navy === '#112233' && s1.theme.evil === undefined, 'theme whitelisted'); ok(s1.tagline === undefined, 'empty skipped');
  await rej(() => B.sanitizeBrand({ logoUrl: 'javascript:alert(1)' }), /https/, 'javascript: rejected');
  await rej(() => B.sanitizeBrand({ logoUrl: 'http://x.com/a.png' }), /https/, 'http rejected');
  await rej(() => B.sanitizeBrand({ logoUrl: '//evil.com/a.png' }), /https/, 'protocol-relative rejected');
  await rej(() => B.sanitizeBrand({ logoFullUrl: 'data:image/png;base64,AAAA' }), /https/, 'data: rejected');
  await rej(() => B.sanitizeBrand({ theme: { navy: 'red' } }), /#RRGGBB/, 'bad color');
  await rej(() => B.sanitizeBrand({ appName: 5 }), /نصًا/, 'non-string');
  await rej(() => B.sanitizeBrand([1]), /كائنًا/, 'array rejected');
  ok(B.sanitizeBrand({ logoUrl: 'https://cdn.x.com/l.png' }).logoUrl === 'https://cdn.x.com/l.png', 'https ok');
  ok(B.normHost('https://App.Client.com:8443/x') === 'app.client.com', 'normHost');
  await rej(() => B.normHost('not a host'), /غير صالح/, 'bad host');
  // 2) إنشاء عميلين كاملين
  const a = await provisionTenant({ tenantName: 'عميل أ', companyLegalName: 'شركة أ', ownerEmail: 'owner-a@x.com', ownerPassword: 'Passw0rd!aa' });
  const b = await provisionTenant({ tenantName: 'عميل ب', companyLegalName: 'شركة ب', ownerEmail: 'owner-b@x.com', ownerPassword: 'Passw0rd!bb' });
  ok(!!a.tenantId && !!b.tenantId && a.tenantId !== b.tenantId, 'two tenants provisioned');
  const accs = await q(`SELECT count(*)::int AS n FROM accounts WHERE company_id = $1`, [a.companyId]); ok(accs.rows[0].n >= 12, 'chart of accounts seeded: ' + accs.rows[0].n);
  const rules = await q(`SELECT count(*)::int AS n FROM posting_rules WHERE company_id = $1`, [a.companyId]); ok(rules.rows[0].n >= 17, 'posting rules seeded: ' + rules.rows[0].n);
  const sess = await login('owner-a@x.com', 'Passw0rd!aa', a.tenantId); ok(!!sess.accessToken, 'owner can login');
  // 3) الهوية والنطاقات
  const r1 = await B.setBranding(a.tenantId, { slug: 'Acme-Co', brand: { appName: 'أكمي', theme: { gold: '#aabbcc' } }, domains: ['https://ERP.Acme.com', 'erp.acme.com', 'acme.localhost'] });
  ok(r1.slug === 'acme-co' && r1.domains.length === 2, 'branding saved/normalized: ' + JSON.stringify(r1.domains));
  await B.setBranding(b.tenantId, { slug: 'beta', brand: { appName: 'بيتا' }, domains: ['erp.beta.com'] });
  await rej(() => B.setBranding(b.tenantId, { slug: 'acme-co' }), /مستخدم لعميل آخر/, 'duplicate slug rejected');
  await rej(() => B.setBranding(b.tenantId, { slug: 'zz-ok', domains: ['erp.acme.com'] }), /مستخدم لعميل آخر/, 'duplicate domain rejected');
  const still = await B.getBranding(b.tenantId); ok(still.slug === 'beta' && still.domains[0] === 'erp.beta.com', 'failed update left tenant B unchanged (atomic?): ' + JSON.stringify(still));
  await rej(() => B.setBranding(a.tenantId, { slug: 'A' }), /الرمز القصير/, 'bad slug');
  await rej(() => B.setBranding('00000000-0000-4000-8000-0000000000ff', { slug: 'nobody' }), /غير موجود/, 'unknown tenant');
  // 4) الحل (resolve)
  const byHost: any = await B.resolveBrand({ host: 'ERP.acme.com' }); ok(byHost?.tenantId === a.tenantId && byHost.brand.appName === 'أكمي', 'resolve by host');
  const bySlug: any = await B.resolveBrand({ slug: 'beta' }); ok(bySlug?.tenantId === b.tenantId && bySlug.brand.appName === 'بيتا', 'resolve by slug');
  const byId: any = await B.resolveBrand({ tenantId: a.tenantId }); ok(byId?.tenantId === a.tenantId, 'resolve by id');
  const pri: any = await B.resolveBrand({ host: 'erp.beta.com', slug: 'acme-co', tenantId: a.tenantId }); ok(pri?.tenantId === b.tenantId, 'host has priority over slug and id');
  ok((await B.resolveBrand({ host: 'unknown.com' })) === null, 'unknown host → null');
  ok((await B.resolveBrand({ slug: "x'; drop table tenants;--" })) === null, 'hostile slug → null (no error)');
  ok((await B.resolveBrand({ tenantId: 'not-a-uuid' })) === null, 'bad uuid → null');
  const leak: any = await B.resolveBrand({ slug: 'acme-co' }); ok(Object.keys(leak).sort().join() === 'brand,tenantId', 'only tenantId+brand exposed');
  // عميل بلا هوية مخصصة
  const c = await provisionTenant({ tenantName: 'عميل ج', companyLegalName: 'شركة ج', ownerEmail: 'owner-c@x.com', ownerPassword: 'Passw0rd!cc' });
  const bc: any = await B.resolveBrand({ tenantId: c.tenantId }); ok(bc?.tenantId === c.tenantId && Object.keys(bc.brand).length === 0, 'tenant without branding → empty brand');
  // 5) المستخدمون
  const users = await B.listTenantUsers(a.tenantId); ok(users.length === 1 && users[0].email === 'owner-a@x.com', 'list tenant users (isolated)');
  const uid = users[0].id;
  await rej(() => B.resetUserPassword(a.tenantId, uid, 'short'), /8 أحرف/, 'short password rejected');
  await rej(() => B.resetUserPassword(b.tenantId, uid), /غير موجود/, 'cannot reset another tenant\'s user');
  const rp = await B.resetUserPassword(a.tenantId, uid); ok(rp.password.length >= 12, 'generated password');
  await rej(() => login('owner-a@x.com', 'Passw0rd!aa', a.tenantId), /غير صحيحة/, 'old password no longer works');
  ok(!!(await login('owner-a@x.com', rp.password, a.tenantId)).accessToken, 'new password works');
  const sess2 = await login('owner-a@x.com', rp.password, a.tenantId);
  await B.resetUserPassword(a.tenantId, uid, 'Another!Pass1');
  const live = await q(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [uid]); ok(live.rows[0].n === 0, 'all sessions revoked on reset');
  ok(!!sess2.accessToken, 'sanity');
  await B.setUserActive(a.tenantId, uid, false);
  await rej(() => login('owner-a@x.com', 'Another!Pass1', a.tenantId), /معطَّل/, 'disabled user cannot login');
  await B.setUserActive(a.tenantId, uid, true); ok(!!(await login('owner-a@x.com', 'Another!Pass1', a.tenantId)).accessToken, 're-enabled login');
  ok(B.generatePassword().length === 14 && B.generatePassword() !== B.generatePassword(), 'password generator random');
  // 6) تكامل مع الترخيص: عميل جديد بحد مستخدمين
  await L.upsertLicense(c.tenantId, { planType: 'annual', maxUsers: 1 });
  ok((await L.usage(c.tenantId)).users === 1, 'new tenant usage = 1 user');
  const pa = await q(`SELECT count(*)::int AS n FROM platform_audit WHERE action IN ('brand.set','user.reset_password','user.set_active','license.set')`); ok(pa.rows[0].n >= 6, 'platform audit rows written: ' + pa.rows[0].n);
  // تنظيف
  for (const t of [a.tenantId, b.tenantId, c.tenantId]) await q(`SELECT 1`);
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
