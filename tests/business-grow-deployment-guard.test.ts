import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Garde de publication Netlify', () => {
  const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const command = config.match(/^\s*ignore\s*=\s*'([^']+)'\s*$/m)?.[1];

  function isBuildIgnored(branch: string, head: string): boolean {
    expect(command, 'La commande Netlify de protection doit être présente').toBeTruthy();
    const result = spawnSync('sh', ['-c', command!], {
      env: { PATH: process.env.PATH ?? '', BRANCH: branch, HEAD: head },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    return result.status === 0; // Convention Netlify : 0 annule le build.
  }

  it.each(['arena/323bad30-saas-ugc', 'arena/ada94e4c-saas-ugc'])(
    'annule les builds pour %s, que le nom figure dans BRANCH ou HEAD',
    (branch) => {
      expect(isBuildIgnored(branch, '')).toBe(true);
      expect(isBuildIgnored('', branch)).toBe(true);
    },
  );

  it('ne modifie pas le comportement de main ni des autres branches', () => {
    expect(isBuildIgnored('main', 'main')).toBe(false);
    expect(isBuildIgnored('another-branch', 'another-branch')).toBe(false);
  });
});
