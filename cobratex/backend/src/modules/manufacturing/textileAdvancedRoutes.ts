import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileAdvancedService';
import * as sch from '@/modules/manufacturing/textileAdvancedSchemas';
import { loomMetersPerHour, twistMultiplier } from '@/modules/manufacturing/textileCosting';

export const textileAdvancedRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
const q = (req: { query: Record<string, unknown> }) => req.query as Record<string, string | undefined>;
const h = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };

// بيمات السدى
textileAdvancedRouter.get('/textile/beams', validate({ query: sch.beamListQuerySchema }), h((r) => svc.listBeams(r.ctx, q(r))));
textileAdvancedRouter.post('/textile/beams', validate({ body: sch.beamBodySchema }), h((r) => svc.createBeam(r.ctx, r.body), 201));
textileAdvancedRouter.post('/textile/beams/:id/mount', validate({ params: idParamSchema, body: sch.beamMountSchema }), h((r) => svc.mountBeam(r.ctx, id(r), r.body.machineId)));
textileAdvancedRouter.post('/textile/beams/:id/progress', validate({ params: idParamSchema, body: sch.beamProgressSchema }), h((r) => svc.addBeamProgress(r.ctx, id(r), r.body.meters)));
textileAdvancedRouter.post('/textile/beams/:id/scrap', validate({ params: idParamSchema, body: sch.beamScrapSchema }), h((r) => svc.scrapBeam(r.ctx, id(r), r.body.reason)));

// التعبئة
textileAdvancedRouter.get('/textile/packing', validate({ query: sch.packingListQuerySchema }), h((r) => svc.listPackingUnits(r.ctx, q(r))));
textileAdvancedRouter.post('/textile/packing', validate({ body: sch.packingBodySchema }), h((r) => svc.createPackingUnits(r.ctx, r.body), 201));
textileAdvancedRouter.post('/textile/packing/ship', validate({ body: sch.packingShipSchema }), h((r) => svc.shipPackingUnits(r.ctx, r.body.ids)));

// تقارير وتخطيط
textileAdvancedRouter.get('/textile/reports/material-balance', validate({ query: sch.rangeSchema }), h((r) => svc.reportMaterialBalance(r.ctx, q(r))));
textileAdvancedRouter.get('/textile/reports/oee', validate({ query: sch.rangeSchema }), h((r) => svc.reportOee(r.ctx, q(r))));
textileAdvancedRouter.get('/textile/reports/cost-variance', validate({ query: sch.rangeSchema }), h((r) => svc.reportCostVariance(r.ctx, q(r))));
textileAdvancedRouter.get('/textile/boms/:id/cost', validate({ params: idParamSchema, query: sch.bomCostQuerySchema }), h((r) => svc.bomCost(r.ctx, id(r), q(r).warehouseId)));
textileAdvancedRouter.post('/textile/planning/requirements', validate({ body: sch.mrpBodySchema }), h((r) => svc.planRequirements(r.ctx, r.body)));

// حاسبات
textileAdvancedRouter.post('/textile/tools/loom-output', validate({ body: sch.loomBodySchema }), h(async (r) => ({ metersPerHour: Number(loomMetersPerHour(r.body.rpm, r.body.ppi, r.body.efficiencyPercent ?? 100).toFixed(4)) })));
textileAdvancedRouter.post('/textile/tools/twist-multiplier', validate({ body: sch.twistBodySchema }), h(async (r) => ({ twistMultiplier: twistMultiplier(r.body.tpi, r.body.ne) })));
