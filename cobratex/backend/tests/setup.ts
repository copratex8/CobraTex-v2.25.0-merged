import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.test'), override: true });

import { afterAll } from 'vitest';
import { closePool } from '@/db/pool';

afterAll(async () => {
  await closePool();
});
