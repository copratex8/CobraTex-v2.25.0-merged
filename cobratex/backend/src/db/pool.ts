import { Pool, PoolClient } from 'pg';
import { config } from '@/config';
import { buildPoolConfig } from '@/db/poolConfig';

/**
 * اتصال آمن بقاعدة البيانات:
 * - سلسلة الاتصال تُقرأ حصرًا من متغير بيئة (لا قيمة مكتوبة في الشيفرة).
 * - Pool واحد يُعاد استخدامه (لا اتصال جديد لكل طلب).
 * - كل عملية كتابة متعددة الخطوات تمر عبر withTransaction() لضمان atomic transaction حقيقية،
 *   مطابقةً لمتطلب "كل عملية حفظ (مستند + مخزون + قيد) ضمن معاملة واحدة" في ARCHITECTURE.md.
 */
export const pool = new Pool(buildPoolConfig(config.databaseUrl));

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
