import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';

/**
 * مثبّت الإضافات الموقَّعة (2.16.0): يتيح للمطوّر شحن ميزة/تقرير جديد لأي عميل دون لمس النواة.
 * الحزمة JSON واحدة: { format:1, name, version, minCoreVersion?, runMigrate?, files:[{path, content(base64), sha256}], signature }.
 * التوقيع Ed25519 على (الاسم+الإصدار+مسارات الملفات وبصماتها) — المفتاح الخاص عند المطوّر فقط، والعام في إعداد الخادم
 * (PLUGIN_PUBLIC_KEY). بدون مفتاح عام مُعدّ يُرفض كل تثبيت. لا فك ضغط ولا تنفيذ أوامر؛ الملفات تُكتب في مجلد الإضافات فقط
 * بعد فحص المسارات والامتدادات والبصمات، مع نسخة احتياطية للإصدار السابق وإمكانية الرجوع.
 */
export interface BundleFile { path: string; content: string; sha256: string }
export interface Bundle { format: 1; name: string; version: string; minCoreVersion?: string; runMigrate?: boolean; files: BundleFile[]; signature: string }

export const MAX_FILES = 300; export const MAX_TOTAL_BYTES = 10 * 1024 * 1024; export const KEEP_BACKUPS = 3;
export const ALLOWED_EXT = new Set(['.js', '.json', '.css', '.html', '.svg', '.png', '.jpg', '.webp', '.md', '.txt', '.woff2']);
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/; const VER_RE = /^\d+\.\d+\.\d+$/;

export const cmpVersion = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

/** الحمولة الموقَّعة: ترتيب ثابت لا يتأثر بترتيب الملفات في الحزمة. */
export function signedPayload(b: Pick<Bundle, 'name' | 'version' | 'minCoreVersion' | 'runMigrate' | 'files'>): Buffer {
  const files = [...b.files].map((f) => ({ path: f.path, sha256: f.sha256 })).sort((p, q) => p.path.localeCompare(q.path));
  return Buffer.from(JSON.stringify({ format: 1, name: b.name, version: b.version, minCoreVersion: b.minCoreVersion ?? null, runMigrate: !!b.runMigrate, files }));
}
export function signBundle(b: Omit<Bundle, 'signature'>, privateKeyPem: string): Bundle { return { ...b, signature: crypto.sign(null, signedPayload(b), privateKeyPem).toString('base64') }; }
export function generateKeys() { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }) as string, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }; }

export function safeRelPath(p: unknown): string {
  if (typeof p !== 'string' || !p || p.length > 200) throw new ValidationError('مسار ملف غير صالح');
  if (p.includes('\\') || p.includes('\0') || path.isAbsolute(p) || p.startsWith('/')) throw new ValidationError(`مسار غير مسموح: ${p}`);
  const parts = p.split('/'); if (parts.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) throw new ValidationError(`مسار غير مسموح: ${p}`);
  if (!ALLOWED_EXT.has(path.extname(p).toLowerCase())) throw new ValidationError(`امتداد غير مسموح: ${p}`);
  return parts.join('/');
}

/** يتحقق من البنية والبصمات والتوقيع ويُرجع الملفات مفكوكة. لا يكتب شيئًا. */
export function verifyBundle(raw: unknown, publicKeyPem: string | undefined, coreVersion?: string): { bundle: Bundle; files: Array<{ path: string; data: Buffer }> } {
  if (!publicKeyPem) throw new ValidationError('لم يُضبط PLUGIN_PUBLIC_KEY على هذا الخادم — التثبيت معطَّل');
  const b = raw as Bundle;
  if (!b || typeof b !== 'object' || b.format !== 1) throw new ValidationError('صيغة حزمة غير معروفة');
  if (!NAME_RE.test(String(b.name))) throw new ValidationError('اسم إضافة غير صالح'); if (!VER_RE.test(String(b.version))) throw new ValidationError('إصدار غير صالح (x.y.z)');
  if (!Array.isArray(b.files) || !b.files.length || b.files.length > MAX_FILES) throw new ValidationError('عدد الملفات غير صالح');
  if (b.minCoreVersion !== undefined && !VER_RE.test(String(b.minCoreVersion))) throw new ValidationError('minCoreVersion غير صالح');
  if (typeof b.signature !== 'string' || !b.signature) throw new ValidationError('الحزمة غير موقَّعة');
  let ok = false; try { ok = crypto.verify(null, signedPayload(b), publicKeyPem, Buffer.from(b.signature, 'base64')); } catch { ok = false; }
  if (!ok) throw new ValidationError('توقيع الحزمة غير صالح');
  const seen = new Set<string>(); let total = 0; const files: Array<{ path: string; data: Buffer }> = [];
  for (const f of b.files) {
    const rel = safeRelPath(f?.path); if (seen.has(rel)) throw new ValidationError(`ملف مكرر: ${rel}`); seen.add(rel);
    const data = Buffer.from(String(f.content ?? ''), 'base64'); total += data.length; if (total > MAX_TOTAL_BYTES) throw new ValidationError('حجم الحزمة يتجاوز الحد');
    if (sha(data) !== f.sha256) throw new ValidationError(`بصمة ملف لا تطابق: ${rel}`);
    files.push({ path: rel, data });
  }
  const mf = files.find((f) => f.path === 'plugin.json'); if (!mf) throw new ValidationError('plugin.json مفقود');
  let meta: { name?: string; version?: string }; try { meta = JSON.parse(mf.data.toString('utf8')); } catch { throw new ValidationError('plugin.json ليس JSON صالحًا'); }
  if (meta.name !== b.name || meta.version !== b.version) throw new ValidationError('plugin.json لا يطابق اسم/إصدار الحزمة');
  if (b.minCoreVersion && coreVersion && cmpVersion(coreVersion, b.minCoreVersion) < 0) throw new ValidationError(`تتطلب النواة ${b.minCoreVersion} على الأقل (الحالية ${coreVersion})`);
  return { bundle: b, files };
}

const installedVersion = (dir: string): string | null => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version ?? null; } catch { return null; } };
const rmrf = (p: string) => fs.rmSync(p, { recursive: true, force: true });
function pruneBackups(root: string, name: string) {
  const dir = path.join(root, '.backup'); if (!fs.existsSync(dir)) return;
  const mine = fs.readdirSync(dir).filter((d) => d.startsWith(name + '@')).sort((a, b) => cmpVersion(a.slice(name.length + 1), b.slice(name.length + 1)));
  while (mine.length > KEEP_BACKUPS) rmrf(path.join(dir, mine.shift()!));
}

export interface InstallOpts { pluginsDir: string; publicKey?: string; coreVersion?: string; allowDowngrade?: boolean; migrate?: (pluginDir: string) => Promise<void> }
export async function installBundle(raw: unknown, o: InstallOpts) {
  const { bundle, files } = verifyBundle(raw, o.publicKey, o.coreVersion);
  fs.mkdirSync(o.pluginsDir, { recursive: true });
  const target = path.join(o.pluginsDir, bundle.name); const current = fs.existsSync(target) ? installedVersion(target) : null;
  if (current && cmpVersion(bundle.version, current) <= 0 && !o.allowDowngrade) throw new ConflictError(`الإصدار المثبَّت ${current} ≥ ${bundle.version} — استخدم الرجوع أو allowDowngrade`);
  const staging = path.join(o.pluginsDir, `.staging-${bundle.name}-${Date.now()}`);
  try {
    for (const f of files) { const dest = path.join(staging, f.path); if (!path.resolve(dest).startsWith(path.resolve(staging) + path.sep)) throw new ValidationError('مسار خارج المجلد'); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.data); }
    fs.writeFileSync(path.join(staging, '.install.json'), JSON.stringify({ installedAt: new Date().toISOString(), version: bundle.version, previous: current, signatureSha: sha(Buffer.from(bundle.signature, 'base64')) }));
  } catch (e) { rmrf(staging); throw e; }
  let backup: string | null = null;
  if (current !== null || fs.existsSync(target)) {
    backup = path.join(o.pluginsDir, '.backup', `${bundle.name}@${current ?? '0.0.0'}`); fs.mkdirSync(path.dirname(backup), { recursive: true }); rmrf(backup); fs.renameSync(target, backup);
  }
  fs.renameSync(staging, target);
  let migrated = false;
  if (bundle.runMigrate && o.migrate) {
    try { await o.migrate(target); migrated = true; }
    catch (e) { rmrf(target); if (backup) fs.renameSync(backup, target); throw new ValidationError(`فشلت تهيئة جداول الإضافة فأُعيد الإصدار السابق: ${(e as Error).message}`); }
  }
  pruneBackups(o.pluginsDir, bundle.name);
  return { name: bundle.name, version: bundle.version, previous: current, migrated, restartRequired: true, files: files.length };
}

export function rollbackPlugin(pluginsDir: string, name: string) {
  if (!NAME_RE.test(name)) throw new ValidationError('اسم غير صالح');
  const dir = path.join(pluginsDir, '.backup'); const mine = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith(name + '@')).sort((a, b) => cmpVersion(a.slice(name.length + 1), b.slice(name.length + 1))) : [];
  if (!mine.length) throw new NotFoundError('لا نسخة احتياطية لهذه الإضافة');
  const last = mine[mine.length - 1]; const target = path.join(pluginsDir, name); const from = installedVersion(target);
  rmrf(target); fs.renameSync(path.join(dir, last), target);
  return { name, restoredVersion: last.slice(name.length + 1), replacedVersion: from, restartRequired: true };
}

export function listInstalled(pluginsDir: string) {
  if (!fs.existsSync(pluginsDir)) return [];
  return fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => {
    const d = path.join(pluginsDir, e.name); let install: Record<string, unknown> | null = null; try { install = JSON.parse(fs.readFileSync(path.join(d, '.install.json'), 'utf8')); } catch { /* مثبَّتة يدويًا */ }
    const bdir = path.join(pluginsDir, '.backup'); const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((x) => x.startsWith(e.name + '@')).map((x) => x.slice(e.name.length + 1)) : [];
    return { name: e.name, version: installedVersion(d), installedAt: (install?.installedAt as string) ?? null, viaInstaller: !!install, backups };
  });
}
