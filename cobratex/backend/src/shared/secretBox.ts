import crypto from 'crypto';
import { config } from '@/config';

/**
 * تشفير أسرار صغيرة (Google client secret / refresh token) قبل حفظها في قاعدة البيانات.
 * AES-256-GCM؛ المفتاح من BACKUP_ENC_KEY إن وُجد، وإلا يُشتق من JWT_REFRESH_SECRET (تغييره يستلزم إعادة ربط Drive).
 */
function key(): Buffer {
  const material = process.env.BACKUP_ENC_KEY || config.jwtRefreshSecret;
  return crypto.scryptSync(material, 'cobratex-backup-v1', 32);
}

export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function openSecret(sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('صيغة سرّ مشفّر غير صالحة');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
