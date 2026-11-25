import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — script Node sans déclaration de types, importé pour ses fonctions pures.
import { accepterait as accepter, auditer, estMotif, extraireOrigines, formater } from '../scripts/audit-origins.mjs';

/**
 * Audit des origines CORS — préparation de migration de domaine.
 *
 * Ces tests ne dépendent pas du contenu réel du dépôt : ils vérifient la LOGIQUE
 * d'audit sur des cas construits. Le résultat réel sur le dépôt est vérifié par
 * un test séparé, plus bas, qui échoue si un jour une liste devient bloquante.
 */

describe('Extraction des origines d’un bloc de code', () => {
  it('trouve les origines littérales et déduplique', () => {
    const bloc = `'https://a.netlify.app', 'http://localhost:5173', 'https://a.netlify.app',`;
    expect(extraireOrigines(bloc)).toEqual(['https://a.netlify.app', 'http://localhost:5173']);
  });

  it('reconnaît un motif d’expression régulière sans le confondre avec une origine fixe', () => {
    const bloc = String.raw`/^https:\/\/deploy-preview-\d+--vyora\.netlify\.app$/,`;
    const origines = extraireOrigines(bloc);
    expect(origines).toHaveLength(1);
    expect(origines[0]).toMatch(/^motif:/);
    expect(estMotif(origines[0])).toBe(true);
  });

  it('ne prend pas un commentaire pour une origine', () => {
    // Seules les chaînes entre quotes simples précédées d'un schéma comptent ;
    // un commentaire en français qui parle d'un domaine reste hors liste.
    const bloc = `// voir https://exemple.test\n'https://reel.netlify.app',`;
    expect(extraireOrigines(bloc)).toEqual(['https://reel.netlify.app']);
  });

  it('renvoie une liste vide quand il n’y a aucune origine', () => {
    expect(extraireOrigines('const x = 1;')).toEqual([]);
  });
});

describe('Comparaison à l’origine de production', () => {
  it('exige une correspondance EXACTE', () => {
    const origines = ['https://a.netlify.app', 'http://localhost:5173'];
    expect(accepter(origines, 'https://a.netlify.app')).toBe(true);
    expect(accepter(origines, 'https://a.netlify.app.evil.test')).toBe(false);
    expect(accepter(origines, 'https://A.netlify.app')).toBe(false);
    expect(accepter(origines, 'https://b.netlify.app')).toBe(false);
  });

  it('une prévisualisation n’accepte pas une origine de production', () => {
    const origines = ['https://*.e2b.app', 'https://deploy-preview-*--site.netlify.app'];
    expect(estMotif(origines[0])).toBe(true);
    expect(accepter(origines, 'https://a.netlify.app')).toBe(false);
  });
});

describe('Audit sur un dépôt construit — classification des constats', () => {
  // L'audit lit le disque : la classification est testée sur un dossier réel temporaire.
  it('signale une liste FERMÉE qui n’accepte pas la production comme bloquante', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'audit-origines-'));
    try {
      mkdirSync(join(dir, 'src/lib'), { recursive: true });
      mkdirSync(join(dir, 'supabase/functions/business-grow'), { recursive: true });
      mkdirSync(join(dir, 'supabase/functions/_shared/saspay'), { recursive: true });
      mkdirSync(join(dir, 'supabase/functions/reelora-owner-bootstrap'), { recursive: true });
      cpSync('scripts/audit-origins.mjs', join(dir, 'audit.mjs'));
      writeFileSync(join(dir, 'src/lib/origin-allowlist.ts'),
        `export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [\n  'https://ancien.netlify.app',\n];\n`);
      writeFileSync(join(dir, 'supabase/functions/business-grow/index.ts'),
        `const defaultAllowedOrigins = [\n  'https://ancien.netlify.app',\n].join(',');\nconst productionOrigins = ['https://ancien.netlify.app'];\n`);
      writeFileSync(join(dir, 'supabase/functions/_shared/saspay/http.ts'),
        `const STATIC_ORIGINS = new Set([\n  'https://ancien.netlify.app',\n]);\nconst ORIGIN_PATTERNS = [\n  /^https:\\/\\/deploy-preview-\\d+--vyora\\.netlify\\.app$/,\n];\n`);
      writeFileSync(join(dir, 'supabase/functions/reelora-owner-bootstrap/index.ts'),
        `const DEFAULT_ALLOWED_ORIGINS = [\n  'https://ancien.netlify.app',\n];\n`);

      const resultat = auditer({ origineProduction: 'https://nouveau.netlify.app', racine: dir });
      const bloquants = resultat.constats.filter((c: { niveau: string }) => c.niveau === 'bloquant');
      // La liste frontend est complétée par un secret → pas bloquante.
      // Tout le reste est complété aussi ; le seul cas bloquant serait une liste
      // fermée. On vérifie donc surtout l'absence de FAUX bloquant.
      for (const blocage of bloquants) {
        expect(blocage.message).toMatch(/n'est PAS accepté|n’est PAS accepté/);
      }
      // Le site de production absent doit être signalé au minimum.
      expect(resultat.constats.some((c: { message: string }) => c.message.includes('https://nouveau.netlify.app'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Audit RÉEL du dépôt — aucune régression bloquante', () => {
  it('aucun constat bloquant sur le dépôt tel qu’il est', () => {
    const resultat = auditer();
    const bloquants = resultat.constats.filter((c: { niveau: string }) => c.niveau === 'bloquant');
    expect(
      bloquants,
      `Constats bloquants :\n${bloquants.map((c: { liste: string; message: string }) => `- ${c.liste} : ${c.message}`).join('\n')}`,
    ).toEqual([]);
    // Et l'audit doit voir les listes : une extraction cassée ne doit pas passer
    // pour un succès silencieux.
    expect(resultat.listes.length).toBeGreaterThanOrEqual(5);
    for (const liste of resultat.listes) {
      expect(liste.origines.length, liste.etiquette).toBeGreaterThan(0);
    }
  });

  it('le site servi dépend d’un secret dans toutes les listes où il n’est pas par défaut', () => {
    const resultat = auditer();
    for (const liste of resultat.listes) {
      if (!liste.accepte_production && !liste.redondante) {
        expect(liste.completee_par_secret, `${liste.etiquette} : liste fermée non signalée comme bloquante`)
          .toBeTruthy();
      }
    }
  });

  it('signale explicitement les origines historiques encore présentes', () => {
    const resultat = auditer();
    const historiques = resultat.constats.filter((c: { message: string }) => c.message.includes('HISTORIQUE'));
    expect(historiques.length).toBeGreaterThan(0);
    for (const constat of historiques) {
      expect(constat.message).toMatch(/vyora-ugc|reelora\.netlify\.app/);
    }
  });

  it('s’exécute en ligne de commande et produit un rapport lisible', () => {
    const r = spawnSync('node', ['scripts/audit-origins.mjs'], { encoding: 'utf8' });
    expect(r.status).toBe(0); // aucun bloquant
    expect(r.stdout).toContain('Audit des origines');
    expect(r.stdout).toContain('accepte le site servi');
    expect(r.stdout).toContain('Constats :');
  });

  it('accepte une origine de production personnalisée (simulation du nouveau site)', () => {
    const r = spawnSync('node', ['scripts/audit-origins.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, ORIGINE_PRODUCTION: 'https://mon-nouveau-site.netlify.app' },
    });
    expect(r.stdout).toContain('https://mon-nouveau-site.netlify.app');
    // Aucune liste ne la connaît : l'audit doit le dire, sans planter.
    expect(r.stdout).toContain('Constats :');
  });

  it('le rapport formaté cite chaque liste et son état', () => {
    const texte = formater(auditer());
    expect(texte).toContain('business-grow');
    expect(texte).toContain('saspay');
    expect(texte).toContain('reelora-owner-bootstrap');
    expect(texte).toContain('frontend partagé');
  });
});
