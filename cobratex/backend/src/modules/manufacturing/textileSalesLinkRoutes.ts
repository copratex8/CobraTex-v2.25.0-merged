import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileSalesLinkService';
import * as sch from '@/modules/manufacturing/textileSalesLinkSchemas';

export const textileSalesLinkRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };

textileSalesLinkRouter.get('/textile/sales-tracking', validate({ query: sch.trackingQuerySchema }), h((r) => svc.tracking(r.ctx, r.query)));
textileSalesLinkRouter.put('/textile/sales-lines/:id/promise', validate({ params: idParamSchema, body: sch.promiseBodySchema }), h((r) => svc.setPromise(r.ctx, id(r), r.body)));
textileSalesLinkRouter.get('/textile/sales-lines/:id/promise-history', validate({ params: idParamSchema }), h((r) => svc.promiseHistory(r.ctx, id(r))));
textileSalesLinkRouter.post('/textile/sales-lines/:id/link-order', validate({ params: idParamSchema, body: sch.linkBodySchema }), h((r) => svc.linkOrder(r.ctx, id(r), r.body.productionOrderId)));
textileSalesLinkRouter.post('/textile/sales-lines/:id/create-order', validate({ params: idParamSchema, body: sch.createFromLineBodySchema }), h((r) => svc.createFromLine(r.ctx, id(r), r.body), 201));
textileSalesLinkRouter.delete('/textile/orders/:id/sales-link', validate({ params: idParamSchema }), h((r) => svc.unlinkOrder(r.ctx, id(r))));
