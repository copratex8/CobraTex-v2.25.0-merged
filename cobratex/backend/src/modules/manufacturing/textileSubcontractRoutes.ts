import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileSubcontractService';
import * as sch from '@/modules/manufacturing/textileSubcontractSchemas';

export const textileSubcontractRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };

textileSubcontractRouter.get('/textile/subcontract-jobs', validate({ query: sch.subcontractListQuerySchema }), h((r) => svc.listSubcontractJobs(r.ctx, r.query)));
textileSubcontractRouter.post('/textile/subcontract-jobs', validate({ body: sch.subcontractJobBodySchema }), h((r) => svc.createSubcontractJob(r.ctx, r.body), 201));
textileSubcontractRouter.get('/textile/subcontract-jobs/:id', validate({ params: idParamSchema }), h((r) => svc.getSubcontractJob(r.ctx, id(r))));
textileSubcontractRouter.post('/textile/subcontract-jobs/:id/movements', validate({ params: idParamSchema, body: sch.subcontractMovementSchema }), h((r) => svc.addSubcontractMovement(r.ctx, id(r), r.body), 201));
textileSubcontractRouter.post('/textile/subcontract-jobs/:id/close', validate({ params: idParamSchema, body: sch.emptyBodySchema }), h((r) => svc.closeSubcontractJob(r.ctx, id(r))));
