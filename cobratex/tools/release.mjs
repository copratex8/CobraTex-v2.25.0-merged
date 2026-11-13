#!/usr/bin/env node
/**
 * Bump the app version in ONE place before every release (the remote-update policy compares against it).
 *   node tools/release.mjs patch | minor | major | 2.22.0
 * Updates: frontend/package.json (this is APP_VERSION baked into the web app/PWA/.exe) and backend/VERSION (reported by /system/version).
 * backend/package.json is NOT touched (its version is independent of the product version).
 * Then prints the exact remaining steps. It never pushes or deploys anything by itself.
 */
import fs from 'node:fs';

const arg = process.argv[2];
if (!arg) { console.error('Usage: node tools/release.mjs patch|minor|major|<x.y.z>'); process.exit(1); }

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const fe = readJson('frontend/package.json');
const cur = fe.version;
if (!/^\d+\.\d+\.\d+$/.test(cur)) { console.error(`Current frontend version "${cur}" is not x.y.z`); process.exit(1); }

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  const [M, m, p] = cur.split('.').map(Number);
  next = arg === 'major' ? `${M + 1}.0.0` : arg === 'minor' ? `${M}.${m + 1}.0` : arg === 'patch' ? `${M}.${m}.${p + 1}` : null;
  if (!next) { console.error('Argument must be patch|minor|major|x.y.z'); process.exit(1); }
}
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
if (cmp(next, cur) <= 0) { console.error(`New version ${next} must be greater than current ${cur}`); process.exit(1); }

// Replace only the "version" line so the rest of each file's formatting is untouched.
const setVersion = (file) => {
  const s = fs.readFileSync(file, 'utf8');
  const out = s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (out === s) throw new Error(`no "version" field changed in ${file}`);
  fs.writeFileSync(file, out);
  console.log(`  ✓ ${file}: ${cur} → ${next}`);
};
setVersion('frontend/package.json');
if (fs.existsSync('backend/VERSION')) { fs.writeFileSync('backend/VERSION', next + '\n'); console.log(`  ✓ backend/VERSION → ${next}`); }

console.log(`
Next steps for v${next}:
  1. git add -A && git commit -m "release v${next}" && git tag v${next} && git push --follow-tags
  2. GitHub → Actions → "Release clients" → choose the clients (or "all") → wait for green.
  3. Developer panel → "التحديثات عن بُعد" → set latestVersion = ${next}  (soft banner for users).
     To FORCE everyone: also set minVersion = ${next}  — only AFTER step 2 finished for that client,
     otherwise users will be asked to update to a version that is not deployed yet.
`);
