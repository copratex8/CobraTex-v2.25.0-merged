import crypto from 'crypto';
import type { Request } from 'express';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** يُرجع رقم العدّاد (الفترة) المطابق أو null. يُسمح بفارق ±1 فترة (30ث) لتفاوت الساعة. */
export function verifyTotp(secretBase32: string, code: string, now = Date.now(), window = 1, step = 30): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let key: Buffer;
  try { key = base32Decode(secretBase32); } catch { return null; }
  const counter = Math.floor(now / 1000 / step);
  let matched: number | null = null;
  for (let w = -window; w <= window; w++) {
    const expected = hotp(key, counter + w);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) matched = counter + w; // لا نقطع الحلقة: زمن ثابت
  }
  return matched;
}

/** قائمة عناوين مسموح بها للوحة المطور (DEVELOPER_IP_ALLOWLIST=ip1,ip2). فارغة = بلا تقييد. */
export function ipAllowed(req: Pick<Request, 'ip'>, list = process.env.DEVELOPER_IP_ALLOWLIST ?? ''): boolean {
  const allowed = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  return allowed.includes(ip);
}
