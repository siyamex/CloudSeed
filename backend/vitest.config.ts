import { defineConfig } from 'vitest/config';

// PGlite boots a full in-process Postgres per test environment, which is slow when several test files run in parallel.
const workers = Number(process.env.TEST_WORKERS) || (process.env.TEST_DB === 'postgres' ? undefined : 2);

export default defineConfig({
  test: {
    testTimeout: 30_000, hookTimeout: 60_000,
    // Every in-process PGlite is a WebAssembly Postgres with its own memory, so too many at once can exhaust a small
    // machine. TEST_WORKERS=1 runs the files strictly one after another.
    fileParallelism: workers !== 1,
    maxWorkers: workers,
    // TEST_DB=postgres runs the whole suite against a throwaway real PostgreSQL server instead of PGlite.
    globalSetup: process.env.TEST_DB === 'postgres' ? ['test/global-pg.ts'] : [],
  },
});
