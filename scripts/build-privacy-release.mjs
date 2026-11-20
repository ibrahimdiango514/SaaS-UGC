#!/usr/bin/env node
/** Immutable, content-addressed publication. Old cold-start loaders keep their
 * original names. Never overwrite their slices during a rolling deployment.
 * Run after tests; apply SQL transaction, verify it, then deploy these loaders.
 * This script neither contacts a provider nor deploys anything. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildBundle, renderLoader, renderSeedSql } from './build-edge-loader.mjs';
const root = process.cwd();
const dir = `${root}/artifacts/privacy-release`;
mkdirSync(dir, { recursive: true });
const manifest = [];
let sql = 'begin;\n';
for (const slug of ['video-quote', 'reelora-video', 'vyora-ai']) {
  const built = buildBundle(root, slug);
  const name = `${slug}-${built.sha256}`;
  // renderSeedSql deletes ONLY this digest's rows, never an old artifact.
  sql += renderSeedSql(name, built) + '\n';
  writeFileSync(`${dir}/${slug}.loader.ts`, renderLoader(name, built));
  manifest.push({ slug, artifact: name, sha256: built.sha256, chars: built.chars, parts: built.slices.length });
}
sql += 'commit;\n';
writeFileSync(`${dir}/publish.sql`, sql);
writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared immutable privacy release; no deployment performed.');
