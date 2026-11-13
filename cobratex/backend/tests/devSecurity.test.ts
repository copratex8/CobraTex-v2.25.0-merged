import { describe, it, expect } from 'vitest';
import { base32Decode, hotp, verifyTotp, ipAllowed } from '@/modules/platform/devSecurity';

// RFC 4226 Appendix D (secret "12345678901234567890")
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
// base32("12345678901234567890")
const RFC_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP / HOTP', () => {
  it('RFC 4226 test vectors', () => { RFC_HOTP.forEach((v, i) => expect(hotp(RFC_KEY, i)).toBe(v)); });
  it('base32 decode matches the ASCII secret', () => { expect(base32Decode(RFC_B32).toString('ascii')).toBe('12345678901234567890'); });
  it('RFC 6238: T=59s -> counter 1 -> 287082', () => { expect(verifyTotp(RFC_B32, '287082', 59_000)).toBe(1); });
  it('accepts ±1 step, rejects ±2', () => {
    expect(verifyTotp(RFC_B32, '287082', 59_000 + 30_000)).toBe(1);
    expect(verifyTotp(RFC_B32, '287082', 59_000 + 90_000)).toBeNull();
  });
  it('rejects malformed codes and secrets', () => {
    expect(verifyTotp(RFC_B32, '12345', 59_000)).toBeNull();
    expect(verifyTotp(RFC_B32, 'abcdef', 59_000)).toBeNull();
    expect(verifyTotp('!!!notbase32', '287082', 59_000)).toBeNull();
  });
});

describe('ipAllowed', () => {
  it('no list = allowed', () => { expect(ipAllowed({ ip: '1.2.3.4' }, '')).toBe(true); });
  it('matches exact and ::ffff: mapped addresses', () => {
    expect(ipAllowed({ ip: '1.2.3.4' }, '9.9.9.9, 1.2.3.4')).toBe(true);
    expect(ipAllowed({ ip: '::ffff:1.2.3.4' }, '1.2.3.4')).toBe(true);
    expect(ipAllowed({ ip: '5.5.5.5' }, '1.2.3.4')).toBe(false);
  });
});
