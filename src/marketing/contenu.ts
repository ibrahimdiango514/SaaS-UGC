/**
 * VYORA — contenu marketing lu en base, jamais codé en dur.
 *
 * ## Pourquoi un module plutôt que des constantes
 *
 * L'exigence est explicite : « prix, quotas, textes marketing, messages,
 * contenus d'aide : modifiables depuis l'admin, rien en dur ». Une landing dont
 * les titres vivent dans un `.tsx` oblige un déploiement pour changer une
 * phrase. Ici :
 *
 *   1. chaque section a un **identifiant stable** (`landing.hero.titre`) ;
 *   2. la base fournit la valeur si elle existe (`marketing_content`) ;
 *   3. sinon on retombe sur le texte ci-dessous, qui sert de valeur initiale
 *      et de filet de sécurité si la base est indisponible.
 *
 * Conséquence : une page ne casse jamais parce qu'un texte manque, et l'admin
 * peut tout réécrire sans redéploiement.
 *
 * ## Les tarifs ne sont pas ici
 *
 * Ils viennent de `saas_ugc.plans_souscrits` / `ugc_app_settings` — voir
 * `src/marketing/tarifs.ts`. Un prix dupliqué dans un fichier de contenu est un
 * prix qui finit par mentir.
 */

import { supabase } from '../lib/supabase';

/** Valeurs initiales. Elles sont semées en base par la migration. */
export const CONTENU_PAR_DEFAUT = {
  'landing.hero.surtitre': 'Business Grow · VYORA Studio',
  'landing.hero.titre': 'Récupérez l’argent qu’on vous doit, et les clients que vous oubliez.',
  'landing.hero.sous_titre':
    'VYORA relance vos clients à votre place, suit vos impayés et produit vos contenus vidéo. Un seul outil, deux espaces : gérer votre business, ou créer pour vos clients.',
  'landing.hero.cta_principal': 'Créer mon espace gratuit',
  'landing.hero.cta_secondaire': 'Voir une démonstration',
  'landing.hero.rassurance': 'Sans carte bancaire · Prêt en 2 minutes · En français',

  'landing.probleme.titre': 'Ce qui vous coûte de l’argent, chaque semaine',
  'landing.probleme.item1.titre': 'Les relances oubliées',
  'landing.probleme.item1.texte':
    'Un client devait payer vendredi. Vous y pensez lundi. Le devis dort dans un carnet ou dans WhatsApp, et personne ne le retrouve.',
  'landing.probleme.item2.titre': 'Les dettes qui traînent',
  'landing.probleme.item2.texte':
    'Vous savez que l’argent est dehors, mais pas combien exactement, ni chez qui, ni depuis quand.',
  'landing.probleme.item3.titre': 'Le temps perdu à produire du contenu',
  'landing.probleme.item3.texte':
    'Publier régulièrement demande des heures de montage que vous n’avez pas — et sans contenu, personne ne vous trouve.',

  'landing.solution.titre': 'Deux espaces, un seul compte',
  'landing.solution.texte':
    'VYORA ne vous demande pas d’apprendre un logiciel compliqué. Vous parlez, l’assistant enregistre. Vous décrivez, le studio produit.',

  'landing.etapes.titre': 'Comment ça marche',
  'landing.etapes.item1.titre': 'Vous parlez à l’assistant',
  'landing.etapes.item1.texte':
    '« Relance mes clients qui n’ont pas payé. » L’assistant lit vos données, propose les messages, vous validez.',
  'landing.etapes.item2.titre': 'VYORA prépare et vous montrez',
  'landing.etapes.item2.texte':
    'Les relances partent, les tâches se créent, les factures se suivent. Rien ne s’envoie sans votre accord.',
  'landing.etapes.item3.titre': 'Vous voyez ce que ça rapporte',
  'landing.etapes.item3.texte':
    'Chaque semaine : combien récupéré, quels clients relancés, quels contenus produits.',

  'landing.tarifs.titre': 'Tarifs',
  'landing.tarifs.sous_titre': 'Prix de lancement. Ils changent sans préavis, jamais sans vous prévenir.',
  'landing.tarifs.note': 'Paiement par Orange Money, Moov Money ou Mobi Cash. Crédits sans expiration.',

  'landing.faq.titre': 'Questions fréquentes',
  'landing.cta_final.titre': 'Commencez par récupérer ce qu’on vous doit.',
  'landing.cta_final.texte':
    'Créez votre espace, entrez trois clients, et laissez VYORA vous dire qui relancer demain matin.',
  'landing.cta_final.bouton': 'Créer mon espace',

  'landing.social.titre': 'Ils utilisent VYORA',
  'landing.social.actif': 'false',
} as const;

export type CleContenu = keyof typeof CONTENU_PAR_DEFAUT;

/**
 * Charge les textes marketing.
 *
 * Une seule requête, tolérante à l'échec : si la table n'existe pas encore ou si
 * la base ne répond pas, la landing s'affiche avec les valeurs par défaut. Une
 * page marketing qui tombe en erreur parce qu'un texte secondaire manque serait
 * une faute commerciale.
 */
export async function chargerContenu(cles: CleContenu[]): Promise<Record<string, string>> {
  const base = Object.fromEntries(cles.map((c) => [c, CONTENU_PAR_DEFAUT[c] as string]));
  try {
    const { data, error } = await supabase
      .from('marketing_content')
      .select('content_key, content_value')
      .in('content_key', cles as unknown as string[]);
    if (error || !data) return base;
    for (const row of data as Array<{ content_key: string; content_value: string | null }>) {
      if (row.content_value && row.content_value.trim() !== '') base[row.content_key] = row.content_value;
    }
    return base;
  } catch {
    return base;
  }
}
