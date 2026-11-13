import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileExtraService';
import * as sch from '@/modules/manufacturing/textileExtraSchemas';

export const textileExtraRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
const q = (req: { query: Record<string, unknown> }) => req.query as Record<string, string | undefined>;

// الجودة
textileExtraRouter.get('/textile/quality/types', async (req, res, next) => { try { res.json(await svc.listQualityTypes(req.ctx)); } catch (e) { next(e); } });
textileExtraRouter.post('/textile/quality/types', validate({ body: sch.qualityTypeBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createQualityType(req.ctx, req.body)); } catch (e) { next(e); } });
textileExtraRouter.put('/textile/quality/types/:id', validate({ params: idParamSchema, body: sch.qualityTypeUpdateSchema }), async (req, res, next) => { try { res.json(await svc.updateQualityType(req.ctx, id(req), req.body)); } catch (e) { next(e); } });
textileExtraRouter.post('/textile/quality/results', validate({ body: sch.qualityResultBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createQualityResult(req.ctx, req.body)); } catch (e) { next(e); } });
textileExtraRouter.get('/textile/quality/results', validate({ query: sch.listQuerySchema }), async (req, res, next) => { try { res.json(await svc.listQualityResults(req.ctx, { ...q(req), productionOrderId: q(req).productionOrderId })); } catch (e) { next(e); } });

// الصيانة
textileExtraRouter.get('/textile/maintenance/plans', async (req, res, next) => { try { res.json(await svc.listMaintenancePlans(req.ctx)); } catch (e) { next(e); } });
textileExtraRouter.post('/textile/maintenance/plans', validate({ body: sch.maintenancePlanBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createMaintenancePlan(req.ctx, req.body)); } catch (e) { next(e); } });
textileExtraRouter.put('/textile/maintenance/plans/:id', validate({ params: idParamSchema, body: sch.maintenancePlanUpdateSchema }), async (req, res, next) => { try { res.json(await svc.updateMaintenancePlan(req.ctx, id(req), req.body)); } catch (e) { next(e); } });
textileExtraRouter.post('/textile/maintenance/logs', validate({ body: sch.maintenanceLogBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createMaintenanceLog(req.ctx, req.body)); } catch (e) { next(e); } });
textileExtraRouter.get('/textile/maintenance/logs', validate({ query: sch.listQuerySchema }), async (req, res, next) => { try { res.json(await svc.listMaintenanceLogs(req.ctx, q(req))); } catch (e) { next(e); } });
textileExtraRouter.get('/textile/maintenance/due', validate({ query: sch.listQuerySchema }), async (req, res, next) => { try { res.json(await svc.listMaintenanceDue(req.ctx, req.query.days === undefined ? 7 : Number(req.query.days))); } catch (e) { next(e); } });

// التقارير والأدوات
textileExtraRouter.get('/textile/reports/maintenance', validate({ query: sch.listQuerySchema }), async (req, res, next) => { try { res.json(await svc.reportMaintenance(req.ctx, q(req))); } catch (e) { next(e); } });
textileExtraRouter.get('/textile/reports/lot-trace', validate({ query: sch.listQuerySchema }), async (req, res, next) => { try { res.json(await svc.traceLot(req.ctx, String(req.query.lot ?? ''))); } catch (e) { next(e); } });
textileExtraRouter.get('/textile/dashboard', validate({ query: sch.listQuerySchema }), async (req, res, next) => { try { res.json(await svc.dashboard(req.ctx, q(req))); } catch (e) { next(e); } });
textileExtraRouter.get('/textile/tools/capacity', validate({ query: sch.listQuerySchema }), async (req, res, next) => {
  try {
    const { machineId, quantity } = req.query as Record<string, string | undefined>;
    if (!machineId || !quantity) return res.status(422).json({ error: 'machineId وquantity مطلوبان' });
    res.json(await svc.capacityEstimate(req.ctx, machineId, Number(quantity)));
  } catch (e) { next(e); }
});
