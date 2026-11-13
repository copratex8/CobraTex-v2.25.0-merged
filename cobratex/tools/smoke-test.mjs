#!/usr/bin/env node
/**
 * Post-deploy smoke test (Node 20+, no dependencies). Proves, against the REAL deployed stack, that:
 * auth works, JWT carries tenant/company, RLS blocks what it must, Express accepts the Supabase token, PWA files are served.
 *
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=... API_URL=https://backend.vercel.app/api \
 *   SITE_URL=https://app.vercel.app TEST_EMAIL=you@company.com TEST_PASSWORD=... node tools/smoke-test.mjs
 * Use a REAL low-risk account of the environment you are testing (staging first). The script only READS and
 * attempts operations that MUST be denied.
 */
const env = (k, req = true) => { const v = process.env[k]; if (!v && req) { console.error(`Missing env ${k}`); process.exit(2); } return v; };
const SB = env('SUPABASE_URL').replace(/\/+$/, ''), KEY = env('SUPABASE_ANON_KEY');
const API = env('API_URL').replace(/\/+$/, ''), SITE = env('SITE_URL', false)?.replace(/\/+$/, '');
const EMAIL = env('TEST_EMAIL'), PASS = env('TEST_PASSWORD');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`); };
const rest = (p, token, init = {}) => fetch(`${SB}/rest/v1/${p}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${token ?? KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
const denied = (r) => r.status === 401 || r.status === 403 || r.status === 404;

// 1) backend alive
try { const r = await fetch(`${API.replace(/\/api$/, '')}/health`); check('Express /health', r.ok, `HTTP ${r.status}`); }
catch (e) { check('Express /health', false, String(e)); }
try { const r = await fetch(`${API.replace(/\/api$/, '')}/health/db`); check('Express /health/db (reaches the database)', r.ok, `HTTP ${r.status}`); }
catch (e) { check('Express /health/db', false, String(e)); }

// 2) login via Supabase Auth
const login = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) });
const session = login.ok ? await login.json() : null;
check('Login with the existing password (bcrypt import)', !!session?.access_token, `HTTP ${login.status}`);
if (!session) { console.error('\nCannot continue without a session.'); process.exit(1); }
const token = session.access_token, c = claims(token);
check('JWT has company_id + tenant_id (auth hook enabled)', !!c.company_id && !!c.tenant_id, c.company_id ? '' : 'enable Authentication → Hooks → Custom Access Token');

// 3) public status RPC (anon)
const st = await rest('rpc/get_platform_status', null, { method: 'POST', body: JSON.stringify({ p_tenant_id: c.tenant_id }) });
const stj = st.ok ? await st.json() : null;
check('get_platform_status (anon)', stj?.status === 'active' || stj?.status === 'suspended', stj ? `status=${stj.status}` : `HTTP ${st.status}`);

// 4) what the browser MUST NOT be able to do
let r = await rest('users?select=password_hash&limit=1', token);
check('users.password_hash is NOT readable', denied(r) || r.status === 400, `HTTP ${r.status}`);
r = await rest('audit_logs?select=id&limit=1', token);
check('audit_logs closed to the browser', denied(r), `HTTP ${r.status}`);
r = await rest('backup_settings?select=*&limit=1', token);
check('backup_settings closed to the browser', denied(r), `HTTP ${r.status}`);
r = await rest('accounts', token, { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ company_id: c.company_id, code: 'SMOKE', name_ar: 'x', name_en: 'x', account_type: 'asset' }) });
check('Direct INSERT into accounts denied', denied(r), `HTTP ${r.status}`);
r = await rest('rpc/seed_textile_defaults', token, { method: 'POST', body: JSON.stringify({ p_company: c.company_id }) });
check('Helper functions not callable as RPC', denied(r), `HTTP ${r.status}`);
check('Anon cannot read tables', denied(await rest('accounts?select=id&limit=1', null)), '');

// 5) what it SHOULD be able to do (own company only)
r = await rest('users?select=id,company_id&limit=200', token);
const users = r.ok ? await r.json() : [];
check('Reads users of OWN company only', r.ok && users.length > 0 && users.every((u) => u.company_id === c.company_id), `${users.length} rows`);
r = await rest('accounts?select=id,company_id&limit=5', token);
const accs = r.ok ? await r.json() : [];
check('accounts readable ONLY within own company (needs accounting.account.view)', r.ok && accs.every((a) => a.company_id === c.company_id), `${accs.length} rows (0 is fine if the user lacks the permission)`);

// 6) Express accepts the Supabase token
r = await fetch(`${API}/notifications`, { headers: { Authorization: `Bearer ${token}` } });
check('Express accepts the Supabase JWT (not 401)', r.status !== 401, `HTTP ${r.status}`);
r = await fetch(`${API}/notifications`);
check('Express rejects requests without a token', r.status === 401, `HTTP ${r.status}`);

// 6b) hardening probes (these MUST be refused)
const rnd = Math.random().toString(36).slice(2);
r = await fetch(`${SB}/auth/v1/signup`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `smoke-${rnd}@example.invalid`, password: `Pw-${rnd}-Aa1!x` }) });
check('Public sign-up is DISABLED in Supabase Auth', !r.ok, `HTTP ${r.status}` + (r.ok ? '  ← disable "Allow new users to sign up"' : ''));
r = await fetch(`${API}/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('/bootstrap is not open to the world (401/404, not 422)', r.status === 401 || r.status === 404, `HTTP ${r.status}` + (r.status === 422 ? '  ← set BOOTSTRAP_SECRET' : ''));
if (process.env.EXPECT_LEGACY_LOGIN_DISABLED === 'true') {
  r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('Legacy /auth/login disabled (DISABLE_LEGACY_LOGIN=true)', r.status === 404, `HTTP ${r.status}`);
}
r = await fetch(`${API}/developer/overview`, { headers: { Authorization: `Bearer ${token}` } });
check('Developer-panel endpoints refuse a normal user token', r.status === 401 || r.status === 403 || r.status === 404, `HTTP ${r.status}`);

// 6c) users/roles administration + remote control surface
r = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const meJson = r.ok ? await r.json() : null;
check('GET /auth/me returns the caller permissions', r.ok && Array.isArray(meJson?.permissions), `HTTP ${r.status}`);
r = await fetch(`${API}/auth/change-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('/auth/change-password requires a session', r.status === 401, `HTTP ${r.status}`);
r = await fetch(`${API}/users`, { headers: { Authorization: `Bearer ${token}` } });
check('/users is protected by permission (200 for owner, 403 otherwise — never 401/404)', r.status === 200 || r.status === 403, `HTTP ${r.status}`);
r = await fetch(`${API}/cron/license-reminders`);
check('Cron endpoint refuses callers without CRON_SECRET (401/404)', r.status === 401 || r.status === 404, `HTTP ${r.status}`);
check('Status RPC exposes the remote update policy', stj && typeof stj.update === 'object', stj ? JSON.stringify(stj.update) : 'no status');

// 7) PWA files on the deployed site
if (SITE) {
  r = await fetch(`${SITE}/manifest.webmanifest`);
  const m = r.ok ? await r.json().catch(() => null) : null;
  check('manifest.webmanifest served & valid', !!m?.name && m.display === 'standalone', `HTTP ${r.status}`);
  r = await fetch(`${SITE}/sw.js`);
  check('sw.js served with no-cache', r.ok && /no-cache|no-store|max-age=0/.test(r.headers.get('cache-control') ?? ''), r.headers.get('cache-control') ?? 'no cache-control header');
  const html = await (await fetch(SITE)).text();
  check('index.html links the manifest', html.includes('rel="manifest"'), '');
  check('Mobile viewport-fit=cover', html.includes('viewport-fit=cover'), '');
  const hdr = (await fetch(SITE)).headers;
  check('Header X-Frame-Options: DENY', (hdr.get('x-frame-options') ?? '').toUpperCase() === 'DENY', hdr.get('x-frame-options') ?? 'missing');
  check('Header Strict-Transport-Security', /max-age=\d+/.test(hdr.get('strict-transport-security') ?? ''), hdr.get('strict-transport-security') ?? 'missing');
  check('Header Permissions-Policy', !!hdr.get('permissions-policy'), hdr.get('permissions-policy') ?? 'missing');
  if (process.env.EXPECT_CSP === 'on') check('CSP meta present (VITE_CSP=on)', html.includes('Content-Security-Policy'), '');
  const js = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1];
  if (js) {
    const mapRes = await fetch(new URL(js + '.map', SITE + '/'));
    const body = mapRes.ok ? await mapRes.text() : '';
    check('No source map is served for the main bundle', !body.trimStart().startsWith('{"version"'), `HTTP ${mapRes.status}`);
  }
}

const bad = results.filter((x) => !x).length;
console.log(`\n${bad === 0 ? '✓ ALL CHECKS PASSED' : `✗ ${bad} check(s) failed`} (${results.length} total)`);
process.exit(bad ? 1 : 0);
