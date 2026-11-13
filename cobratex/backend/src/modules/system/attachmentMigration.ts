/** ينقل المرفقات القديمة (BYTEA) إلى Supabase Storage دفعات صغيرة، آمنًا وقابلًا للاستئناف:
 *  npm run attachments:to-storage            (يعالج الكل)   |  DRY_RUN=1 npm run attachments:to-storage (يعدّ فقط)
 *  لكل صف: رفع الكائن ← تحقق الحجم ← ثم فقط تصفير file_data. أي فشل يُوقف الصف دون فقد بيانات. */
import type { Pool } from 'pg';
import { storageEnabled, putObject, getObject, objectPath } from '@/modules/system/attachmentStorage';

export async function moveAttachments(pool: Pool, opts: { dryRun?: boolean; batch?: number } = {}) {
  if (!storageEnabled() && !opts.dryRun) throw new Error('اضبط SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY أولًا');
  const batch = opts.batch ?? 20; let moved = 0, failed = 0, bytes = 0; const errors: string[] = [];
  const total = Number((await pool.query(`SELECT count(*)::int AS n FROM attachments WHERE storage_path IS NULL AND file_data IS NOT NULL`)).rows[0].n);
  if (opts.dryRun) return { total, moved, failed, bytes, errors };
  for (;;) {
    const rows = (await pool.query(`SELECT id, company_id, entity_type, mime_type, file_data FROM attachments WHERE storage_path IS NULL AND file_data IS NOT NULL ORDER BY created_at LIMIT $1`, [batch])).rows;
    const todo = rows.filter((r) => !errors.some((e) => e.startsWith(r.id)));
    if (!todo.length) break;
    for (const r of todo) {
      const path = objectPath(r.company_id, r.entity_type, r.id, r.mime_type);
      try {
        await putObject(path, r.file_data, r.mime_type).catch(async (e) => { if (!/\(409\)|\(400\)/.test(String(e.message))) throw e; }); // موجود مسبقًا من محاولة سابقة
        const back = await getObject(path); if (back.length !== r.file_data.length) throw new Error('حجم الكائن بعد الرفع لا يطابق الأصل');
        await pool.query(`UPDATE attachments SET storage_path=$2, file_data=NULL WHERE id=$1 AND storage_path IS NULL`, [r.id, path]); moved++; bytes += r.file_data.length;
      } catch (e) { failed++; errors.push(`${r.id}: ${(e as Error).message}`); }
    }
    if (todo.length < batch && failed === 0) break;
    if (failed >= 5) break; // لا نكرّر الفشل بلا نهاية
  }
  return { total, moved, failed, bytes, errors };
}

