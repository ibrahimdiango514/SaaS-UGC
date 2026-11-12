export class AppError extends Error {
  code: string;
  constructor(message: string, code = 'UNKNOWN_ERROR') {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

const DB_MESSAGES: Array<[RegExp, string]> = [
  [/quota_exceeded:script/i, 'Limite mensuelle de scripts atteinte pour votre formule.'],
  [/quota_exceeded:prompt/i, 'Limite mensuelle de prompts atteinte pour votre formule.'],
  [/quota_exceeded:video/i, 'Limite mensuelle de vidéos atteinte pour votre formule.'],
  [/quota_exceeded/i, 'Limite d’utilisation mensuelle atteinte.'],
  [/project_limit_reached/i, 'Nombre maximum de projets atteint pour votre formule. Archivez un projet ou changez de formule.'],
  [/insufficient_credits/i, 'Crédits insuffisants. Rechargez votre solde depuis l’abonnement.'],
  [/account_not_active/i, 'Votre compte est suspendu. Contactez l’administration.'],
  [/not_authenticated/i, 'Session expirée, veuillez vous reconnecter.'],
  [/service_unavailable/i, 'Ce service de génération n’est pas disponible actuellement.'],
  [/saspay_order_requires_verified_payment/i, 'Une commande SasPay ne peut pas être validée à la main : elle n’est réglée que par un paiement vérifié auprès de SasPay.'],
  [/saspay_order_requires_payment_service|saspay_provider_name_reserved/i, 'Les paiements SasPay ne peuvent être créés que par le service de paiement.'],
  [/paid_order_is_terminal|recharge_order_identity_is_immutable|payment_order_identity_is_immutable|provider_reference_is_immutable/i, 'Cette commande ne peut plus être modifiée.'],
  [/invalid_product/i, 'Produit inconnu.'],
  [/forbidden/i, 'Vous n’avez pas les droits nécessaires pour cette action.'],
  [/job_not_cancellable/i, 'Cette génération ne peut plus être annulée.'],
  [/cannot_remove_last_admin/i, 'Impossible de retirer le dernier administrateur de la plateforme.'],
  [/plan_not_found/i, 'Formule introuvable.'],
  [/Recharge pricing is not configured/i, 'La tarification des recharges n’est pas configurée pour ce pays.'],
  [/Recharge amount outside configured limits/i, 'Le montant saisi est hors des limites autorisées.'],
  [/Code promotionnel invalide/i, 'Code promotionnel invalide.'],
  [/Code promotionnel expiré/i, 'Ce code promotionnel a expiré.'],
  [/déjà utilisé au maximum/i, 'Vous avez déjà utilisé ce code promotionnel.'],
  [/duplicate key value violates unique constraint/i, 'Cette entrée existe déjà.'],
  [/violates row-level security/i, 'Action refusée par les règles de sécurité.'],
  [/invalid input syntax/i, 'Une valeur saisie est invalide.'],
  [/invalid_idempotency_key/i, 'Identifiant d’opération invalide. Relancez la génération.'],
  [/MUAPI_NOT_CONFIGURED/i, 'La génération vidéo est indisponible pour le moment. Réessayez plus tard.'],
  [/MODEL_UNAVAILABLE/i, 'Ce modèle vidéo n’est plus disponible. Choisissez-en un autre.'],
  [/MODEL_NOT_FOUND/i, 'Modèle vidéo introuvable.'],
  [/IMAGE_MISSING/i, 'Ce modèle exige une image de référence (produit ou avatar).'],
  [/SCRIPT_MISSING/i, 'Générez ou saisissez un script avant de lancer la vidéo.'],
  [/MUAPI_SUBMIT_ERROR/i, 'La génération n’a pas pu être lancée. Vérifiez les paramètres et réessayez.'],
  [/MUAPI_NO_REQUEST_ID/i, 'La génération n’a pas pu être confirmée. Vos crédits ont été restitués.'],
  [/timeout/i, 'Le service vidéo n’a pas répondu à temps. Vos crédits ont été restitués.'],
  [/GROQ_NOT_CONFIGURED/i, 'L’assistance IA est indisponible pour le moment. Saisissez votre script ou votre prompt manuellement.'],
  [/AI_PROVIDERS_NOT_CONFIGURED/i, 'Aucun service IA n’est disponible pour le moment. Aucune réponse n’est simulée.'],
  [/BG_INSUFFICIENT_CREDITS|bg_insufficient_credits/i, 'Crédits Business Grow épuisés. Vos crédits Studio UGC ne sont jamais utilisés dans Business Grow.'],
  [/BG_INSUFFICIENT_QUOTA|bg_insufficient_quota/i, 'Quota Business Grow atteint pour cette période. Vos crédits Studio UGC restent totalement séparés.'],
  [/NO_VERIFIED_PROVIDER/i, 'Aucun service IA n’est disponible pour cette demande. Réessayez plus tard.'],
  [/PROVIDER_NOT_CONFIGURED/i, 'Ce service IA est indisponible pour le moment.'],
  [/PROVIDER_SPEND_DISABLED/i, 'Les générations vidéo payantes sont temporairement suspendues par l’administration. Aucun crédit n’a été débité.'],
  [/PROVIDER_SPEND_CAP_EXCEEDED/i, 'Le budget fournisseur disponible ne couvre pas cette génération. Aucun crédit n’a été débité.'],
  [/PROVIDER_SPEND_UNAVAILABLE/i, 'La vérification du budget fournisseur est momentanément indisponible. Aucun appel payant n’a été lancé.'],
  [/PROVIDER_SPEND_ALREADY_RESERVED/i, 'Une vérification de budget est déjà en cours pour cette génération. Actualisez le suivi.'],
  [/PROVIDER_ADAPTER_NOT_IMPLEMENTED/i, 'Cette fonctionnalité n’est pas encore disponible.'],
  [/business_memory_consent_required/i, 'La mémoire métier est désactivée pour cette entreprise. Activez le consentement avant d’enregistrer des souvenirs.'],
  [/AI_EMPTY_RESPONSE/i, 'Le service IA n’a renvoyé aucun contenu exploitable. Aucun texte n’est simulé ; réessayez ou saisissez votre texte manuellement.'],
  [/AI_PROVIDER_ERROR/i, 'Le service IA a rencontré une erreur. Aucun texte n’est simulé ; réessayez plus tard.'],
  [/AI_INTERNAL_ERROR/i, 'Une erreur inattendue est survenue côté IA. Aucun texte n’est simulé.'],
];

export function humanizeError(raw: string | undefined | null, fallback = 'Une erreur est survenue. Réessayez.'): string {
  if (!raw) return fallback;
  for (const [pattern, message] of DB_MESSAGES) if (pattern.test(raw)) return message;
  if (/Failed to send a request to the Edge Function|FunctionsFetchError/i.test(raw)) {
    return 'Impossible de joindre un service VYORA (réseau ou CORS). Vérifiez votre connexion puis réessayez.';
  }
  if (/fetch failed|network|Failed to fetch|NetworkError/i.test(raw)) return 'Connexion impossible. Vérifiez votre réseau puis réessayez.';
  return raw.length > 260 ? `${raw.slice(0, 260)}…` : raw;
}

export function asAppError(error: unknown, fallback?: string): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return new AppError(humanizeError(message, fallback), 'UNKNOWN_ERROR');
}
