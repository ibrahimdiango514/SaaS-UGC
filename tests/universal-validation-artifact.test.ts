import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildBundle, renderLoader, renderSeedSql } from '../scripts/build-edge-loader.mjs';
it('pins the validation deployment to the exact tested source, without replacing old artifact names', () => {
  const built = buildBundle(process.cwd(),'universal-catalog');
  const name = `universal-catalog-${built.sha256}`;
  expect(readFileSync('artifacts/universal-validation/loader.ts','utf8')).toBe(renderLoader(name,built));
  expect(readFileSync('artifacts/universal-validation/publish.sql','utf8')).toBe(`begin;\n${renderSeedSql(name,built)}commit;\n`);
  expect(readFileSync('supabase/functions/universal-catalog.edge.js','utf8')).toBe(built.source);
});
