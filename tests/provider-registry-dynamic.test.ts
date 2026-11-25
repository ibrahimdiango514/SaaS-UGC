// SORAHNEX — garde-fou « catalogue de fournisseurs NON figé ».
//
// Décision produit du 2026-11-14 : la liste des fournisseurs IA ne doit jamais
// être écrite dans le code, une migration ou un fichier de configuration. Elle
// vit dans le registre central (`saas_business.ai_providers`) et évolue par une
// ligne de registre + un secret Edge.
//
// Ces tests échouent dès qu'une liste réapparaît — c'est leur seule raison d'être.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Fournisseurs antérieurement écrits en dur : toute réapparition est une régression. */
const LEGACY_PROVIDER_IDS = [
  'deepseek', 'mistral', 'grok', 'openrouter', 'openai', 'anthropic', 'llm7', 'gonka', 'kilo',
];

const CORE_FILES = [
  'supabase/functions/_shared/ai-core/adapters.ts',
  'supabase/functions/_shared/ai-core/engine.ts',
  'supabase/functions/_shared/ai-core/registry.ts',
  'supabase/functions/vyora-ai/index.ts',
  'supabase/functions/business-grow/providers.ts',
  'supabase/functions/business-grow/index.ts',
];

describe('registre dynamique — aucun catalogue de fournisseurs figé', () => {
  it('n’exporte plus de table AI_PROVIDERS ni d’adaptateur natif par fournisseur', () => {
    const adapters = read('supabase/functions/_shared/ai-core/adapters.ts');
    expect(adapters).not.toMatch(/export\s+const\s+AI_PROVIDERS/);
    // Un seul protocole subsiste : `openai`. Aucun fournisseur n'est nommé.
    expect(adapters).not.toMatch(/NATIVE_ADAPTERS|getAiAdapter/);
    expect(adapters).toMatch(/descriptor\.kind !== 'openai'/);
    for (const provider of ['groq', 'gemini', 'cloudflare', 'openrouter', 'llm7', 'gonka']) {
      expect(adapters.toLowerCase()).not.toContain(provider);
    }
  });

  it('ne contient aucune union de fournisseurs ni liste blanche de clés', () => {
    for (const file of CORE_FILES) {
      const source = read(file);
      // Une union fermée de fournisseurs (`type X = 'a' | 'b' | ...`) interdirait
      // l'ajout d'un fournisseur sans modification de code.
      expect(source, file).not.toMatch(/type\s+\w*Provider(?:Name|Id)?\s*=\s*\n?\s*'[a-z0-9_-]+'\s*\n?\s*\|/);
      expect(source, file).not.toMatch(/PROVIDER_NAMES\s*(?::[^=]+)?=\s*\[/);
    }
  });

  it('le moteur accepte n’importe quelle clé de fournisseur valide (aucun catalogue)', () => {
    const providers = read('supabase/functions/business-grow/providers.ts');
    // La validation porte sur la FORME de l'identifiant, pas sur une liste.
    expect(providers).toMatch(/\^\[a-z\]\[a-z0-9_-\]\{1,39\}\$/);
    // `providerOrder` ne filtre plus par liste blanche de fournisseurs.
    const orderFn = providers.slice(providers.indexOf('export function providerOrder'));
    expect(orderFn.slice(0, 600)).not.toMatch(/supported\s*[:=]\s*\[/);
  });

  it('la migration additive ne crée AUCUN fournisseur (pas de fournisseur fictif)', () => {
    const migration = read('supabase/migrations/20261114140000_vyora_ai_provider_dynamic_registry.sql');
    // Aucune insertion AU NIVEAU DU SCRIPT : le seul `insert` admis est celui de
    // la fonction d'administration (appelée explicitement par un administrateur),
    // jamais une ligne créée par la migration elle-même.
    const scriptOnly = migration.slice(0, migration.indexOf('create or replace function public.vyora_ai_admin_provider_upsert'));
    expect(scriptOnly).not.toMatch(/insert\s+into\s+saas_business\.ai_providers/i);
    // Elle ne fait que compléter les lignes déjà présentes.
    expect(migration).toMatch(/update\s+saas_business\.ai_providers/i);
    // Aucune clé : uniquement le NOM de la variable qui la porte.
    expect(migration).toMatch(/api_key_env/);
    expect(migration).not.toMatch(/sk-[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}/);
  });

  it('l’interface d’administration n’écrit aucune liste de fournisseurs', () => {
    for (const file of ['src/business/ai/registry.ts', 'src/business/BusinessGrowWorkspace.tsx']) {
      const source = read(file);
      expect(source, file).not.toMatch(/BUSINESS_PROVIDERS\s*(?::[^=]+)?=\s*\[/);
      expect(source, file).not.toMatch(/EXTENSIBLE_PROVIDER_ADAPTERS\s*(?::[^=]+)?=\s*\[/);
    }
  });

  it('les fichiers de test et sources ne réintroduisent pas de catalogue hérité', () => {
    // On autorise les mentions historiques dans les migrations (données) et la
    // documentation (procédure de réception), jamais dans le code applicatif.
    const sources = readdirSync(join(root, 'src'), { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'))
      .map((entry) => `src/${entry.replaceAll('\\', '/')}`)
      .filter((file) => !file.endsWith('.test.ts'));

    for (const file of sources) {
      const source = read(file);
      for (const provider of LEGACY_PROVIDER_IDS) {
        // Interdit uniquement sous forme de tableau/union de fournisseurs.
        expect(source, `${file} contient une liste de fournisseurs (${provider})`)
          .not.toMatch(new RegExp(`[[,]\\s*'${provider}'\\s*,`));
      }
    }
  });
});
