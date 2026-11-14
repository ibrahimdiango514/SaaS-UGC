import type { LucideIcon } from 'lucide-react';
import {
  Bot, BookOpen, Boxes, Brain, CheckSquare, Clapperboard, Coins, CreditCard,
  Film, FolderKanban, History, LayoutDashboard, LifeBuoy, Megaphone,
  MessageSquare, Package, Plug, Radar, Scissors, Settings, Shield,
  ShoppingCart, SlidersHorizontal, Sparkles, Truck, Users, Wallet, Wand2, Workflow,
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
  {
    id: 'overview',
    label: 'Vue d’ensemble',
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
    id: 'creation',
    label: 'Création et génération',
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
        to: '/app/studio/avance',
        label: 'Studio avancé',
        description: 'Parcours historique et options avancées',
        icon: Wand2,
        keywords: ['avance', 'legacy', 'options'],
      },
      {
        to: '/app/studio/classique',
        label: 'Studio classique',
        description: 'Interface de génération simplifiée',
        icon: Film,
        keywords: ['classique', 'simple', 'video'],
      },
    ],
  },
  {
    id: 'production',
    label: 'Production vidéo',
    icon: Scissors,
    defaultOpen: true,
    items: [
      {
        to: '/app/studio/montage',
        label: 'Montage vidéo',
        description: 'Assemblage, sous-titres et export',
        icon: Scissors,
        keywords: ['montage', 'editeur', 'sous-titres', 'export'],
      },
      {
        to: '/app/presets',
        label: 'Réglages vidéo',
        description: 'Formats, durées et préférences de rendu',
        icon: SlidersHorizontal,
        keywords: ['reglages', 'formats', 'presets', 'rendu'],
      },
    ],
  },
  {
    id: 'avatars',
    label: 'Avatars et personnages IA',
    icon: Users,
    items: [{
      to: '/app/avatars',
      label: 'Avatars IA',
      description: 'Personnages et cohérence visuelle',
      icon: Users,
      keywords: ['avatar', 'personnage', 'visage', 'ia'],
    }],
  },
  {
    id: 'content',
    label: 'Scripts et contenus',
    icon: BookOpen,
    items: [
      {
        to: '/app/scripts',
        label: 'Scripts IA',
        description: 'Scripts, hooks et angles créatifs',
        icon: Wand2,
        keywords: ['script', 'hook', 'contenu', 'texte'],
      },
      {
        to: '/app/prompts',
        label: 'Prompts',
        description: 'Bibliothèque de prompts réutilisables',
        icon: BookOpen,
        keywords: ['prompt', 'bibliotheque', 'idees'],
      },
    ],
  },
  {
    id: 'library',
    label: 'Projets et bibliothèque',
    icon: FolderKanban,
    items: [
      {
        to: '/app/projets',
        label: 'Projets',
        description: 'Briefs, scripts et vidéos par projet',
        icon: FolderKanban,
        matchPrefix: true,
        keywords: ['projet', 'brief', 'scenario'],
      },
      {
        to: '/app/bibliotheque',
        label: 'Bibliothèque',
        description: 'Créations enregistrées et fichiers privés',
        icon: Sparkles,
        keywords: ['bibliotheque', 'fichiers', 'creations', 'saved'],
      },
    ],
  },
  {
    id: 'history',
    label: 'Historique',
    icon: History,
    items: [{
      to: '/app/historique',
      label: 'Générations récentes',
      description: 'Statuts, coûts et résultats de génération',
      icon: History,
      keywords: ['historique', 'generations', 'jobs', 'statut'],
    }],
  },
  {
    id: 'account',
    label: 'Crédits et paramètres',
    icon: CreditCard,
    items: [
      {
        to: '/app/abonnement',
        label: 'Abonnement Studio',
        description: 'Formule et limites mensuelles',
        icon: CreditCard,
        keywords: ['abonnement', 'formule', 'plan'],
      },
      {
        to: '/app/credits',
        label: 'Crédits Studio',
        description: 'Packs, solde et historique d’usage',
        icon: Coins,
        keywords: ['credits', 'packs', 'solde', 'paiement'],
      },
      {
        to: '/app/parametres',
        label: 'Paramètres',
        description: 'Compte, langue et préférences',
        icon: Settings,
        keywords: ['parametres', 'compte', 'profil', 'reglages'],
      },
    ],
  },
];

export const BUSINESS_NAV_GROUPS: WorkspaceNavGroup[] = [
  {
    id: 'pilotage',
    label: 'Dashboard et intelligence',
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
        to: '/app/business?section=growth&growthTab=overview',
        label: 'Croissance',
        description: 'Objectifs, marché et lecture de la croissance',
        icon: Sparkles,
        keywords: ['croissance', 'growth', 'objectifs', 'marche'],
      },
      {
        to: '/app/business/modules',
        label: 'Modules métier',
        description: '13 outils opérationnels, données persistées',
        icon: Boxes,
        badge: '13',
        matchPrefix: true,
        keywords: ['modules', 'outils', 'metier', 'catalogue'],
      },
    ],
  },
  {
    id: 'assistant',
    label: 'Assistant IA et intelligence',
    icon: Brain,
    defaultOpen: true,
    items: [
      {
        to: '/app/business?section=chat',
        label: 'Assistant IA',
        description: 'Chat contextualisé et actions à valider',
        icon: MessageSquare,
        badge: 'IA',
        keywords: ['assistant', 'chat', 'agent', 'ia', 'conversation'],
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
        to: '/app/business?section=providers',
        label: 'Services IA',
        description: 'Fournisseurs vérifiés et routage des modèles',
        icon: Bot,
        keywords: ['fournisseur', 'provider', 'modele', 'routage', 'gemini', 'groq'],
      },
    ],
  },
  {
    id: 'crm',
    label: 'CRM et prospects',
    icon: Users,
    defaultOpen: true,
    items: [
      {
        to: '/app/business?section=growth&growthTab=crm',
        label: 'Smart CRM',
        description: 'Prospects, pipeline et valeur commerciale',
        icon: Users,
        keywords: ['crm', 'prospects', 'pipeline', 'opportunites'],
      },
      {
        to: '/app/business/modules/lead-rescue',
        label: 'Lead Rescue',
        description: 'Prospects sans réponse et relances dues',
        icon: LifeBuoy,
        keywords: ['leads', 'prospects', 'relance', 'rescue'],
      },
    ],
  },
  {
    id: 'revenue',
    label: 'Récupération des revenus',
    icon: LifeBuoy,
    items: [
      {
        to: '/app/business/modules/payment-recovery',
        label: 'Payment Recovery',
        description: 'Factures échues et encaissements',
        icon: CreditCard,
        keywords: ['facture', 'impaye', 'paiement', 'encaissement'],
      },
      {
        to: '/app/business/modules/order-cart-recovery',
        label: 'Order & Cart Recovery',
        description: 'Paniers et commandes abandonnés',
        icon: ShoppingCart,
        keywords: ['panier', 'commande', 'abandon', 'cart'],
      },
      {
        to: '/app/business/modules/customer-recovery',
        label: 'Customer Recovery',
        description: 'Clients à réactiver et valeur historique',
        icon: Users,
        keywords: ['client', 'reactivation', 'fidelite'],
      },
    ],
  },
  {
    id: 'sales',
    label: 'Ventes et automatisations',
    icon: Workflow,
    items: [
      {
        to: '/app/business/modules/sales-automation',
        label: 'Sales Automation',
        description: 'Règles de relance et tâches générées',
        icon: Workflow,
        keywords: ['automatisation', 'regles', 'ventes', 'taches'],
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
    ],
  },
  {
    id: 'finance',
    label: 'Finance et trésorerie',
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
    label: 'Stocks et opérations',
    icon: Package,
    items: [
      {
        to: '/app/business/modules/smart-inventory',
        label: 'Smart Inventory',
        description: 'Stocks, seuils et valeur immobilisée',
        icon: Package,
        keywords: ['stock', 'inventaire', 'seuil', 'produits'],
      },
      {
        to: '/app/business/modules/operations-manager',
        label: 'Operations Manager',
        description: 'Tâches, responsables et échéances',
        icon: CheckSquare,
        keywords: ['operations', 'taches', 'equipe', 'echeances'],
      },
      {
        to: '/app/business/modules/supplier-delivery',
        label: 'Supplier & Delivery',
        description: 'Fournisseurs, commandes et livraisons',
        icon: Truck,
        keywords: ['fournisseur', 'livraison', 'commande', 'retard'],
      },
    ],
  },
  {
    id: 'support',
    label: 'Clients et support',
    icon: MessageSquare,
    items: [{
      to: '/app/business/modules/customer-support-ai',
      label: 'Customer Support AI',
      description: 'Demandes, réponses assistées et suivi',
      icon: MessageSquare,
      keywords: ['support', 'tickets', 'sav', 'reclamation'],
    }],
  },
  {
    id: 'growth-social',
    label: 'Croissance et réseaux sociaux',
    icon: Megaphone,
    items: [
      {
        to: '/app/business/modules/social-growth',
        label: 'Social Growth',
        description: 'Calendrier éditorial et production',
        icon: Megaphone,
        keywords: ['social', 'contenu', 'calendrier', 'publication'],
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
    id: 'integrations',
    label: 'Intégrations',
    icon: Plug,
    items: [{
      to: '/app/business?section=integrations',
      label: 'Integrations Hub',
      description: 'Connecteurs, autorisations et état réel',
      icon: Plug,
      keywords: ['integrations', 'connecteurs', 'oauth', 'shopify', 'meta'],
    }],
  },
  {
    id: 'protection',
    label: 'Protection des revenus',
    icon: Shield,
    items: [
      {
        to: '/app/business/modules/revenue-leak',
        label: 'Revenue Leak Detector',
        description: 'Fuites calculées sur vos données réelles',
        icon: Radar,
        keywords: ['fuites', 'revenus', 'leaks', 'pertes'],
      },
      {
        to: '/app/business/modules/dispute-shield',
        label: 'Dispute Shield',
        description: 'Litiges, preuves et résolution',
        icon: Shield,
        keywords: ['litige', 'dispute', 'preuves', 'remboursement'],
      },
    ],
  },
  {
    id: 'settings',
    label: 'Paramètres',
    icon: Settings,
    items: [
      {
        to: '/app/business/abonnement',
        label: 'Formules Business Growth',
        description: 'Abonnement et limites de l’espace métier',
        icon: CreditCard,
        keywords: ['formule', 'abonnement', 'plan', 'prix'],
      },
      {
        to: '/app/parametres',
        label: 'Paramètres du compte',
        description: 'Profil, langue et sécurité',
        icon: Settings,
        keywords: ['parametres', 'compte', 'profil', 'securite'],
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
