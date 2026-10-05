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
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
