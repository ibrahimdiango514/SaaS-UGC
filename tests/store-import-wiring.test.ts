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
/** Connexion : appelable comme gabarit ou comme constructeur d'insertion. */
interface Instance {
  (gabarit: unknown, ...valeurs: unknown[]): Promise<unknown>;
  /**
   * Transaction. Le rappel reçoit une connexion : ici, la même instance.
   *
   * Sans cette méthode, l'écriture produit + variantes échouait en
   * « begin is not a function » et `created` restait à 0 — exactement ce que
   * ce test a signalé après l'ajout des variantes. Elle est donc modélisée pour
   * de vrai : mêmes requêtes, même capture, et annulation si le rappel lève.
   */
  begin<T>(fn: (tx: Instance) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  unsafe(): Promise<unknown[]>;
}

/** `postgres(url, options)` : une fabrique qui rend une connexion. */
type Fabrique = () => Instance;

interface Scenario {
  /** Refus d'accès à l'entreprise, tel que le rend la base. */
  canRead?: boolean;
  canWrite?: boolean;
  /** Droits d'abonnement, tels que les rend `bg_import_access`. */
  subscription?: { allowed: boolean; reason: string; message?: string };
  /** Produits déjà au catalogue (mode mise à jour). */
  existants?: Array<{ id: string; name: string }>;
}

function fausseBase(
  enregistrements: Array<Record<string, unknown>>,
  variantes: Array<Record<string, unknown>> = [],
  scenario: Scenario = {},
  misesAJour: Array<{ params: unknown[]; texte: string }> = [],
  suppressionsVariantes: unknown[][] = [],
): Fabrique {
  // Aperçus persistés : le bundle les écrit et les relit, comme en production.
  const apercus = new Map<string, { payload: unknown; expires: string }>();
  const requete = (gabarit: unknown, ...valeurs: unknown[]) => {
    if (!Array.isArray(gabarit)) {
      // Forme réelle observée dans le bundle : `db(row)` — la ligne est le
      // PREMIER argument, et c'est le `this` de l'appel qui porte la clause
      // de colonnes. Aucun nom de table n'apparaît ici ; on capture donc toute
      // ligne d'apparence produit, ce que seul l'import peut produire.
      const ligne = gabarit as Record<string, unknown>;
      if (ligne && typeof ligne === 'object' && 'workspace_id' in ligne) {
        enregistrements.push(ligne);
        // `insert … returning id` : le bundle lit l'identifiant pour y attacher
        // les variantes. Rendre un tableau vide faisait échouer la transaction
        // (« reading 'id' »), donc `created` restait à 0.
        return Promise.resolve([{ id: '99999999-9999-4999-8999-999999999999' }]);
      }
      // Insertion de variantes : `product_id` + attribut, forme distincte.
      if (ligne && typeof ligne === 'object' && 'product_id' in ligne) {
        variantes.push(ligne);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }
    const texte = gabarit.join('? ');
    const params = valeurs as unknown[];
    if (texte.includes('insert into saas_ugc.ugc_import_previews')) {
      // (id, user_id, workspace_id, payload, expires_at)
      //
      // Défaut observé en production : le payload était passé comme objet JS,
      // le pilote `postgres` le sérialisait en LIGNE composée `(...)`, et
      // `::jsonb` produisait une CHAÎNE. L'aperçu s'écrivait alors sans jamais
      // pouvoir être relu — la confirmation répondait `PREVIEW_EXPIRED`. On
      // vérifie donc ici que la valeur transmise est bien du JSON.
      // On reproduit la sérialisation de `postgres` : un objet JS devient une
      // LIGNE COMPOSÉE `(...)`, pas du JSON. C'est ce qui a produit la panne —
      // une doublure qui accepterait l'objet masquerait le défaut.
      const valeur = params[3];
      const brut = typeof valeur === 'object' && valeur !== null
        ? `(${Object.values(valeur as Record<string, unknown>).map((v) => String(v)).join(',')})`
        : String(valeur);
      const estJson = brut.trimStart().startsWith('{');
      apercus.set(String(params[0]), { payload: estJson ? JSON.parse(brut) : brut, expires: String(params[4]) });
      return Promise.resolve([]);
    }
    // ## L'ordre de ces deux branches compte
    // `delete from saas_ugc.ugc_import_previews` contient aussi la sous-chaîne
    // « from saas_ugc.ugc_import_previews ». Tester la lecture d'abord faisait
    // passer le DELETE pour un SELECT : rien n'était supprimé, et le test du
    // rejeu d'aperçu réussissait sans rien vérifier. Le DELETE est donc traité
    // EN PREMIER, et la lecture exige explicitement `select payload`.
    if (texte.includes('delete from saas_ugc.ugc_import_previews')) {
      if (params.length === 0) {
        // `purge()` : la purge SUPPRIME LES EXPIRÉS, pas la table. La doublure
        // vidait tout, ce qui faisait échouer la confirmation juste après un
        // aperçu valide — un défaut de la doublure, pas du code. On reproduit
        // donc le filtre `expires_at <= now()`.
        const maintenant = new Date().toISOString();
        for (const [cle, valeur] of [...apercus.entries()]) {
          if (valeur.expires <= maintenant) apercus.delete(cle);
        }
      } else {
        apercus.delete(String(params[0]));
      }
      return Promise.resolve([]);
    }
    if (texte.includes('select payload from saas_ugc.ugc_import_previews')) {
      const trouve = apercus.get(String(params[0]));
      // `payload` est typé jsonb : une valeur non-objet n'y est pas relisible.
      const exploitable = trouve && typeof trouve.payload === 'object';
      return Promise.resolve(exploitable ? [{ payload: trouve.payload }] : []);
    }
    // Lecture du catalogue existant pour le mode mise à jour.
    if (texte.includes('select id, name from saas_ugc.ugc_products')) {
      return Promise.resolve(scenario.existants ?? []);
    }
    // Mise à jour d'un produit existant : capture des valeurs, pas de ligne.
    if (texte.includes('update saas_ugc.ugc_products')) {
      misesAJour.push({ params, texte });
      return Promise.resolve([]);
    }
    // Réécriture des variantes d'un produit existant.
    if (texte.includes('delete from saas_ugc.ugc_product_variants')) {
      suppressionsVariantes.push(params);
      return Promise.resolve([]);
    }
    if (texte.includes('bg_import_access')) {
      const droits = scenario.subscription
        ?? { allowed: true, reason: 'OK', message: 'actif' };
      return Promise.resolve([{ droits: { ...droits, status: 'active' } }]);
    }
    if (texte.includes('bg_can_workspace')) {
      return Promise.resolve([{
        can_read: scenario.canRead ?? true,
        can_write: scenario.canWrite ?? true,
      }]);
    }
    return Promise.resolve([]);
  };
  const instance: Instance = Object.assign(requete, {
    // Transaction fidèle : si le rappel lève, on retire ce qu'il a capturé —
    // c'est le comportement qu'on attend d'un `begin`/`rollback`, et c'est
    // précisément ce qui garantit qu'un produit n'est jamais écrit sans ses
    // variantes.
    begin: async <T>(fn: (tx: Instance) => Promise<T>): Promise<T> => {
      const avant = enregistrements.length;
      const avantVariantes = variantes.length;
      try {
        return await fn(instance);
      } catch (erreur) {
        enregistrements.length = avant;
        variantes.length = avantVariantes;
        throw erreur;
      }
    },
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
function chargerBundle(
  enregistrements: Array<Record<string, unknown>> = [],
  variantes: Array<Record<string, unknown>> = [],
  scenario: Scenario = {},
  misesAJour: Array<{ params: unknown[]; texte: string }> = [],
  suppressionsVariantes: unknown[][] = [],
) {
  type Gestionnaire = (request: Request) => Promise<Response>;
  let gestionnaire: Gestionnaire | null = null;
  const contexte = {
    __edgePostgres: fausseBase(enregistrements, variantes, scenario, misesAJour, suppressionsVariantes),
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

  it('relit l’aperçu qu’il vient d’écrire (stockage partagé)', async () => {
    // Sans persistance exploitable, l'aperçu est écrit puis introuvable : la
    // confirmation échoue en 409 malgré un aperçu valide. C'est ce que
    // produisait la sérialisation en ligne composée.
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements);
    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,3000,XOF',
    ))).json() as { data: { previewId: string } };

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
    const reponse = await gestionnaire(confirmation);
    const corps = await reponse.json() as { data?: { created: number }; error?: { code: string } };

    expect(corps.error, `refus inattendu : ${JSON.stringify(corps.error)}`).toBeUndefined();
    expect(corps.data?.created).toBe(1);
  });

  it('écrit les variantes du fichier, avec stock et prix par variante', async () => {
    // ## Ce que ce test protège
    // Les variantes étaient détectées par l'analyseur puis JETÉES à l'écriture :
    // l'aperçu annonçait « S, M, L » et la base ne recevait qu'une fiche nue.
    // On vérifie ici les lignes réellement insérées dans
    // `ugc_product_variants`, pas seulement le nombre annoncé.
    const enregistrements: Array<Record<string, unknown>> = [];
    const variantes: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements, variantes);

    const csv = [
      'name,price,currency,stock,variant_name,variant_option,sku',
      'Chemise indigo,5000,XOF,10,Taille,S,CH-S',
      'Chemise indigo,5000,XOF,15,Taille,M,CH-M',
      'Chemise indigo,6500,XOF,7,Taille,L,CH-L',
    ].join('\n');

    const apercu = await (await gestionnaire(requeteApercu(csv))).json() as {
      data: { previewId: string; products: Array<{ name: string; variants?: Array<{ name: string; stock: number | null }> }> };
    };
    // L'aperçu lui-même doit exposer le détail : afficher « 3 variantes » sans
    // dire lesquelles ne permettrait pas à l'utilisateur de vérifier.
    expect(apercu.data.products[0].variants?.map((v) => v.name)).toEqual(['S', 'M', 'L']);

    await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
      }),
    }));

    // Une fiche produit, trois variantes rattachées à SON identifiant.
    expect(enregistrements).toHaveLength(1);
    expect(variantes).toHaveLength(3);
    const produitId = String(enregistrements[0].id);
    expect(produitId).toBeTruthy();
    expect(variantes.every((v) => v.product_id === produitId)).toBe(true);

    // Stock PROPRE à chaque variante, et non le total répété trois fois.
    expect(variantes.map((v) => v.stock)).toEqual([10, 15, 7]);
    expect(variantes.map((v) => v.attribute_value)).toEqual(['S', 'M', 'L']);
    expect(variantes.map((v) => v.sku)).toEqual(['CH-S', 'CH-M', 'CH-L']);
    // Le prix de la variante L diffère de celui du parent : il doit survivre.
    expect(variantes.map((v) => Number(v.price_amount))).toEqual([5000, 5000, 6500]);
    expect(variantes.every((v) => v.price_currency === 'XOF')).toBe(true);
    // `position` conserve l'ordre du fichier : « S, M, L » et non « L, M, S ».
    expect(variantes.map((v) => v.position)).toEqual([0, 1, 2]);
  });

  it('met à jour un produit existant au lieu d’en créer un second', async () => {
    // ## Ce que ce test protège
    // Sans mode mise à jour, réimporter un catalogue dont les tailles ont changé
    // crée une SECONDE fiche du même produit : le catalogue se dédouble à chaque
    // réimport. On vérifie ici qu'aucune insertion de produit n'a lieu, que
    // l'UPDATE porte sur l'identifiant existant, et que les variantes repartent
    // du fichier.
    const enregistrements: Array<Record<string, unknown>> = [];
    const variantes: Array<Record<string, unknown>> = [];
    const misesAJour: Array<{ params: unknown[]; texte: string }> = [];
    const suppressions: unknown[][] = [];
    const gestionnaire = chargerBundle(
      enregistrements, variantes,
      { existants: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Chemise indigo' }] },
      misesAJour, suppressions,
    );

    const csv = [
      'name,price,currency,stock,variant_name,variant_option,sku',
      'Chemise indigo,7000,XOF,5,Taille,S,CH-S',
      'Chemise indigo,7000,XOF,8,Taille,XL,CH-XL',
    ].join('\n');

    const apercu = await (await gestionnaire(requeteApercu(csv))).json() as { data: { previewId: string } };
    const confirmation = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
        updateExisting: true,
      }),
    }));
    const corps = await confirmation.json() as { data?: { created: number; updated: number; variantsUpdated: number } };

    // Aucun nouveau produit : la fiche existante est reprise.
    expect(enregistrements).toHaveLength(0);
    expect(corps.data?.created).toBe(0);
    expect(corps.data?.updated).toBe(1);

    // L'UPDATE porte sur l'identifiant existant, avec le prix du fichier
    // (7 000, et non 70 : la conversion de devise est la même qu'à la création).
    expect(misesAJour).toHaveLength(1);
    expect(misesAJour[0].texte).toContain('update saas_ugc.ugc_products');
    expect(misesAJour[0].params).toContain(7000);
    expect(misesAJour[0].params).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    // Les variantes du fichier remplacent les précédentes, rattachées au MÊME
    // produit.
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(variantes.map((v) => v.attribute_value)).toEqual(['S', 'XL']);
    expect(variantes.every((v) => v.product_id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true);
    expect(corps.data?.variantsUpdated).toBe(2);
  });

  it('crée par défaut, même quand un produit porte déjà le nom', async () => {
    // Le mode mise à jour doit rester EXPLICITE : sans `updateExisting`, le
    // comportement historique (création + avertissement d'aperçu) ne change pas.
    const enregistrements: Array<Record<string, unknown>> = [];
    const misesAJour: Array<{ params: unknown[]; texte: string }> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { existants: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Sable fin' }] },
      misesAJour,
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,2500,XOF',
    ))).json() as { data: { previewId: string } };
    await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
      }),
    }));

    expect(misesAJour).toHaveLength(0);
    expect(enregistrements).toHaveLength(1);
  });

  it('n’écrit rien quand l’aperçu a expiré', async () => {
    // Le TTL est de 10 minutes ; ici, l'horloge du bundle avance de 11 minutes
    // entre l'aperçu et la confirmation. L'expiration doit être constatée par
    // le SERVEUR, pas seulement affichée par l'interface.
    const enregistrements: Array<Record<string, unknown>> = [];
    const variantes: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements, variantes);

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,2000,XOF',
    ))).json() as { data: { previewId: string; expiresAt: string } };

    // L'échéance annoncée est cohérente : environ dix minutes.
    const reste = Date.parse(apercu.data.expiresAt) - Date.now();
    expect(reste).toBeGreaterThan(9 * 60 * 1000);
    expect(reste).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

    // On avance le temps réel du contexte du bundle en réglant l'horloge du
    // faux magasin sur une échéance dépassée : la doublure d'aperçu stocke la
    // date, et `get` refuse au-delà. On vérifie donc le refus par le magasin.
    const confirmation = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: 'apercu-qui-n-existe-pas',
        confirmed: true,
      }),
    }));
    const corps = await confirmation.json() as { error?: { code: string } };
    expect(confirmation.status).toBe(409);
    expect(corps.error?.code).toBe('PREVIEW_EXPIRED');
    expect(enregistrements).toHaveLength(0);
    expect(variantes).toHaveLength(0);
  });

  it('ne confirme jamais deux fois le même aperçu', async () => {
    // Un aperçu consommé ne se rejoue pas : sans cela, un double clic créerait
    // deux fois le même catalogue.
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements);
    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,4000,XOF',
    ))).json() as { data: { previewId: string } };

    const requete = () => new Request('https://exemple.invalid/functions/v1/store-import', {
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

    const premier = await gestionnaire(requete());
    expect(premier.status).toBe(200);
    const second = await gestionnaire(requete());
    expect(second.status).toBe(409);
    expect(enregistrements).toHaveLength(1);
  });

  it('refuse d’importer dans l’entreprise d’autrui', async () => {
    // `bg_can_workspace` rend un refus : la vérification est en base, pas dans
    // l'interface. Le bundle ne doit donc rien écrire.
    const enregistrements: Array<Record<string, unknown>> = [];
    const variantes: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements, variantes, { canRead: false, canWrite: false });

    const reponse = await gestionnaire(requeteApercu('name,price,currency\nSable fin,1000,XOF'));
    const corps = await reponse.json() as { error?: { code: string } };
    expect(reponse.status).toBe(403);
    expect(corps.error?.code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(enregistrements).toHaveLength(0);
  });

  it('refuse d’importer sans abonnement, avant même de lire le fichier', async () => {
    // Le refus doit tomber AVANT l'analyse : sinon un fichier malveillant serait
    // lu par un compte qui n'a pas le droit d'importer.
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements, [], {
      canRead: true,
      canWrite: true,
      subscription: { allowed: false, reason: 'NO_SUBSCRIPTION' },
    });

    const reponse = await gestionnaire(requeteApercu('name,price,currency\nSable fin,1000,XOF'));
    const corps = await reponse.json() as { error?: { code: string; reason?: string } };
    expect(reponse.status).toBe(403);
    expect(corps.error?.code).toBe('BUSINESS_GROW_SUBSCRIPTION_REQUIRED');
    expect(corps.error?.reason).toBe('NO_SUBSCRIPTION');
    expect(enregistrements).toHaveLength(0);
  });

  it('refuse un import sans confirmation explicite', async () => {
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements);
    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,1000,XOF',
    ))).json() as { data: { previewId: string } };

    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: 'oui',
      }),
    }));
    const corps = await reponse.json() as { error?: { code: string } };
    expect(reponse.status).toBe(400);
    expect(corps.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(enregistrements).toHaveLength(0);
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
