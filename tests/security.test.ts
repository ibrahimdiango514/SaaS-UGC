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
  it('le client Supabase n’utilise que la clé publishable', () => {
    const client = stripComments(read('src/lib/supabase.ts'));
    expect(client).toContain('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(client).not.toContain('SERVICE_ROLE');
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
  it('aucune fonction n’est déployée sans vérification JWT sauf la sonde', () => {
    expect(config).not.toContain('--no-verify-jwt');
    expect(config.match(/verify_jwt\s*=\s*false/g)?.length).toBe(1);
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
    const secure = read('supabase/migrations/20261108000006_reelora_secure_refund.sql');
    expect(secure).toContain('revoke all on function public.reelora_refund_quota(text, uuid, uuid) from public, anon, authenticated');
    expect(secure).toContain("auth.jwt()->>'role'");
    const legacy = read('supabase/migrations/20261108000007_reelora_legacy_video_refund.sql');
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
