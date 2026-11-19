import type { LucideIcon } from 'lucide-react';
import {
  Bot, Boxes, Brain, CheckSquare, Clapperboard, CreditCard, FileText, Film,
  FolderKanban, FolderOpen, History, LayoutDashboard, LifeBuoy, Megaphone,
  MessageSquare, Package, Plug, Radar, Scissors, Settings, Shield,
  ShoppingCart, SlidersHorizontal, Sparkles, Truck, Upload, UserRound, Users,
  Wallet, Wand2, Workflow,
} from 'lucide-react';

export type WorkspaceScope = 'studio' | 'business';

export interface WorkspaceNavItem {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Un onglet « préparation » reste visible mais clairement étiqueté. */
  badge?: string;
  /** `/app/business/modules` reste actif sur `/app/business/modules/:key`. */
  matchPrefix?: boolean;
  /** N'est actif que si ces paramètres sont absents (vue d'ensemble). */
  onlyWithoutParams?: string[];
  keywords?: string[];
}

export interface WorkspaceNavGroup {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  items: WorkspaceNavItem[];
  /** Groupe ouvert au premier affichage, hors route active. */
  defaultOpen?: boolean;
}

export interface WorkspaceShortcut {
  to: string;
  label: string;
  icon: LucideIcon;
}

export const STUDIO_NAV_GROUPS: WorkspaceNavGroup[] = [
  /*
   * ORDRE : on suit le parcours réel d'un créateur, pas l'ancienne arborescence
   * technique. Accueil (où j'en suis) → Créer (ce que je veux produire) →
   * Projets (ce que je construis) → Bibliothèque (ce que j'ai déjà produit) →
   * Outils (avatars, scripts, presets) → Assistant → Paramètres.
   *
   * Seuls les deux premiers groupes sont ouverts par défaut : au-delà, la barre
   * redevient une liste de liens et l'utilisateur perd le bénéfice du rangement.
   *
   * L'ancienne structure comptait neuf groupes — « Avatars », « Scripts et
   * contenus » et « Historique » étaient des catégories de premier niveau pour
   * deux ou trois entrées chacune, ce qui allongeait la barre sans l'éclairer.
   * Aucune destination n'est perdue : les 17 entrées sont réparties ci-dessous.
   */
  {
    id: 'accueil',
    label: 'Accueil',
    hint: 'Où j’en suis',
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [{
      to: '/app/studio/accueil',
      label: 'Tableau de bord Studio',
      description: 'Projets, crédits et activité de création',
      icon: LayoutDashboard,
      keywords: ['accueil', 'dashboard', 'studio'],
    }],
  },
  {
    id: 'creer',
    label: 'Créer',
    hint: 'Produire une vidéo',
    icon: Sparkles,
    defaultOpen: true,
    items: [
      {
        to: '/app/studio',
        label: 'Créer une vidéo',
        description: 'Génération UGC avec devis vérifié',
        icon: Clapperboard,
        keywords: ['video', 'ugc', 'generer', 'creer'],
      },
      {
        to: '/app/studio/classique',
        label: 'Studio classique',
        description: 'Interface de génération simplifiée',
        icon: Film,
        keywords: ['classique', 'simple', 'rapide'],
      },
      {
        to: '/app/studio/avance',
        label: 'Studio avancé',
        description: 'Parcours historique et options avancées',
        icon: Wand2,
        keywords: ['avance', 'legacy', 'options'],
      },
      {
        to: '/app/montage',
        label: 'Montage vidéo',
        description: 'Timeline, sous-titres et export — espace dédié',
        icon: Scissors,
        keywords: ['montage', 'timeline', 'editeur', 'sous-titres', 'export'],
      },
    ],
  },
  {
    id: 'projets',
    label: 'Projets',
    hint: 'Ce que je construis',
    icon: FolderOpen,
    defaultOpen: false,
    items: [{
      to: '/app/projets',
      label: 'Mes projets',
      description: 'Reprendre un projet en cours',
      icon: FolderOpen,
      keywords: ['projets', 'reprendre', 'brouillon'],
    }],
  },
  {
    id: 'bibliotheque',
    label: 'Bibliothèque',
    hint: 'Ce que j’ai produit',
    icon: Film,
    defaultOpen: false,
    items: [
      {
        to: '/app/bibliotheque',
        label: 'Créations enregistrées',
        description: 'Fichiers réellement produits',
        icon: Film,
        keywords: ['bibliotheque', 'creations', 'fichiers', 'enregistre'],
      },
      {
        to: '/app/fichiers',
        label: 'Fichiers importés',
        description: 'Médias sources de vos montages',
        icon: Upload,
        keywords: ['fichiers', 'import', 'media', 'sources'],
      },
      {
        to: '/app/historique',
        label: 'Historique',
        description: 'Générations passées et statuts',
        icon: History,
        keywords: ['historique', 'generations', 'passe'],
      },
    ],
  },
  {
    id: 'outils',
    label: 'Outils',
    hint: 'Briques spécialisées',
    icon: Wand2,
    defaultOpen: false,
    items: [
      {
        to: '/app/avatars',
        label: 'Avatars',
        description: 'Personnages et voix réutilisables',
        icon: UserRound,
        keywords: ['avatars', 'personnages', 'voix', 'presence'],
      },
      {
        to: '/app/scripts',
        label: 'Scripts',
        description: 'Textes et dialogues de vos vidéos',
        icon: FileText,
        keywords: ['scripts', 'textes', 'dialogues'],
      },
      {
        to: '/app/prompts',
        label: 'Prompts',
        description: 'Bibliothèque de prompts réutilisables',
        icon: MessageSquare,
        keywords: ['prompts', 'modeles', 'inspiration'],
      },
      {
        to: '/app/presets',
        label: 'Presets',
        description: 'Styles et rendus enregistrés',
        icon: SlidersHorizontal,
        keywords: ['presets', 'styles', 'rendus'],
      },
    ],
  },
  {
    id: 'assistant',
    label: 'Assistant IA',
    hint: 'Chat et analyse',
    icon: Bot,
    defaultOpen: false,
    items: [{
      to: '/app/ai',
      label: 'Assistant VYORA',
      description: 'Conversations, pièces jointes et analyse',
      icon: Bot,
      keywords: ['ia', 'chat', 'assistant', 'conversation', 'analyse', 'gpt'],
    }],
  },
  {
    id: 'parametres',
    label: 'Paramètres et crédits',
    hint: 'Compte et facturation',
    icon: CreditCard,
    defaultOpen: false,
    items: [
      {
        to: '/app/abonnement',
        label: 'Abonnement',
        description: 'Formule et renouvellement',
        icon: CreditCard,
        keywords: ['abonnement', 'formule', 'plan'],
      },
      {
        to: '/app/credits',
        label: 'Crédits',
        description: 'Packs, solde et historique du portefeuille',
        icon: CreditCard,
        keywords: ['credits', 'solde', 'portefeuille', 'packs'],
      },
      {
        to: '/app/parametres',
        label: 'Paramètres',
        description: 'Profil et préférences du compte',
        icon: Settings,
        keywords: ['parametres', 'profil', 'preferences', 'compte'],
      },
    ],
  },
];

/**
 * Navigation Business Grow — regroupée par BESOIN, pas par module.
 *
 * ## Pourquoi cette refonte
 *
 * L'ancienne version exposait 14 groupes et 28 entrées dès l'ouverture du menu.
 * Chaque module avait son groupe (« Récupération des revenus », « Ventes et
 * automatisations », « Stocks et opérations », « Protection des revenus »…),
 * si bien qu'un utilisateur devait lire toute la liste pour trouver une action
 * qu'il connaissait déjà. Un menu long n'est pas un menu riche : c'est un menu
 * qu'on ne lit pas.
 *
 * Le découpage ci-dessous suit ce que l'utilisateur VEUT FAIRE, pas la façon
 * dont le code est rangé :
 *
 *   Assistant      → parler à l'IA (en tête : c'est l'entrée principale)
 *   Pilotage       → voir où j'en suis
 *   Ventes         → prospects, clients, pipeline, relances
 *   Argent         → encaissements, factures, trésorerie
 *   Opérations     → stocks, livraisons, tâches
 *   Marketing      → contenus, réseau social, marché
 *   Automatisations→ règles qui travaillent sans moi
 *   Outils         → intégrations, services IA, entreprise, mémoire, formule
 *
 * ## Ce qui n'a PAS changé
 *
 * Aucune fonctionnalité n'est supprimée : les 28 destinations existent toujours,
 * aux mêmes URL. Seul leur rangement change — et les liens profonds déjà
 * partagés (`?section=…`, `?growthTab=…`) continuent de fonctionner.
 *
 * ## Règle d'ouverture
 *
 * Seuls le pilotage et l'assistant sont dépliés au premier affichage. Les autres
 * groupes s'ouvrent au clic, ou automatiquement si la route active s'y trouve
 * (voir `WorkspaceNav`). C'est ce qui rend le menu lisible sans rien cacher.
 */
export const BUSINESS_NAV_GROUPS: WorkspaceNavGroup[] = [
  {
    id: 'assistant',
    label: 'Assistant IA',
    hint: 'Conversation plein écran, actions à valider',
    icon: Bot,
    defaultOpen: true,
    items: [
      {
        to: '/app/business/assistant',
        label: 'Assistant VYORA',
        description: 'Conversation plein écran avec votre contexte métier',
        icon: MessageSquare,
        badge: 'IA',
        keywords: ['assistant', 'chat', 'agent', 'ia', 'conversation', 'business grow'],
      },
      {
        to: '/app/business?section=chat',
        label: 'Assistant dans le tableau de bord',
        description: 'Le même assistant, encadré par les indicateurs métier',
        icon: Brain,
        keywords: ['assistant', 'dashboard', 'indicateurs'],
      },
    ],
  },
  {
    id: 'pilotage',
    label: 'Pilotage',
    hint: 'Où j’en suis',
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [
      {
        to: '/app/business',
        label: 'Vue d’ensemble',
        description: 'Activité, conversations et indicateurs métier',
        icon: LayoutDashboard,
        onlyWithoutParams: ['section'],
        keywords: ['dashboard', 'accueil', 'pilotage', 'indicateurs'],
      },
      {
        to: '/app/business/modules',
        label: 'Tous les modules métier',
        description: '13 outils opérationnels, données persistées',
        icon: Boxes,
        badge: '13',
        matchPrefix: true,
        keywords: ['modules', 'outils', 'metier', 'catalogue'],
      },
      {
        to: '/app/business?section=growth&growthTab=overview',
        label: 'Croissance',
        description: 'Objectifs, marché et lecture de la croissance',
        icon: Sparkles,
        keywords: ['croissance', 'growth', 'objectifs', 'marche'],
      },
    ],
  },
  {
    id: 'ventes',
    label: 'Ventes et clients',
    hint: 'Prospects, pipeline, relances',
    icon: Users,
    items: [
      {
        to: '/app/business?section=growth&growthTab=crm',
        label: 'Smart CRM',
        description: 'Prospects, pipeline et valeur commerciale',
        icon: Users,
        keywords: ['crm', 'prospects', 'pipeline', 'opportunites', 'clients'],
      },
      {
        to: '/app/business/modules/lead-rescue',
        label: 'Lead Rescue',
        description: 'Prospects sans réponse et relances dues',
        icon: LifeBuoy,
        keywords: ['leads', 'prospects', 'relance', 'rescue'],
      },
      {
        to: '/app/business/modules/customer-support-ai',
        label: 'Support client',
        description: 'Demandes, réponses assistées et suivi',
        icon: MessageSquare,
        keywords: ['support', 'tickets', 'sav', 'reclamation'],
      },
      {
        to: '/app/business/modules/customer-recovery',
        label: 'Clients à réactiver',
        description: 'Clients dormants et valeur historique',
        icon: Users,
        keywords: ['client', 'reactivation', 'fidelite'],
      },
    ],
  },
  {
    id: 'argent',
    label: 'Argent',
    hint: 'Encaissements, factures, trésorerie',
    icon: Wallet,
    items: [
      {
        to: '/app/business/modules/finance-intelligence',
        label: 'Finance Intelligence',
        description: 'Revenus, dépenses et marge réels',
        icon: Wallet,
        keywords: ['finance', 'tresorerie', 'marge', 'depenses'],
      },
      {
        to: '/app/business/modules/payment-recovery',
        label: 'Factures impayées',
        description: 'Factures échues et encaissements',
        icon: CreditCard,
        keywords: ['facture', 'impaye', 'paiement', 'encaissement'],
      },
      {
        to: '/app/business/modules/order-cart-recovery',
        label: 'Paniers abandonnés',
        description: 'Paniers et commandes abandonnés',
        icon: ShoppingCart,
        keywords: ['panier', 'commande', 'abandon', 'cart'],
      },
      {
        to: '/app/business/modules/revenue-leak',
        label: 'Fuites de revenus',
        description: 'Pertes calculées sur vos données réelles',
        icon: Radar,
        keywords: ['fuites', 'revenus', 'leaks', 'pertes'],
      },
      {
        to: '/app/business/modules/dispute-shield',
        label: 'Litiges',
        description: 'Litiges, preuves et résolution',
        icon: Shield,
        keywords: ['litige', 'dispute', 'preuves', 'remboursement'],
      },
      {
        to: '/app/business?section=growth&growthTab=goals',
        label: 'Objectifs financiers',
        description: 'Cibles suivies et progression',
        icon: Radar,
        keywords: ['objectifs', 'goals', 'cibles', 'revenus'],
      },
    ],
  },
  {
    id: 'operations',
    label: 'Organisation',
    hint: 'Tâches, stocks, livraisons',
    icon: CheckSquare,
    items: [
      {
        to: '/app/business/modules/operations-manager',
        label: 'Tâches et équipe',
        description: 'Tâches, responsables et échéances',
        icon: CheckSquare,
        keywords: ['operations', 'taches', 'equipe', 'echeances'],
      },
      {
        to: '/app/business/modules/smart-inventory',
        label: 'Stocks',
        description: 'Stocks, seuils et valeur immobilisée',
        icon: Package,
        keywords: ['stock', 'inventaire', 'seuil', 'produits'],
      },
      {
        to: '/app/business/modules/supplier-delivery',
        label: 'Fournisseurs et livraisons',
        description: 'Fournisseurs, commandes et retards',
        icon: Truck,
        keywords: ['fournisseur', 'livraison', 'commande', 'retard'],
      },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing et contenus',
    hint: 'Campagnes, réseaux, marché',
    icon: Megaphone,
    items: [
      {
        to: '/app/business/modules/social-growth',
        label: 'Calendrier éditorial',
        description: 'Planification et production de contenus',
        icon: Megaphone,
        keywords: ['social', 'contenu', 'calendrier', 'publication'],
      },
      {
        to: '/app/business?section=growth&growthTab=catalog',
        label: 'Catalogue et offres',
        description: 'Produits, services et prix de référence',
        icon: Package,
        keywords: ['catalogue', 'offres', 'produits', 'services'],
      },
      {
        to: '/app/business?section=growth&growthTab=strategy',
        label: 'Stratégie commerciale',
        description: 'Priorités et plan de croissance',
        icon: Brain,
        keywords: ['strategie', 'plan', 'commercial'],
      },
      {
        to: '/app/business?section=growth&growthTab=market',
        label: 'Marché et concurrence',
        description: 'Veille et positionnement',
        icon: Radar,
        keywords: ['marche', 'concurrence', 'veille'],
      },
    ],
  },
  {
    id: 'automatisations',
    label: 'Automatisations',
    hint: 'Ce qui travaille sans vous',
    icon: Workflow,
    items: [
      {
        to: '/app/business/modules/sales-automation',
        label: 'Règles de relance',
        description: 'Automatisations commerciales et tâches générées',
        icon: Workflow,
        keywords: ['automatisation', 'regles', 'ventes', 'taches'],
      },
    ],
  },
  {
    id: 'outils',
    label: 'Outils et réglages',
    hint: 'Intégrations, services IA, entreprise',
    icon: Plug,
    items: [
      {
        to: '/app/business?section=integrations',
        label: 'Intégrations',
        description: 'Connecteurs, autorisations et état réel',
        icon: Plug,
        keywords: ['integrations', 'connecteurs', 'oauth', 'shopify', 'meta'],
      },
      {
        to: '/app/business?section=providers',
        label: 'Services IA',
        description: 'Fournisseurs vérifiés et routage des modèles',
        icon: Bot,
        keywords: ['fournisseur', 'provider', 'modele', 'routage', 'gemini', 'groq'],
      },
      {
        to: '/app/business?section=company',
        label: 'Contexte entreprise',
        description: 'Activité, offre, clients et priorités',
        icon: Package,
        keywords: ['entreprise', 'societe', 'contexte', 'offre'],
      },
      {
        to: '/app/business?section=memory',
        label: 'Mémoire métier',
        description: 'Faits consentis utilisés par l’agent',
        icon: Brain,
        keywords: ['memoire', 'memory', 'consentement', 'contexte'],
      },
      {
        to: '/app/business/abonnement',
        label: 'Formule et limites',
        description: 'Abonnement et limites de l’espace métier',
        icon: CreditCard,
        keywords: ['formule', 'abonnement', 'plan', 'prix'],
      },
      {
        to: '/app/parametres',
        label: 'Paramètres du compte',
        description: 'Profil et préférences VYORA',
        icon: Settings,
        keywords: ['parametres', 'compte', 'profil', 'reglages'],
      },
    ],
  },
];

export const STUDIO_SHORTCUTS: WorkspaceShortcut[] = [
  { to: '/app/studio', label: 'Créer', icon: Clapperboard },
  { to: '/app/projets', label: 'Projets', icon: FolderKanban },
  { to: '/app/bibliotheque', label: 'Bibliothèque', icon: Sparkles },
];

export const BUSINESS_SHORTCUTS: WorkspaceShortcut[] = [
  { to: '/app/business?section=chat', label: 'Assistant', icon: MessageSquare },
  { to: '/app/business?section=growth&growthTab=crm', label: 'Smart CRM', icon: Users },
  { to: '/app/business/modules', label: 'Modules', icon: Boxes },
];

export const STUDIO_MOBILE_NAV = [
  { to: '/app/studio/accueil', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { to: '/app/studio', label: 'Créer', icon: Clapperboard },
  { to: '/app/projets', label: 'Projets', icon: FolderKanban },
  { to: '/app/historique', label: 'Historique', icon: History },
];

export const BUSINESS_MOBILE_NAV = [
  { to: '/app/business', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { to: '/app/business?section=chat', label: 'Assistant', icon: MessageSquare },
  { to: '/app/business?section=growth&growthTab=crm', label: 'Smart CRM', icon: Users },
  { to: '/app/business/modules', label: 'Modules', icon: Boxes },
];

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function filterNavGroups(groups: WorkspaceNavGroup[], query: string): WorkspaceNavGroup[] {
  const needle = normalizeSearch(query);
  if (!needle) return groups;
  return groups
    .map((group) => {
      const groupMatch = normalizeSearch(`${group.label} ${group.hint ?? ''}`).includes(needle);
      const items = group.items.filter((item) => {
        const haystack = normalizeSearch(`${item.label} ${item.description} ${(item.keywords ?? []).join(' ')}`);
        return groupMatch || haystack.includes(needle);
      });
      return { ...group, items };
    })
    .filter((group) => group.items.length > 0);
}

function targetOf(to: string): { path: string; params: URLSearchParams } {
  const [path, query = ''] = to.split('?');
  return { path, params: new URLSearchParams(query) };
}

/** Activation exacte : pathname, paramètres de section et onglet Croissance. */
export function isNavItemActive(item: WorkspaceNavItem, pathname: string, search: string): boolean {
  const target = targetOf(item.to);
  const isPath = item.matchPrefix
    ? pathname === target.path || pathname.startsWith(`${target.path}/`)
    : pathname === target.path;
  if (!isPath) return false;

  const current = new URLSearchParams(search);
  if (item.onlyWithoutParams?.some((param) => current.has(param))) return false;

  for (const [key, value] of target.params.entries()) {
    if (current.get(key) !== value) return false;
  }
  // Un lien sans paramètre ne doit pas s'allumer sur une autre sous-section.
  if (target.params.toString() === '' && item.onlyWithoutParams?.length) {
    return true;
  }
  if (target.params.toString() === '') {
    return item.matchPrefix ? true : true;
  }
  return true;
}

export function activeGroupId(groups: WorkspaceNavGroup[], pathname: string, search: string): string | null {
  return groups.find((group) => group.items.some((item) => isNavItemActive(item, pathname, search)))?.id ?? null;
}
