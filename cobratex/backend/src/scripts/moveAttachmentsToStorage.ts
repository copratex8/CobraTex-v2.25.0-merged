/** CLI: npm run attachments:to-storage  (DRY_RUN=1 للعدّ فقط). المنطق في modules/system/attachmentMigration.ts */
import { moveAttachments } from '@/modules/system/attachmentMigration';
(async () => {
  const { Pool } = await import('pg'); const { buildPoolConfig } = await import('@/db/poolConfig');
  const pool = new Pool({ ...buildPoolConfig(process.env.DATABASE_URL!), max: 1 });
  const r = await moveAttachments(pool, { dryRun: !!process.env.DRY_RUN });
  console.log(JSON.stringify(r)); await pool.end(); process.exit(r.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
