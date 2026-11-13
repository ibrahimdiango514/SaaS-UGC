import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LOADER, artifact, renderLoader } from '../scripts/build-business-grow-artifact.mjs';

/**
 * Le canal de déploiement peut tronquer une source longue : le code réellement
 * exécuté en production est l'artefact gzip+base64 du chargeur. Ces tests
 * garantissent que cet artefact reste, octet pour octet, le code du dépôt.
 */
describe('artefact déployable business-grow', () => {
  const loader = readFileSync(join(process.cwd(), LOADER), 'utf8');

  it('est identique à ce que produit la compilation du dépôt', () => {
    const built = artifact();
    expect(loader).toBe(renderLoader(built));
  });

  it('se décompresse vers un bundle ES2022 intègre et complet', () => {
    const payload = loader.match(/const PAYLOAD = "([A-Za-z0-9+/=]+)";/)?.[1];
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

  it('tient sous la limite de troncature du canal de déploiement', () => {
    const payload = loader.match(/const PAYLOAD = "([A-Za-z0-9+/=]+)";/)?.[1] ?? '';
    // Au-delà de 20 000 caractères, l'API de déploiement tronque la source :
    // la fonction démarrait alors en BOOT_ERROR (503).
    expect(payload.length).toBeLessThan(20_000);
  });

  it('est exécutable par new Function (aucun import) et démarre le handler', () => {
    const payload = loader.match(/const PAYLOAD = "([A-Za-z0-9+/=]+)";/)?.[1];
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
    const payload = loader.match(/const PAYLOAD = "([A-Za-z0-9+/=]+)";/)?.[1];
    const source = gunzipSync(Buffer.from(payload as string, 'base64')).toString('utf8');

    // Le chargeur est le seul fichier déployé : un import relatif casserait le boot.
    expect(source).not.toMatch(/from\s*["']\.\.?\//);
    // Aucune clé n'est inlinée : les valeurs restent lues via env(...).
    expect(source).not.toMatch(/gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}/);
    expect(source).toContain('BUSINESS_GROW_GROQ_API_KEY');
    expect(source).toContain('BUSINESS_GROW_GEMINI_API_KEY');
  });

  it('refuse une origine inconnue en renvoyant l’en-tête CORS explicite', () => {
    // Régression : un 403 sans en-tête CORS est vu par le navigateur comme une
    // panne réseau, affichée à tort « backend absent ou non déployé ».
    const payload = loader.match(/const PAYLOAD = "([A-Za-z0-9+/=]+)";/)?.[1];
    const source = gunzipSync(Buffer.from(payload as string, 'base64')).toString('utf8');
    expect(source).toContain('forceAllowOrigin');
    expect(source).toContain('ORIGIN_NOT_ALLOWED');
  });
});
