/**
 * Actions EXTERNES (publication sociale, mise à jour de profil/vidéo).
 *
 * Ces modèles ne sont pas des générateurs : leur sortie est un identifiant de
 * publication (`publish_id`, `media_id`) et leur entrée désigne un COMPTE
 * connecté (`options_source: social_accounts`). Les faire passer pour une
 * génération donnerait un résultat « réussi » sans contenu et masquerait
 * l'action réelle sur un compte tiers.
 *
 * Ce module ne fournit AUCUNE exécution : il décrit le contrat, les
 * permissions et les confirmations exigées. La soumission reste impossible
 * tant que (1) un compte lié existe, (2) l'exécution est ouverte par
 * l'administration, (3) un test fournisseur réel a réussi.
 *
 * Toute détection s'appuie sur une DÉCLARATION de la fiche (champ, options ou
 * identifiant de sortie), jamais sur le nom du modèle.
 */

type Obj = Record<string, any>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

const inputLeaves = (definition: unknown, out: Obj[] = []): Obj[] => {
  if (!definition || typeof definition !== 'object') return out;
  const d = definition as Obj;
  if (d.field !== undefined || d.options_source !== undefined) out.push(d);
  for (const value of Object.values(obj(d.properties))) inputLeaves(value, out);
  if (d.items) inputLeaves(d.items, out);
  return out;
};

const responseProps = (model: Obj): Obj => {
  const schemas = obj(obj(model.output_schema).schemas);
  return obj(obj(obj(schemas.properties).output).properties ?? obj(schemas.properties));
};

/** Plateformes reconnues par une déclaration `options_platform`. */
const PLATFORMS = new Set(['facebook', 'instagram', 'linkedin', 'pinterest', 'threads', 'tiktok', 'x', 'youtube']);

export type ExternalAction = {
  /** Plateforme déclarée par la fiche (jamais déduite du nom du modèle). */
  platform: string;
  /** Nature déclarée : publication de média, mise à jour, miniature. */
  kind: 'publish' | 'update' | 'thumbnail';
  /** Champs d'entrée obligatoires, tels que déclarés. */
  required_inputs: string[];
  /** Champs qui désignent le compte connecté (jamais un identifiant libre). */
  account_fields: string[];
  /** Portées de permission SORAHNEX exigées avant toute exécution. */
  permission_scopes: string[];
  /** Confirmation explicite obligatoire (texte à présenter à l'utilisateur). */
  confirmation: string;
  /** La sortie déclarée n'est pas un média : elle ne peut pas être un résultat. */
  output_kind: 'publication_id';
  /** État d'exécution : toujours indisponible dans ce lot. */
  execution: 'unavailable';
  execution_blockers: string[];
};

/**
 * Le modèle déclare-t-il une action externe ?
 * Preuves acceptées :
 *  - une entrée qui déclare `options_source: social_accounts` (compte connecté) ;
 *  - une sortie qui déclare `publish_id` ou `media_id` (identifiant de publication).
 * Aucune autre heuristique : un simple champ `url` de sortie n'en fait pas une
 * action (youtube-publish déclare les deux).
 */
export function declaresExternalAction(model: Obj): boolean {
  const leaves = inputLeaves(obj(obj(model.input_schema).schemas).input_data);
  if (leaves.some((d) => d.options_source === 'social_accounts')) return true;
  const props = responseProps(model);
  return obj(props.publish_id).type === 'string' || obj(props.media_id).type === 'string';
}

/**
 * Contrat d'action externe, borné aux déclarations de la fiche.
 * `null` si le modèle n'est pas une action externe.
 */
export function externalActionContract(model: Obj): ExternalAction | null {
  if (!declaresExternalAction(model)) return null;
  const input = obj(obj(obj(model.input_schema).schemas).input_data);
  const properties = obj(input.properties);
  const leaves = inputLeaves(input);
  const platform = leaves
    .map((d) => d.options_platform)
    .find((value): value is string => typeof value === 'string' && PLATFORMS.has(value)) ?? 'unknown';
  const accountFields = Object.entries(properties)
    .filter(([, d]) => obj(d).options_source === 'social_accounts')
    .map(([key]) => key);
  const required = (Array.isArray(input.required) ? input.required : [])
    .filter((key: unknown): key is string => typeof key === 'string');
  const hasMedia = required.some((key) => obj(properties[key]).field !== undefined);
  const hasVideoId = Object.prototype.hasOwnProperty.call(properties, 'video_id');
  const hasThumbnail = Object.prototype.hasOwnProperty.call(properties, 'thumbnail_url')
    || Object.prototype.hasOwnProperty.call(properties, 'thumbnail');
  const kind: ExternalAction['kind'] = hasThumbnail ? 'thumbnail' : hasVideoId && !hasMedia ? 'update' : 'publish';
  const scopes = [
    platform === 'unknown' ? 'social.account' : `social.${platform}.account`,
    ...(kind === 'publish' ? [`social.${platform}.publish`] : []),
    ...(kind === 'update' ? [`social.${platform}.update`] : []),
    ...(kind === 'thumbnail' ? [`social.${platform}.thumbnail`] : []),
  ];
  return {
    platform,
    kind,
    required_inputs: required,
    account_fields: accountFields,
    permission_scopes: scopes,
    confirmation: platform === 'unknown'
      ? 'Confirmez la publication sur le compte connecté.'
      : `Confirmez la publication sur votre compte ${platform}.`,
    output_kind: 'publication_id',
    execution: 'unavailable',
    // Un identifiant de publication ne prouve pas qu'un média a été produit :
    // l'action reste hors du pipeline de génération et hors du Studio.
    execution_blockers: ['PROVIDER_ACCOUNT_LINK_MISSING', 'EXECUTION_DISABLED', 'REAL_TEST_PENDING'],
  };
}

/** Codes de blocage exposés au catalogue pour une action externe. */
export function externalActionBlockers(model: Obj): string[] {
  return declaresExternalAction(model)
    ? ['EXTERNAL_ACTION_REQUIRED', 'PROVIDER_ACCOUNT_LINK_MISSING', 'CONSTRAINT_REVIEW_REQUIRED', 'REAL_TEST_PENDING']
    : [];
}
