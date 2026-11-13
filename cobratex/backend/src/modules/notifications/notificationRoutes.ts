import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '@/modules/notifications/notificationService';
import { savePushSubscription, removePushSubscription } from '@/modules/notifications/pushService';

export const notificationRouter = Router();

notificationRouter.get('/notifications', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    const onlyUnread = req.query.onlyUnread === 'true';
    res.status(200).json(await listNotifications(req.ctx, page, pageSize, onlyUnread));
  } catch (err) { next(err); }
});

notificationRouter.post('/notifications/:id/read', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await markNotificationRead(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

notificationRouter.post('/notifications/read-all', async (req, res, next) => {
  try { res.status(200).json(await markAllNotificationsRead(req.ctx)); } catch (err) { next(err); }
});

notificationRouter.post('/notifications/push-subscriptions', async (req, res, next) => {
  try { res.status(201).json(await savePushSubscription(req.ctx, req.body)); } catch (err) { next(err); }
});

notificationRouter.delete('/notifications/push-subscriptions', async (req, res, next) => {
  try { res.status(200).json(await removePushSubscription(req.ctx, req.body?.endpoint)); } catch (err) { next(err); }
});

/** المفتاح العام فقط (لا سرّ) — الواجهة تحتاجه لطلب اشتراك Web Push من المتصفح؛ لا معنى لحمايته. */
notificationRouter.get('/notifications/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
});
