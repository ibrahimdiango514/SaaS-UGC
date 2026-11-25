/**
 * SORAHNEX — rapprochement d'un produit importé avec le catalogue existant.
 *
 * ## Le problème
 * La déduplication actuelle compare le nom exact (casse, accents et ponctuation
 * ignorés). C'est sûr mais aveugle : réimporter une boutique dont on a renommé
 * un produit crée une seconde fiche, et deux produits réellement différents
 * dont le nom se ressemble ne sont pas distingués.
 *
 * ## La règle qui gouverne tout ce module
 * **On ne fusionne jamais sur une ressemblance de nom.** Un nom proche est un
 * indice à examiner, jamais une décision. Deux conséquences concrètes :
 *
 *   - un identifiant stable identique (référence interne de la source, SKU
 *     partagé) rapproche — et encore, seulement s'il ne désigne pas plusieurs
 *     produits différents, auquel cas c'est une ambiguïté ;
 *   - un nom seulement proche produit une **correspondance ambiguë**, présentée
 *     à l'utilisateur, jamais appliquée d'office.
 *
 * ## Pourquoi des niveaux, et pas un score
 * Un score unique oblige à choisir un seuil, et un seuil se trompe. Ici chaque
 * règle a un niveau de confiance nommé, et l'ordre est explicite :
 *
 *   1. `platform-id` — l'identifiant du produit chez la source (Shopify
 *      `handle`, PrestaShop `id`, OpenCart `product_id`) ;
 *   2. `sku` — une référence produit ou de variante identique ;
 *   3. `name-exact` — nom identique après normalisation (comportement
 *      historique, conservé) ;
 *   4. `name-near` — nom proche : **ambigu**, jamais appliqué seul.
 *
 * Le niveau le plus fiable gagne ; un désaccord entre deux niveaux fiables est
 * aussi une ambiguïté, pas un arbitrage silencieux.
 */
import { nameKey } from './normalize.ts';

/** Niveau de confiance d'un rapprochement, du plus fiable au plus faible. */
export type MatchLevel = 'platform-id' | 'sku' | 'name-exact' | 'name-near';

/**
 * Ce que le rapprochement décide pour un produit.
 *
 * - `create` : rien ne correspond, le produit sera créé ;
 * - `update` : correspondance fiable et unique, le produit existant sera mis à
 *   jour — son identifiant, ses vidéos et son historique sont conservés ;
 * - `ambiguous` : plusieurs candidats, ou un désaccord entre indices fiables.
 *   **Rien n'est décidé** : l'aperçu l'affiche et l'utilisateur tranche ;
 * - `duplicate-in-batch` : le même produit apparaît deux fois dans la source.
 */
export type MatchDecision = 'create' | 'update' | 'ambiguous' | 'duplicate-in-batch';

/** Produit déjà au catalogue, tel que le rapprochement le consomme. */
export interface CatalogCandidate {
  id: string;
  name: string;
  /** Référence du produit lui-même, si le catalogue en stocke une. */
  sku?: string | null;
  /** Identifiant chez la plateforme source, conservé lors d'un précédent import. */
  platformId?: string | null;
  /** Références des variantes du produit. */
  variantSkus?: string[];
}

/** Produit à rapprocher, réduit à ce qui sert à la décision. */
export interface IncomingProduct {
  name: string;
  /** Référence stable fournie par la source (SKU produit, référence interne). */
  sku?: string | null;
  /** Identifiant du produit chez la plateforme (jamais deviné). */
  platformId?: string | null;
  /** Références des variantes du produit entrant. */
  variantSkus?: string[];
}

/** Raison lisible d'un rapprochement, pour l'aperçu et l'audit. */
export interface MatchEvidence {
  level: MatchLevel;
  /** Identifiant du produit existant concerné. */
  candidateId: string;
  /** Détail affichable : « même référence REF-12 », « nom identique »… */
  detail: string;
}

export interface MatchResult {
  decision: MatchDecision;
  /** Produit existant retenu — uniquement quand `decision === 'update'`. */
  targetId: string | null;
  /** Indices retenus, du plus fiable au moins fiable. */
  evidence: MatchEvidence[];
  /**
   * Candidats en concurrence quand la décision est ambiguë.
   *
   * Exposé pour que l'interface puisse proposer un choix explicite plutôt
   * qu'un simple « ambigu » sans issue.
   */
  candidates: string[];
  /** Index du premier produit identique dans le lot, pour `duplicate-in-batch`. */
  against?: number;
  /** Explication destinée à l'utilisateur. */
  reason: string;
}

/* ------------------------------- utilitaires ------------------------------ */

/** Normalise une référence : majuscules, sans espaces ni séparateurs. */
export function skuKey(sku: string | null | undefined): string {
  return String(sku ?? '').trim().toUpperCase().replace(/[\s\-_.]+/g, '');
}

/**
 * Mots significatifs d'un nom, pour la comparaison « proche ».
 *
 * Les mots d'une lettre et les unités courantes sont écartés : « 30 ml » ne
 * distingue pas deux produits, alors que « sérum » et « baume » oui.
 */
function tokens(name: string): string[] {
  return nameKey(name)
    .split(' ')
    .filter((mot) => mot.length > 1);
}

/**
 * Similarité de deux noms, entre 0 et 1.
 *
 * Mesure de Dice sur les bigrammes : elle pardonne une faute de frappe ou un
 * mot en plus, et ne rapproche pas « savon » de « savon noir intense » autant
 * qu'un score sur la seule intersection de mots le ferait.
 */
export function nameSimilarity(a: string, b: string): number {
  const cleA = nameKey(a);
  const cleB = nameKey(b);
  if (!cleA || !cleB) return 0;
  if (cleA === cleB) return 1;
  const bigrammes = (texte: string): Map<string, number> => {
    const compact = texte.replace(/\s+/g, ' ');
    const carte = new Map<string, number>();
    for (let i = 0; i < compact.length - 1; i += 1) {
      const paire = compact.slice(i, i + 2);
      carte.set(paire, (carte.get(paire) ?? 0) + 1);
    }
    return carte;
  };
  const carteA = bigrammes(cleA);
  const carteB = bigrammes(cleB);
  let communs = 0;
  for (const [paire, compte] of carteA) {
    const autre = carteB.get(paire) ?? 0;
    communs += Math.min(compte, autre);
  }
  const total = [...carteA.values()].reduce((s, v) => s + v, 0)
    + [...carteB.values()].reduce((s, v) => s + v, 0);
  return total === 0 ? 0 : (2 * communs) / total;
}

/** Seuil au-delà duquel deux noms sont « proches » — donc à examiner. */
export const NEAR_THRESHOLD = 0.82;

/**
 * Deux noms proches mais pas identiques ?
 *
 * Deux mesures, parce qu'une seule se trompe systématiquement dans un cas :
 *
 *   - **inclusion de mots** : « Chemise indigo » et « Chemise indigo premium »
 *     désignent visiblement le même produit enrichi, alors que la similarité de
 *     caractères chute (le nom long dilue les bigrammes communs). Tous les mots
 *     significatifs du plus court doivent figurer dans l'autre.
 *   - **similarité de caractères** : rattrape la faute de frappe
 *     (« Serum eclatt »), que l'inclusion de mots ne voit pas.
 *
 * Le garde-fou reste le même dans les deux cas : au moins un mot significatif
 * en commun. Sans lui, « savon » et « baume » seraient rapprochés par leurs
 * seules lettres.
 */
export function isNearName(a: string, b: string): boolean {
  const cleA = nameKey(a);
  const cleB = nameKey(b);
  if (cleA === cleB) return false;

  const motsA = tokens(a);
  const motsB = tokens(b);
  const communs = motsA.filter((mot) => motsB.includes(mot));
  if (communs.length === 0) return false;

  // Le plus court est contenu dans le plus long : un mot ajouté ou retiré ne
  // change pas l'identité perçue du produit.
  const [court, long] = motsA.length <= motsB.length ? [motsA, motsB] : [motsB, motsA];
  if (court.every((mot) => long.includes(mot))) return true;

  return nameSimilarity(a, b) >= NEAR_THRESHOLD;
}

/* ------------------------------- rapprochement ---------------------------- */

/** Index du catalogue existant, construit une fois pour tout un import. */
export interface CatalogIndex {
  parPlatformId: Map<string, CatalogCandidate[]>;
  parSku: Map<string, CatalogCandidate[]>;
  parNom: Map<string, CatalogCandidate[]>;
  tous: CatalogCandidate[];
}

/**
 * Indexe le catalogue existant.
 *
 * Plusieurs candidats peuvent partager une référence ou un identifiant : c'est
 * précisément le cas ambigu, et l'index doit le conserver au lieu d'en écraser
 * un au hasard.
 */
export function indexCatalog(existing: CatalogCandidate[]): CatalogIndex {
  const parPlatformId = new Map<string, CatalogCandidate[]>();
  const parSku = new Map<string, CatalogCandidate[]>();
  const parNom = new Map<string, CatalogCandidate[]>();
  const ajouter = (carte: Map<string, CatalogCandidate[]>, cle: string, produit: CatalogCandidate) => {
    if (!cle) return;
    const liste = carte.get(cle);
    if (liste) {
      // Un même produit ne doit pas apparaître deux fois (SKU produit + SKU
      // de variante identiques, par exemple).
      if (!liste.some((p) => p.id === produit.id)) liste.push(produit);
    } else {
      carte.set(cle, [produit]);
    }
  };

  for (const produit of existing) {
    if (produit.platformId) ajouter(parPlatformId, String(produit.platformId).trim().toLowerCase(), produit);
    if (produit.sku) ajouter(parSku, skuKey(produit.sku), produit);
    for (const ref of produit.variantSkus ?? []) ajouter(parSku, skuKey(ref), produit);
    ajouter(parNom, nameKey(produit.name), produit);
  }
  return { parPlatformId, parSku, parNom, tous: existing };
}

/** Indices fiables trouvés pour un produit entrant. */
function indicesFiables(produit: IncomingProduct, index: CatalogIndex): MatchEvidence[] {
  const preuves: MatchEvidence[] = [];

  const platformId = String(produit.platformId ?? '').trim().toLowerCase();
  if (platformId) {
    for (const candidat of index.parPlatformId.get(platformId) ?? []) {
      preuves.push({
        level: 'platform-id',
        candidateId: candidat.id,
        detail: `même identifiant de source (${produit.platformId})`,
      });
    }
  }

  // Référence du produit, puis références de ses variantes : une variante
  // partagée est un indice aussi fort qu'un SKU produit, c'est le même
  // identifiant commercial.
  const references = [produit.sku, ...(produit.variantSkus ?? [])]
    .map((ref) => ({ brute: ref, cle: skuKey(ref) }))
    .filter((ref): ref is { brute: string; cle: string } => ref.cle !== '');
  for (const reference of references) {
    for (const candidat of index.parSku.get(reference.cle) ?? []) {
      preuves.push({
        level: 'sku',
        candidateId: candidat.id,
        detail: `même référence (${reference.brute})`,
      });
    }
  }

  const nom = nameKey(produit.name);
  if (nom) {
    for (const candidat of index.parNom.get(nom) ?? []) {
      preuves.push({ level: 'name-exact', candidateId: candidat.id, detail: 'nom identique' });
    }
  }
  return preuves;
}

/**
 * Rapproche un produit entrant du catalogue existant.
 *
 * `dejaVus` porte les produits déjà rencontrés dans le lot, pour détecter les
 * doublons internes sans dépendre de l'ordre d'appel.
 */
export function matchProduct(
  produit: IncomingProduct,
  index: CatalogIndex,
  dejaVus: Map<string, number> = new Map(),
): MatchResult {
  /* 1. Doublon interne au lot -------------------------------------------- */
  // Une référence stable identique dans le même fichier désigne le même
  // produit ; à défaut, un nom identique. On teste AVANT le catalogue : écrire
  // deux fois la même fiche dans un seul import est le doublon le plus visible,
  // et celui qu'aucune mise à jour ne rattrape.
  const cleReference = skuKey(produit.sku);
  const cleNom = nameKey(produit.name);
  const cleLot = cleReference ? `ref:${cleReference}` : `nom:${cleNom}`;
  const dejaVu = dejaVus.get(cleLot);
  if (dejaVu !== undefined) {
    return {
      decision: 'duplicate-in-batch',
      targetId: null,
      evidence: [],
      candidates: [],
      against: dejaVu,
      reason: cleReference
        ? `La référence ${produit.sku} apparaît déjà à la ligne ${dejaVu + 1} de ce fichier.`
        : `Un produit du même nom apparaît déjà à la ligne ${dejaVu + 1} de ce fichier.`,
    };
  }

  /* 2. Indices fiables ---------------------------------------------------- */
  const preuves = indicesFiables(produit, index);
  if (preuves.length > 0) {
    const candidatsFiables = [...new Set(preuves.map((p) => p.candidateId))];
    const candidatsParNiveau = (niveau: MatchLevel): Set<string> =>
      new Set(preuves.filter((p) => p.level === niveau).map((p) => p.candidateId));

    // Deux cas d'ambiguïté qu'il ne faut pas confondre, parce qu'ils
    // n'appellent pas la même correction :
    //
    //  a) UN MÊME indice désigne plusieurs produits — le catalogue contient un
    //     doublon de référence ou d'identifiant de source, à corriger chez lui ;
    //  b) DEUX indices FIABLES se contredisent — la référence pointe vers un
    //     produit, l'identifiant de source vers un autre. C'est souvent le
    //     signe d'une réassociation côté marchand.
    if (candidatsParNiveau('platform-id').size > 1) {
      return ambigu(preuves, produit, 'Plusieurs produits du catalogue portent le même identifiant de source.');
    }
    if (candidatsParNiveau('sku').size > 1) {
      return ambigu(preuves, produit, 'Plusieurs produits du catalogue partagent cette référence.');
    }
    if (candidatsFiables.length > 1) {
      return ambigu(preuves, produit, 'La référence et l’identifiant de source désignent deux produits différents.');
    }

    const retenu = candidatsFiables[0];
    return {
      decision: 'update',
      targetId: retenu,
      evidence: preuves,
      candidates: [retenu],
      reason: preuves[0].detail,
    };
  }

  /* 3. Nom proche : ambiguïté soumise à décision ------------------------- */
  const proches = index.tous.filter((candidat) => isNearName(produit.name, candidat.name));
  if (proches.length > 0) {
    return {
      decision: 'ambiguous',
      targetId: null,
      evidence: proches.map((candidat) => ({
        level: 'name-near' as MatchLevel,
        candidateId: candidat.id,
        detail: `nom proche de « ${candidat.name} »`,
      })),
      candidates: proches.map((candidat) => candidat.id),
      reason: proches.length === 1
        ? `Un produit au nom proche existe déjà (« ${proches[0].name} »). Aucune fusion n’est appliquée sans votre accord.`
        : `${proches.length} produits au nom proche existent déjà. Aucune fusion n’est appliquée sans votre accord.`,
    };
  }

  return {
    decision: 'create',
    targetId: null,
    evidence: [],
    candidates: [],
    reason: 'Nouveau produit.',
  };
}

function ambigu(preuves: MatchEvidence[], produit: IncomingProduct, raison: string): MatchResult {
  const candidats = [...new Set(preuves.map((p) => p.candidateId))];
  return {
    decision: 'ambiguous',
    targetId: null,
    evidence: preuves,
    candidates: candidats,
    reason: `${raison} « ${produit.name} » n’a pas été rapproché automatiquement.`,
  };
}

/**
 * Rapproche tout un lot.
 *
 * Retourne un résultat par produit, dans l'ordre d'entrée. `dejaVus` est mis à
 * jour au fil du parcours : le premier produit d'une référence gagne, les
 * suivants sont marqués doublons du lot.
 */
export function matchBatch(
  produits: IncomingProduct[],
  existing: CatalogCandidate[],
): MatchResult[] {
  const index = indexCatalog(existing);
  const dejaVus = new Map<string, number>();
  return produits.map((produit, indexProduit) => {
    const resultat = matchProduct(produit, index, dejaVus);
    const cleReference = skuKey(produit.sku);
    const cleLot = cleReference ? `ref:${cleReference}` : `nom:${nameKey(produit.name)}`;
    // Seul un produit réellement importable entre dans l'index du lot : deux
    // lignes en conflit ne doivent pas se bloquer mutuellement indéfiniment.
    if (resultat.decision !== 'duplicate-in-batch' && !dejaVus.has(cleLot)) {
      dejaVus.set(cleLot, indexProduit);
    }
    return resultat;
  });
}
