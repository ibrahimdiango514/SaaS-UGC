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
  existants?: Array<{
    id: string;
    name: string;
    sku?: string | null;
    platformId?: string | null;
    variantSkus?: string[];
  }>;
  /** Lignes de progression déjà présentes pour le lot. */
  progress?: Array<{ line_key: string; product_id: string; outcome: string; variants_written: number }>;
}

function fausseBase(
  enregistrements: Array<Record<string, unknown>>,
  variantes: Array<Record<string, unknown>> = [],
  scenario: Scenario = {},
  misesAJour: Array<{ params: unknown[]; texte: string }> = [],
  suppressionsVariantes: unknown[][] = [],
  progressions: unknown[][] = [],
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
    // Lecture de la progression d'un lot (reprise).
    if (texte.includes('from saas_ugc.ugc_import_progress')) {
      return Promise.resolve(scenario.progress ?? []);
    }
    // Écriture d'une ligne de progression.
    if (texte.includes('insert into saas_ugc.ugc_import_progress')) {
      progressions.push(params);
      return Promise.resolve([]);
    }
    // Lecture du catalogue existant : sert au rapprochement ET au mode mise à
    // jour. Reconnue sur la table lue, pas sur la liste de colonnes — celle-ci
    // porte désormais l'identité (`sku`, `platform_id`, SKU des variantes).
    if (texte.includes('from saas_ugc.ugc_products')) {
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
  progressions: unknown[][] = [],
) {
  type Gestionnaire = (request: Request) => Promise<Response>;
  let gestionnaire: Gestionnaire | null = null;
  const contexte = {
    __edgePostgres: fausseBase(
      enregistrements, variantes, scenario, misesAJour, suppressionsVariantes, progressions,
    ),
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

  it('met à jour une correspondance exacte, mais crée les autres', async () => {
    /*
     * ## Ce test a changé de sens, volontairement
     *
     * Il vérifiait que SANS `updateExisting`, un produit homonyme était créé en
     * double — une régression, pas une garantie. La déduplication intelligente
     * renverse la règle : une correspondance EXACTE est appliquée d'office,
     * parce qu'elle est sûre (nom identique normalisé, référence identique ou
     * identifiant de source identique). C'est ce que la commande demande.
     *
     * Ce qui reste vrai, et que l'ancien test protégeait : aucune fusion sur
     * une RESSEMBLANCE. Cette garantie est testée plus haut (« présente un nom
     * proche comme ambigu »).
     */
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

    expect(misesAJour).toHaveLength(1);
    expect(enregistrements).toHaveLength(0);
    // Le produit garde son identifiant : vidéos et historique restent liés.
    expect(misesAJour[0].params).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('rapproche par SKU : met à jour le bon produit au lieu d’en créer un', async () => {
    // ## Ce que ce test protège
    // L'ancienne déduplication ne regardait que le nom. Un produit renommé à la
    // source — même référence, nouveau libellé — était donc CRÉÉ une seconde
    // fois. Ici la référence identifie le produit : il est mis à jour, et son
    // identifiant interne est réutilisé (donc ses vidéos et son historique
    // restent attachés).
    const enregistrements: Array<Record<string, unknown>> = [];
    const misesAJour: Array<{ params: unknown[]; texte: string }> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { existants: [{ id: '99999999-9999-4999-8999-999999999999', name: 'Ancien nom', sku: 'SAB-1' }] },
      misesAJour,
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency,reference\nNouveau nom,2500,XOF,SAB-1',
    ))).json() as { data: { products: Array<{ match: string; targetId: string | null; importable: boolean }> } };

    expect(apercu.data.products[0].match).toBe('update');
    expect(apercu.data.products[0].targetId).toBe('99999999-9999-4999-8999-999999999999');
    // Un produit rapproché reste importable : il sera mis à jour, pas dupliqué.
    expect(apercu.data.products[0].importable).toBe(true);

    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: (apercu as unknown as { data: { previewId: string } }).data.previewId,
        confirmed: true,
      }),
    }));
    await reponse.json();

    // Aucune création : la cible du rapprochement est mise à jour.
    expect(enregistrements).toHaveLength(0);
    expect(misesAJour).toHaveLength(1);
    expect(misesAJour[0].params).toContain('99999999-9999-4999-8999-999999999999');
  });

  it('présente un nom proche comme ambigu et n’écrit rien', async () => {
    // Jamais de fusion automatique sur une ressemblance de nom. La ligne est
    // montrée avec ses candidats et n'est pas importable tant qu'elle n'est pas
    // tranchée : c'est une décision, pas une devinette.
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { existants: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Chemise indigo' }] },
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nChemise indigo premium,4500,XOF',
    ))).json() as {
      data: {
        previewId: string;
        products: Array<{ match: string; matchReason: string; importable: boolean; candidates: Array<{ id: string; name: string }> }>;
        summary: { importable: number };
      };
    };

    const ligne = apercu.data.products[0];
    expect(ligne.match).toBe('ambiguous');
    expect(ligne.importable).toBe(false);
    expect(ligne.candidates[0]).toMatchObject({ name: 'Chemise indigo' });
    // La raison est lisible, en français : elle dit ce qui empêche d'écrire.
    expect(ligne.matchReason.length).toBeGreaterThan(10);
    expect(apercu.data.summary.importable).toBe(0);

    // Confirmer le lot ne doit rien écrire : la ligne ambiguë est exclue.
    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
      }),
    }));
    expect(reponse.status).toBe(400);
    expect(enregistrements).toHaveLength(0);
  });

  it('ne fusionne pas deux produits différents qui portent le même nom', async () => {
    // Deux fiches homonymes au catalogue et une seule ligne entrante : le
    // rapprochement ne peut pas choisir. Il le dit, au lieu d'écraser l'une au
    // hasard.
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { existants: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Sac cuir' },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Sac cuir' },
      ] },
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSac cuir,9000,XOF',
    ))).json() as { data: { products: Array<{ match: string; importable: boolean; candidates: unknown[] }> } };

    expect(apercu.data.products[0].match).toBe('ambiguous');
    expect(apercu.data.products[0].importable).toBe(false);
    expect(apercu.data.products[0].candidates).toHaveLength(2);
  });

  it('garde le comportement historique : nom identique, casse ignorée', async () => {
    // Aucun identifiant stable nulle part : le nom exact reste le seul indice,
    // et il rapproche comme avant — sans créer de doublon.
    const enregistrements: Array<Record<string, unknown>> = [];
    const misesAJour: Array<{ params: unknown[]; texte: string }> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { existants: [{ id: '33333333-3333-4333-8333-333333333333', name: 'SÉRUM ÉCLAT' }] },
      misesAJour,
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nsérum éclat,2500,XOF',
    ))).json() as { data: { products: Array<{ match: string; importable: boolean }> } };

    expect(apercu.data.products[0].match).toBe('update');
    expect(apercu.data.products[0].importable).toBe(true);
  });

  it('signale un doublon interne au lot sans l’écrire deux fois', async () => {
    const enregistrements: Array<Record<string, unknown>> = [];
    const gestionnaire = chargerBundle(enregistrements);

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency\nSable fin,2500,XOF\nSable fin,2500,XOF',
    ))).json() as { data: { products: Array<{ match: string; importable: boolean }>; summary: { importable: number } } };

    expect(apercu.data.products[0].importable).toBe(true);
    expect(apercu.data.products[1].match).toBe('duplicate-in-batch');
    expect(apercu.data.products[1].importable).toBe(false);
    expect(apercu.data.summary.importable).toBe(1);
  });

  it('n’écrase pas une description connue par une valeur absente', async () => {
    // Une source qui ne publie pas de description ne doit pas effacer celle
    // saisie par le commerçant. La garde est dans le SQL (`coalesce`) : on
    // vérifie qu'elle est bien présente dans l'instruction envoyée.
    const enregistrements: Array<Record<string, unknown>> = [];
    const misesAJour: Array<{ params: unknown[]; texte: string }> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { existants: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Sable fin', sku: 'SAB-1' }] },
      misesAJour,
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency,reference\nSable fin,2500,XOF,SAB-1',
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

    expect(misesAJour).toHaveLength(1);
    const texte = misesAJour[0].texte.replace(/\s+/g, ' ');
    expect(texte).toMatch(/description = coalesce\(nullif\(/);
    expect(texte).toMatch(/product_url = coalesce\(nullif\(/);
    // Le prix n'est remplacé que s'il est connu.
    expect(texte).toMatch(/case when .* then price_amount/);
  });

  it('reprend un lot et ne réécrit que les lignes restantes', async () => {
    // ## Ce que ce test protège
    // Une reprise qui retraite tout le lot réécrit les produits déjà faits.
    // Ici le journal dit que « Sable fin » est écrit : la reprise ne doit
    // écrire QUE « Brise matinale ».
    const enregistrements: Array<Record<string, unknown>> = [];
    const progressions: unknown[][] = [];
    const gestionnaire = chargerBundle(
      enregistrements, [], { progress: [
        { line_key: 'ref:SAB1', product_id: 'deja-ecrit', outcome: 'created', variants_written: 0 },
      ] }, [], [], progressions,
    );

    const csv = [
      'name,price,currency,reference',
      'Sable fin,2500,XOF,SAB-1',
      'Brise matinale,7500,XOF,BRI-1',
    ].join('\n');
    const apercu = await (await gestionnaire(requeteApercu(csv))).json() as { data: { previewId: string } };

    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
        importKey: 'lot-42',
      }),
    }));
    const corps = await reponse.json() as { data?: { created: number; alreadyDone: number } };

    // Un seul produit écrit : celui qui restait.
    expect(enregistrements).toHaveLength(1);
    expect(enregistrements[0].name).toBe('Brise matinale');
    expect(corps.data?.created).toBe(1);
    expect(corps.data?.alreadyDone).toBe(1);
    // La progression est journalisée pour la ligne écrite, et pour elle seule.
    expect(progressions).toHaveLength(1);
    expect(progressions[0]).toContain('ref:BRI1');
    expect(progressions[0]).not.toContain('ref:SAB1');
  });

  it('est idempotent : un lot entièrement fait n’écrit rien', async () => {
    // Rejouer une confirmation ne doit ni dupliquer ni réécrire. C'est la
    // propriété qui autorise à proposer « reprendre » sans réserve.
    const enregistrements: Array<Record<string, unknown>> = [];
    const progressions: unknown[][] = [];
    const gestionnaire = chargerBundle(
      enregistrements, [], { progress: [
        { line_key: 'ref:SAB1', product_id: 'deja', outcome: 'created', variants_written: 0 },
      ] }, [], [], progressions,
    );

    const apercu = await (await gestionnaire(requeteApercu(
      'name,price,currency,reference\nSable fin,2500,XOF,SAB-1',
    ))).json() as { data: { previewId: string } };

    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'import',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        previewId: apercu.data.previewId,
        confirmed: true,
        importKey: 'lot-fait',
      }),
    }));
    const corps = await reponse.json() as { data?: { created: number; updated: number; alreadyDone: number; message?: string } };

    expect(enregistrements).toHaveLength(0);
    expect((corps.data?.created ?? 0) + (corps.data?.updated ?? 0)).toBe(0);
    expect(corps.data?.alreadyDone).toBe(1);
    expect(corps.data?.message).toMatch(/déjà écrits/);
    // Aucune nouvelle ligne de progression : rejouer n'ajoute rien.
    expect(progressions).toHaveLength(0);
  });

  it('reprend tout quand le journal est vide, sans dupliquer', async () => {
    // Journal perdu (panne, purge) : on retraite le lot, mais le rapprochement
    // transforme les produits déjà présents en mises à jour.
    const enregistrements: Array<Record<string, unknown>> = [];
    const misesAJour: Array<{ params: unknown[]; texte: string }> = [];
    const gestionnaire = chargerBundle(
      enregistrements, [],
      { progress: [], existants: [{ id: 'aaaa-aaaa', name: 'Sable fin' }] },
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
        importKey: 'lot-perdu',
        updateExisting: true,
      }),
    }));

    expect(enregistrements).toHaveLength(0);
    expect(misesAJour).toHaveLength(1);
  });

  it('répond à `resume` en lecture seule, sans rien écrire', async () => {
    // L'état est consulté AVANT de reprendre : une action dont le résultat est
    // incertain ne se relance pas sans vérifier à quoi ressemble la base.
    const enregistrements: Array<Record<string, unknown>> = [];
    const progressions: unknown[][] = [];
    const gestionnaire = chargerBundle(
      enregistrements, [], { progress: [
        { line_key: 'ref:SAB1', product_id: 'p-1', outcome: 'created', variants_written: 2 },
      ] }, [], [], progressions,
    );

    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'resume',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        importKey: 'lot-42',
      }),
    }));
    const corps = await reponse.json() as {
      data?: { total: number; progressAvailable: boolean; lines: Array<{ lineKey: string; variantsWritten: number }> };
    };

    expect(reponse.status).toBe(200);
    expect(corps.data?.progressAvailable).toBe(true);
    expect(corps.data?.total).toBe(1);
    expect(corps.data?.lines[0]).toMatchObject({ lineKey: 'ref:SAB1', variantsWritten: 2 });
    // Lecture seule : aucune écriture, même de progression.
    expect(enregistrements).toHaveLength(0);
    expect(progressions).toHaveLength(0);
  });

  it('refuse `resume` sans identifiant de lot', async () => {
    const gestionnaire = chargerBundle();
    const reponse = await gestionnaire(new Request('https://exemple.invalid/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer jeton' },
      body: JSON.stringify({
        action: 'resume',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      }),
    }));
    expect(reponse.status).toBe(400);
    const corps = await reponse.json() as { error?: { code: string } };
    expect(corps.error?.code).toBe('IMPORT_KEY_REQUIRED');
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
