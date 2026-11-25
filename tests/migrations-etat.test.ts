import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RACINE = process.cwd();
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), 'utf8');

const MIGRATION_VUES = 'supabase/migrations/20261125130000_public_views_reconstruction.sql';

/**
 * Reconstruction des vues `public` — garde-fous.
 *
 * Le frontend n'interroge que le schéma `public` (seul exposé par PostgREST),
 * alors que les tables vivent dans `saas_ugc`. Les vues qui font le pont avaient
 * été créées dans le tableau de bord, jamais dans une migration : sur une base
 * neuve reconstruite depuis ce dépôt, toutes les lectures échouent.
 *
 * Ces tests empêchent la réapparition du trou et, surtout, empêchent qu'une vue
 * soit un jour écrite SANS `security_invoker` — auquel cas elle contournerait la
 * RLS des tables et ouvrirait les données de tous les comptes.
 */

/** Tables réellement interrogées par le frontend (relevé par lecture du code). */
const TABLES_FRONTEND = [
  'reelora_audit_logs', 'reelora_avatars', 'reelora_generation_presets', 'reelora_notifications',
  'reelora_plans', 'reelora_prompt_templates', 'reelora_subscriptions', 'ugc_app_settings',
  'ugc_brands', 'ugc_credit_ledger', 'ugc_generated_assets', 'ugc_generation_jobs',
  'ugc_job_events', 'ugc_products', 'ugc_profiles', 'ugc_project_scenes', 'ugc_project_scripts',
  'ugc_recharge_orders', 'ugc_service_catalog', 'ugc_video_projects', 'ugc_workspace_members',
  'ugc_workspaces',
];

describe('Migration des vues public', () => {
  const sql = lire(MIGRATION_VUES);
  /** Le DDL seul, sans les commentaires. */
  const ddl = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('couvre TOUTES les tables interrogées par le frontend', () => {
    for (const table of TABLES_FRONTEND) {
      expect(ddl, `vue manquante pour ${table}`).toContain(`view public.${table} with (security_invoker = true)`);
    }
    expect(TABLES_FRONTEND).toHaveLength(22);
  });

  it('chaque vue porte security_invoker = true (sans quoi la RLS est contournée)', () => {
    const vues = [...ddl.matchAll(/create or replace view public\.([a-z_]+)/g)].map((m) => m[1]);
    expect(vues.length).toBeGreaterThanOrEqual(40);
    // Aucune vue ne doit être créée sans l'option : on vérifie la construction
    // entière, pas seulement la présence du mot-clé une fois.
    for (const vue of vues) {
      expect(ddl, `vue ${vue} sans security_invoker`).toMatch(
        new RegExp(`view public\\.${vue} with \\(security_invoker = true\\) as`),
      );
    }
    const declarations = (ddl.match(/create or replace view /g) ?? []).length;
    const options = (ddl.match(/with \(security_invoker = true\)/g) ?? []).length;
    expect(options).toBe(declarations);
  });

  it('ne crée aucune vue sans clause FROM explicite vers le schéma métier', () => {
    // Une vue sans source serait une erreur de copie ; on exige `from saas_ugc.`
    // en nombre suffisant pour toutes les vues.
    const sources = (ddl.match(/from saas_ugc\./g) ?? []).length;
    const vues = (ddl.match(/create or replace view /g) ?? []).length;
    expect(sources).toBe(vues);
  });

  it('est idempotente : create OR REPLACE seulement, jamais drop', () => {
    // Un `drop view` casserait la production le temps de la recréation, et
    // échouerait si une dépendance existe.
    expect(ddl).not.toMatch(/drop\s+view/i);
    expect(ddl).not.toMatch(/create\s+view\s/i); // toujours « create or replace »
  });

  it('n’accorde que la lecture, et seulement à anon et authenticated', () => {
    // Les grants s'écrivent sur plusieurs lignes : on raisonne sur des
    // instructions complètes, pas ligne par ligne.
    const instructions = ddl.split(';').map((i) => i.trim()).filter((i) => /^grant /i.test(i));
    expect(instructions.length).toBeGreaterThan(0);
    for (const instruction of instructions) {
      expect(instruction).toMatch(/^grant select on /i);
      expect(instruction).toMatch(/to anon, authenticated$/i);
      expect(instruction).not.toMatch(/insert|update|delete|all privileges/i);
    }
  });

  it('ne touche à aucune donnée', () => {
    const motsInterdits = [/\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i];
    for (const interdit of motsInterdits) expect(ddl).not.toMatch(interdit);
  });
});

describe('Documentation de l’état des migrations', () => {
  const doc = lire('docs/MIGRATIONS_STATUS.md');

  it('consigne le trou de reconstruction et ne le minimise pas', () => {
    expect(doc).toMatch(/32 tables|32 des/i);
    expect(doc).toContain('saas_ugc');
    expect(doc).toContain('security_invoker');
    // Le document doit dire clairement que la base ne se reconstruit pas seule.
    expect(doc).toMatch(/ne peut pas reconstruire|ne se reconstruit pas|impossible de reconstruire/i);
  });

  it('donne une procédure exécutable pour combler le trou', () => {
    expect(doc).toMatch(/pg_dump/);
    expect(doc).toMatch(/MIGRATIONS_STATUS|migration/);
    // Et précise que cela exige une autorisation ou une action de l'utilisateur.
    expect(doc).toMatch(/autorisation/i);
  });

  it('rappelle le statut lot16/17 et sa procédure de résolution', () => {
    expect(doc).toMatch(/lot16|lot 16/i);
    expect(doc).toMatch(/non appliquées|non appliqué|ne sont pas appliquées/i);
  });

  it('n’invente aucun chiffre : les totaux cités sont ceux mesurés', () => {
    // 111 fichiers de migration dans le dépôt au moment de la rédaction.
    const fichiers = readdirSync(join(RACINE, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    expect(fichiers.length).toBeGreaterThanOrEqual(111);
    expect(doc).toMatch(/111/);
  });
});
