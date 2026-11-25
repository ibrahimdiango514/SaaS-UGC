import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fou « aucun secret dans le dépôt ».
 *
 * Règle produit explicite : les clés fournisseurs vivent **uniquement** dans les
 * secrets Supabase. Ce test échoue si une valeur ressemblant à une clé apparaît
 * dans le code, les migrations, la documentation ou la configuration.
 *
 * Il ne remplace pas un scanner dédié (gitleaks, GitHub secret scanning) : il
 * empêche la régression la plus probable, l'ajout accidentel d'un exemple réel
 * pendant une intégration fournisseur.
 */

const ROOT = process.cwd();

/** Dossiers/fichiers inspectés (le dépôt utile, hors artefacts). */
const SCAN_DIRS = ['src', 'supabase', 'docs', 'scripts', 'netlify', 'tests'];
const SCAN_FILES = ['.env.example', 'README.md', 'netlify.toml', 'index.html'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

/**
 * Signatures de clés réelles. Chaque motif est volontairement spécifique pour
 * éviter les faux positifs (classes CSS, identifiants de test neutres).
 */
const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'Google API key (AIza…)', regex: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'OpenAI / DeepSeek style key (sk-…)', regex: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'OpenRouter key (sk-or-v1-…)', regex: /\bsk-or-v1-[A-Za-z0-9]{16,}/ },
  { name: 'Groq key (gsk_…)', regex: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'xAI key (xai-…)', regex: /\bxai-[A-Za-z0-9]{20,}/ },
  { name: 'Mistral key (32+ alnum after a bearer)', regex: /Bearer\s+[A-Za-z0-9]{32,}\b/ },
  { name: 'JWT (service_role / sb_secret)', regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
  { name: 'Supabase secret key (sb_secret_…)', regex: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'Clé privée PEM', regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Exceptions documentées : valeurs publiques par conception. */
const ALLOWED_PUBLIC = [
  // La clé « publishable » Supabase est destinée au navigateur (RLS protège les données).
  /\bsb_publishable_[A-Za-z0-9_-]+/,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
  for (const file of SCAN_FILES) {
    try {
      if (statSync(join(ROOT, file)).isFile()) files.push(join(ROOT, file));
    } catch {
      // Fichier optionnel absent : rien à inspecter.
    }
  }
  return files;
}

/** Retire les exceptions publiques avant analyse. */
function stripAllowed(content: string): string {
  return ALLOWED_PUBLIC.reduce((text, regex) => text.replace(new RegExp(regex.source, 'g'), '<public>'), content);
}

describe('sécurité — aucun secret dans le dépôt', () => {
  it('ne contient aucune signature de clé fournisseur ou Supabase secrète', () => {
    const findings: string[] = [];
    for (const file of scannedFiles()) {
      const content = stripAllowed(readFileSync(file, 'utf8'));
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(content)) {
          findings.push(`${relative(ROOT, file)} → ${pattern.name}`);
        }
      }
    }
    expect(findings, `Secrets potentiels détectés :\n${findings.join('\n')}`).toEqual([]);
  });

  it('le frontend n’expose aucune variable serveur (seules les VITE_ sont publiques)', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src'))) {
      const content = readFileSync(file, 'utf8');
      // Un accès direct à l'environnement serveur depuis le navigateur.
      if (/process\.env\.(?!VITE_)[A-Z_]+/.test(content) || /Deno\.env\.get\(\s*['"](?!VITE_)/.test(content)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders, `Accès serveur depuis src/ :\n${offenders.join('\n')}`).toEqual([]);
  });

  it('les Edge Functions lisent les clés via les secrets, jamais en littéral', () => {
    const files = walk(join(ROOT, 'supabase/functions')).filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Ex. `const KEY = 'sk-...'` ou `apiKey: "..."` avec une valeur longue.
      if (/api[_-]?key\s*[:=]\s*['"][^'"]{16,}['"]/i.test(content)) offenders.push(relative(ROOT, file));
    }
    expect(offenders, `Clé en littéral dans une fonction :\n${offenders.join('\n')}`).toEqual([]);
  });

  it('documente les variables d’environnement sans en révéler les valeurs', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const [, , value] of example.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
      const cleaned = stripAllowed(value.trim());
      if (!cleaned) continue;
      // Valeurs admises : URL publique, vide, ou PLACEHOLDER BORNÉ `<MAJUSCULES>`.
      // Un placeholder ne peut pas être une vraie valeur : les clés réelles
      // contiennent des minuscules, des chiffres collés et des tirets. Tout le
      // reste est refusé — coller une vraie clé ici échoue au test.
      const estPlaceholder = /^<[A-Za-z0-9_|]+>$/.test(cleaned);
      // Valeurs littérales PUBLIQUES par conception, documentées et vérifiables
      // ailleurs dans le dépôt. Le jeton d'autorisation de déploiement n'est pas
      // un secret : c'est le second facteur d'un verrou, écrit en clair dans
      // netlify.site.conf et dans la garde (scripts/netlify-guard-lib.sh).
      const estValeurPublique = cleaned === 'sorahnex-deploy';
      expect(
        /^https?:\/\//.test(cleaned) || cleaned === '<public>' || cleaned === '' || estPlaceholder || estValeurPublique,
        `Valeur suspecte dans .env.example : ${cleaned}`,
      ).toBe(true);
      if (estPlaceholder) {
        // Un placeholder ne doit pas contenir de suite assez longue pour être un
        // secret copié puis entouré de chevrons (`<sk_live_abc123…>`).
        expect(cleaned).not.toMatch(/[A-Za-z0-9]{16,}/);
      }
    }
  });
});

// ===========================================================================
describe('scanner de secrets Netlify — échec du 25/11/2026', () => {
  /**
   * Le premier build de production a compilé avec succès, puis a ÉCHOUÉ au
   * scanner de secrets de Netlify. Cause : `SORAHNEX_DEPLOY_AUTHORIZED_NAME`
   * vaut le jeton public `sorahnex-deploy`, documenté à dessein partout.
   *
   * La correction n'est pas de retirer la documentation — c'est de dire au
   * scanner quelles clés ne sont PAS des secrets. Ce test verrouille cette
   * déclaration, sinon un futur nettoyage de `netlify.toml` recasserait le
   * déploiement pour la même raison, après une compilation réussie.
   */
  const tomL = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

  const clesOmises = (): string[] => {
    const ligne = tomL.split('\n').find((l) => l.trim().startsWith('SECRETS_SCAN_OMIT_KEYS'));
    if (!ligne) return [];
    return ligne
      .split('=')
      .slice(1)
      .join('=')
      .replace(/"/g, '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  };

  it('le jeton public d’autorisation est déclaré NON scanné', () => {
    expect(clesOmises()).toContain('SORAHNEX_DEPLOY_AUTHORIZED_NAME');
  });

  it('les valeurs VITE_ publiées dans le bundle sont déclarées NON scannées', () => {
    // Elles finissent dans `dist/assets/index-*.js` : impossible de les
    // protéger, et inutile de les chercher. Les marquer « secrètes » casserait
    // chaque build, y compris ceux qui compilent parfaitement.
    const omises = clesOmises();
    for (const cle of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SITE_URL']) {
      expect(omises, `${cle} doit être omise du scanner`).toContain(cle);
    }
  });

  it('le scanner n’est PAS désactivé globalement', () => {
    // `SECRETS_SCAN_ENABLED=false` supprimerait toute protection, y compris
    // pour les vraies clés fournisseurs. C'est la solution paresseuse : refusée.
    // On cherche une AFFECTATION en début de ligne, pas une simple mention :
    // le commentaire qui explique pourquoi on la refuse contient le mot.
    const affecte = tomL
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#'))
      .some((l) => /^SECRETS_SCAN_ENABLED\s*=\s*"?false/i.test(l));
    expect(affecte).toBe(false);
  });

  it('aucune clé réellement secrète n’est omise du scanner', () => {
    const interdites = [
      'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS', 'SASPAY_SECRET_KEY',
      'MUAPI_API_KEY', 'FREE_LLM_API_KEY', 'VYORA_OAUTH_ENCRYPTION_KEY',
      'BUSINESS_GROW_ALLOWED_ORIGINS', 'SUPABASE_DB_URL',
    ];
    const omises = clesOmises();
    for (const cle of interdites) {
      expect(omises, `${cle} est un vrai secret : ne jamais l'omettre`).not.toContain(cle);
    }
  });
});
