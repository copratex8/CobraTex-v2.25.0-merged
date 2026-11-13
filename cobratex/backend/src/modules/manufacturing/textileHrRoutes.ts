import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileHrService';

export const textileHrRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };

textileHrRouter.put('/textile/workers/:id/pay', validate({ params: idParamSchema, body: svc.workerPaySchema }), h((r) => svc.updateWorkerPay(r.ctx, id(r), r.body)));
textileHrRouter.get('/textile/attendance', validate({ query: svc.attendanceQuerySchema }), h((r) => svc.listAttendance(r.ctx, r.query)));
textileHrRouter.post('/textile/attendance', validate({ body: svc.attendanceBulkSchema }), h((r) => svc.saveAttendance(r.ctx, r.body), 201));
textileHrRouter.get('/textile/adjustments', validate({ query: svc.adjQuerySchema }), h((r) => svc.listAdjustments(r.ctx, r.query)));
textileHrRouter.post('/textile/adjustments', validate({ body: svc.adjustmentSchema }), h((r) => svc.createAdjustment(r.ctx, r.body), 201));
textileHrRouter.delete('/textile/adjustments/:id', validate({ params: idParamSchema }), h((r) => svc.deleteAdjustment(r.ctx, id(r))));
textileHrRouter.get('/textile/payroll', h((r) => svc.listRuns(r.ctx)));
textileHrRouter.post('/textile/payroll', validate({ body: svc.runBodySchema }), h((r) => svc.createRun(r.ctx, r.body), 201));
textileHrRouter.get('/textile/payroll/:id', validate({ params: idParamSchema }), h((r) => svc.getRun(r.ctx, id(r))));
textileHrRouter.post('/textile/payroll/:id/recalculate', validate({ params: idParamSchema }), h((r) => svc.recalcRun(r.ctx, id(r))));
textileHrRouter.post('/textile/payroll/:id/approve', validate({ params: idParamSchema }), h((r) => svc.approveRun(r.ctx, id(r))));
textileHrRouter.post('/textile/payroll/:id/cancel', validate({ params: idParamSchema, body: svc.cancelRunSchema }), h((r) => svc.cancelRun(r.ctx, id(r), r.body.reason)));
textileHrRouter.get('/textile/payroll-settings', h((r) => svc.getPostingSettings(r.ctx)));
textileHrRouter.put('/textile/payroll-settings', validate({ body: svc.postingSettingsSchema }), h((r) => svc.updatePostingSettings(r.ctx, r.body)));
textileHrRouter.post('/textile/payroll/:id/post', validate({ params: idParamSchema, body: svc.postRunSchema }), h((r) => svc.postRun(r.ctx, id(r), r.body)));
textileHrRouter.post('/textile/payroll/:id/unpost', validate({ params: idParamSchema, body: svc.unpostRunSchema }), h((r) => svc.unpostRun(r.ctx, id(r), r.body.reason)));
textileHrRouter.post('/textile/payroll/:id/pay', validate({ params: idParamSchema, body: svc.payRunSchema }), h((r) => svc.payRun(r.ctx, id(r), r.body)));
textileHrRouter.post('/textile/payroll/:id/unpay', validate({ params: idParamSchema, body: svc.unpayRunSchema }), h((r) => svc.unpayRun(r.ctx, id(r), r.body)));
textileHrRouter.post('/textile/attendance/import', validate({ body: svc.importSchema }), h((r) => svc.importPunches(r.ctx, r.body)));
textileHrRouter.get('/textile/leave-balance', validate({ query: svc.leaveQuerySchema }), h((r) => svc.leaveBalance(r.ctx, r.query)));
