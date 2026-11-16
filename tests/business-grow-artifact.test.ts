import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GITHUB_LOADER, HOSTED_LOADER, LOADER, artifact, renderGithubLoader, renderLoader, renderHostedLoader } from '../scripts/build-business-grow-artifact.mjs';

/**
 * Le canal de déploiement peut tronquer une source longue : le code réellement
 * exécuté en production est l'artefact gzip+base64 du chargeur. Ces tests
 * garantissent que cet artefact reste, octet pour octet, le code du dépôt.
 */
describe('artefact déployable business-grow', () => {
  const loader = readFileSync(join(process.cwd(), LOADER), 'utf8');

  // Le payload voyage en plusieurs constantes (PAYLOAD_N) : le canal de
  // déploiement tronque toute CONSTANTE de plus de 20 000 caractères, tandis
  // que la taille totale du fichier reste tolérée (chargeur prod ~23 Ko).
  const payloadParts = (): string[] =>
    [...loader.matchAll(/const PAYLOAD_\d = "([A-Za-z0-9+/=]+)";/g)].map((m) => m[1]);
  const fullPayload = (): string => payloadParts().join('');

  it('est identique à ce que produit la compilation du dépôt', () => {
    const built = artifact();
    expect(loader).toBe(renderLoader(built));
  });

  it('se décompresse vers un bundle ES2022 intègre et complet', () => {
    const payload = fullPayload();
    expect(payload).toBeTruthy();

    const source = gunzipSync(Buffer.from(payload as string, 'base64')).toString('utf8');

    // Taille et empreinte déclarées dans le chargeur = contenu réel.
    expect(source.length).toBe(Number(loader.match(/const ARTIFACT_CHARS = (\d+);/)?.[1]));
    expect(createHash('sha256').update(source, 'utf8').digest('hex'))
      .toBe(loader.match(/const ARTIFACT_SHA256 = "([0-9a-f]{64})";/)?.[1]);
  });

  it('fournit la connexion postgres au bundle avant de l’exécuter', () => {
    const inject = loader.indexOf('__bgPostgres = postgres');
    const run = loader.indexOf('new Function(CODE)()');
    expect(inject).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    // L'injection doit précéder l'exécution, sinon le bundle démarre en 500.
    expect(inject).toBeLessThan(run);
    expect(loader).toContain('import postgres from "npm:postgres@3.4.5";');
  });

  it('chaque morceau de payload reste sous la limite de troncature du canal de déploiement', () => {
    // Au-delà de 20 000 caractères, l'API de déploiement tronque une CONSTANTE :
    // la fonction démarrait alors en BOOT_ERROR (503). La taille totale du
    // fichier reste tolérée (le chargeur de production fait ~23 Ko), d'où le
    // découpage en plusieurs constantes reconcaténées.
    const parts = payloadParts();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThan(20_000);
    expect(fullPayload().length).toBeGreaterThanOrEqual(parts.length * 1000);
  });

  it('déploie un chargeur hébergé court, sans payload inline tronquable', () => {
    const hosted = readFileSync(join(process.cwd(), HOSTED_LOADER), 'utf8');
    const built = artifact();
    // Le canal court publie loader.ts, pas la variante autonome bootstrap.ts.
    expect(hosted).toBe(renderHostedLoader(built));
    expect(hosted.length).toBeLessThan(20_000);
    expect(hosted).not.toContain('const PAYLOAD');
    expect(hosted).toContain(built.sha256);
  });

  it('est exécutable par new Function (aucun import) et démarre le handler', () => {
    const payload = fullPayload();
    const source = gunzipSync(Buffer.from(payload as string, 'base64')).toString('utf8');

    // Régression v14 : le bundle conservait `import postgres from "npm:…"`, que
    // `new Function` refuse — la fonction démarrait alors en BOOT_ERROR (503).
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).toContain('globalThis.__bgPostgres');

    const served = source.replace(/(\w+)\.Deno\?\.serve&&\1\.Deno\.serve\((\w+)\);?/g, '');
    const globalScope = globalThis as unknown as Record<string, unknown>;
    const previousDeno = globalScope.Deno;
    const previousPg = globalScope.__bgPostgres;
    let servedHandler = false;
    globalScope.Deno = { serve: () => { servedHandler = true; }, env: { get: () => '' } };
    // Régression v15 : `postgres` doit être fourni par le chargeur AVANT
    // l'exécution du bundle, sinon la fonction démarre en WORKER_ERROR (500).
    delete globalScope.__bgPostgres;
    try {
      new Function(source.includes('__bgPostgres = postgres') ? '' : served)();
    } finally {
      globalScope.Deno = previousDeno;
      globalScope.__bgPostgres = previousPg;
    }
    expect(servedHandler).toBe(true);
  });

  it('ne contient aucun import relatif ni secret fournisseur', () => {
    const payload = fullPayload();
    const source = gunzipSync(Buffer.from(payload as string, 'base64')).toString('utf8');

    // Le chargeur est le seul fichier déployé : un import relatif casserait le boot.
    expect(source).not.toMatch(/from\s*["']\.\.?\//);
    // Aucune clé n'est inlinée : les valeurs restent lues via env(...).
    expect(source).not.toMatch(/gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}/);
    // Plus aucun catalogue de fournisseurs dans l'artefact : le nom des
    // variables est CONSTRUIT depuis la clé du registre (convention), et la
    // liste elle-même est lue en base.
    expect(source).toContain('_API_KEY');
    expect(source).toContain('saas_business.ai_providers');
    expect(source).not.toMatch(/BUSINESS_GROW_(GROQ|GEMINI|DEEPSEEK|MISTRAL|GROK|OPENROUTER|CLOUDFLARE)_/);
  });

  it('refuse une origine inconnue en renvoyant l’en-tête CORS explicite', () => {
    // Régression : un 403 sans en-tête CORS est vu par le navigateur comme une
    // panne réseau, affichée à tort « backend absent ou non déployé ».
    const payload = fullPayload();
    const source = gunzipSync(Buffer.from(payload as string, 'base64')).toString('utf8');
    expect(source).toContain('forceAllowOrigin');
    expect(source).toContain('ORIGIN_NOT_ALLOWED');
  });
});

/**
 * Chargeur GitHub épinglé.
 *
 * Ce chargeur existe parce que le canal de déploiement n'accepte pas 88 k de
 * bundle. Sa faiblesse potentielle est connue : si l'empreinte ne correspond
 * plus au fichier committé, la fonction refuse de démarrer — c'est-à-dire
 * qu'elle tombe en panne plutôt que d'exécuter autre chose. Ces tests
 * verrouillent l'accord entre les trois valeurs épinglées.
 */
describe('chargeur GitHub épinglé', () => {
  const loader = readFileSync(join(process.cwd(), GITHUB_LOADER), 'utf8');
  const built = artifact();

  const valeur = (nom: string): string => {
    // Les valeurs épinglées sont soit des chaînes, soit un nombre
    // (`ARTIFACT_CHARS`) : les deux formes sont acceptées ici pour que le test
    // porte sur l'accord des valeurs, pas sur leur syntaxe.
    const m = new RegExp(`const ${nom} = (?:"([^"]+)"|(\\d+));`).exec(loader);
    if (!m) throw new Error(`${nom} absent du chargeur GitHub`);
    return m[1] ?? m[2];
  };

  it('est identique à ce que produit le script de build', () => {
    const commit = valeur('COMMIT');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(loader).toBe(renderGithubLoader(built, commit));
  });

  it('épingle l’empreinte et la taille réelles du bundle du dépôt', () => {
    // C'est l'accord qui rend le chargement possible : une empreinte périmée
    // ferait refuser le bundle pourtant légitime.
    expect(valeur('ARTIFACT_SHA256')).toBe(built.sha256);
    expect(Number(valeur('ARTIFACT_CHARS'))).toBe(built.chars);
    expect(built.source.length).toBe(built.chars);
  });

  it('n’épingle ni `main` ni une branche mouvante', () => {
    // Une URL sur `main` servirait demain un autre contenu : l'empreinte
    // deviendrait fausse et le service tomberait en panne au déploiement
    // suivant, sans que personne n'ait touché au code.
    const commit = valeur('COMMIT');
    expect(['main', 'develop', 'master', 'HEAD']).not.toContain(commit);
    expect(loader).not.toMatch(/raw\.githubusercontent\.com[^"]*\/(main|develop|master)\//);
  });

  it('vérifie la taille et l’empreinte AVANT d’exécuter le code', () => {
    const ordreTaille = loader.indexOf('source.length !== ARTIFACT_CHARS');
    const ordreEmpreinte = loader.indexOf('hex !== ARTIFACT_SHA256');
    const execution = loader.indexOf('new Function(CODE)()');
    expect(ordreTaille).toBeGreaterThan(-1);
    expect(ordreEmpreinte).toBeGreaterThan(ordreTaille);
    expect(execution).toBeGreaterThan(ordreEmpreinte);
  });

  it('échoue fermé : aucune exécution si le chargement échoue', () => {
    // Le `else` sert un 503 ; il n'exécute jamais un code vide ou partiel.
    expect(loader).toContain('BUSINESS_GROW_ARTIFACT_UNAVAILABLE');
    expect(loader).toContain('status: 503');
    expect(loader).toMatch(/if \(CODE\) \{/);
  });

  it('ne contient aucun placeholder ni valeur fictive', () => {
    // Leçon des tours précédents : un `__PAYLOAD__` ou un `__PROBE__` envoyé
    // en production casse le service. Le test refuse désormais ces marqueurs.
    expect(loader).not.toMatch(/__[A-Z_]+__/);
    expect(loader).not.toContain('PLACEHOLDER');
    expect(loader).not.toContain('TODO');
  });

  it('compare le fichier tel qu’il est committé, saut de ligne final compris', () => {
    // Piège rencontré chez `store-import` : retirer le dernier caractère
    // change l'empreinte et bloque le chargement.
    const brut = readFileSync(join(process.cwd(), 'supabase/functions/business-grow.edge.js'), 'utf8');
    expect(brut).toBe(built.source);
    expect(loader).not.toContain('endsWith("\\n")');
  });
});
