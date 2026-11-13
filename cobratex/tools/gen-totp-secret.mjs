#!/usr/bin/env node
/**
 * Generates DEVELOPER_TOTP_SECRET (two-factor for the developer panel).
 *   node tools/gen-totp-secret.mjs            -> new secret + otpauth URI
 *   node tools/gen-totp-secret.mjs --check <SECRET> <6-digit-code>   -> verifies a code from your authenticator app
 * Add the secret in Google Authenticator / Authy / Microsoft Authenticator → "Enter setup key" (type: time-based).
 * Then set DEVELOPER_TOTP_SECRET on the backend of EACH client you control (same secret or one per client).
 */
import crypto from 'node:crypto';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encode = (buf) => { let bits = 0, value = 0, out = ''; for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } value &= (1 << bits) - 1; } if (bits > 0) out += B32[(value << (5 - bits)) & 31]; return out; };
const decode = (s) => { let bits = 0, value = 0; const out = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) throw new Error('invalid base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; } } return Buffer.from(out); };
const hotp = (key, counter) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', key).update(b).digest(); const o = h[19] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };

if (process.argv[2] === '--check') {
  const [, , , secret, code] = process.argv; const c = Math.floor(Date.now() / 30000); const key = decode(secret);
  const ok = [-1, 0, 1].some((w) => hotp(key, c + w) === code);
  console.log(ok ? '✓ code is valid' : '✗ code is NOT valid (check the secret and your phone clock)'); process.exit(ok ? 0 : 1);
}
const secret = encode(crypto.randomBytes(20));
console.log(`DEVELOPER_TOTP_SECRET=${secret}\n\nSetup key for the authenticator app (type: time-based):\n  ${secret}\n\notpauth URI (for apps/QR generators):\n  otpauth://totp/CobraTex%20Developer?secret=${secret}&issuer=CobraTex&digits=6&period=30\n\nThen verify: node tools/gen-totp-secret.mjs --check ${secret} <code-from-app>`);
