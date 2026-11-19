/**
 * VYORA — quotas côté client.
 *
 * Le client ne fait qu'une chose : demander à la base. Il ne calcule jamais un
 * solde, ne devine jamais une limite. C'est la fonction SQL `quota_consommer`
 * qui tranche, parce qu'un compteur calculé dans le navigateur est un compteur
 * qu'on peut contourner.
 *
 * Ce module sert à deux choses :
 *   1. consommer une unité avant une action (prospect, e-mail, audit…) ;
 *   2. traduire un refus en message compréhensible — c'est ici que se joue la
 *      différence entre « ça ne marche pas » et « vous avez utilisé 30 de vos
 *      30 prospects ce mois-ci, votre quota se renouvelle le 18 décembre ».
 */

import { supabase } from './supabase';

export type ActionQuota =
  | 'prospect'
  | 'client'
  | 'produit'
  | 'email'
  | 'import'
  | 'audit'
  | 'analyse_image'
  | 'ia_lecture'
  | 'ia_ecriture'
  | 'ia_email'
  | 'ia_image'
  | 'ia_audit'
  | 'ia_generation';

export interface ResultatQuota {
  autorise: boolean;
  utilise: number;
  limite: number | null;
  restant: number | null;
  periode_fin: string | null;
  plan: string;
  raison: 'quota_atteint' | null;
}

export interface EtatQuotas {
  plan: string;
  periode_debut: string;
  periode_fin: string;
  compteurs: Record<string, { utilise: number; limite: number | null }>;
}

/** Consomme `quantite` unités. Ne lève pas d'exception : renvoie le verdict. */
export async function consommerQuota(
  workspaceId: string,
  action: ActionQuota,
  quantite = 1,
): Promise<ResultatQuota> {
  const { data, error } = await supabase.rpc('quota_consommer', {
    p_workspace_id: workspaceId,
    p_action: action,
    p_quantite: quantite,
  });
  if (error) {
    // Une erreur technique ne doit jamais être transformée en « quota atteint » :
    // ce serait mentir au client sur la raison du blocage.
    throw new Error(`Quota indisponible : ${error.message}`);
  }
  return data as ResultatQuota;
}

export async function etatQuotas(workspaceId: string): Promise<EtatQuotas | null> {
  const { data, error } = await supabase.rpc('quota_etat', { p_workspace_id: workspaceId });
  if (error) return null;
  return data as EtatQuotas;
}

/** Libellés lisibles : un client ne doit jamais lire `max_prospects`. */
export const LIBELLE_ACTION: Record<ActionQuota, string> = {
  prospect: 'prospects',
  client: 'clients',
  produit: 'produits',
  email: 'e-mails',
  import: 'imports',
  audit: 'audits de boutique',
  analyse_image: 'analyses d’images',
  ia_lecture: 'analyses de l’assistant',
  ia_ecriture: 'écritures de l’assistant',
  ia_email: 'rédaction de relances',
  ia_image: 'lectures de documents',
  ia_audit: 'audits de boutique',
  ia_generation: 'générations de contenu',
};

/** Nombre de jours avant renouvellement — affiché dans le message de blocage. */
export function joursAvantRenouvellement(periodeFin: string | null): number | null {
  if (!periodeFin) return null;
  const fin = new Date(periodeFin + 'T23:59:59');
  const diff = Math.ceil((fin.getTime() - Date.now()) / 86_400_000);
  return diff >= 0 ? diff : 0;
}

/** Date lisible en français, sans dépendance de formatage externe. */
export function dateLisible(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
