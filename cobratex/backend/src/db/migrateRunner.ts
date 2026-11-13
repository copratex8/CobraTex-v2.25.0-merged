import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

/**
 * مشغّل هجرات قابل للاستدعاء من داخل العملية (يستخدمه غلاف سطح المكتب/exe عند كل إقلاع).
 * نفس منطق migrate.ts تمامًا (ملفات .sql مرتبة، كل ملف في معاملة، سجل _migrations)، لكنه يُرجع النتيجة بدل process.exit.
 */
export async function runMigrations(pool: Pool, migrationsDir: string, log: (m: string) => void = () => undefined): Promise<number> {
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT filename FROM _migrations');
  const applied = new Set(rows.map((r) => r.filename as string));
  let n = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log(`migrated ${file}`);
      n++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`فشل تطبيق الهجرة ${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return n;
}
