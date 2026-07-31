import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration tests hit one shared Postgres instance; run files
    // sequentially so table cleanup in one file can't race another.
    fileParallelism: false,
  },
});
