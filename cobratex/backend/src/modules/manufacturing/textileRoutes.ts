import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileService';
import * as sch from '@/modules/manufacturing/textileSchemas';
import { convertCount, estimateFabric, spindleKgPerHour } from '@/modules/manufacturing/textileCosting';
import { RequestContext } from '@/shared/requestContext';

export const textileRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
const q = (req: { query: Record<string, unknown> }) => req.query as Record<string, string | undefined>;

// المراحل
textileRouter.get('/textile/stages', async (req, res, next) => { try { res.json(await svc.listStages(req.ctx)); } catch (e) { next(e); } });
textileRouter.post('/textile/stages', validate({ body: sch.stageBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createStage(req.ctx, req.body)); } catch (e) { next(e); } });
textileRouter.put('/textile/stages/:id', validate({ params: idParamSchema, body: sch.stageUpdateBodySchema }), async (req, res, next) => { try { res.json(await svc.updateStage(req.ctx, id(req), req.body)); } catch (e) { next(e); } });

// أنواع الهالك
textileRouter.get('/textile/waste-types', async (req, res, next) => { try { res.json(await svc.listWasteTypes(req.ctx)); } catch (e) { next(e); } });
textileRouter.post('/textile/waste-types', validate({ body: sch.wasteTypeBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createWasteType(req.ctx, req.body)); } catch (e) { next(e); } });
textileRouter.put('/textile/waste-types/:id', validate({ params: idParamSchema, body: sch.wasteTypeUpdateBodySchema }), async (req, res, next) => { try { res.json(await svc.updateWasteType(req.ctx, id(req), req.body)); } catch (e) { next(e); } });

// مواصفات الصنف
textileRouter.get('/textile/items/:id/specs', validate({ params: idParamSchema }), async (req, res, next) => { try { res.json(await svc.getItemSpecs(req.ctx, id(req))); } catch (e) { next(e); } });
textileRouter.put('/textile/items/:id/specs', validate({ params: idParamSchema, body: sch.itemSpecsBodySchema }), async (req, res, next) => { try { res.json(await svc.upsertItemSpecs(req.ctx, id(req), req.body)); } catch (e) { next(e); } });

// الماكينات والسجل
textileRouter.get('/textile/machines', async (req, res, next) => { try { res.json(await svc.listMachines(req.ctx)); } catch (e) { next(e); } });
textileRouter.post('/textile/machines', validate({ body: sch.machineBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createMachine(req.ctx, req.body)); } catch (e) { next(e); } });
textileRouter.put('/textile/machines/:id', validate({ params: idParamSchema, body: sch.machineUpdateBodySchema }), async (req, res, next) => { try { res.json(await svc.updateMachine(req.ctx, id(req), req.body)); } catch (e) { next(e); } });
textileRouter.post('/textile/machine-logs', validate({ body: sch.machineLogBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createMachineLog(req.ctx, req.body)); } catch (e) { next(e); } });
textileRouter.get('/textile/machine-logs', validate({ query: sch.rangeQuerySchema }), async (req, res, next) => { try { res.json(await svc.listMachineLogs(req.ctx, q(req))); } catch (e) { next(e); } });

// الإنتاج الفعلي والهالك على أمر التصنيع
textileRouter.put('/textile/orders/:id/completion', validate({ params: idParamSchema, body: sch.completionBodySchema }), async (req, res, next) => { try { res.json(await svc.saveOrderCompletion(req.ctx, id(req), req.body)); } catch (e) { next(e); } });
textileRouter.get('/textile/orders/:id/completion/preview', validate({ params: idParamSchema }), async (req, res, next) => { try { res.json(await svc.previewOrderCompletion(req.ctx, id(req))); } catch (e) { next(e); } });

// فحص الرولات
textileRouter.post('/textile/fabric-rolls', validate({ body: sch.fabricRollBodySchema }), async (req, res, next) => { try { res.status(201).json(await svc.createFabricRoll(req.ctx, req.body)); } catch (e) { next(e); } });
textileRouter.get('/textile/fabric-rolls', validate({ query: sch.rangeQuerySchema }), async (req, res, next) => { try { res.json(await svc.listFabricRolls(req.ctx, q(req).productionOrderId)); } catch (e) { next(e); } });

// التقارير
textileRouter.get('/textile/reports/waste', validate({ query: sch.rangeQuerySchema }), async (req, res, next) => { try { res.json(await svc.reportWaste(req.ctx, q(req))); } catch (e) { next(e); } });
textileRouter.get('/textile/reports/orders/:id/yield', validate({ params: idParamSchema }), async (req, res, next) => { try { res.json(await svc.reportOrderYield(req.ctx, id(req))); } catch (e) { next(e); } });
textileRouter.get('/textile/reports/machine-efficiency', validate({ query: sch.rangeQuerySchema }), async (req, res, next) => { try { res.json(await svc.reportMachineEfficiency(req.ctx, q(req))); } catch (e) { next(e); } });

// حاسبات مرجعية (بلا بيانات): لا تحتاج صلاحية خاصة غير تسجيل الدخول
const noCtx = (_c: RequestContext) => undefined;
textileRouter.get('/textile/tools/count-convert', validate({ query: sch.countConvertQuerySchema }), (req, res, next) => {
  try { noCtx(req.ctx); const { value, system } = req.query as unknown as { value: string; system: 'Ne' | 'Nm' | 'Tex' | 'Denier' }; res.json(convertCount(Number(value), system)); } catch (e) { next(e); }
});
textileRouter.post('/textile/tools/fabric-estimate', validate({ body: sch.fabricEstimateBodySchema }), (req, res, next) => { try { res.json(estimateFabric(req.body)); } catch (e) { next(e); } });
textileRouter.post('/textile/tools/spindle-output', validate({ body: sch.spindleBodySchema }), (req, res, next) => {
  try { res.json({ kgPerSpindleHour: Number(spindleKgPerHour(req.body.rpm, req.body.tpi, req.body.ne, req.body.efficiencyPercent ?? 100).toFixed(5)) }); } catch (e) { next(e); }
});
