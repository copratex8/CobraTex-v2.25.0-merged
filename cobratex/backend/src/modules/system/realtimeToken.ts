import jwt from 'jsonwebtoken';
import { RequestContext } from '@/shared/requestContext';

/** توكن قصير (ساعة) بصيغة يفهمها Supabase (RLS + Realtime) دون ترحيل المستخدمين إلى Supabase Auth.
 *  يحمل الشركة والعميل كمطالبتين علويتين (company_id/tenant_id) تمامًا كما يفعل custom_access_token_hook؛ فتقرؤهما سياسات RLS (supabase/migrations، دوال app.company_id()/app.tenant_id()) قراءةً فقط وبـ"نبضة" لا بيانات. */
export const realtimeEnabled = () => !!process.env.SUPABASE_JWT_SECRET;
export function mintRealtimeToken(ctx: RequestContext, now = Math.floor(Date.now() / 1000)) {
  const secret = process.env.SUPABASE_JWT_SECRET; if (!secret) return { enabled: false as const };
  const ttl = 3600;
  return { enabled: true as const, expiresIn: ttl, companyId: ctx.companyId, token: jwt.sign({ role: 'authenticated', aud: 'authenticated', sub: ctx.userId, app_metadata: { company_id: ctx.companyId }, company_id: ctx.companyId, tenant_id: ctx.tenantId, iat: now, exp: now + ttl }, secret, { algorithm: 'HS256' }) };
}
