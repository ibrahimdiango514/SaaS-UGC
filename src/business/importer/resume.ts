/**
 * VYORA — reprise d'un import interrompu.
 *
 * ## Le problème, concrètement
 * Un import écrit produit par produit, dans une transaction par produit. Si la
 * session expire, si le réseau coupe ou si l'instance est recyclée au milieu du
 * lot, une partie des produits est déjà en base. Rien ne dit où l'écriture s'est
 * arrêtée : relancer l'import réécrit les lignes déjà passées.
 *
 * ## Ce que la reprise fait — et ne fait pas
 *
 * **Elle ne relance jamais une écriture dont le résultat est incertain.**
 * Avant de reprendre, l'état est relu dans la base (les lignes de progression et
 * les produits existants). Une ligne n'est retraitée que si la base ne la connaît
 * pas. Un produit déjà écrit mais absent de la progression — écriture réussie
 * dont l'accusé de réception s'est perdu — est retrouvé par son identité
 * (référence ou identifiant de source), pas réécrit.
 *
 * **Elle est idempotente.** Reprendre deux fois de suite ne crée aucun doublon :
 * la deuxième reprise constate que tout est fait et ne fait rien. C'est ce qui
 * permet de la proposer à l'utilisateur sans réserve.
 *
 * **Elle ne perd rien.** Les résultats déjà confirmés restent ; la progression
 * est un journal, jamais une source de vérité qui remplacerait le catalogue.
 *
 * ## Pourquoi une clé de lot, et pas le `previewId`
 * Un aperçu expire et disparaît : une reprise après expiration de session
 * n'aurait plus d'identifiant. `importKey` est une empreinte STABLE du contenu du
 * lot (origine + lignes), de sorte que réimporter le même catalogue retrouve la
 * même progression, même des jours plus tard.
 */
import { nameKey } from './normalize.ts';
import { skuKey } from './matching.ts';

/** Une ligne déjà traitée, telle que la RPC la renvoie. */
export interface ProgressLine {
  lineKey: string;
  productId: string;
  outcome: 'created' | 'updated';
  variantsWritten: number;
  createdAt: string;
}

export interface ImportProgress {
  importKey: string;
  total: number;
  lines: ProgressLine[];
}

/**
 * Clé stable d'une ligne de produit dans un lot.
 *
 * Priorité à la référence : c'est l'identifiant le plus stable dont on dispose.
 * À défaut, le nom normalisé — imparfait, mais suffisant pour reconnaître une
 * ligne DÉJÀ TRAITÉE dans le même lot, ce qui est le seul usage.
 */
export function lineKey(product: { name: string; sku?: string | null; platformId?: string | null }): string {
  const reference = skuKey(product.sku);
  if (reference) return `ref:${reference}`;
  const identifiant = String(product.platformId ?? '').trim();
  if (identifiant) return `pid:${identifiant}`;
  return `nom:${nameKey(product.name)}`;
}

/**
 * Empreinte d'un lot d'import.
 *
 * Volontairement calculée sur l'ORIGINE et les clés de lignes, pas sur les prix
 * ni les stocks : un catalogue dont seul un prix a changé est le même lot, et
 * doit pouvoir reprendre l'import précédent. Le tri rend la clé indépendante de
 * l'ordre des lignes — un export réordonné reste le même lot.
 */
export function importKey(origin: { reference: string }, products: Array<{ name: string; sku?: string | null; platformId?: string | null }>): string {
  const base = [origin.reference.trim().toLowerCase(), ...products.map(lineKey).sort()].join('|');
  // FNV-1a 64 bits simulé sur deux passes 32 bits : court, déterministe,
  // suffisant pour distinguer deux lots (ce n'est pas un secret).
  let haut = 0x811c9dc5;
  let bas = 0x01000193;
  for (let i = 0; i < base.length; i += 1) {
    const code = base.charCodeAt(i);
    haut ^= code;
    haut = Math.imul(haut, 0x01000193) >>> 0;
    bas = (bas + code) >>> 0;
    bas = Math.imul(bas, 0x85ebca6b) >>> 0;
  }
  return `${haut.toString(16).padStart(8, '0')}${bas.toString(16).padStart(8, '0')}`;
}

/** Lit la progression renvoyée par la RPC. */
export function normalizeProgress(raw: unknown): ImportProgress {
  const source = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const lignes = Array.isArray(source.lines) ? source.lines : [];
  const lines: ProgressLine[] = lignes.flatMap((entree) => {
    const ligne = (entree && typeof entree === 'object' ? entree : {}) as Record<string, unknown>;
    const cle = typeof ligne.line_key === 'string' ? ligne.line_key : '';
    const produit = typeof ligne.product_id === 'string' ? ligne.product_id : '';
    if (!cle || !produit) return [];
    return [{
      lineKey: cle,
      productId: produit,
      outcome: ligne.outcome === 'updated' ? 'updated' : 'created',
      variantsWritten: Number.isFinite(Number(ligne.variants_written)) ? Number(ligne.variants_written) : 0,
      createdAt: typeof ligne.created_at === 'string' ? ligne.created_at : '',
    }];
  });
  return {
    importKey: typeof source.import_key === 'string' ? source.import_key : '',
    total: Number.isFinite(Number(source.total)) ? Number(source.total) : lines.length,
    lines,
  };
}

/** Ce qu'il reste à traiter, et ce qui a déjà été fait. */
export interface ResumePlan {
  /** Index, dans le lot, des produits restant à écrire — dans l'ordre d'origine. */
  restant: number[];
  /** Nombre de lignes déjà traitées, retrouvées par la progression. */
  dejaFait: number;
  /**
   * Produits dont l'écriture est incertaine : présents dans le catalogue mais
   * absents de la progression. Ils ne sont PAS retraités en création — on les
   * rapproche du catalogue, ce qui les met à jour au lieu de les dupliquer.
   */
  incertains: number;
  /** Vrai quand tout est déjà fait : reprendre ne ferait rien. */
  termine: boolean;
}

/**
 * Calcule ce qu'il reste à faire.
 *
 * `existingKeys` contient les clés de lignes des produits RÉELLEMENT présents en
 * base (lues par l'appelant). Une ligne absente de la progression mais présente
 * en base est un cas d'écriture réussie sans accusé de réception : elle est
 * comptée comme incertaine et laissée au rapprochement, qui la traitera en mise
 * à jour. C'est la seule façon de ne pas dupliquer sans prétendre savoir ce qui
 * s'est passé.
 */
export function planResume(
  products: Array<{ name: string; sku?: string | null; platformId?: string | null }>,
  progress: ImportProgress | null,
  existingKeys: Set<string> = new Set(),
): ResumePlan {
  const faites = new Set((progress?.lines ?? []).map((ligne) => ligne.lineKey));
  const restant: number[] = [];
  let dejaFait = 0;
  let incertains = 0;

  products.forEach((produit, index) => {
    const cle = lineKey(produit);
    if (faites.has(cle)) {
      dejaFait += 1;
      return;
    }
    if (existingKeys.has(cle)) {
      // Écrit lors d'un import précédent sans trace de progression : le
      // rapprochement le reconnaîtra et le mettra à jour. On ne le compte pas
      // comme « à créer ».
      incertains += 1;
    }
    restant.push(index);
  });

  return {
    restant,
    dejaFait,
    incertains,
    // Terminé seulement s'il ne reste RIEN. Une ligne incertaine reste à
    // traiter — par une mise à jour, pas par une création — donc le lot n'est
    // pas fini.
    termine: restant.length === 0,
  };
}

/**
 * Résumé affichable de l'état d'un import.
 *
 * Dit ce qui est fait et ce qui reste, sans promettre que la reprise suffira :
 * une reprise peut encore échouer sur une ligne invalide, et ce sera rapporté.
 */
export function resumeSummary(plan: ResumePlan, total: number): string {
  if (plan.termine) return `Import déjà terminé : ${plan.dejaFait} produit(s) sur ${total}.`;
  const parties = [`${plan.dejaFait} produit(s) sur ${total} déjà écrit(s)`];
  if (plan.incertains > 0) {
    parties.push(`${plan.incertains} à vérifier avant écriture`);
  }
  parties.push(`${plan.restant.length - plan.incertains} restant(s)`);
  return `Reprise : ${parties.join(', ')}.`;
}
