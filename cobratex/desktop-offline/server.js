'use strict';
/**
 * خادم كوبرا تكس لسطح المكتب: يشغّل داخل العملية نفسها
 *   قاعدة PostgreSQL مضمَّنة (embedded-postgres) ← تطبيق الهجرات ← خادم Express (الـAPI + الواجهة المبنية) على localhost.
 * كل شيء (Node + مكتبات الباك إند + Postgres + الواجهة) داخل الـexe، فلا يحتاج الجهاز تثبيت أي شيء.
 * لاستخدام قاعدة خارجية (مثل Supabase) ضع databaseUrl في config.json أو المتغير COBRATEX_DATABASE_URL.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const PAYLOAD = path.join(__dirname, 'payload');
const rand = (n = 48) => crypto.randomBytes(n).toString('base64url');

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name); const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function loadConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* أول تشغيل */ }
  let changed = false;
  const ensure = (k, v) => { if (!cfg[k]) { cfg[k] = v; changed = true; } };
  ensure('port', 47600);
  ensure('jwtAccessSecret', rand()); ensure('jwtRefreshSecret', rand());
  ensure('backupEncKey', rand()); ensure('bootstrapSecret', rand(24));
  ensure('pgPassword', rand(18)); ensure('pgPort', 54329);
  if (changed) fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

async function startDatabase(cfg, dataDir, log) {
  const external = process.env.COBRATEX_DATABASE_URL || cfg.databaseUrl;
  if (external) { log('قاعدة بيانات خارجية'); return { url: external, stop: async () => {} }; }
  const mod = await import('embedded-postgres');
  const EmbeddedPostgres = mod.default || mod.EmbeddedPostgres;
  const databaseDir = path.join(dataDir, 'pgdata');
  const pg = new EmbeddedPostgres({ databaseDir, user: 'cobratex', password: cfg.pgPassword, port: cfg.pgPort, persistent: true, onLog: () => {}, onError: (m) => log('pg: ' + m) });
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) { log('تهيئة قاعدة البيانات أول مرة…'); await pg.initialise(); }
  await pg.start();
  try { await pg.createDatabase('cobratex'); } catch { /* موجودة */ }
  return {
    url: `postgres://cobratex:${encodeURIComponent(cfg.pgPassword)}@127.0.0.1:${cfg.pgPort}/cobratex`,
    stop: async () => { try { await pg.stop(); } catch { /* ignore */ } },
    local: true,
  };
}

async function start(userData, log = console.log) {
  const dataDir = path.join(userData, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig(dataDir);
  const db = await startDatabase(cfg, dataDir, log);

  // مجلد تشغيل قابل للكتابة: الباك إند يقرأ VERSION وplugins من cwd.
  const runtime = path.join(userData, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(path.join(PAYLOAD, 'backend', 'VERSION'), path.join(runtime, 'VERSION'));
  copyDir(path.join(PAYLOAD, 'backend', 'plugins'), path.join(runtime, 'plugins'));
  process.chdir(runtime);

  const origin = `http://localhost:${cfg.port}`;
  Object.assign(process.env, {
    NODE_ENV: 'production', PORT: String(cfg.port), DATABASE_URL: db.url, DATABASE_SSL: db.local ? 'false' : (process.env.DATABASE_SSL || 'auto'),
    JWT_ACCESS_SECRET: cfg.jwtAccessSecret, JWT_REFRESH_SECRET: cfg.jwtRefreshSecret, BACKUP_ENC_KEY: cfg.backupEncKey,
    BOOTSTRAP_SECRET: cfg.bootstrapSecret, BACKUP_DIR: path.join(userData, 'backups'), PUBLIC_API_URL: origin,
    PLUGINS_DIR: path.join(runtime, 'plugins'), DB_POOL_MAX: '8',
  });
  fs.mkdirSync(process.env.BACKUP_DIR, { recursive: true });

  // الباك إند يقرأ البيئة عند الاستيراد، لذلك نستورده بعد ضبطها.
  const dist = path.join(PAYLOAD, 'backend', 'dist');
  const { pool } = require(path.join(dist, 'src', 'db', 'pool'));
  const { runMigrations } = require(path.join(dist, 'src', 'db', 'migrateRunner'));
  const applied = await runMigrations(pool, path.join(PAYLOAD, 'backend', 'migrations'), log);
  log(`الهجرات: طُبِّق ${applied} ملف`);
  const { createApp } = require(path.join(dist, 'src', 'app'));
  const { startBackupScheduler } = require(path.join(dist, 'src', 'modules', 'backup', 'driveService'));
  const version = fs.readFileSync(path.join(runtime, 'VERSION'), 'utf8').trim();

  const express = require('express');
  const app = express();
  const frontend = path.join(PAYLOAD, 'frontend');
  const hasTenant = async () => (await pool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 2')).rows;

  // إعداد أول تشغيل: يظهر فقط ما دام لا يوجد أي عميل في القاعدة.
  app.get('/__setup/state', async (_q, r, n) => { try { r.json({ needsSetup: (await hasTenant()).length === 0 }); } catch (e) { n(e); } });
  app.post('/__setup/create', express.json(), async (req, res, next) => {
    try {
      if ((await hasTenant()).length > 0) return res.status(409).json({ error: 'تم الإعداد مسبقًا' });
      const b = req.body || {};
      if (!b.companyName || !b.ownerName || !b.email || !b.password) return res.status(422).json({ error: 'كل الحقول مطلوبة' });
      if (String(b.password).length < 8) return res.status(422).json({ error: 'كلمة المرور 8 أحرف على الأقل' });
      const r = await fetch(`${origin}/api/bootstrap`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bootstrap-secret': cfg.bootstrapSecret },
        body: JSON.stringify({ tenantName: b.companyName, companyLegalName: b.companyName, companyDisplayName: b.companyName, ownerFullName: b.ownerName, ownerEmail: b.email, ownerPassword: b.password }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(r.status).json({ error: body.error || 'فشل الإعداد' });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get('/setup', (_q, r) => r.sendFile(path.join(__dirname, 'setup.html')));

  // brand.json: نحقن defaultTenantId تلقائيًا (تثبيت عميل واحد) فيختفي حقل معرّف المستأجر من شاشة الدخول.
  app.get('/brand.json', async (_q, res, next) => {
    try {
      const brand = JSON.parse(fs.readFileSync(path.join(frontend, 'brand.json'), 'utf8'));
      const t = await hasTenant();
      if (t.length === 1) brand.defaultTenantId = t[0].id;
      res.set('Cache-Control', 'no-store').json(brand);
    } catch (e) { next(e); }
  });

  // الواجهة أولًا (بلا ترويسات helmet: upgrade-insecure-requests كانت ستحوّل موارد http://localhost إلى https)، ثم الـAPI فقط للمسارات الخاصة به.
  // لا نستخدم app.use('/api', …) لأن Express يقتطع البادئة، بينما التطبيق الأصلي يعرّف مساراته كاملة (/api/...).
  app.use(express.static(frontend, { index: false, maxAge: '1h' }));
  const api = createApp();
  app.use((req, res, next) => (/^\/(api|health|plugin-assets)(\/|$)/.test(req.path) ? api(req, res, next) : next()));
  app.get('/{*splat}', async (_q, res, next) => {
    try {
      if ((await hasTenant()).length === 0) return res.redirect('/setup');
      res.sendFile(path.join(frontend, 'index.html'));
    } catch (e) { next(e); }
  });

  const servers = [];
  const listen = (host) => new Promise((resolve, reject) => {
    const s = http.createServer(app);
    s.once('error', reject); s.listen(cfg.port, host, () => resolve(s));
  });
  servers.push(await listen('127.0.0.1')); // محلي فقط: لا يُعرَّض للشبكة
  try { servers.push(await listen('::1')); } catch { /* IPv6 غير متاح */ }
  startBackupScheduler(version);
  log(`CobraTex ${version} يعمل على ${origin}`);

  return {
    url: origin, version, dataDir,
    stop: async () => { for (const s of servers) s.close(); try { await pool.end(); } catch { /* ignore */ } await db.stop(); },
  };
}

module.exports = { start };
