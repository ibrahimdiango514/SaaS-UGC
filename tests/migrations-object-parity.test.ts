import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Parité entre ce que le code appelle et ce que les migrations créent.
 *
 * ## Le défaut que ce test empêche
 * En production, deux RPC appelées par `src/lib/api.ts` n'existaient pas en
 * base : `vyora_ai_admin_provider_upsert` et `vyora_ai_admin_provider_disable`.
 * Les migrations correspondantes étaient présentes dans le dépôt, mais leur
 * version n'avait jamais été appliquée sur le projet — et rien ne le signalait.
 * Les tests unitaires ne pouvaient pas le voir : ils simulent la couche `rpc()`.
 *
 * Ce test ne remplace pas une vérification en base (impossible hors ligne), mais
 * il garantit qu'aucune RPC appelée par le code n'est orpheline de migration.
 */
const MIGRATIONS = 'supabase/migrations';
const API = 'src/lib/api.ts';

/** Noms des RPC réellement invoquées depuis la couche API. */
function calledRpcs(): string[] {
  const source = readFileSync(API, 'utf8');
  const names = new Set<string>();
  const pattern = /rpc(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) names.add(match[1]);
  return [...names].sort();
}

/** Toutes les définitions de fonctions présentes dans les migrations. */
function definedFunctions(): Set<string> {
  const defined = new Set<string>();
  const pattern = /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_]+\.)?([a-z0-9_]+)\s*\(/gi;
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql)) !== null) defined.add(match[1].toLowerCase());
  }
  return defined;
}

describe('parité migrations ↔ code', () => {
  it('inventorie les RPC appelées par la couche API', () => {
    const names = calledRpcs();
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain('vyora_ai_admin_provider_upsert');
    expect(names).toContain('vyora_ai_admin_provider_disable');
  });

  it('n’appelle aucune RPC sans définition dans les migrations', () => {
    const defined = definedFunctions();
    const orphans = calledRpcs().filter((name) => !defined.has(name.toLowerCase()));
    expect(orphans).toEqual([]);
  });
});
