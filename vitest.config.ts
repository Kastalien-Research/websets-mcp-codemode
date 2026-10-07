import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config();

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', '.claude/worktrees/**'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run test files sequentially to avoid Exa API rate limits during integration tests
    fileParallelism: false,
    // Worker threads intermittently SIGSEGV on teardown with the native
    // better-sqlite3 addon (2/8 runs vs 0/20 with forks).
    pool: 'forks',
  },
});
