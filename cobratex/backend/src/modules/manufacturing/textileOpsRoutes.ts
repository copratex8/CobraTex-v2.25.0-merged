import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileOpsService';
import * as sch from '@/modules/manufacturing/textileOpsSchemas';

export const textileOpsRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };

// الجدولة
textileOpsRouter.get('/textile/schedule', validate({ query: sch.scheduleQuerySchema }), h((r) => svc.scheduleBoard(r.ctx, r.query)));
textileOpsRouter.put('/textile/orders/:id/schedule', validate({ params: idParamSchema, body: sch.scheduleBodySchema }), h((r) => svc.scheduleOrder(r.ctx, id(r), r.body)));

// العمالة والحوافز
textileOpsRouter.get('/textile/workers', h((r) => svc.listWorkers(r.ctx)));
textileOpsRouter.post('/textile/workers', validate({ body: sch.workerBodySchema }), h((r) => svc.createWorker(r.ctx, r.body), 201));
textileOpsRouter.put('/textile/workers/:id', validate({ params: idParamSchema, body: sch.workerUpdateSchema }), h((r) => svc.updateWorker(r.ctx, id(r), r.body)));
textileOpsRouter.get('/textile/incentive-rates', h((r) => svc.listIncentiveRates(r.ctx)));
textileOpsRouter.post('/textile/incentive-rates', validate({ body: sch.incentiveRateBodySchema }), h((r) => svc.createIncentiveRate(r.ctx, r.body), 201));
textileOpsRouter.delete('/textile/incentive-rates/:id', validate({ params: idParamSchema }), h((r) => svc.deleteIncentiveRate(r.ctx, id(r))));
textileOpsRouter.post('/textile/worker-logs', validate({ body: sch.workerLogBodySchema }), h((r) => svc.addWorkerLog(r.ctx, r.body), 201));
textileOpsRouter.get('/textile/worker-logs', validate({ query: sch.rangeQuerySchema }), h((r) => svc.listWorkerLogs(r.ctx, r.query)));
textileOpsRouter.get('/textile/reports/incentives', validate({ query: sch.rangeQuerySchema }), h((r) => svc.incentiveReport(r.ctx, r.query)));

// الملصقات وأرصدة الهوالك
textileOpsRouter.get('/textile/labels', validate({ query: sch.labelQuerySchema }), h((r) => svc.labelsData(r.ctx, String(r.query.kind), String(r.query.ids).split(','))));
textileOpsRouter.get('/textile/reports/waste-stock', validate({ query: sch.rangeQuerySchema }), h((r) => svc.wasteStockReport(r.ctx, r.query)));
