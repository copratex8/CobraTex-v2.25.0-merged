import { Router } from 'express';
import { z } from 'zod';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/identity/userAdminService';

export const userAdminRouter = Router();
const hh = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** هوية المستخدم الحالي وصلاحياته (تستعملها الواجهة في وضع Supabase Auth حيث لا تحمل التوكنات قائمة الصلاحيات). */
userAdminRouter.get('/auth/me', hh((r) => svc.me(r.ctx)));
userAdminRouter.get('/admin/users', hh((r) => svc.listUsers(r.ctx)));
userAdminRouter.post('/admin/users', validate({ body: svc.userCreateSchema }), hh((r) => svc.createUser(r.ctx, r.body), 201));
userAdminRouter.patch('/admin/users/:id', validate({ params: idParamSchema, body: svc.userUpdateSchema }), hh((r) => svc.updateUser(r.ctx, String(r.params.id), r.body)));
userAdminRouter.post('/admin/users/:id/reset-password', validate({ params: idParamSchema, body: z.object({ password: z.string().max(128).optional() }) }), hh((r) => svc.resetPassword(r.ctx, String(r.params.id), r.body.password)));
userAdminRouter.get('/admin/permissions', hh((r) => svc.listPermissions(r.ctx)));
userAdminRouter.get('/admin/roles', hh((r) => svc.listRoles(r.ctx)));
userAdminRouter.post('/admin/roles', validate({ body: svc.roleSchema }), hh((r) => svc.createRole(r.ctx, r.body), 201));
userAdminRouter.put('/admin/roles/:id', validate({ params: idParamSchema, body: svc.roleSchema }), hh((r) => svc.updateRole(r.ctx, String(r.params.id), r.body)));
userAdminRouter.delete('/admin/roles/:id', validate({ params: idParamSchema }), hh(async (r) => { await svc.deleteRole(r.ctx, String(r.params.id)); return { ok: true }; }));
/** أي مستخدم مصادَق يغيّر كلمة مروره بنفسه (لا يتطلب صلاحية إدارية). */
userAdminRouter.post('/me/password', validate({ body: z.object({ currentPassword: z.string().max(128), newPassword: z.string().max(128) }) }), hh((r) => svc.changeOwnPassword(r.ctx, r.body.currentPassword, r.body.newPassword)));
