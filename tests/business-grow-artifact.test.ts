import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GITHUB_LOADER, artifact, renderGithubLoader } from '../scripts/build-business-grow-artifact.mjs';

/**
 * Bundle et chargeur déployables.
 *
 * Le canal de déploiement n'accepte pas 88 k de code : le chargeur télécharge
 * donc le bundle committé, à un commit précis, puis vérifie taille et empreinte
 * avant de l'exécuter. Ces tests garantissent que ce bundle est bien celui du
 * dépôt, qu'il reste exécutable par `new Function` et qu'il ne fuit aucun
 * secret.
 *
 * ## Ce qui a changé
 * Ils décrivaient auparavant un chargeur autonome gzip+base64 (`bootstrap.ts`),
 * qui n'est plus déployé. Tester un artefact que la production n'exécute pas
 * donne une fausse assurance : c'est exactement ce qui a laissé la garde
 * d'abonnement hors du bundle `store-import` pendant une phase entière.
 */
describe('bundle business-grow', () => {
  const built = artifact();
  const bundle = built.source;

  it('est identique à ce que produit la compilation du dépôt', () => {
    // `artifact()` recompile la source : le fichier committé doit en découler
    // exactement, sans quoi le chargeur épinglerait un contenu périmé.
    const committe = readFileSync(join(process.cwd(), 'supabase/functions/business-grow.edge.js'), 'utf8');
    expect(committe).toBe(bundle);
    expect(bundle.length).toBe(built.chars);
  });

  it('déclare la taille et l’empreinte réelles du bundle', () => {
    expect(createHash('sha256').update(bundle, 'utf8').digest('hex')).toBe(built.sha256);
    expect(built.chars).toBeGreaterThan(10_000);
  });

  it('est exécutable par new Function (aucun import) et démarre le handler', () => {
    // Régression v14 : un bundle conservant `import postgres from "npm:…"`
    // fait démarrer la fonction en BOOT_ERROR (503), car `new Function`
    // refuse les imports.
    expect(bundle).not.toMatch(/^\s*import\s/m);
    expect(bundle).toContain('globalThis.__bgPostgres');

    const globalScope = globalThis as unknown as Record<string, unknown>;
    const previousDeno = globalScope.Deno;
    const previousPg = globalScope.__bgPostgres;
    let servedHandler = false;
    globalScope.Deno = { serve: () => { servedHandler = true; }, env: { get: () => '' } };
    // `postgres` doit être fourni AVANT l'exécution, sinon WORKER_ERROR (500).
    globalScope.__bgPostgres = () => ({});
    try {
      new Function(bundle)();
    } finally {
      globalScope.Deno = previousDeno;
      globalScope.__bgPostgres = previousPg;
    }
    expect(servedHandler).toBe(true);
  });

  it('ne contient aucun import relatif ni secret fournisseur', () => {
    expect(bundle).not.toMatch(/from\s*["']\.\.?\//);
    // Aucune clé n'est inlinée : les valeurs restent lues via env(...).
    expect(bundle).not.toMatch(/gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}/);
    // La liste des fournisseurs vient du registre, pas d'un catalogue en dur.
    expect(bundle).toContain('_API_KEY');
    expect(bundle).toContain('saas_business.ai_providers');
    expect(bundle).not.toMatch(/BUSINESS_GROW_(GROQ|GEMINI|DEEPSEEK|MISTRAL|GROK|OPENROUTER|CLOUDFLARE)_/);
  });

  it('embarque la garde d’abonnement de la Phase A', () => {
    // Sans cette assertion, un bundle périmé pourrait repasser inaperçu : c'est
    // arrivé sur `store-import`, où la garde manquait au fichier committé.
    expect(bundle).toContain('checkImportConnectAccess');
    expect(bundle).toContain('bg_import_access');
    expect(bundle).toContain('IMPORT_ACCESS_UNAVAILABLE');
    expect(bundle).toContain('BUSINESS_GROW_SUBSCRIPTION_REQUIRED');
  });

  it('refuse une origine inconnue en renvoyant l’en-tête CORS explicite', () => {
    // Régression : un 403 sans en-tête CORS est vu par le navigateur comme une
    // panne réseau, affichée à tort « backend absent ou non déployé ».
    expect(bundle).toContain('forceAllowOrigin');
    expect(bundle).toContain('ORIGIN_NOT_ALLOWED');
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
  // `LOADER` et `GITHUB_LOADER` désignent le même fichier depuis l'alignement
  // sur le mécanisme réellement déployé : `loader.ts`.
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
