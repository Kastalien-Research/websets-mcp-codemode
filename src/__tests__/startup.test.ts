import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('production startup', () => {
  it('fails with actionable guidance when EXA_API_KEY is missing', () => {
    const env = { ...process.env };
    delete env.EXA_API_KEY;
    delete env.ALLOW_NO_EXA_KEY;

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts'],
      {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXA_API_KEY is not set.');
    expect(result.stderr).toContain('ALLOW_NO_EXA_KEY=1');
  });
});
