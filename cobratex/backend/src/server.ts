import { createApp } from '@/app';
import fs from 'fs';
import path from 'path';
import { config } from '@/config';
import { startBackupScheduler } from '@/modules/backup/driveService';

const app = createApp();
app.listen(config.port, () => {
  try { startBackupScheduler(fs.readFileSync(path.resolve(process.cwd(), 'VERSION'), 'utf-8').trim()); } catch { startBackupScheduler('unknown'); }
  // eslint-disable-next-line no-console
  console.log(`CobraTex ERP backend listening on port ${config.port} (${config.nodeEnv})`);
});
