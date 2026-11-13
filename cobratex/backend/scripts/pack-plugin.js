#!/usr/bin/env node
/**
 * أداة المطوّر: توقيع إضافة وتحويلها لحزمة تثبيت واحدة (JSON) — بلا مكتبات.
 *   node scripts/pack-plugin.js --gen-keys <مجلد>            ينشئ plugin-private.pem (احفظه سريًا) و plugin-public.pem (يوضع في PLUGIN_PUBLIC_KEY)
 *   node scripts/pack-plugin.js <مجلد-الإضافة> <private.pem> [out.cobraplug.json] [--migrate] [--min-core=2.16.0]
 * يرفع الحزمة لوحة المطوّر (رفع ثنائي Content-Type: application/octet-stream إلى /api/platform/developer/plugins/install).
 */
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ALLOWED = new Set(['.js', '.json', '.css', '.html', '.svg', '.png', '.jpg', '.webp', '.md', '.txt', '.woff2']);
const args = process.argv.slice(2);
if (args[0] === '--gen-keys') {
  const dir = args[1] || '.'; fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(dir, 'plugin-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'plugin-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`تم. المفتاح الخاص: ${dir}/plugin-private.pem (سرّي) — العام: ${dir}/plugin-public.pem (ضعه في PLUGIN_PUBLIC_KEY على الخوادم)`); process.exit(0);
}
const [dir, keyFile, outArg] = args.filter((a) => !a.startsWith('--'));
if (!dir || !keyFile) { console.error('الاستخدام: pack-plugin.js <مجلد-الإضافة> <private.pem> [out]'); process.exit(1); }
const flag = (n) => args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const walk = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name), base + e.name + '/') : [base + e.name]));
const files = walk(dir).filter((f) => ALLOWED.has(path.extname(f).toLowerCase())).map((f) => { const buf = fs.readFileSync(path.join(dir, f)); return { path: f, content: buf.toString('base64'), sha256: crypto.createHash('sha256').update(buf).digest('hex') }; });
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
const minArg = flag('min-core'); const base = { format: 1, name: meta.name, version: meta.version, ...(minArg ? { minCoreVersion: minArg.split('=')[1] } : {}), runMigrate: !!flag('migrate'), files };
const payload = Buffer.from(JSON.stringify({ format: 1, name: base.name, version: base.version, minCoreVersion: base.minCoreVersion ?? null, runMigrate: base.runMigrate, files: files.map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path)) }));
const signature = crypto.sign(null, payload, fs.readFileSync(keyFile, 'utf8')).toString('base64');
const out = outArg || `${meta.name}-${meta.version}.cobraplug.json`; fs.writeFileSync(out, JSON.stringify({ ...base, signature }));
console.log(`حزمة موقَّعة: ${out} (${files.length} ملف)`);
