// The offline suite used by invariants G2 and G3: every test file except the
// live-API e2e and integration suites, with the network guard installed and no
// dotenv loading (the verifier also strips credentials from the environment).

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  test: {
    root,
    exclude: [
      'dist/**',
      'node_modules/**',
      '.claude/worktrees/**',
      'src/__tests__/e2e/**',
      '**/integration/**',
    ],
    setupFiles: [fileURLToPath(new URL('./net-guard.setup.ts', import.meta.url))],
    // vitest 1.x defaults to worker threads, where native addons
    // (better-sqlite3) intermittently SIGSEGV on teardown: 2/8 runs crashed
    // with threads, 0/20 with forks.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
