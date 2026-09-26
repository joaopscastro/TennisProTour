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
    },
  },
  test: {
    // `scripts/**/*.test.mjs` — the soak/agent harness's shared pure
    // helpers (scripts/lib/*.mjs) are regression-covered here too; see
    // scripts/lib/soakEvidence.test.mjs.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Integration tests hit one shared Postgres instance; run files
    // sequentially so table cleanup in one file can't race another.
    fileParallelism: false,
  },
});
