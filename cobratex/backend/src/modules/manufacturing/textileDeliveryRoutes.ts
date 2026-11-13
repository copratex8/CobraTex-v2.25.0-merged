import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileDeliveryService';
import * as sch from '@/modules/manufacturing/textileDeliverySchemas';

export const textileDeliveryRouter = Router();
const id = (req: { params: Record<string, unknown> }) => String(req.params.id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };

textileDeliveryRouter.get('/textile/defect-types', h((r) => svc.listDefectTypes(r.ctx)));
textileDeliveryRouter.post('/textile/defect-types', validate({ body: sch.defectTypeBodySchema }), h((r) => svc.createDefectType(r.ctx, r.body), 201));
textileDeliveryRouter.post('/textile/defect-types/seed', h((r) => svc.seedDefectCatalog(r.ctx), 201));
textileDeliveryRouter.put('/textile/defect-types/:id', validate({ params: idParamSchema, body: sch.defectTypeUpdateSchema }), h((r) => svc.updateDefectType(r.ctx, id(r), r.body)));
textileDeliveryRouter.post('/textile/rolls-with-defects', validate({ body: sch.rollWithDefectsBodySchema }), h((r) => svc.createRollWithDefects(r.ctx, r.body), 201));
textileDeliveryRouter.get('/textile/reports/defect-pareto', h((r) => svc.defectPareto(r.ctx, r.query)));

textileDeliveryRouter.get('/textile/shippable', h((r) => svc.shippable(r.ctx)));
textileDeliveryRouter.get('/textile/delivery-notes', validate({ query: sch.deliveryListQuerySchema }), h((r) => svc.listDeliveryNotes(r.ctx, r.query)));
textileDeliveryRouter.post('/textile/delivery-notes', validate({ body: sch.deliveryNoteBodySchema }), h((r) => svc.createDeliveryNote(r.ctx, r.body), 201));
textileDeliveryRouter.get('/textile/delivery-notes/:id/doc', validate({ params: idParamSchema }), h((r) => svc.deliveryNoteDoc(r.ctx, id(r))));
textileDeliveryRouter.post('/textile/delivery-notes/:id/cancel', validate({ params: idParamSchema, body: sch.cancelNoteBodySchema }), h((r) => svc.cancelDeliveryNote(r.ctx, id(r), r.body.reason)));
textileDeliveryRouter.get('/textile/delivery-notes/:id/invoice-candidates', validate({ params: idParamSchema }), h((r) => svc.invoiceCandidates(r.ctx, id(r))));
textileDeliveryRouter.put('/textile/delivery-notes/:id/invoice', validate({ params: idParamSchema, body: sch.linkInvoiceBodySchema }), h((r) => svc.linkInvoice(r.ctx, id(r), r.body.invoiceId)));
textileDeliveryRouter.get('/textile/reports/invoice-delivery/:id', validate({ params: idParamSchema }), h((r) => svc.invoiceReconciliation(r.ctx, id(r))));
