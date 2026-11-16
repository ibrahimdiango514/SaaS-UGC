import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildArtifact } from '../scripts/build-edge-artifact.mjs';

/**
 * Exécution du bundle `store-import` **tel qu'il est livré**.
 *
 * ## Pourquoi ce test existe
 * Trois défauts ont été trouvés en testant le parcours réel, aucun en relisant
 * le code ni en lançant la suite :
 *
 *  1. `index.ts` appelait `importFile` sans l'importer. Tout import de fichier
 *     répondait 500 `STORE_IMPORT_BACKEND_ERROR`.
 *  2. Le prix était divisé par `10 ** produit.currencyExponent`, propriété
 *     inexistante : 12 000 XOF serait devenu 120.
 *  3. `supabase/functions/` n'était couvert par aucun `tsconfig` : rien de tout
 *     cela ne pouvait être vu par `tsc`.
 *
 * Chercher des noms de fonctions dans le bundle ne prouverait rien : esbuild le
 * minifie, et un identifiant manquant ne se voit qu'**à l'appel**. Ce test
 * charge donc le bundle dans un contexte isolé, capture le gestionnaire HTTP
 * qu'il enregistre, et lui envoie une vraie requête d'aperçu de fichier.
 *
 * Les dépendances externes sont remplacées : `Deno` (globale) et la connexion
 * PostgreSQL. Le SQL est reconnu sur son texte, que la minification préserve.
 */

const BUNDLE = buildArtifact('store-import').source;

/**
 * Faux `sql` : répond selon la requête, sans base.
 *
 * Deux formes à distinguer. En gabarit (`sql\`select …\``), le premier argument
 * est le tableau de chaînes. En constructeur d'insertion
 * (`sql('table', valeur)`), c'est une chaîne : c'est ce qui permet de
 * reconnaître l'écriture et d'en capturer la ligne.
 */
type Fabrique = () => {
  (gabarit: unknown, ...valeurs: unknown[]): Promise<unknown>;
  end(): Promise<void>;
  unsafe(): Promise<unknown[]>;
};

function fausseBase(enregistrements: Array<Record<string, unknown>>): Fabrique {
  const requete = (gabarit: unknown) => {
    if (!Array.isArray(gabarit)) {
      // Forme réelle observée dans le bundle : `db(row)` — la ligne est le
      // PREMIER argument, et c'est le `this` de l'appel qui porte la clause
      // de colonnes. Aucun nom de table n'apparaît ici ; on capture donc toute
      // ligne d'apparence produit, ce que seul l'import peut produire.
      const ligne = gabarit as Record<string, unknown>;
      if (ligne && typeof ligne === 'object' && 'workspace_id' in ligne) {
        enregistrements.push(ligne);
      }
      return Promise.resolve([]);
    }
    const texte = gabarit.join('? ');
    if (texte.includes('bg_import_access')) {
      return Promise.resolve([{ droits: { allowed: true, reason: 'OK', message: 'actif', status: 'active' } }]);
    }
    if (texte.includes('bg_can_workspace')) {
      return Promise.resolve([{ can_read: true, can_write: true }]);
    }
    return Promise.resolve([]);
  };
  const instance = Object.assign(requete, {
    end: () => Promise.resolve(),
    unsafe: () => Promise.resolve([]),
  });
  // `__edgePostgres` est la FABRIQUE (`postgres(url, options)`), pas l'instance :
  // le bundle l'appelle au chargement puis garde le retour. Rendre l'instance
  // directement faisait de `sql` une promesse, et la première requête échouait
  // par « t is not a function » — masqué en 503.
  return () => instance;
}

/**
 * Charge le bundle et renvoie le gestionnaire HTTP enregistré.
 *
 * Le contexte fournit ce que la production fournit : `Deno` (avec `serve`) et
 * `__edgePostgres` (la connexion, posée par le chargeur). Rien d'autre : si le
 * bundle dépend d'une globale non déclarée, il échoue ici comme en production.
 */
function chargerBundle(enregistrements: Array<Record<string, unknown>> = []) {
  type Gestionnaire = (request: Request) => Promise<Response>;
  let gestionnaire: Gestionnaire | null = null;
  const contexte = {
    __edgePostgres: fausseBase(enregistrements),
    Deno: {
      serve: (h: Gestionnaire) => { gestionnaire = h; },
      env: { get: (nom: string) => (nom === 'SUPABASE_URL' ? 'https://exemple.invalid' : 'cle') },
    },
    // GoTrue rend l'identité de l'appelant : `getUserId` exige un UUID réel,
    // sinon le bundle refuse la requête comme non authentifiée.
    fetch: () => Promise.resolve(new Response(
      JSON.stringify({ id: '22222222-2222-4222-8222-222222222222' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )),
    Response, Request, Headers, URL, AbortSignal, AbortController,
    TextEncoder, TextDecoder, crypto, atob, btoa, Blob, console,
    setTimeout, clearTimeout, structuredClone, Math, Date, JSON,
  };
  runInNewContext(BUNDLE, contexte);
  if (!gestionnaire) throw new Error('le bundle n’a enregistré aucun gestionnaire HTTP');
  return gestionnaire as Gestionnaire;
}

/** Construit une requête `preview` de fichier, comme le fait le navigateur. */
function requeteApercu(corpsCsv: string): Request {
  const base64 = Buffer.from(corpsCsv, 'utf8').toString('base64');
  return new Request('https://exemple.invalid/functions/v1/store-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
    body: JSON.stringify({
      action: 'preview',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      fileName: 'catalogue.csv',
      fileBase64: base64,
    }),
  });
}

describe('bundle store-import exécuté', () => {
  it('analyse un fichier CSV sans lever de ReferenceError', async () => {
    const gestionnaire = chargerBundle();
    // Le défaut n° 1 se manifestait ici : `importFile is not defined`.
    const reponse = await gestionnaire(requeteApercu(
      'name,price,currency,stock\nSable fin,2500,XOF,4\nBrise matinale,7500,XOF,9',
    ));

    const corps = await reponse.json() as { data?: { products?: unknown[]; summary?: { total: number } }; error?: { code: string } };
    expect(corps.error, `échec serveur : ${JSON.stringify(corps.error)}`).toBeUndefined();
    expect(reponse.status).toBe(200);
    expect(corps.data?.summary?.total).toBe(2);
  });

  it('écrit un prix XOF sans le diviser par cent', async () => {
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements);

    // 1) Aperçu, qui émet le `previewId`.
    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,12000,XOF',
    ))).json() as { data: { previewId: string; products: Array<{ index: number }> } };

    // 2) Confirmation explicite, comme le fait l'interface.
    const confirmation = new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
        selection: [0],
      }),
    });
    const resultat = await (await gestionnaire(confirmation)).json() as { data?: { created: number } };

    expect(resultat.data?.created).toBe(1);
    // Le défaut n° 2 se manifestait ici : 12 000 devenait 120.
    expect(enregistrements).toHaveLength(1);
    expect(Number(enregistrements[0].price_amount)).toBe(12000);
    expect(enregistrements[0].price_currency).toBe('XOF');
    expect(enregistrements[0].name).toBe('Sable fin');
  });

  it('refuse un fichier illisible sans écrire quoi que ce soit', async () => {
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements);
    const reponse = await gestionnaire(requeteApercu('n’importe quoi, sans en-tête ni colonnes'));

    // Un fichier sans en-tête reconnaissable est refusé, et l'aperçu ne doit
    // produire AUCUNE ligne de produit.
    expect(reponse.status).toBeGreaterThanOrEqual(400);
    expect(enregistrements).toHaveLength(0);
  });
});

describe('configuration de vérification des Edge Functions', () => {
  it('couvre store-import par un tsconfig dédié', () => {
    // Sans ce fichier, `npm run typecheck` ne voit pas les Edge Functions :
    // c'est exactement ce trou qui a laissé passer l'import manquant.
    expect(existsSync('tsconfig.edge.json')).toBe(true);
    const config = JSON.parse(readFileSync('tsconfig.edge.json', 'utf8')) as {
      include?: string[];
    };
    expect(config.include ?? []).toContain('supabase/functions/store-import/index.ts');
  });

  it('déclare le module npm: pour que TypeScript puisse résoudre postgres', () => {
    expect(existsSync('supabase/functions/types/npm-postgres.d.ts')).toBe(true);
  });
});
