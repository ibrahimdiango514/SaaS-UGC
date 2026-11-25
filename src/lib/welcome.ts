/**
 * SORAHNEX — accueil personnalisé après connexion.
 *
 * Deux règles non négociables :
 *  1. **Jamais de nom inventé.** Si le profil ne contient pas de nom
 *     exploitable, on salue sans prénom (aucune supposition à partir de
 *     l'e-mail : `awa.traore@…` ne prouve pas que la personne s'appelle Awa).
 *  2. **Messages variés mais stables pendant la session.** Le choix est
 *     deterministe à partir d'une graine (identifiant + jour), pour éviter un
 *     texte qui change à chaque rendu tout en restant différent d'un jour et
 *     d'un utilisateur à l'autre.
 *
 * Le module est pur (aucun accès au DOM) : il est testable directement.
 */

export interface WelcomeInput {
  /** `profile.display_name` — seule source légitime du prénom. */
  displayName?: string | null;
  /** Salutation locale (« Bonjour », « Bonsoir »…). */
  greeting: string;
  /** Graine stable (ex. `${user.id}:${AAAA-MM-JJ}`). */
  seed?: string;
  /** Première visite enregistrée sur cet appareil. */
  firstVisit?: boolean;
  /** Nom de l'espace de travail, s'il existe. */
  workspaceName?: string | null;
}

export interface WelcomeMessage {
  /** Prénom nettoyé, ou `null` si le profil n'en fournit pas. */
  firstName: string | null;
  /** Titre principal (contient le prénom uniquement s'il existe). */
  heading: string;
  /** Phrase chaleureuse, humaine, sans emphase publicitaire. */
  sentence: string;
  /** Libellé court de l'état de l'espace. */
  status: string;
}

const PARTICLES = new Set([
  'de', 'da', 'di', 'du', 'des', 'del', 'dos', 'do',
  'la', 'le', 'les', 'van', 'von', 'der', 'den', 'bin', 'al', 'el', 'ben', 'y',
]);

/**
 * Extrait un prénom présentable depuis un nom complet.
 * - garde la casse des particules (« de » ne devient pas « De ») ;
 * - met une majuscule initiale au prénom (« ibrahim » → « Ibrahim ») ;
 * - renvoie `null` pour un nom vide, un pseudo technique ou une adresse e-mail.
 */
export function firstNameFrom(displayName: string | null | undefined): string | null {
  const raw = (displayName ?? '').trim();
  if (!raw) return null;
  // Un e-mail n'est pas un nom : on ne l'utilise jamais comme prénom.
  if (raw.includes('@')) return null;
  // Un identifiant technique (uuid, suite de chiffres) n'est pas un prénom.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(raw) || /^\d+$/.test(raw)) return null;

  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  // Les particules (« de », « van », « bin »…) restent en minuscules et
  // précèdent le nom qui porte réellement le prénom.
  let index = 0;
  while (index < words.length - 1 && PARTICLES.has(words[index].toLowerCase())) index += 1;
  const core = words[index];
  if (!core) return null;
  const particles = words.slice(0, index).map((particle) => particle.toLowerCase());
  return [...particles, capitalize(core)].join(' ');
}

function capitalize(word: string): string {
  if (!word) return word;
  // Conserve les prénoms déjà composés (« Jean-Pierre », « MC »).
  if (word.length > 1 && word === word.toUpperCase()) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Hash FNV-1a 32 bits : déterministe, sans dépendance. */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Phrases d'accueil — aucune promesse chiffrée, aucun superlatif creux. */
const RETURNING_LINES = [
  'Heureux de vous retrouver. Votre espace est prêt, et vos projets vous attendent là où vous les avez laissés.',
  'Ravi de vous revoir. Tout est en place pour reprendre exactement là où vous vous êtes arrêté.',
  'Content de vous retrouver. Vos idées ont encore de la place ici — allons-y tranquillement.',
  'Bon retour parmi nous. Votre espace a gardé votre travail intact, prêt à continuer.',
  'Votre atelier est ouvert. Reprenez le fil, une étape après l’autre.',
] as const;

const FIRST_VISIT_LINES = [
  'Bienvenue chez vous. Prenez un instant pour choisir l’espace qui correspond à votre envie du moment.',
  'Votre espace SORAHNEX est prêt. Rien à installer : choisissez un univers et commencez par une petite action.',
  'Bienvenue. Tout est en place — commencez simplement par ce qui vous inspire aujourd’hui.',
  'Voici votre espace. Prenez vos repères, puis lancez-vous : la première étape est toujours la plus simple.',
] as const;

const STATUS_READY = 'Espace prêt';
const STATUS_FIRST = 'Premier passage';

/**
 * Compose le message d'accueil.
 *
 * @example
 * welcomeMessage({ displayName: 'Ibrahim Diango', greeting: 'Bonsoir', seed: 'u1:2026-11-14' })
 * // → heading: 'Bonsoir, Ibrahim.', sentence: 'Bon retour parmi nous.…'
 */
export function welcomeMessage(input: WelcomeInput): WelcomeMessage {
  const firstName = firstNameFrom(input.displayName);
  const greeting = (input.greeting || 'Bonjour').trim();
  const seed = `${input.seed ?? ''}|${firstName ?? 'anonyme'}|${input.firstVisit ? 'first' : 'return'}`;
  const bank = input.firstVisit ? FIRST_VISIT_LINES : RETURNING_LINES;
  const sentence = bank[stableHash(seed) % bank.length];

  return {
    firstName,
    heading: firstName ? `${greeting}, ${firstName}.` : `${greeting}.`,
    sentence,
    status: input.firstVisit ? STATUS_FIRST : STATUS_READY,
  };
}

/**
 * Rappel de contexte, uniquement si le nom d'espace existe réellement.
 * Aucune phrase n'est produite à partir d'une donnée absente.
 */
export function workspaceHint(workspaceName: string | null | undefined): string | null {
  const name = (workspaceName ?? '').trim();
  if (!name) return null;
  return `Vous êtes dans ${name}.`;
}
