import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileUtilitiesService';

export const textileUtilitiesRouter = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };
textileUtilitiesRouter.get('/textile/utility-bills', validate({ query: svc.utilityQuerySchema }), h((r) => svc.listBills(r.ctx, r.query)));
textileUtilitiesRouter.post('/textile/utility-bills', validate({ body: svc.utilityBillSchema }), h((r) => svc.createBill(r.ctx, r.body), 201));
textileUtilitiesRouter.delete('/textile/utility-bills/:id', validate({ params: idParamSchema }), h((r) => svc.deleteBill(r.ctx, String(r.params.id))));
textileUtilitiesRouter.get('/textile/reports/utility-allocation', validate({ query: svc.utilityQuerySchema }), h((r) => svc.allocationReport(r.ctx, r.query)));
