import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileMillService';
import * as sch from '@/modules/manufacturing/textileMillSchemas';

export const textileMillRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
const q = (req: { query: Record<string, unknown> }) => req.query as Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };
const idv = { params: idParamSchema };

// ألياف وخلط
textileMillRouter.get('/textile/fiber-lots', validate({ query: sch.fiberListQuerySchema }), h((r) => svc.listFiberLots(r.ctx, q(r))));
textileMillRouter.post('/textile/fiber-lots', validate({ body: sch.fiberLotBodySchema }), h((r) => svc.createFiberLot(r.ctx, r.body), 201));
textileMillRouter.put('/textile/fiber-lots/:id', validate({ ...idv, body: sch.fiberLotUpdateSchema }), h((r) => svc.updateFiberLot(r.ctx, id(r), r.body)));
textileMillRouter.get('/textile/mixing-plans', h((r) => svc.listMixingPlans(r.ctx)));
textileMillRouter.post('/textile/mixing-plans', validate({ body: sch.mixingPlanBodySchema }), h((r) => svc.createMixingPlan(r.ctx, r.body), 201));
textileMillRouter.get('/textile/mixing-plans/:id', validate(idv), h((r) => svc.getMixingPlan(r.ctx, id(r))));
textileMillRouter.post('/textile/mixing-plans/:id/approve', validate({ ...idv, body: sch.mixingApproveSchema }), h((r) => svc.approveMixingPlan(r.ctx, id(r))));

// صباغة
textileMillRouter.get('/textile/dyeing/shades', h((r) => svc.listShades(r.ctx)));
textileMillRouter.post('/textile/dyeing/shades', validate({ body: sch.shadeBodySchema }), h((r) => svc.createShade(r.ctx, r.body), 201));
textileMillRouter.put('/textile/dyeing/shades/:id', validate({ ...idv, body: sch.shadeUpdateSchema }), h((r) => svc.updateShade(r.ctx, id(r), r.body)));
textileMillRouter.get('/textile/dyeing/recipes', h((r) => svc.listRecipes(r.ctx)));
textileMillRouter.post('/textile/dyeing/recipes', validate({ body: sch.recipeBodySchema }), h((r) => svc.createRecipe(r.ctx, r.body), 201));
textileMillRouter.get('/textile/dyeing/batches', validate({ query: sch.rangeSchema }), h((r) => svc.listDyeBatches(r.ctx, q(r))));
textileMillRouter.post('/textile/dyeing/batches', validate({ body: sch.dyeBatchBodySchema }), h((r) => svc.createDyeBatch(r.ctx, r.body), 201));
textileMillRouter.put('/textile/dyeing/batches/:id/result', validate({ ...idv, body: sch.dyeBatchResultSchema }), h((r) => svc.updateDyeBatchResult(r.ctx, id(r), r.body)));
textileMillRouter.get('/textile/dyeing/batches/:id/requirements', validate(idv), h((r) => svc.dyeBatchRequirements(r.ctx, id(r))));
textileMillRouter.get('/textile/reports/dyeing', validate({ query: sch.rangeSchema }), h((r) => svc.reportDyeing(r.ctx, q(r))));

// تشغيل للغير
textileMillRouter.get('/textile/toll-jobs', validate({ query: sch.tollListQuerySchema }), h((r) => svc.listTollJobs(r.ctx, q(r))));
textileMillRouter.post('/textile/toll-jobs', validate({ body: sch.tollJobBodySchema }), h((r) => svc.createTollJob(r.ctx, r.body), 201));
textileMillRouter.get('/textile/toll-jobs/:id', validate(idv), h((r) => svc.getTollJob(r.ctx, id(r))));
textileMillRouter.post('/textile/toll-jobs/:id/movements', validate({ ...idv, body: sch.tollMovementBodySchema }), h((r) => svc.addTollMovement(r.ctx, id(r), r.body), 201));
textileMillRouter.post('/textile/toll-jobs/:id/close', validate({ ...idv, body: sch.mixingApproveSchema }), h((r) => svc.closeTollJob(r.ctx, id(r))));

// معدّلات تكلفة التحويل
textileMillRouter.get('/textile/cost-rates', h((r) => svc.listCostRates(r.ctx)));
textileMillRouter.post('/textile/cost-rates', validate({ body: sch.costRateBodySchema }), h((r) => svc.upsertCostRate(r.ctx, r.body), 201));
textileMillRouter.delete('/textile/cost-rates/:id', validate(idv), h((r) => svc.deactivateCostRate(r.ctx, id(r))));
textileMillRouter.get('/textile/orders/:id/conversion-suggestion', validate(idv), h((r) => svc.suggestOrderConversion(r.ctx, id(r))));
textileMillRouter.post('/textile/orders/:id/apply-conversion-rates', validate({ ...idv, body: sch.mixingApproveSchema }), h((r) => svc.applyOrderConversion(r.ctx, id(r))));

// تقارير وأدوات
textileMillRouter.get('/textile/reports/daily-production', validate({ query: sch.rangeSchema }), h((r) => svc.reportDailyProduction(r.ctx, q(r))));
textileMillRouter.get('/textile/tools/commercial-weight', validate({ query: sch.commercialWeightQuerySchema }), h((r) => svc.commercialWeightTool(r.query)));
