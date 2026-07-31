import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against package sources, not built dist output.
      '@tennis-manager/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@tennis-manager/application': fileURLToPath(
        new URL('../../packages/application/src/index.ts', import.meta.url),
      ),
      '@tennis-manager/api': fileURLToPath(new URL('../api/src/lib.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Real Postgres + real Redis shared with other integration suites.
    fileParallelism: false,
  },
});
