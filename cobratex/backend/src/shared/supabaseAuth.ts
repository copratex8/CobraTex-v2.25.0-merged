import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { pool } from '@/db/pool';
import type { AuthenticatedUserClaims, GrantedPermission, PermissionScope } from '@/shared/requestContext';

/**
 * HYBRID PHASE: Express accepts Supabase Auth access tokens.
 *  - SUPABASE_URL set  -> Supabase tokens are verified (JWKS; HS256 fallback if SUPABASE_JWT_SECRET is set,
 *    for legacy projects). Old self-issued tokens are still accepted as a fallback (see authMiddleware).
 *  - SUPABASE_URL unset -> feature off: behavior identical to before (existing tests keep passing).
 * Permissions / branch scope are loaded LIVE from the DB (same logic as identityService.buildAccessClaims),
 * cached for a few seconds, so role changes apply almost immediately.
 */
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const LEGACY_SECRET = process.env.SUPABASE_JWT_SECRET;

export const supabaseAuthEnabled = Boolean(SUPABASE_URL);

const jwks = SUPABASE_URL ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)) : null;

export async function verifySupabaseJwt(token: string): Promise<JWTPayload> {
  if (!SUPABASE_URL || !jwks) throw new Error('SUPABASE_URL is not configured');
  const options = { issuer: `${SUPABASE_URL}/auth/v1`, audience: 'authenticated' };
  try {
    return (await jwtVerify(token, jwks, options)).payload;
  } catch (err) {
    if (!LEGACY_SECRET) throw err;
    return (await jwtVerify(token, new TextEncoder().encode(LEGACY_SECRET), { ...options, algorithms: ['HS256'] })).payload;
  }
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; claims: AuthenticatedUserClaims }>();

export async function loadClaimsForUser(userId: string): Promise<AuthenticatedUserClaims> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.claims;

  const u = await pool.query(`SELECT id, tenant_id, company_id, is_active FROM users WHERE id = $1`, [userId]);
  const user = u.rows[0];
  if (!user || !user.is_active || !user.company_id) throw new Error('user not available');

  const scopes = await pool.query(`SELECT branch_id, scope_type FROM user_branch_scopes WHERE user_id = $1`, [userId]);
  const scopeType = scopes.rows.some((r) => r.scope_type === 'all') ? 'all' : 'multi';
  const branchIds: string[] = scopes.rows.map((r) => r.branch_id);
  const finalScopeType = branchIds.length <= 1 && scopeType !== 'all' ? 'single' : scopeType;

  const perms = await pool.query(
    `SELECT p.code AS code,
            MAX(CASE rp.scope WHEN 'all_branches' THEN 3 WHEN 'multi_branch' THEN 2 ELSE 1 END) AS rank
     FROM user_roles ur
     JOIN role_permissions rp ON rp.role_id = ur.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1 AND ur.company_id = $2
     GROUP BY p.code`,
    [userId, user.company_id],
  );
  const rankToScope: Record<number, PermissionScope> = { 3: 'all_branches', 2: 'multi_branch', 1: 'own_branch' };
  const permissions: GrantedPermission[] = perms.rows.map((r) => ({ code: r.code, scope: rankToScope[Number(r.rank)] }));

  const claims: AuthenticatedUserClaims = {
    userId: user.id, tenantId: user.tenant_id, companyId: user.company_id,
    branchIds, scopeType: finalScopeType, permissions,
  };
  cache.set(userId, { at: Date.now(), claims });
  return claims;
}

/** Verified tenant of a Supabase token (used by platformGuard for per-tenant suspension). */
export async function tenantFromSupabaseToken(token: string): Promise<string | null> {
  if (!supabaseAuthEnabled) return null;
  try {
    const payload = await verifySupabaseJwt(token);
    const t = (payload as { tenant_id?: unknown }).tenant_id;
    return typeof t === 'string' ? t : null;
  } catch {
    return null;
  }
}
