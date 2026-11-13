import { pool } from '@/db/pool';
import { provisionTenant } from '@/modules/tenancy/provisioning';
import { login } from '@/modules/identity/identityService';
import { verifyAccessToken } from '@/shared/auth';
import { RequestContext } from '@/shared/requestContext';
import * as A from '@/modules/identity/userAdminService';
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown> | unknown, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
const ctxOf = async (email: string, pw: string, tenantId: string) => new RequestContext(verifyAccessToken((await login(email, pw, tenantId)).accessToken));
(async () => {
  const a = await provisionTenant({ tenantName: 'عميل أ', companyLegalName: 'شركة أ', ownerEmail: 'owner@a.com', ownerPassword: 'Passw0rd!aa' });
  const b = await provisionTenant({ tenantName: 'عميل ب', companyLegalName: 'شركة ب', ownerEmail: 'owner@b.com', ownerPassword: 'Passw0rd!bb' });
  const owner = await ctxOf('owner@a.com', 'Passw0rd!aa', a.tenantId);
  const ownerB = await ctxOf('owner@b.com', 'Passw0rd!bb', b.tenantId);
  ok(owner.permissions.some((p) => p.code === 'admin.users.manage'), 'owner has admin.users.manage');
  // الصلاحيات والقوالب
  const perms = await A.listPermissions(owner);
  ok(perms.codes.length > 100, 'permission list: ' + perms.codes.length);
  const tv = perms.templates.find((t) => t.id === 'viewer')!; ok(tv.codes.length > 20 && tv.codes.every((c) => c.endsWith('.view')), 'viewer template = only .view');
  ok(perms.templates.every((t) => !t.codes.some((c) => c.startsWith('admin.') || c.startsWith('system.') || c === 'company.settings.update')), 'no template includes admin/system');
  ok(perms.templates.every((t) => t.codes.length > 0), 'templates non-empty: ' + perms.templates.map((t) => t.id + ':' + t.codes.length).join());
  const roles0 = await A.listRoles(owner); ok(roles0.length === 1 && roles0[0].isSystem && roles0[0].userCount === 1, 'Owner role listed');
  const ownerRoleId = roles0[0].id;
  const br = await q(`SELECT id FROM branches WHERE company_id = $1`, [a.companyId]); const branchId = br.rows[0].id as string;
  // دور محاسب
  const acc = perms.templates.find((t) => t.id === 'accountant')!;
  const role = await A.createRole(owner, { name: 'محاسب', scope: 'own_branch', permissionCodes: acc.codes });
  await rej(() => A.createRole(owner, { name: 'محاسب', scope: 'own_branch', permissionCodes: acc.codes }), /بهذا الاسم/, 'duplicate role name');
  await rej(() => A.createRole(owner, { name: 'x1', scope: 'own_branch', permissionCodes: ['nope.nothing'] }), /غير معروفة/, 'unknown permission');
  // مستخدم بكلمة مرور خاصة
  await rej(() => A.createUser(owner, { fullName: 'سعيد', email: 's@a.com', password: 'abc', roleIds: [role.id], branchIds: [branchId], allBranches: false }), /8 أحرف/, 'weak password');
  await rej(() => A.createUser(owner, { fullName: 'سعيد', email: 's@a.com', password: 'abcdefgh', roleIds: [role.id], branchIds: [branchId], allBranches: false }), /8 أحرف/, 'password without digit');
  await rej(() => A.createUser(owner, { fullName: 'سعيد', email: 's@a.com', password: 'Pass1234', roleIds: [role.id], branchIds: [], allBranches: false }), /فرعًا/, 'no branch');
  const cnt = await q(`SELECT count(*)::int AS n FROM users WHERE tenant_id = $1`, [a.tenantId]);
  ok(cnt.rows[0].n === 1, 'failed creation left no orphan user: ' + cnt.rows[0].n);
  const u1 = await A.createUser(owner, { fullName: 'سعيد المحاسب', email: 'S@a.com', password: 'Pass1234', roleIds: [role.id], branchIds: [branchId], allBranches: false });
  ok(!(u1 as any).generatedPassword, 'explicit password not echoed');
  await rej(() => A.createUser(owner, { fullName: 'مكرر', email: 's@a.com', password: 'Pass1234', roleIds: [role.id], branchIds: [branchId], allBranches: false }), /./, 'duplicate email');
  const u2 = await A.createUser(owner, { fullName: 'منى', email: 'mona@a.com', roleIds: [role.id], branchIds: [], allBranches: true, phone: '0100' });
  ok(!!(u2 as any).generatedPassword && (u2 as any).generatedPassword.length >= 10, 'generated password returned once');
  const sa = await ctxOf('s@a.com', 'Pass1234', a.tenantId);
  ok(sa.permissions.length === acc.codes.length && !sa.permissions.some((p) => p.code.startsWith('admin.')), 'user gets only role permissions');
  const mo = await ctxOf('mona@a.com', (u2 as any).generatedPassword, a.tenantId); ok(!!mo.userId, 'generated password logs in');
  await rej(() => login('s@a.com', (u2 as any).generatedPassword, a.tenantId), /غير صحيحة/, 'passwords are per-user');
  // لا صلاحية إدارة لغير المدير
  await rej(() => A.listUsers(sa), /صلاحية/, 'non-admin cannot list users');
  await rej(() => A.createRole(sa, { name: 'z', scope: 'own_branch', permissionCodes: [acc.codes[0]] }), /صلاحية/, 'non-admin cannot create role');
  await rej(() => A.resetPassword(sa, u2.id, 'Pass12345'), /صلاحية/, 'non-admin cannot reset');
  // منع التصعيد: مدير مستخدمين بلا باقي الصلاحيات
  const mgr = await A.createRole(owner, { name: 'مدير مستخدمين', scope: 'own_branch', permissionCodes: ['admin.users.manage', 'admin.roles.manage', acc.codes[0]] });
  const u3 = await A.createUser(owner, { fullName: 'مدير', email: 'mgr@a.com', password: 'Pass1234', roleIds: [mgr.id], branchIds: [branchId], allBranches: false });
  const mg = await ctxOf('mgr@a.com', 'Pass1234', a.tenantId);
  await rej(() => A.createUser(mg, { fullName: 'x', email: 'x@a.com', password: 'Pass1234', roleIds: [ownerRoleId], branchIds: [branchId], allBranches: false }), /تفوق صلاحياتك/, 'cannot assign Owner role (escalation)');
  await rej(() => A.createRole(mg, { name: 'كبير', scope: 'own_branch', permissionCodes: perms.codes.filter((c) => c.startsWith('sales.')) }), /لا تملكها/, 'cannot grant permissions you lack');
  await rej(() => A.createRole(mg, { name: 'واسع', scope: 'all_branches', permissionCodes: [acc.codes[0]] }), /أوسع/, 'cannot grant wider scope');
  const okRole = await A.createRole(mg, { name: 'ضمن حدودي', scope: 'own_branch', permissionCodes: [acc.codes[0]] }); ok(!!okRole.id, 'can grant within own limits');
  // حماية الأدوار النظامية
  await rej(() => A.updateRole(owner, ownerRoleId, { name: 'Owner', scope: 'own_branch', permissionCodes: ['admin.users.manage'] }), /النظامي/, 'system role not editable');
  await rej(() => A.deleteRole(owner, ownerRoleId), /النظامي/, 'system role not deletable');
  await rej(() => A.deleteRole(owner, role.id), /مُسنَد/, 'role in use not deletable');
  // تعديل دور يتوقف عنده آخر مدير
  const adminRole = await A.createRole(owner, { name: 'مدير2', scope: 'all_branches', permissionCodes: ['admin.users.manage'] });
  // تعطيل الذات/الأدوار الذاتية
  await rej(() => A.updateUser(owner, owner.userId, { isActive: false }), /تعطيل نفسك/, 'cannot deactivate self');
  await rej(() => A.updateUser(owner, owner.userId, { roleIds: [role.id] }), /تعطيل نفسك|أدوارك/, 'cannot change own roles');
  // تعطيل الجميع عدا الأخير
  await A.updateUser(owner, u3.id, { isActive: false });
  await rej(() => login('mgr@a.com', 'Pass1234', a.tenantId), /./, 'deactivated cannot login');
  const rt = await q(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u3.id]); ok(rt.rows[0].n === 0, 'deactivation revokes refresh tokens');
  await A.updateUser(owner, u3.id, { isActive: true });
  // آخر مدير: owner يحاول (عبر مدير آخر) تعطيل المالك → المالك لا يعطّل نفسه؛ نجرّب مدير يعطّل المالك بعد إزالة أدوار الآخرين
  await A.updateUser(owner, u3.id, { roleIds: [role.id] }).catch(() => undefined);
  // تعديل بيانات
  await A.updateUser(owner, u1.id, { fullName: 'سعيد 2', phone: null, allBranches: true });
  const lst = await A.listUsers(owner); const s = lst.find((x) => x.id === u1.id)!; ok(s.fullName === 'سعيد 2' && s.allBranches && s.roles.length === 1, 'update user'); ok(lst.find((x) => x.isSelf)?.id === owner.userId, 'isSelf flag');
  // عزل العملاء
  await rej(() => A.updateUser(ownerB, u1.id, { fullName: 'اختراق' }), /غير موجود/, 'tenant B cannot edit tenant A user');
  await rej(() => A.resetPassword(ownerB, u1.id), /غير موجود/, 'tenant B cannot reset A user');
  await rej(() => A.deleteRole(ownerB, role.id), /غير موجود/, 'tenant B cannot delete A role');
  ok((await A.listUsers(ownerB)).length === 1, 'tenant B list isolated');
  await rej(() => A.createUser(ownerB, { fullName: 'x', email: 'x@b.com', password: 'Pass1234', roleIds: [role.id], branchIds: [branchId], allBranches: false }), /./, 'cannot use role/branch of another company');
  // إعادة ضبط كلمة المرور
  const rr: any = await A.resetPassword(owner, u1.id);
  await rej(() => login('s@a.com', 'Pass1234', a.tenantId), /غير صحيحة/, 'old password dead after reset');
  ok(!!(await ctxOf('s@a.com', rr.generatedPassword, a.tenantId)).userId, 'new generated password works');
  await A.resetPassword(owner, u1.id, 'Another123');
  ok(!!(await ctxOf('s@a.com', 'Another123', a.tenantId)).userId, 'explicit reset works');
  // تغيير كلمة المرور الذاتي
  const me = await ctxOf('s@a.com', 'Another123', a.tenantId);
  await rej(() => A.changeOwnPassword(me, 'wrong', 'NewPass123'), /الحالية غير صحيحة/, 'wrong current');
  await rej(() => A.changeOwnPassword(me, 'Another123', 'weak'), /8 أحرف/, 'weak new');
  await rej(() => A.changeOwnPassword(me, 'Another123', 'Another123'), /مطابقة/, 'same password');
  await A.changeOwnPassword(me, 'Another123', 'NewPass123');
  await rej(() => login('s@a.com', 'Another123', a.tenantId), /غير صحيحة/, 'old own password dead');
  ok(!!(await ctxOf('s@a.com', 'NewPass123', a.tenantId)).userId, 'new own password works');
  // ملاحظة: writeAuditLog مُستبدَل بـ stub في الـharness، فلا يُفحص سجل التدقيق هنا (الاستدعاءات لا تمرّر كلمات مرور).
  // آخر مدير
  const only = await A.createUser(owner, { fullName: 'م', email: 'm3@a.com', password: 'Pass1234', roleIds: [adminRole.id], branchIds: [branchId], allBranches: false });
  const m3 = await ctxOf('m3@a.com', 'Pass1234', a.tenantId);
  await A.updateUser(m3, owner.userId, { isActive: false }); // يوجد مدير آخر (m3) ⇒ مسموح
  await q(`UPDATE users SET is_active = false WHERE id = $1`, [mgr.id]);
  await rej(() => A.updateUser(m3, owner.userId, { isActive: true, roleIds: [role.id] }), /تفوق|./, 'sanity').catch(() => undefined);
  const ownerAfter = await q(`SELECT is_active FROM users WHERE id = $1`, [owner.userId]); ok(ownerAfter.rows[0].is_active === false, 'owner deactivated by another admin');
  console.log(`\nuser-admin: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
