import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
import { once } from 'events';
import type { PoolClient } from 'pg';
import { pool } from '@/db/pool';
import { AppError } from '@/shared/errors';

/**
 * نسخ احتياطي/استعادة منطقيان لقاعدة PostgreSQL بلا أي اعتماد على pg_dump (لا يتوفر في exe ولا على Vercel).
 *
 * صيغة الملف (.cbk): gzip لنص أسطر (NDJSON):
 *   سطر 1 : ترويسة {format:'cobratex-backup', version, createdAt, migrations[], tables[{name,columns,count}]}
 *   ثم لكل جدول: سطر علامة {"$table":"اسم"} يليه سطر لكل صف = ناتج row_to_json(...)::text الحرفي من PostgreSQL.
 * لا يُحلَّل JSON الصفوف في JavaScript إطلاقًا → لا فقد دقة للأرقام العشرية (NUMERIC) ولا تحويل للتواريخ/BYTEA؛
 * وعند الاستعادة تُعاد عبر json_populate_recordset فتعود الأنواع كما كانت تمامًا.
 * اللقطة متّسقة: كل القراءة داخل معاملة REPEATABLE READ READ ONLY واحدة.
 */

export const BACKUP_FORMAT = 'cobratex-backup';
export const BACKUP_VERSION = 1;
const ROW_BATCH = 500;
const BATCH_BYTES = 8 * 1024 * 1024;

/** جداول لا تُنسخ ولا تُستعاد: سجل الهجرات (يخص مخطط النسخة الحالية) وإعدادات النسخ نفسها (فيها أسرار Google). */
const EXCLUDED = new Set(['_migrations', 'backup_settings']);

export interface BackupFileInfo {
  name: string;
  path: string;
  sizeBytes: number;
  tables: number;
  rows: number;
  durationMs: number;
}

export function backupDir(): string {
  const dir = process.env.BACKUP_DIR || path.join(os.tmpdir(), 'cobratex-backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}`;
}

/** أسماء ملفات النسخ مقيَّدة بنمط ثابت: يمنع اجتياز المسارات عند التنزيل/الحذف من مجلد النسخ. */
export const BACKUP_NAME_RE = /^cobratex-[A-Za-z0-9_-]{1,40}\.cbk$/;

interface TableMeta { name: string; columns: string[]; }

async function listTables(client: PoolClient): Promise<TableMeta[]> {
  const t = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const names: string[] = t.rows.map((r) => r.tablename).filter((n: string) => !EXCLUDED.has(n));
  const c = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND is_generated = 'NEVER' ORDER BY table_name, ordinal_position`,
  );
  const cols = new Map<string, string[]>();
  for (const r of c.rows) {
    const arr = cols.get(r.table_name) ?? [];
    arr.push(r.column_name);
    cols.set(r.table_name, arr);
  }
  const metas = names.map((name) => ({ name, columns: cols.get(name) ?? [] }));
  return topoSort(metas, await fkEdges(client));
}

/** حواف المفاتيح الأجنبية: [الجدول التابع, الجدول المرجعي]. */
async function fkEdges(client: PoolClient): Promise<Array<[string, string]>> {
  const r = await client.query(
    `SELECT c.relname AS child, p.relname AS parent
     FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
     JOIN pg_class p ON p.oid = k.confrelid
     WHERE k.contype = 'f' AND cn.nspname = 'public' AND k.conrelid <> k.confrelid`,
  );
  return r.rows.map((x) => [x.child, x.parent]);
}

/** ترتيب طوبولوجي: الآباء قبل الأبناء (Kahn). الحلقات (إن وُجدت) تُلحَق بالنهاية بترتيب الاسم. */
export function topoSort(metas: TableMeta[], edges: Array<[string, string]>): TableMeta[] {
  const byName = new Map(metas.map((m) => [m.name, m]));
  const indeg = new Map<string, number>(metas.map((m) => [m.name, 0]));
  const children = new Map<string, string[]>();
  for (const [child, parent] of edges) {
    if (!byName.has(child) || !byName.has(parent)) continue;
    indeg.set(child, (indeg.get(child) ?? 0) + 1);
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n).sort();
  const out: TableMeta[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    out.push(byName.get(n)!);
    for (const ch of children.get(n) ?? []) {
      indeg.set(ch, indeg.get(ch)! - 1);
      if (indeg.get(ch) === 0) { ready.push(ch); ready.sort(); }
    }
  }
  const done = new Set(out.map((m) => m.name));
  for (const m of metas) if (!done.has(m.name)) out.push(m);
  return out;
}

async function writeLine(stream: NodeJS.WritableStream, line: string) {
  if (!stream.write(line + '\n')) await once(stream, 'drain');
}

/** ينشئ ملف نسخة احتياطية كاملة داخل backupDir ويُرجع معلوماته. */
export async function createBackupFile(appVersion = 'unknown'): Promise<BackupFileInfo> {
  const started = Date.now();
  const name = `cobratex-${stamp()}.cbk`;
  const filePath = path.join(backupDir(), name);
  const tmpPath = filePath + '.part';

  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmpPath);
  gzip.pipe(out);
  const finished = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gzip.on('error', reject); });

  const client = await pool.connect();
  let totalRows = 0;
  let tableCount = 0;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await listTables(client);
    const mig = await client.query(`SELECT filename FROM _migrations ORDER BY filename`).catch(() => ({ rows: [] as { filename: string }[] }));
    const meta = [];
    for (const t of tables) {
      const cnt = await client.query(`SELECT count(*)::bigint AS n FROM ${q(t.name)}`);
      meta.push({ name: t.name, columns: t.columns, count: Number(cnt.rows[0].n) });
    }
    await writeLine(gzip, JSON.stringify({
      format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(), appVersion,
      migrations: mig.rows.map((r) => r.filename), tables: meta,
    }));
    for (const t of meta) {
      await writeLine(gzip, JSON.stringify({ $table: t.name }));
      if (t.count === 0) continue;
      await client.query(`DECLARE bk_cur NO SCROLL CURSOR FOR SELECT row_to_json(x)::text AS j FROM ${q(t.name)} x`);
      for (;;) {
        const batch = await client.query(`FETCH 1000 FROM bk_cur`);
        if (batch.rows.length === 0) break;
        for (const r of batch.rows) await writeLine(gzip, r.j);
        totalRows += batch.rows.length;
      }
      await client.query(`CLOSE bk_cur`);
      tableCount++;
    }
    await client.query('COMMIT');
    gzip.end();
    await finished;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    gzip.destroy();
    out.destroy();
    fs.rmSync(tmpPath, { force: true });
    throw err;
  } finally {
    client.release();
  }
  return { name, path: filePath, sizeBytes: fs.statSync(filePath).size, tables: tableCount, rows: totalRows, durationMs: Date.now() - started };
}

export interface RestoreResult { tables: number; rows: number; usedReplicaRole: boolean; safetyBackup: string | null; }

interface Header {
  format: string; version: number; createdAt: string; appVersion?: string;
  migrations: string[]; tables: Array<{ name: string; columns: string[]; count: number }>;
}

function lineReader(filePath: string): readline.Interface {
  const input = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  return readline.createInterface({ input, crlfDelay: Infinity });
}

/** يقرأ الترويسة ويتحقق منها فقط (بلا أي تعديل في قاعدة البيانات). */
export async function readBackupHeader(filePath: string): Promise<Header> {
  const rl = lineReader(filePath);
  try {
    for await (const line of rl) {
      let h: Header;
      try { h = JSON.parse(line) as Header; } catch { throw new AppError('ملف النسخة الاحتياطية تالف أو ليس بصيغة CobraTex', 422); }
      if (h.format !== BACKUP_FORMAT) throw new AppError('هذا الملف ليس نسخة احتياطية من CobraTex', 422);
      if (h.version !== BACKUP_VERSION) throw new AppError(`إصدار صيغة النسخة غير مدعوم: ${h.version}`, 422);
      return h;
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('تعذّرت قراءة الملف: ليس ملف نسخة احتياطية صالحًا', 422);
  } finally {
    rl.close();
  }
  throw new AppError('ملف النسخة الاحتياطية فارغ', 422);
}

/**
 * استعادة كاملة: تستبدل بيانات كل الجداول ببيانات النسخة داخل معاملة واحدة — إما تنجح كلها أو لا يتغيّر شيء.
 * تُنشئ قبلها نسخة أمان تلقائية (يُرجَع اسمها). تتحمّل اختلاف الإصدار: أعمدة النسخة غير الموجودة حاليًا تُهمَل،
 * والأعمدة الجديدة غير الموجودة في النسخة تأخذ قيمها الافتراضية. ترفض نسخة فيها هجرات لم تُطبَّق على هذه القاعدة.
 */
export async function restoreBackupFile(filePath: string, appVersion = 'unknown'): Promise<RestoreResult> {
  const header = await readBackupHeader(filePath);

  const applied = await pool.query(`SELECT filename FROM _migrations`);
  const have = new Set(applied.rows.map((r) => r.filename as string));
  const unknown = header.migrations.filter((m) => !have.has(m));
  if (unknown.length) {
    throw new AppError(`النسخة من إصدار أحدث من هذا النظام (هجرات غير مُطبَّقة: ${unknown.slice(0, 3).join(', ')}). حدّث النظام أولًا.`, 409);
  }

  let safety: string | null = null;
  try { safety = (await createBackupFile(appVersion)).name; } catch { /* نسخة الأمان best-effort؛ لا تمنع الاستعادة إن تعذّرت */ }

  const client = await pool.connect();
  let usedReplica = false;
  let rows = 0;
  let tables = 0;
  try {
    await client.query('BEGIN');
    const dbTables = await listTables(client); // بترتيب الآباء أولًا
    const dbMap = new Map(dbTables.map((t) => [t.name, t]));

    // أسرع وأسلم: تعطيل الزنادات وفحص المفاتيح الأجنبية أثناء الاستعادة إن سمحت الصلاحيات؛ وإلا نعتمد الترتيب الطوبولوجي.
    try {
      await client.query('SAVEPOINT replica_try');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query('RELEASE SAVEPOINT replica_try');
      usedReplica = true;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT replica_try');
    }

    if (dbTables.length) {
      await client.query(`TRUNCATE ${dbTables.map((t) => q(t.name)).join(', ')} RESTART IDENTITY CASCADE`);
    }

    const rl = lineReader(filePath);
    let current: TableMeta | null = null;
    let useCols: string[] = [];
    let batch: string[] = [];
    let batchBytes = 0;
    let first = true;

    const flush = async () => {
      if (!current || batch.length === 0) { batch = []; batchBytes = 0; return; }
      const cols = useCols.map(q).join(', ');
      await client.query(
        `INSERT INTO ${q(current.name)} (${cols}) OVERRIDING SYSTEM VALUE
         SELECT ${cols} FROM json_populate_recordset(null::${q(current.name)}, $1::json)`,
        ['[' + batch.join(',') + ']'],
      );
      rows += batch.length;
      batch = []; batchBytes = 0;
    };

    for await (const line of rl) {
      if (first) { first = false; continue; } // الترويسة
      if (line.startsWith('{"$table":')) {
        await flush();
        const name = (JSON.parse(line) as { $table: string }).$table;
        current = dbMap.get(name) ?? null; // جدول غير موجود في هذا الإصدار → يُتجاهل
        const inBackup = header.tables.find((t) => t.name === name)?.columns ?? [];
        useCols = current ? inBackup.filter((c) => current!.columns.includes(c)) : [];
        if (current) tables++;
        continue;
      }
      if (!current || line.length === 0) continue;
      batch.push(line);
      batchBytes += line.length;
      if (batch.length >= ROW_BATCH || batchBytes >= BATCH_BYTES) await flush();
    }
    await flush();

    // إعادة ضبط المتسلسلات (serial/identity) فوق أكبر قيمة مُستعادة.
    const seqs = await client.query(
      `SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
       FROM pg_class s
       JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a','i')
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       WHERE s.relkind = 'S'`,
    );
    for (const s of seqs.rows) {
      if (EXCLUDED.has(s.tbl)) continue;
      await client.query(
        `SELECT setval(format('%I.%I','public',$1::text)::regclass, COALESCE((SELECT max(${q(s.col)}) FROM ${q(s.tbl)}), 1), (SELECT max(${q(s.col)}) IS NOT NULL FROM ${q(s.tbl)}))`,
        [s.seq],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  return { tables, rows, usedReplicaRole: usedReplica, safetyBackup: safety };
}

/** نسخ محلية في backupDir (للتشغيل على جهاز/خادم بقرص دائم) — الأحدث أولًا. */
export function listLocalBackups(): Array<{ name: string; sizeBytes: number; modifiedAt: string }> {
  const dir = backupDir();
  return fs.readdirSync(dir).filter((n) => BACKUP_NAME_RE.test(n)).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
  }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function pruneLocalBackups(keep: number): string[] {
  const all = listLocalBackups();
  const removed: string[] = [];
  for (const b of all.slice(keep)) { fs.rmSync(path.join(backupDir(), b.name), { force: true }); removed.push(b.name); }
  return removed;
}

export function localBackupPath(name: string): string {
  if (!BACKUP_NAME_RE.test(name)) throw new AppError('اسم ملف غير صالح', 422);
  const p = path.join(backupDir(), name);
  if (!fs.existsSync(p)) throw new AppError('الملف غير موجود', 404);
  return p;
}
