/**
 * SORAHNEX — diagnostic du moteur IA central.
 *
 * ## Le problème que ce module résout
 * Quand le moteur IA ne répond pas, l'écran affichait « registre indisponible »
 * ou un code brut (`PROVIDER_NETWORK_ERROR`). L'utilisateur ne pouvait pas
 * savoir QUELLE étape était bloquante : clé absente ? adresse absente ? adresse
 * injoignable ? fournisseur désactivé ? Aucun modèle validé ? Chaque étape a
 * pourtant une action corrective différente, souvent côté administrateur.
 *
 * ## Ce que ce module NE fait pas
 * Il n'appelle aucun service : il transforme un état DÉJÀ OBSERVÉ (par la sonde
 * serveur) en une phrase lisible. Aucune valeur n'est inventée, aucun statut
 * n'est supposé « bon » par défaut — un état inconnu reste inconnu.
 *
 * ## Règles d'affichage
 * - Aucun secret, aucune valeur de clé n'est jamais citée.
 * - Aucune URL complète : seule la FORME de l'adresse est décrite (publique,
 *   locale, privée, illisible), jamais son contenu.
 * - Chaque message dit quoi faire.
 */

/** Cause bloquante, dans l'ordre réel du chemin d'appel. */
export type BlocageMoteur =
  | 'cle_absente'
  | 'adresse_absente'
  | 'adresse_invalide'
  | 'adresse_non_publique'
  | 'desactive'
  | 'injoignable'
  | 'delai_depasse'
  | 'cle_refusee'
  | 'adresse_introuvable'
  | 'quota'
  | 'aucun_modele'
  | 'completion_refusee'
  | 'registre_indisponible'
  | 'operationnel';

export interface DiagnosticMoteur {
  /** Cause bloquante, ou `operationnel`. */
  blocage: BlocageMoteur;
  /** Une phrase, en français, sans secret ni URL. */
  message: string;
  /** Ce qu'il faut faire, concrètement. */
  action: string;
  /** L'étape du chemin où le blocage survient. */
  etape: 'configuration' | 'reseau' | 'catalogue' | 'modele' | 'ras';
  /** Vrai seulement si une complétion réelle a été validée. */
  pret: boolean;
}

/**
 * Nature d'une adresse, SANS jamais la restituer.
 *
 * Edge Functions tournent dans le cloud : une adresse `localhost`, une IP privée
 * ou un nom sans domaine public ne peuvent pas être joints, quel que soit le
 * secret fourni. Distinguer ce cas évite de faire chercher une panne réseau
 * là où le problème est l'adresse elle-même.
 */
export type FormeAdresse = 'publique' | 'locale' | 'privee' | 'illisible' | 'absente';

export function formeAdresse(valeur: string | null | undefined): FormeAdresse {
  const brut = (valeur ?? '').trim();
  if (!brut) return 'absente';

  let hote: string;
  try {
    const url = new URL(brut);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'illisible';
    hote = url.hostname.toLowerCase();
  } catch {
    return 'illisible';
  }

  if (
    hote === 'localhost'
    || hote === '::1'
    || hote === '[::1]'
    || hote.endsWith('.localhost')
    || hote.endsWith('.local')
    || hote.endsWith('.internal')
  ) {
    return 'locale';
  }

  // IPv4 privée (RFC 1918) ou boucle locale.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hote);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    // 127.x et 0.x sont la boucle locale ; 10.x est privée (RFC 1918).
    if (a === 127 || a === 0) return 'locale';
    if (a === 10) return 'privee';
    if (a === 192 && b === 168) return 'privee';
    if (a === 172 && b >= 16 && b <= 31) return 'privee';
    if (a === 169 && b === 254) return 'privee';
    return 'publique';
  }

  // IPv6 de boucle locale ou lien-local.
  if (hote.startsWith('[') || hote.includes(':')) {
    const nu = hote.replace(/^\[|\]$/g, '');
    if (nu === '::1' || nu.startsWith('fe80:') || nu.startsWith('fc') || nu.startsWith('fd')) return 'privee';
    return 'publique';
  }

  // Nom sans point : résolution interne, jamais joignable depuis Edge.
  if (!hote.includes('.')) return 'locale';

  return 'publique';
}

/** État observé du fournisseur central, tel que la sonde serveur le rapporte. */
export interface EtatMoteurObserve {
  /** Clé présente côté serveur (jamais la valeur). */
  clePresente: boolean;
  /** Adresse de base configurée (jamais la valeur renvoyée au client). */
  adresseConfiguree: boolean;
  /** Forme de l'adresse, calculée côté serveur. */
  formeAdresse: FormeAdresse;
  /** Fournisseur activé dans le registre. */
  actif: boolean;
  /** Code d'erreur brut de la dernière sonde (`null` = aucune erreur). */
  codeErreur: string | null;
  /** Statut HTTP observé, si la sonde a joint le service. */
  statutHttp: number | null;
  /** Nombre de modèles réellement publiés par le fournisseur. */
  modelesCatalogue: number | null;
  /** Nombre de modèles validés par une complétion réelle. */
  modelesVerifies: number | null;
  /** Le registre lui-même a-t-il pu être lu ? */
  registreLisible: boolean;
}

const ACTIONS: Record<BlocageMoteur, { message: string; action: string; etape: DiagnosticMoteur['etape'] }> = {
  cle_absente: {
    message: 'Clé FREE_LLM_API_KEY absente côté serveur.',
    action: 'Renseigner le secret FREE_LLM_API_KEY dans Supabase (Edge Functions), puis relancer la sonde.',
    etape: 'configuration',
  },
  adresse_absente: {
    message: 'Adresse FREE_LLM_API_BASE_URL absente côté serveur.',
    action: 'Renseigner le secret FREE_LLM_API_BASE_URL avec l’adresse HTTPS publique de FreeLLMAPI, puis relancer la sonde.',
    etape: 'configuration',
  },
  adresse_invalide: {
    message: 'Adresse FREE_LLM_API_BASE_URL illisible.',
    action: 'Saisir une URL complète commençant par https:// (par exemple https://votre-instance.example.com/v1).',
    etape: 'configuration',
  },
  adresse_non_publique: {
    message: 'Adresse FreeLLMAPI locale ou privée : injoignable depuis le cloud.',
    action: 'Héberger FreeLLMAPI sur une adresse HTTPS publique, puis renseigner FREE_LLM_API_BASE_URL avec cette adresse.',
    etape: 'configuration',
  },
  desactive: {
    message: 'Fournisseur FreeLLMAPI désactivé dans le registre.',
    action: 'Après une sonde réussie, activer explicitement le fournisseur depuis la fiche « Rendre FreeLLMAPI joignable ».',
    etape: 'configuration',
  },
  injoignable: {
    message: 'Adresse injoignable : aucune connexion établie.',
    action: 'Vérifier que l’instance FreeLLMAPI est démarrée, publiée en HTTPS, et que son pare-feu autorise les requêtes externes.',
    etape: 'reseau',
  },
  delai_depasse: {
    message: 'Adresse injoignable (délai dépassé).',
    action: 'Vérifier la disponibilité de l’instance FreeLLMAPI et son temps de réponse ; une instance endormie ne répond pas dans le délai.',
    etape: 'reseau',
  },
  cle_refusee: {
    message: 'Clé refusée par le fournisseur (401/403).',
    action: 'Remplacer FREE_LLM_API_KEY par une clé valide et active pour cette instance.',
    etape: 'catalogue',
  },
  adresse_introuvable: {
    message: 'Adresse du catalogue introuvable (404) : le chemin de l’API est probablement faux.',
    action: 'Vérifier le suffixe de FREE_LLM_API_BASE_URL (souvent /v1) : le catalogue se lit sur <adresse>/models.',
    etape: 'catalogue',
  },
  quota: {
    message: 'Quota ou solde épuisé chez le fournisseur (402/429).',
    action: 'Vérifier le solde et les limites de l’instance FreeLLMAPI ; aucune nouvelle tentative ne les corrigera.',
    etape: 'catalogue',
  },
  aucun_modele: {
    message: 'Aucun modèle validé par sonde.',
    action: 'Relancer la sonde ; si le catalogue reste vide, vérifier que l’instance expose bien /models avec au moins un modèle de conversation.',
    etape: 'modele',
  },
  completion_refusee: {
    message: 'Catalogue lisible, mais la complétion de contrôle a échoué.',
    action: 'Vérifier les paramètres du modèle de test, puis relancer la sonde en choisissant un modèle explicitement.',
    etape: 'modele',
  },
  registre_indisponible: {
    message: 'Registre des fournisseurs illisible côté serveur.',
    action: 'Vérifier que les migrations du registre IA sont appliquées ; sans registre, aucun fournisseur ne peut être servi.',
    etape: 'configuration',
  },
  operationnel: {
    message: 'Opérationnel : clé acceptée et complétion réelle validée.',
    action: 'Aucune action : le moteur répond.',
    etape: 'ras',
  },
};

/**
 * Traduit l'état observé en diagnostic affichable.
 *
 * L'ordre des contrôles suit le chemin RÉEL d'un appel : configuration, puis
 * réseau, puis catalogue, puis modèle. Signaler « désactivé » avant « clé
 * absente » enverrait l'administrateur activer un fournisseur qui ne peut pas
 * fonctionner.
 */
export function diagnostiquerMoteur(etat: EtatMoteurObserve): DiagnosticMoteur {
  const construire = (blocage: BlocageMoteur, pret = false): DiagnosticMoteur => ({
    blocage,
    message: ACTIONS[blocage].message,
    action: ACTIONS[blocage].action,
    etape: ACTIONS[blocage].etape,
    pret,
  });

  if (!etat.registreLisible) return construire('registre_indisponible');

  // 1. Configuration : sans clé ni adresse, aucun appel n'est possible.
  if (!etat.clePresente) return construire('cle_absente');
  if (!etat.adresseConfiguree || etat.formeAdresse === 'absente') return construire('adresse_absente');
  if (etat.formeAdresse === 'illisible') return construire('adresse_invalide');
  if (etat.formeAdresse === 'locale' || etat.formeAdresse === 'privee') return construire('adresse_non_publique');

  // 2. Réseau : l'appel n'a pas abouti.
  const code = (etat.codeErreur ?? '').toUpperCase();
  if (code === 'PROVIDER_NETWORK_ERROR' || code === 'PROVIDER_UNREACHABLE') return construire('injoignable');
  if (code === 'PROVIDER_TIMEOUT') return construire('delai_depasse');
  if (code === 'PROVIDER_AUTH_FAILED' || etat.statutHttp === 401 || etat.statutHttp === 403) {
    return construire('cle_refusee');
  }
  if (code === 'PROVIDER_MODELS_ENDPOINT_MISSING' || code === 'PROVIDER_ACCOUNT_ID_MISSING' || etat.statutHttp === 404) {
    return construire('adresse_introuvable');
  }
  if (code === 'PROVIDER_PAYMENT_REQUIRED' || code === 'PROVIDER_RATE_LIMITED'
    || etat.statutHttp === 402 || etat.statutHttp === 429) {
    return construire('quota');
  }

  // 3. Catalogue : joint, mais muet.
  if ((etat.modelesCatalogue ?? 0) === 0) return construire('aucun_modele');

  // 4. Modèle : un catalogue non vide ne prouve pas qu'un modèle répond.
  if (code === 'PROVIDER_REQUEST_REJECTED' || code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_ADAPTER_UNSUPPORTED') {
    return construire('completion_refusee');
  }
  if ((etat.modelesVerifies ?? 0) === 0) return construire('aucun_modele');

  // 5. Le fournisseur est joignable et sait répondre : reste l'activation.
  if (!etat.actif) return construire('desactive');

  return construire('operationnel', true);
}

/** État minimal d'un fournisseur dans la réponse `health`. */
export interface FournisseurSante {
  configured?: boolean;
  model?: string | null;
  status?: string;
  enabled?: boolean;
  base_url_configured?: boolean;
  base_url_form?: FormeAdresse;
  error_code?: string | null;
  http_status?: number | null;
  catalog_models?: number | null;
  verified_models?: number | null;
}

/**
 * Construit l'état observé du fournisseur central depuis la réponse `health`.
 *
 * Aucune clé de fournisseur n'est citée : le registre peut en contenir
 * plusieurs, et le diagnostic porte sur celui qui sert réellement les appels.
 */
export function etatDepuisSante(
  fournisseur: FournisseurSante | null | undefined,
  registreLisible = true,
): EtatMoteurObserve {
  return {
    registreLisible: registreLisible && Boolean(fournisseur),
    clePresente: fournisseur?.configured === true,
    adresseConfiguree: fournisseur?.base_url_configured === true,
    formeAdresse: fournisseur?.base_url_form ?? (fournisseur?.base_url_configured ? 'publique' : 'absente'),
    actif: fournisseur?.status === 'available' || fournisseur?.enabled !== false,
    codeErreur: fournisseur?.error_code ?? null,
    statutHttp: fournisseur?.http_status ?? null,
    modelesCatalogue: fournisseur?.catalog_models ?? null,
    modelesVerifies: fournisseur?.verified_models ?? null,
  };
}
