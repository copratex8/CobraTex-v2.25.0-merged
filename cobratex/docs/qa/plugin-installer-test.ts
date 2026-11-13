import * as pi from '@/modules/platform/pluginInstaller';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => unknown, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const mkFile = (p: string, s: string | Buffer) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s); return { path: p, content: b.toString('base64'), sha256: sha(b) }; };
const keys = pi.generateKeys(), other = pi.generateKeys();
const bundle = (version = '1.0.0', extra: any = {}, files?: any[]) => pi.signBundle({ format: 1, name: 'demo-report', version, ...extra, files: files ?? [mkFile('plugin.json', JSON.stringify({ name: 'demo-report', version })), mkFile('index.js', `module.exports={registerRoutes(){},version:'${version}'}`), mkFile('frontend/entry.js', '// ui')] } as any, keys.privateKey);
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  const O = (extra: any = {}) => ({ pluginsDir: dir, publicKey: keys.publicKey, coreVersion: '2.16.0', ...extra });
  // ===== أمان التحقق =====
  await rej(() => pi.installBundle(bundle(), { pluginsDir: dir }), /PLUGIN_PUBLIC_KEY/, 'no public key configured → installer disabled');
  await rej(() => pi.installBundle(bundle(), O({ publicKey: other.publicKey })), /توقيع/, 'signature from another key rejected');
  const tampered = bundle(); tampered.files[1].content = Buffer.from('process.exit(1)').toString('base64'); await rej(() => pi.installBundle(tampered, O()), /بصمة/, 'tampered file content rejected (hash mismatch)');
  const t2 = bundle(); t2.files[1] = mkFile('index.js', 'evil'); await rej(() => pi.installBundle(t2, O()), /توقيع/, 'content+hash replaced but signature mismatch rejected');
  const t3 = bundle(); (t3 as any).version = '9.9.9'; await rej(() => pi.installBundle(t3, O()), /توقيع/, 'version change invalidates signature');
  const unsigned: any = bundle(); delete unsigned.signature; await rej(() => pi.installBundle(unsigned, O()), /غير موقَّعة/, 'unsigned rejected');
  for (const bad of ['../evil.js', '/etc/passwd.js', 'a/../../x.js', '.hidden.js', 'a\\b.js', 'run.sh', 'bin.node', 'x.exe', 'a//b.js']) await rej(() => pi.installBundle(bundle('1.0.0', {}, [mkFile('plugin.json', '{"name":"demo-report","version":"1.0.0"}'), mkFile(bad, 'x')]), O()), /مسار|امتداد/, `path/ext rejected: ${bad}`);
  await rej(() => pi.installBundle(bundle('1.0.0', {}, [mkFile('index.js', 'x')]), O()), /plugin\.json مفقود/, 'plugin.json required');
  await rej(() => pi.installBundle(bundle('1.0.0', {}, [mkFile('plugin.json', '{"name":"other","version":"1.0.0"}')]), O()), /لا يطابق/, 'plugin.json must match bundle');
  await rej(() => pi.installBundle(bundle('1.0.0', {}, [mkFile('plugin.json', '{"name":"demo-report","version":"1.0.0"}'), mkFile('a.js', 'x'), mkFile('a.js', 'y')]), O()), /مكرر/, 'duplicate file rejected');
  await rej(() => pi.installBundle({ ...bundle(), name: '../x' }, O()), /اسم/, 'bad name'); await rej(() => pi.installBundle({ ...bundle(), version: '1.0' }, O()), /إصدار/, 'bad version');
  await rej(() => pi.installBundle(bundle('1.0.0', { minCoreVersion: '3.0.0' }), O()), /تتطلب النواة/, 'minCoreVersion enforced');
  ok(fs.readdirSync(dir).length === 0, 'nothing written by any rejected install');
  // ===== التثبيت =====
  const r1 = await pi.installBundle(bundle('1.0.0'), O()); ok(r1.version === '1.0.0' && r1.previous === null && r1.restartRequired && r1.files === 3, 'first install ok, restart required');
  ok(fs.readFileSync(path.join(dir, 'demo-report', 'frontend/entry.js'), 'utf8') === '// ui', 'nested file written'); ok(fs.existsSync(path.join(dir, 'demo-report', '.install.json')), 'install metadata written');
  await rej(() => pi.installBundle(bundle('1.0.0'), O()), /≥/, 'same version rejected'); await rej(() => pi.installBundle(bundle('0.9.0'), O()), /≥/, 'downgrade rejected by default');
  const r2 = await pi.installBundle(bundle('1.1.0', { minCoreVersion: '2.15.0' }), O()); ok(r2.previous === '1.0.0', 'upgrade reports previous version');
  ok(fs.existsSync(path.join(dir, '.backup', 'demo-report@1.0.0', 'plugin.json')), 'previous version backed up'); ok(!fs.readdirSync(dir).some((d) => d.startsWith('.staging')), 'no staging leftovers');
  ok(JSON.parse(fs.readFileSync(path.join(dir, 'demo-report', 'plugin.json'), 'utf8')).version === '1.1.0', 'new version live');
  // ===== التهيئة (migrate) وفشلها =====
  let ran = ''; const r3 = await pi.installBundle(bundle('1.2.0', { runMigrate: true }), O({ migrate: async (d: string) => { ran = d; } })); ok(r3.migrated && ran.endsWith('demo-report'), 'migrate called after install');
  await rej(() => pi.installBundle(bundle('1.3.0', { runMigrate: true }), O({ migrate: async () => { throw new Error('boom'); } })), /أُعيد الإصدار السابق/, 'failed migrate reported');
  ok(JSON.parse(fs.readFileSync(path.join(dir, 'demo-report', 'plugin.json'), 'utf8')).version === '1.2.0', 'failed migrate → previous version restored');
  // ===== الرجوع والقائمة =====
  const l = pi.listInstalled(dir); ok(l.length === 1 && l[0].version === '1.2.0' && l[0].viaInstaller && l[0].backups.length >= 2, 'list shows version and backups');
  const rb = pi.rollbackPlugin(dir, 'demo-report'); ok(rb.restoredVersion === '1.1.0' && rb.replacedVersion === '1.2.0', 'rollback restores latest backup (1.1.0)');
  ok(JSON.parse(fs.readFileSync(path.join(dir, 'demo-report', 'plugin.json'), 'utf8')).version === '1.1.0', 'rolled-back version live');
  await rej(() => pi.rollbackPlugin(dir, 'nope-x'), /لا نسخة/, 'rollback without backup'); await rej(() => pi.rollbackPlugin(dir, '../x'), /اسم/, 'rollback name validated');
  // downgrade مسموح صراحةً + تقليم النسخ الاحتياطية
  for (const v of ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0']) await pi.installBundle(bundle(v), O());
  ok(fs.readdirSync(path.join(dir, '.backup')).filter((d) => d.startsWith('demo-report@')).length <= pi.KEEP_BACKUPS, `backups pruned to ${pi.KEEP_BACKUPS}`);
  const r4 = await pi.installBundle(bundle('1.5.0'), O({ allowDowngrade: true })); ok(r4.previous === '2.4.0', 'explicit downgrade allowed');
  ok(pi.cmpVersion('1.10.0', '1.9.0') === 1 && pi.cmpVersion('1.0.0', '1.0.0') === 0, 'numeric version compare (1.10 > 1.9)');
  // حجم
  const big = bundle('9.0.0', {}, [mkFile('plugin.json', '{"name":"demo-report","version":"9.0.0"}'), mkFile('big.txt', Buffer.alloc(11 * 1024 * 1024, 65))]); await rej(() => pi.installBundle(big, O()), /الحد/, 'oversize rejected');
  // أداة التوقيع CLI تنتج حزمة يقبلها المثبّت
  const { execFileSync } = require('child_process'); const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')); const src = path.join(work, 'src'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'plugin.json'), '{"name":"cli-plugin","version":"1.0.0"}'); fs.writeFileSync(path.join(src, 'index.js'), 'module.exports={}'); fs.writeFileSync(path.join(src, '.secret'), 'x');
  execFileSync('node', ['/home/claude/cobratex/backend/scripts/pack-plugin.js', '--gen-keys', path.join(work, 'k')]); const out = path.join(work, 'out.json');
  execFileSync('node', ['/home/claude/cobratex/backend/scripts/pack-plugin.js', src, path.join(work, 'k', 'plugin-private.pem'), out, '--min-core=2.0.0']);
  const cliB = JSON.parse(fs.readFileSync(out, 'utf8')); ok(cliB.files.length === 2 && !cliB.files.some((f: any) => f.path.startsWith('.')), 'CLI skips hidden files');
  const rc = await pi.installBundle(cliB, { pluginsDir: dir, publicKey: fs.readFileSync(path.join(work, 'k', 'plugin-public.pem'), 'utf8'), coreVersion: '2.16.0' }); ok(rc.name === 'cli-plugin', 'CLI-signed bundle verifies and installs');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message || e); process.exit(1); });
