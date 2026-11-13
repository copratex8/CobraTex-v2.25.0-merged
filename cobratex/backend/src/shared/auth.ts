import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '@/config';
import { AuthenticatedUserClaims } from '@/shared/requestContext';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(claims: AuthenticatedUserClaims): string {
  const options: jwt.SignOptions = { expiresIn: config.accessTokenTtl as jwt.SignOptions['expiresIn'] };
  return jwt.sign(claims, config.jwtAccessSecret, { ...options, algorithm: 'HS256' });
}

export function verifyAccessToken(token: string): AuthenticatedUserClaims {
  return jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'] }) as AuthenticatedUserClaims;
}

export interface RefreshTokenClaims {
  userId: string;
  tenantId: string;
  jti: string;
}

/** jti عشوائي (لا يعتمد على معرّف قاعدة بيانات) يربط توكن الـJWT الخام بصفه في refresh_tokens دون
 * تخزين التوكن نفسه. */
export function generateJti(): string {
  return crypto.randomUUID();
}

export function signRefreshToken(claims: RefreshTokenClaims): string {
  const options: jwt.SignOptions = { expiresIn: config.refreshTokenTtl as jwt.SignOptions['expiresIn'] };
  return jwt.sign(claims, config.jwtRefreshSecret, { ...options, algorithm: 'HS256' });
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  return jwt.verify(token, config.jwtRefreshSecret, { algorithms: ['HS256'] }) as RefreshTokenClaims;
}

/** هاش أحادي الاتجاه (SHA-256) للتوكن الخام — يُخزَّن في refresh_tokens بدل التوكن نفسه، على غرار
 * تخزين كلمات المرور: تسرُّب قاعدة البيانات وحده لا يكفي لانتحال جلسة. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

