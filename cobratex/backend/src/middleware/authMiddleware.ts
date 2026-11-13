import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '@/shared/auth';
import { RequestContext, type AuthenticatedUserClaims } from '@/shared/requestContext';
import { UnauthorizedError } from '@/shared/errors';
import { isUserActive } from '@/shared/activeUsers';
import { supabaseAuthEnabled, verifySupabaseJwt, loadClaimsForUser } from '@/shared/supabaseAuth';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

/**
 * يقبل نوعين من التوكن:
 *  1) توكن Supabase Auth (عند ضبط SUPABASE_URL): يُتحقق منه عبر JWKS ثم تُحمَّل الصلاحيات حيّة من القاعدة.
 *  2) توكن CobraTex الخاص (HS256) — الوحيد عند عدم ضبط SUPABASE_URL، أو عند DISABLE_LEGACY_LOGIN=false كمسار احتياطي.
 */
async function resolveClaims(token: string): Promise<AuthenticatedUserClaims> {
  if (supabaseAuthEnabled) {
    try {
      const payload = await verifySupabaseJwt(token);
      if (typeof payload.sub === 'string') return await loadClaimsForUser(payload.sub);
    } catch {
      /* ليس توكن Supabase صالحًا — جرّب التوكن الخاص */
    }
  }
  return verifyAccessToken(token);
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError('التوكن مفقود'));
  }
  let claims: AuthenticatedUserClaims;
  try {
    claims = await resolveClaims(header.slice('Bearer '.length));
  } catch {
    return next(new UnauthorizedError('توكن غير صالح أو منتهي'));
  }
  try {
    if (!claims.userId || !(await isUserActive(claims.userId))) return next(new UnauthorizedError('الحساب معطَّل أو غير موجود'));
  } catch (e) {
    return next(e);
  }
  req.ctx = new RequestContext(claims);
  next();
}
