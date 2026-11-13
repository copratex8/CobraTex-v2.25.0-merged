#!/usr/bin/env node
/**
 * Zero-dependency secret scan for the repository (runs in CI). Fails if it finds likely real secrets:
 *  - Supabase service_role / secret keys, JWTs with role=service_role
 *  - private keys, AWS/Google/Stripe-like keys
 *  - postgres:// URLs that carry a real-looking password for a non-local host
 *  - .env files committed (anything except *.example)
 * Placeholders (PASSWORD, YOUR-, change-me, localhost, 127.0.0.1, devpassword, example) are ignored.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-ssr', '.removed-by-pack']);
const SKIP_EXT = /\.(png|jpe?g|gif|ico|woff2?|ttf|zip|pdf|webp|mp4|lock)$/i;
const problems = [];

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  if (SKIP_DIRS.has(e.name)) return [];
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

const placeholder = /(PASSWORD|YOUR[-_]|change[-_ ]?me|localhost|127\.0\.0\.1|devpassword|example|<[^>]+>|\.\.\.|xxxx|PROJECT_REF|REGION|SECRET_HERE)/i;
const rules = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'Supabase secret key (sb_secret_)', re: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Stripe live key', re: /sk_live_[0-9a-zA-Z]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
];

for (const f of walk(root)) {
  const rel = path.relative(root, f);
  const base = path.basename(f);
  if (/^\.env(\..+)?$/.test(base) && !/\.example$/.test(base) && base !== '.env.development') problems.push(`${rel}: .env file must not be committed`);
  if (SKIP_EXT.test(f)) continue;
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (text.length > 2_000_000) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const r of rules) if (r.re.test(line) && !placeholder.test(line)) problems.push(`${rel}:${i + 1}: ${r.name}`);
    for (const m of line.matchAll(/postgres(?:ql)?:\/\/([^:\s/]+):([^@\s]+)@([^/\s:?]+)/g)) {
      if (!placeholder.test(m[0]) && !placeholder.test(m[2])) problems.push(`${rel}:${i + 1}: database URL with embedded password (${m[3]})`);
    }
    for (const m of line.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
      try {
        const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
        if (payload.role === 'service_role') problems.push(`${rel}:${i + 1}: Supabase service_role JWT`);
      } catch { /* not a JWT */ }
    }
  });
}
if (problems.length) { console.error('✗ possible secrets found:\n' + problems.map((p) => '  ' + p).join('\n')); process.exit(1); }
console.log('✓ no secrets found');
