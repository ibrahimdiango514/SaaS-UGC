/**
 * Veille marché et concurrence — synthèse honnête de données saisies ou importées.
 *
 * ## Ce que ce module NE fait pas
 * Aucune collecte automatique : pas de connecteur Meta, Google ou autre, pas de
 * robot qui lirait le site d'un concurrent. Les fiches et les signaux viennent
 * de ce que l'utilisateur a saisi ou importé (CSV). C'est une limite assumée :
 * elle rend la synthèse vérifiable, et évite de présenter une donnée inventée
 * comme un fait observé.
 *
 * ## Ce qu'il fait
 * Il transforme ces saisies en lecture utile : qui est positionné où, quels
 * signaux sont récents, quels prix sont comparables, et ce qui MANQUE pour
 * conclure. Un manque est affiché comme un manque.
 */
import type { GrowthCompetitor, GrowthSignal } from './model';

export interface ConcurrentImporte {
  nom: string;
  url?: string;
  positionnement?: string;
  forces?: string;
  faiblesses?: string;
  /** Prix affiché par le concurrent, tel qu'il a été relevé. */
  prix?: number | null;
  devise?: string;
  /** Date du relevé de prix : sans elle, un prix est indicatif, pas comparatif. */
  releveLe?: string;
}

export interface FicheConcurrent extends ConcurrentImporte {
  /** Prix comparé au vôtre, quand les deux existent et que la devise est la même. */
  ecartPourcent: number | null;
  /** Ce qui manque pour rendre la comparaison fiable. */
  incompletudes: string[];
}

/**
 * Compare les prix, sans jamais comparer des devises différentes.
 *
 * Un écart entre 100 000 FCFA et 150 EUR n'existe pas : il faut un taux, et ce
 * module n'en invente pas. L'écart est alors `null` et la fiche le dit.
 */
export function comparerPrix(
  prixConcurrent: number | null | undefined,
  prixMaison: number | null | undefined,
  deviseConcurrent: string | undefined,
  deviseMaison: string | undefined,
): { ecartPourcent: number | null; raison: string } {
  if (typeof prixConcurrent !== 'number' || !Number.isFinite(prixConcurrent) || prixConcurrent <= 0) {
    return { ecartPourcent: null, raison: 'Prix du concurrent non relevé.' };
  }
  if (typeof prixMaison !== 'number' || !Number.isFinite(prixMaison) || prixMaison <= 0) {
    return { ecartPourcent: null, raison: 'Votre prix n’est pas renseigné.' };
  }
  const deviseC = (deviseConcurrent ?? '').trim().toUpperCase();
  const deviseM = (deviseMaison ?? '').trim().toUpperCase();
  if (!deviseC || !deviseM) {
    return { ecartPourcent: null, raison: 'Devise non précisée : comparaison impossible.' };
  }
  if (deviseC !== deviseM) {
    return { ecartPourcent: null, raison: `Devises différentes (${deviseC} / ${deviseM}) : aucun taux n’est appliqué.` };
  }
  return { ecartPourcent: Math.round(((prixConcurrent - prixMaison) / prixMaison) * 1000) / 10, raison: '' };
}

/** Construit les fiches comparables à partir des saisies et de votre prix. */
export function fichesConcurrents(
  concurrents: readonly ConcurrentImporte[],
  prixMaison: number | null,
  deviseMaison: string,
): FicheConcurrent[] {
  return concurrents
    .filter((concurrent) => (concurrent.nom ?? '').trim().length > 0)
    .map((concurrent) => {
      const { ecartPourcent, raison } = comparerPrix(concurrent.prix, prixMaison, concurrent.devise ?? deviseMaison, deviseMaison);
      const manques: string[] = [];
      if (!concurrent.url) manques.push('Site non renseigné');
      if (!concurrent.positionnement) manques.push('Positionnement non décrit');
      if (typeof concurrent.prix !== 'number') manques.push('Prix non relevé');
      if (typeof concurrent.prix === 'number' && !concurrent.releveLe) manques.push('Date du relevé de prix absente');
      if (raison) manques.push(raison);
      return {
        ...concurrent,
        nom: concurrent.nom.trim().slice(0, 160),
        ecartPourcent,
        incompletudes: manques,
      };
    });
}

export interface SyntheseVeille {
  /** Nombre de fiches réellement exploitables. */
  fiches: number;
  signauxRecents: GrowthSignal[];
  /** Constats factuels, chacun appuyé sur une donnée présente. */
  constats: string[];
  /** Ce qui manque pour aller plus loin. */
  manques: string[];
  /** Vrai si aucune donnée n'existe : on ne fabrique pas de synthèse vide. */
  vide: boolean;
}

/** Un signal est « récent » s'il a été observé dans les `jours` derniers jours. */
export function signalRecent(signal: GrowthSignal, aujourdHui: string, jours = 30): boolean {
  if (!signal.observedAt) return false;
  const date = new Date(`${signal.observedAt.slice(0, 10)}T00:00:00Z`);
  const maintenant = new Date(`${aujourdHui.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || Number.isNaN(maintenant.getTime())) return false;
  const ecart = Math.round((maintenant.getTime() - date.getTime()) / 86_400_000);
  // Un signal daté dans le FUTUR n'est pas « récent » : c'est une saisie à vérifier.
  return ecart >= 0 && ecart <= jours;
}

/**
 * Synthèse destinée à l'écran ET au brief envoyé à l'agent.
 *
 * Chaque constat nomme sa source (« 3 fiches », « 2 signaux »). Aucune phrase
 * du type « votre marché est en croissance » : sans donnée de volume, ce serait
 * une invention.
 */
export function syntheseVeille(
  concurrents: readonly FicheConcurrent[],
  signaux: readonly GrowthSignal[],
  aujourdHui: string,
): SyntheseVeille {
  const recents = signaux.filter((signal) => signalRecent(signal, aujourdHui));
  const constats: string[] = [];
  const manques: string[] = [];

  if (concurrents.length > 0) {
    const avecPrix = concurrents.filter((fiche) => typeof fiche.prix === 'number');
    constats.push(`${concurrents.length} concurrent(s) suivi(s), dont ${avecPrix.length} avec un prix relevé.`);
    const moinsChers = concurrents.filter((fiche) => fiche.ecartPourcent !== null && fiche.ecartPourcent < 0);
    const plusChers = concurrents.filter((fiche) => fiche.ecartPourcent !== null && fiche.ecartPourcent > 0);
    if (moinsChers.length > 0) {
      constats.push(`${moinsChers.length} concurrent(s) moins cher(s) que vous : ${moinsChers.map((fiche) => fiche.nom).join(', ')}.`);
    }
    if (plusChers.length > 0) {
      constats.push(`${plusChers.length} concurrent(s) plus cher(s) que vous : ${plusChers.map((fiche) => fiche.nom).slice(0, 4).join(', ')}.`);
    }
    if (avecPrix.length < concurrents.length) {
      manques.push(`Prix manquant pour ${concurrents.length - avecPrix.length} concurrent(s) : la comparaison est partielle.`);
    }
  } else {
    manques.push('Aucun concurrent enregistré : ajoutez au moins une fiche pour obtenir une comparaison.');
  }

  if (recents.length > 0) {
    constats.push(`${recents.length} signal(aux) observé(s) dans les 30 derniers jours.`);
    const plateformes = [...new Set(recents.map((signal) => signal.platform).filter(Boolean))];
    if (plateformes.length > 0) constats.push(`Plateformes concernées : ${plateformes.join(', ')}.`);
  } else if (signaux.length > 0) {
    constats.push(`${signaux.length} signal(aux) enregistré(s), aucun dans les 30 derniers jours.`);
  } else {
    manques.push('Aucun signal enregistré : impossible de dire ce qui bouge sur le marché.');
  }

  if (signaux.some((signal) => !signal.observedAt)) {
    manques.push('Des signaux n’ont pas de date d’observation : ils ne peuvent pas être qualifiés de récents.');
  }

  return {
    fiches: concurrents.length,
    signauxRecents: recents,
    constats,
    manques,
    vide: concurrents.length === 0 && signaux.length === 0,
  };
}

/**
 * Fiche concurrent lisible depuis une entrée de mémoire métier.
 *
 * On réutilise `GrowthCompetitor` (déjà stocké) plutôt que d'inventer un second
 * format : deux formats pour la même chose finissent toujours par diverger.
 */
export function concurrentDepuisMemoire(competitor: GrowthCompetitor): ConcurrentImporte {
  return {
    nom: competitor.name,
    url: competitor.url || undefined,
    positionnement: competitor.positioning || undefined,
    forces: competitor.strengths || undefined,
    faiblesses: competitor.weaknesses || undefined,
  };
}

/**
 * Import CSV de concurrents.
 *
 * En-têtes attendus : `nom`, puis facultatifs `url`, `positionnement`, `forces`,
 * `faiblesses`, `prix`, `devise`, `releve_le`. Une ligne sans nom est ignorée
 * (elle ne peut pas désigner un concurrent), et les lignes ignorées sont
 * rapportées à l'utilisateur au lieu de disparaître.
 */
export function importerConcurrentsCsv(texte: string): {
  concurrents: ConcurrentImporte[];
  ignorees: number;
  erreurs: string[];
} {
  const lignes = texte.split(/\r?\n/).filter((ligne) => ligne.trim().length > 0);
  const erreurs: string[] = [];
  if (lignes.length === 0) return { concurrents: [], ignorees: 0, erreurs: ['Fichier vide.'] };

  const separateur = (lignes[0].match(/;/g)?.length ?? 0) > (lignes[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const decouper = (ligne: string): string[] => {
    const cellules: string[] = [];
    let courante = '';
    let entreGuillemets = false;
    for (let index = 0; index < ligne.length; index += 1) {
      const caractere = ligne[index];
      if (caractere === '"') {
        if (entreGuillemets && ligne[index + 1] === '"') { courante += '"'; index += 1; }
        else entreGuillemets = !entreGuillemets;
      } else if (caractere === separateur && !entreGuillemets) {
        cellules.push(courante); courante = '';
      } else courante += caractere;
    }
    cellules.push(courante);
    return cellules.map((cellule) => cellule.trim());
  };

  const entetes = decouper(lignes[0]).map((entete) => entete.toLowerCase().replace(/[^a-z_]/g, ''));
  const colonne = (nom: string) => entetes.indexOf(nom);
  if (colonne('nom') === -1) {
    return { concurrents: [], ignorees: lignes.length, erreurs: ['Colonne « nom » absente : impossible d’identifier les concurrents.'] };
  }

  const concurrents: ConcurrentImporte[] = [];
  let ignorees = 0;
  for (const ligne of lignes.slice(1)) {
    const cellules = decouper(ligne);
    const valeur = (nom: string): string => {
      const index = colonne(nom);
      return index === -1 ? '' : (cellules[index] ?? '');
    };
    const nom = valeur('nom');
    if (!nom) { ignorees += 1; continue; }
    const prixBrut = valeur('prix').replace(/\s/g, '').replace(',', '.');
    const prix = prixBrut && Number.isFinite(Number(prixBrut)) ? Number(prixBrut) : null;
    if (prixBrut && prix === null) erreurs.push(`Prix illisible pour « ${nom} » : valeur ignorée.`);
    concurrents.push({
      nom: nom.slice(0, 160),
      url: valeur('url') || undefined,
      positionnement: valeur('positionnement') || undefined,
      forces: valeur('forces') || undefined,
      faiblesses: valeur('faiblesses') || undefined,
      prix,
      devise: valeur('devise') || undefined,
      releveLe: valeur('releve_le') || undefined,
    });
  }
  return { concurrents, ignorees, erreurs };
}
