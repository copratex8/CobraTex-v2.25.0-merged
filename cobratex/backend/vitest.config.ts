import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'path';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
    // تنفيذ تسلسلي: كل الاختبارات تتشارك قاعدة بيانات اختبار واحدة، والتسلسل يمنع تداخل
    // اختبارات التزامن (concurrency) مع بعضها البعض عبر ملفات مختلفة.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
