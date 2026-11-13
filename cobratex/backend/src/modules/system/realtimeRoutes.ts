import { Router } from 'express';
import { mintRealtimeToken } from '@/modules/system/realtimeToken';
export const realtimeRouter = Router();
/** يُركَّب خلف authMiddleware. {enabled:false} إن لم يُضبط SUPABASE_JWT_SECRET فتتجاهل الواجهة Realtime بصمت. */
realtimeRouter.get('/realtime/token', (req, res) => { res.json(mintRealtimeToken(req.ctx)); });
