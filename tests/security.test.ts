import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function frontendCode(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(stripComments(read(rel)));
    }
  };
  walk('src');
  return out.join('\n');
}

describe('clés secrètes côté serveur uniquement', () => {
  const code = frontendCode();
  it('le frontend ne lit jamais de variables d’environnement serveur', () => {
    expect(code).not.toContain('Deno.env.get');
    expect(code).not.toContain('process.env');
    expect(code).not.toMatch(/VITE_(GROQ|HEYGEN|FAL|SERVICE|SECRET)/);
  });
  it('aucune clé secrète ni jeton n’est embarqué dans le code', () => {
    expect(code).not.toContain('sb_secret_');
    expect(code).not.toContain('eyJ');
    expect(code).not.toContain('SUPABASE_SERVICE_ROLE_KEY as string');
    expect(code).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*\)/);
  });
  it('le client Supabase n’utilise que la clé publishable et n’injecte pas de header global incompatible CORS Edge', () => {
    const client = stripComments(read('src/lib/supabase.ts'));
    expect(client).toContain('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(client).not.toContain('SERVICE_ROLE');
    expect(client).not.toContain('x-application-name');
  });
  it('.env.example ne documente que des variables publiques VITE_', () => {
    const env = read('.env.example');
    const assigned = env.split('\n').map((l) => l.trim())
      .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split('=')[0]);
    expect(assigned.length).toBeGreaterThan(0);
    for (const name of assigned) expect(name.startsWith('VITE_')).toBe(true);
    expect(env).not.toContain('GROQ_API_KEY=');
    expect(env).not.toContain('FAL_KEY=');
  });
});

describe('configuration des Edge Functions', () => {
  const config = read('supabase/config.toml');
  it('les fonctions IA et vidéo exigent un JWT vérifié', () => {
    expect(config).toMatch(/\[functions\.reelora-ai\][\s\S]*?verify_jwt\s*=\s*true/);
    expect(config).toMatch(/\[functions\.reelora-video\][\s\S]*?verify_jwt\s*=\s*true/);
  });
  it('la sonde de santé n’expose que des booléens de présence', () => {
    expect(config).toMatch(/\[functions\.reelora-health\][\s\S]*?verify_jwt\s*=\s*false/);
    const health = read('supabase/functions/reelora-health/index.ts');
    expect(health.match(/Boolean\(Deno\.env\.get\(/g)?.length).toBe(4);
    expect(health).not.toContain('JSON.stringify(Deno.env');
  });
  it('les endpoints sans JWT vérifient eux-mêmes leur authentification', () => {
    expect(config).not.toContain('--no-verify-jwt');
    expect(config.match(/verify_jwt\s*=\s*false/g)?.length).toBe(6);
    expect(config).toMatch(/\[functions\.reelora-video-worker\][\s\S]*?verify_jwt\s*=\s*false/);
    expect(config).toMatch(/\[functions\.reelora-health\][\s\S]*?verify_jwt\s*=\s*false/);
    expect(config).toMatch(/\[functions\.reelora-owner-bootstrap\][\s\S]*?verify_jwt\s*=\s*false/);
    // Surveillance fournisseur : jeton Vault comparé à temps constant + en-tête
    // dédié, jamais un JWT utilisateur (le job pg_cron n'en a pas).
    expect(config).toMatch(/\[functions\.vyora-provider-health\][\s\S]*?verify_jwt\s*=\s*false/);
    const providerHealth = read('supabase/functions/vyora-provider-health/index.ts');
    expect(providerHealth).toContain("x-vyora-cron");
    expect(providerHealth).toContain('constantTimeEqual');
    expect(providerHealth).toContain('vyora_provider_health_cron_token');
    // Contrôle catalogue uniquement : aucune complétion, donc aucune génération.
    expect(providerHealth).not.toContain('chat/completions');
    expect(providerHealth).not.toContain(':generateContent');
    // Webhook SasPay : appelé par SasPay, donc sans JWT utilisateur. Il s'authentifie
    // par signature HMAC-SHA256 du corps brut, comparée à temps constant, avec un
    // secret propre à VYORA et une fenêtre anti-rejeu ; sans secret, tout est refusé.
    expect(config).toMatch(/\[functions\.vyora-saspay-webhook\][\s\S]*?verify_jwt\s*=\s*false/);
    const sasPayWebhook = read('supabase/functions/_shared/saspay/webhook.ts');
    expect(sasPayWebhook).toContain("name: 'HMAC', hash: 'SHA-256'");
    expect(sasPayWebhook).toContain('timingSafeEqualHex');
    expect(sasPayWebhook).toContain('WEBHOOK_TOLERANCE_SECONDS');
    const sasPayHttp = read('supabase/functions/_shared/saspay/http.ts');
    expect(sasPayHttp).toContain('x-webhook-signature');
    expect(sasPayHttp).toContain('x-webhook-timestamp');
    expect(sasPayHttp).toContain('VYORA_SASPAY_WEBHOOK_SECRET');
    // Le corps est lu brut (texte) avant toute analyse JSON : la signature porte dessus.
    expect(sasPayHttp).toMatch(/createWebhookHandler[\s\S]*?await request\.text\(\)/);
    const sasPayService = read('supabase/functions/_shared/saspay/payments.ts');
    expect(sasPayService).toContain('WEBHOOK_NOT_CONFIGURED');
    expect(sasPayService).toContain('WEBHOOK_SIGNATURE_INVALID');
    expect(sasPayService).toContain('verifyWebhookSignature');
    // Réconciliation planifiée : en-tête dédié contrôlé AVANT toute lecture en base,
    // puis jeton Vault comparé à temps constant. Ni JWT utilisateur, ni clé de service.
    expect(config).toMatch(/\[functions\.vyora-payments-reconcile\][\s\S]*?verify_jwt\s*=\s*false/);
    expect(sasPayHttp).toMatch(/createReconcileHandler[\s\S]*?x-vyora-cron[\s\S]*?payments-reconcile[\s\S]*?isCronToken/);
    expect(sasPayService).toMatch(/async function isCronToken[\s\S]*?constantTimeEqual\(presented, expected\)/);
    expect(read('supabase/functions/_shared/saspay/store.ts')).toContain('vyora_payments_reconcile_token');
    const reconcile = read('supabase/functions/vyora-payments-reconcile/index.ts');
    expect(reconcile).toContain('createReconcileHandler');
    // Le jeton n'est écrit nulle part dans le dépôt : il naît dans Vault, à la migration.
    const reconcileMigration = read('supabase/migrations/20261113110000_vyora_saspay_refunds_reconcile.sql');
    expect(reconcileMigration).toContain("vault.create_secret(");
    expect(reconcileMigration).toContain("'vyora_payments_reconcile_token'");
    expect(reconcileMigration).not.toMatch(/Bearer [0-9a-f]{32,}/);
    // La clé SasPay est propre à VYORA : aucun repli sur celle d'un autre produit.
    expect(sasPayHttp).not.toMatch(/get\('SASPAY_SECRET_KEY'\)/);
    expect(sasPayHttp).not.toMatch(/get\('SASPAY_WEBHOOK_SECRET'\)/);
    const worker = read('supabase/functions/reelora-video-worker/index.ts');
    expect(worker).toContain('constantTimeEqual');
    expect(worker).toContain('reelora_worker_token');
    const ownerBootstrap = read('supabase/functions/reelora-owner-bootstrap/index.ts');
    expect(ownerBootstrap).toContain('/auth/v1/user');
    expect(ownerBootstrap).toContain('VYORA_OWNER_ADMIN_EMAIL');
    expect(ownerBootstrap).toContain('reelora_bootstrap_first_admin');
    expect(ownerBootstrap).toContain('email_confirmation_required');
  });

  it('la clé MuAPI n’est jamais une variable frontend ni un secret en clair', () => {
    const env = read('.env.example');
    const frontend = frontendCode();
    expect(env).not.toMatch(/^\s*MUAPI_API_KEY\s*=/m);
    expect(env).not.toContain('VITE_MUAPI');
    expect(frontend).not.toContain('x-api-key');
    expect(frontend).not.toContain('MUAPI_API_KEY=');
  });
});

describe('Video Studio : frontière des secrets et espaces non opérationnels', () => {
  const frontend = frontendCode();
  it('aucun fournisseur vidéo retiré n’est nommé dans le frontend', () => {
    expect(frontend.toLowerCase()).not.toContain('heygen');
    expect(frontend.toLowerCase()).not.toContain('fal.ai');
  });
  it('le nouveau studio ne lit ni clé serveur ni en-tête fournisseur', () => {
    expect(frontend).not.toContain('VITE_MUAPI');
    expect(frontend).not.toContain('x-api-key');
    expect(frontend).not.toContain('MUAPI_API_KEY=');
  });
  it('la navigation marque explicitement les espaces préparés', () => {
    const sections = read('src/studio/sections.ts');
    // Ce qui n'a pas de moteur reste explicitement préparé, jamais présenté
    // comme générable ; la fiche dédiée porte le libellé « non opérationnel ».
    expect(sections).toContain("status: 'prepared'");
    expect(read('src/studio/components/PreparedSpace.tsx')).toContain('non opérationnel');
    // …et Video→Video n'est plus présenté comme verrouillé : il route vers le
    // Studio réel (import vidéo source + devis serveur).
    expect(sections).toContain("id: 'video-to-video'");
    expect(sections).toMatch(/id: 'video-to-video'[\s\S]{0,200}status: 'live'/);
    expect(sections).not.toMatch(/id: 'video-to-video'[\s\S]{0,200}status: 'prepared'/);
  });
});

describe('bibliothèque Reelora : RPC additive et RLS', () => {
  it('l’attachement à un projet est défini, vérifié et réservé aux utilisateurs authentifiés', () => {
    const sql = read('supabase/migrations/20261108233629_reelora_studio_library.sql');
    expect(sql).toContain('function public.reelora_attach_asset_to_project(');
    expect(sql).toContain('ugc_private.can_edit_workspace');
    expect(sql).toContain('grant execute on function public.reelora_attach_asset_to_project(uuid, uuid) to authenticated');
    expect(sql).not.toMatch(/disable row level security/i);
    expect(sql).not.toMatch(/drop\s+table/i);
  });
});

describe('bootstrap propriétaire et budget fournisseur', () => {
  const migration = read('supabase/migrations/20261111150407_vyora_owner_admin_provider_breakdown.sql');
  const bootstrapMigration = read('supabase/migrations/20261111160505_vyora_owner_bootstrap_status_20261111.sql');

  it('réserve le rôle administrateur au bootstrap unique et protège le rôle propriétaire', () => {
    expect(migration).toContain("where role = 'admin'");
    expect(migration).toContain('admin_role_bootstrap_only');
    expect(migration).toContain('owner_admin_role_immutable');
    expect(migration).toContain('reelora_assert_admin');
    expect(bootstrapMigration).toContain('reelora_first_admin_bootstrap_available');
    expect(bootstrapMigration).toContain('grant execute on function public.reelora_first_admin_bootstrap_available() to anon, authenticated, service_role');
    expect(bootstrapMigration).not.toContain('insert into saas_ugc.ugc_user_roles');
  });

  it('empêche la modification du plafond par le RPC générique et expose les totaux fournisseurs', () => {
    expect(migration).toContain("'provider_spend_cap'");
    expect(migration).toContain("'by_provider'");
    expect(migration).toContain("'actual_spent_usd'");
    expect(migration).toContain("'reserved_usd'");
    expect(migration).toContain("'committed_usd'");
  });
});

describe('contrat RPC frontend ↔ migrations', () => {
  const migrations = readdirSync(join(root, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => read(join('supabase/migrations', f)))
    .join('\n');
  const api = read('src/lib/api.ts');
  const rpcNames = Array.from(api.matchAll(/rpc(?:<[^>]+>)?\(\s*'([a-z_]+)'/g), (m) => m[1]);

  it('tous les RPC Reelora appelés par le frontend sont définis dans les migrations', () => {
    const reelora = rpcNames.filter((n) => n.startsWith('reelora_'));
    expect(reelora.length).toBeGreaterThan(15);
    for (const name of reelora) expect(migrations).toContain(`function public.${name}(`);
  });

  it('les remboursements de quota sont protégés côté base', () => {
    const secure = read('supabase/migrations/20261108170950_reelora_v1_secure_refund.sql');
    expect(secure).toContain('revoke all on function public.reelora_refund_quota(text, uuid, uuid) from public, anon, authenticated');
    expect(secure).toContain("auth.jwt()->>'role'");
    const legacy = read('supabase/migrations/20261108171425_reelora_v1_legacy_video_refund.sql');
    expect(legacy).toContain("status in ('failed', 'cancelled')");
  });

  it('les migrations Reelora ne suppriment aucune table ou vue existante', () => {
    const sql = readdirSync(join(root, 'supabase/migrations'))
      .filter((f) => f.includes('reelora'))
      .map((f) => read(join('supabase/migrations', f)))
      .join('\n');
    expect(sql).not.toMatch(/drop\s+table\s+(if\s+exists\s+)?saas_ugc\./i);
    expect(sql).not.toMatch(/drop\s+view\s+(if\s+exists\s+)?public\.ugc_/i);
  });
});

describe('reconstructibilité du dépôt', () => {
  it('les fichiers d’entrée et la configuration de build existent', () => {
    for (const f of ['index.html', 'src/main.tsx', 'src/index.css', 'package.json', 'vite.config.ts', 'tsconfig.json', 'netlify.toml', 'public/_redirects', 'README.md']) {
      expect(() => read(f)).not.toThrow();
    }
    expect(read('index.html')).toContain('/src/main.tsx');
  });
  it('le déploiement publie dist et les secrets restent ignorés', () => {
    expect(read('netlify.toml')).toContain('publish = "dist"');
    expect(read('.gitignore')).toContain('.env.local');
    expect(read('.gitignore')).toContain('node_modules');
  });
});
