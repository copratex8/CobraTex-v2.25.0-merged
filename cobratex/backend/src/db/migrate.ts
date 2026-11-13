import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { buildPoolConfig } from './poolConfig';

/**
 * لماذا لا نستخدم `prisma migrate`؟
 * محرك Prisma (schema-engine) يُنزَّل عند أول تشغيل من binaries.prisma.sh، وهو نطاق غير
 * متاح في شبكة هذه البيئة (انظر DECISIONS.md). لذلك استُبدل بمُشغِّل SQL بسيط يطبّق ملفات
 * .sql مرقّمة بالترتيب، ويسجّل كل ملف مُطبَّق في جدول _migrations لمنع إعادة التطبيق.
 * في بيئة إنتاج تصل فيها الشبكة لموقع Prisma، يمكن استبدال هذا المشغّل بـ `prisma migrate deploy`
 * دون تغيير محتوى ملفات .sql نفسها (تبقى صالحة كمرجع SQL خام).
 */

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL غير مُعرَّف');
  }
  const pool = new Pool({ ...buildPoolConfig(databaseUrl), max: 1 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: appliedRows } = await pool.query('SELECT filename FROM _migrations');
  const applied = new Set(appliedRows.map((r) => r.filename));

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`⏭  تخطي (مُطبَّق سابقًا): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ طُبِّق: ${file}`);
      appliedCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ فشل تطبيق ${file}:`, (err as Error).message);
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(`\nتم. عدد الملفات المُطبَّقة الآن: ${appliedCount} / إجمالي الملفات: ${files.length}`);
  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
