import { pool } from '@/db/pool';
import { provisionTenant } from '@/modules/tenancy/provisioning';
import { login } from '@/modules/identity/identityService';
import { verifyAccessToken } from '@/shared/auth';
import { RequestContext } from '@/shared/requestContext';
import { matchesMagic } from '@/modules/system/attachmentService';
import { createUom } from '@/modules/items/itemService';
import { resolveUnitPrice } from '@/modules/sales/priceListService';
import * as A from '@/modules/identity/userAdminService';
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown> | unknown, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // بصمة المرفقات
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), jpg = Buffer.from('ffd8ffe000104a464946', 'hex');
  ok(matchesMagic('image/png', png) && matchesMagic('image/jpeg', jpg), 'real png/jpg accepted');
  ok(matchesMagic('application/pdf', Buffer.from('%PDF-1.7\n')) && matchesMagic('image/gif', Buffer.from('GIF89a....')), 'pdf/gif accepted');
  ok(matchesMagic('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp accepted');
  ok(!matchesMagic('image/png', Buffer.from('<html><script>alert(1)</script>')), 'html labelled png rejected');
  ok(!matchesMagic('image/png', jpg) && !matchesMagic('application/pdf', png) && !matchesMagic('text/html', Buffer.from('x')), 'mismatch/unknown rejected');
  ok(!matchesMagic('image/png', Buffer.alloc(0)), 'empty rejected');
  // الصلاحيات
  const a = await provisionTenant({ tenantName: 'أ', companyLegalName: 'شركة أ', ownerEmail: 'Owner@A.com', ownerPassword: 'Passw0rd!aa' });
  const ctxOf = async (e: string, p: string) => new RequestContext(verifyAccessToken((await login(e, p, a.tenantId)).accessToken));
  const owner = await ctxOf('Owner@A.com', 'Passw0rd!aa');
  ok(!!(await createUom(owner, 'كيلو', 'Kilo', 'kg')).id, 'owner can create uom');
  await rej(() => createUom(owner, '', 'x', 'y'), /مطلوب/, 'empty uom name rejected');
  await rej(() => createUom(owner, 'x'.repeat(61), 'x', 'y'), /مطلوب/, 'oversized uom rejected');
  const br = (await q(`SELECT id FROM branches WHERE company_id=$1`, [a.companyId])).rows[0].id;
  const perms = await A.listPermissions(owner); const viewer = perms.templates.find((t) => t.id === 'viewer')!;
  const role = await A.createRole(owner, { name: 'قارئ', scope: 'own_branch', permissionCodes: viewer.codes });
  await A.createUser(owner, { fullName: 'قارئ', email: 'v@a.com', password: 'Pass1234', roleIds: [role.id], branchIds: [br], allBranches: false });
  const v = await ctxOf('v@a.com', 'Pass1234');
  await rej(() => createUom(v, 'متر', 'm', 'm'), /صلاحية/, 'viewer cannot create uom');
  await rej(() => resolveUnitPrice(v, { itemId: '00000000-0000-4000-8000-000000000001', quantity: 1 } as any), /صلاحية/, 'viewer cannot price-lookup');
  // تسجيل الدخول
  ok(!!(await login('owner@a.com', 'Passw0rd!aa', a.tenantId)).accessToken, 'login is case-insensitive on email');
  ok(!!(await login('  owner@a.com ', 'Passw0rd!aa', a.tenantId)).accessToken, 'email trimmed');
  await rej(() => login('nobody@a.com', 'Passw0rd!aa', a.tenantId), /غير صحيحة/, 'unknown user generic error');
  await rej(() => login('v@a.com', 'wrong', a.tenantId), /غير صحيحة/, 'wrong password generic');
  await rej(() => login(['v@a.com'] as any, 'Pass1234', a.tenantId), /غير صحيحة/, 'non-string email rejected');
  await rej(() => login('v@a.com', 'x'.repeat(500), a.tenantId), /غير صحيحة/, 'huge password rejected early');
  const vid = (await q(`SELECT id FROM users WHERE email='v@a.com'`)).rows[0].id;
  await A.updateUser(owner, vid, { isActive: false });
  await rej(() => login('v@a.com', 'wrong', a.tenantId), /غير صحيحة/, 'disabled + wrong password → no status leak');
  await rej(() => login('v@a.com', 'Pass1234', a.tenantId), /معطَّل/, 'disabled + right password → disabled');
  // سياسة كلمات المرور
  await rej(() => A.validatePassword('ab1'), /8 أحرف/, 'short password');
  await rej(() => A.validatePassword('a1' + 'ي'.repeat(40)), /72/, 'over 72 bytes rejected (bcrypt truncation)');
  ok(A.validatePassword('كلمة12345') === 'كلمة12345', 'arabic password allowed');
  console.log(`\nsecurity: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
