import type { LucideIcon } from 'lucide-react';
import {
  BarChart3, BellRing, BookOpen, Bot, Boxes, Brain, Building2, Clapperboard,
  ClipboardList, Coins, CreditCard, Film, FolderKanban, HardDrive, History,
  LayoutDashboard, Mail, MoreHorizontal, Plug, Scissors, Settings, Shield, SlidersHorizontal,
  Sparkles, Target, Users, Wallet, Wand2, Zap,
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
    id: 'assistant',
    label: 'Assistant IA',
    hint: 'Chat, analyse et rédaction',
    icon: Bot,
    defaultOpen: true,
    items: [{
      to: '/app/ai',
      label: 'Assistant SORAHNEX',
      description: 'Conversations, pièces jointes et analyse',
      icon: Bot,
      keywords: ['ia', 'chat', 'assistant', 'conversation', 'analyse', 'gpt'],
    }],
  },
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
      {
        to: '/app/fichiers',
        label: 'Fichiers et médias',
        description: 'Importer, prévisualiser, rattacher, supprimer',
        icon: HardDrive,
        keywords: ['fichiers', 'medias', 'upload', 'import', 'documents', 'images', 'videos'],
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
    label: 'Pilotage',
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [
      {
        to: '/app/business',
        label: 'Vue générale',
        description: 'Chiffres clés, alertes et activité du jour',
        icon: LayoutDashboard,
        keywords: ['dashboard', 'accueil', 'pilotage', 'indicateurs', 'growth os'],
      },
      {
        to: '/app/business/reports',
        label: 'Rapports et analyses',
        description: 'Conversion, sources, encaissements et recouvrement',
        icon: BarChart3,
        keywords: ['rapports', 'analyses', 'conversion', 'sources', 'exports'],
      },
      {
        to: '/app/business/modules',
        label: 'Modules métier',
        description: 'Outils opérationnels, données persistées',
        icon: Boxes,
        badge: '13',
        matchPrefix: true,
        keywords: ['modules', 'outils', 'metier', 'catalogue'],
      },
    ],
  },
  {
    id: 'commercial',
    label: 'Commercial',
    icon: Users,
    defaultOpen: true,
    items: [
      {
        to: '/app/business/crm',
        label: 'CRM',
        description: 'Contacts, fiches, segments, doublons et imports',
        icon: Users,
        keywords: ['crm', 'contacts', 'clients', 'prospects', 'segments', 'doublons'],
      },
      {
        to: '/app/business/pipeline',
        label: 'Pipeline commercial',
        description: 'Opportunités, étapes et prévisions',
        icon: Target,
        keywords: ['pipeline', 'opportunites', 'kanban', 'ventes'],
      },
      {
        to: '/app/business/tasks',
        label: 'Tâches et activités',
        description: 'Aujourd’hui, retards, agenda et suivi',
        icon: ClipboardList,
        keywords: ['taches', 'activites', 'agenda', 'rappels'],
      },
      {
        to: '/app/business/relances',
        label: 'Relances',
        description: 'Messages préparés, canaux et historique',
        icon: Mail,
        keywords: ['relances', 'messages', 'whatsapp', 'email', 'sms'],
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    icon: Wallet,
    defaultOpen: true,
    items: [
      {
        to: '/app/business/finance',
        label: 'Finance',
        description: 'Créances, paiements, soldes et échéances',
        icon: Wallet,
        keywords: ['finance', 'creances', 'paiements', 'soldes', 'echeances', 'recus'],
      },
      {
        to: '/app/business/recouvrement',
        label: 'Recouvrement',
        description: 'Priorités, promesses, litiges et risques',
        icon: BellRing,
        keywords: ['recouvrement', 'dettes', 'promesses', 'litiges', 'risque'],
      },
    ],
  },
  {
    id: 'assistant',
    label: 'Assistant IA',
    icon: Brain,
    defaultOpen: true,
    items: [
      {
        to: '/app/business/assistant',
        label: 'Assistant IA',
        description: 'Conversation reliée au CRM et aux finances',
        icon: Brain,
        badge: 'IA',
        keywords: ['assistant', 'chat', 'agent', 'ia', 'conversation'],
      },
      {
        to: '/app/business/company',
        label: 'Contexte entreprise',
        description: 'Activité, offre, clients et priorités',
        icon: Building2,
        keywords: ['entreprise', 'societe', 'contexte', 'offre'],
      },
    ],
  },
  {
    id: 'settings',
    label: 'Configuration',
    icon: Settings,
    items: [
      {
        to: '/app/business/memory',
        label: 'Mémoire métier',
        description: 'Faits consentis utilisés par l’assistant',
        icon: Brain,
        keywords: ['memoire', 'memory', 'consentement', 'contexte'],
      },
      {
        to: '/app/business/providers',
        label: 'Services IA',
        description: 'Fournisseurs vérifiés et routage des modèles',
        icon: Zap,
        keywords: ['fournisseur', 'provider', 'modele', 'routage'],
      },
      {
        to: '/app/business/integrations',
        label: 'Intégrations',
        description: 'Connecteurs, autorisations et état réel',
        icon: Plug,
        keywords: ['integrations', 'connecteurs', 'oauth', 'shopify', 'meta'],
      },
      {
        to: '/app/business/ai',
        label: 'Contrôle IA',
        description: 'Mémoire de l’agent et consentement',
        icon: Shield,
        keywords: ['controle', 'ia', 'agent', 'consentement'],
      },
      {
        to: '/app/business/abonnement',
        label: 'Formules Grow',
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
  { to: '/app/business', label: 'Vue générale', icon: LayoutDashboard },
  { to: '/app/business/crm', label: 'CRM', icon: Users },
  { to: '/app/business/pipeline', label: 'Pipeline', icon: Target },
  { to: '/app/business/finance', label: 'Finance', icon: Wallet },
];

/**
 * Entrée de la barre de navigation mobile.
 *
 * `shortLabel` évite de couper le libellé au premier mot (« Vue d’ensemble »
 * devenait « Vue ») : la barre affiche un mot choisi, jamais une troncature
 * automatique. `opensDrawer` permet une entrée « Plus » qui ouvre le tiroir
 * complet au lieu de naviguer vers une route inexistante.
 */
export interface MobileNavItem {
  to: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  opensDrawer?: boolean;
}

export const STUDIO_MOBILE_NAV: MobileNavItem[] = [
  { to: '/app/studio/accueil', label: 'Vue d’ensemble', shortLabel: 'Accueil', icon: LayoutDashboard },
  { to: '/app/studio', label: 'Créer', shortLabel: 'Créer', icon: Clapperboard },
  { to: '/app/projets', label: 'Projets', shortLabel: 'Projets', icon: FolderKanban },
  { to: '/app/historique', label: 'Historique', shortLabel: 'Historique', icon: History },
];

/**
 * Cinq entrées : les quatre usages quotidiens de Grow, plus un accès au tiroir
 * complet (pipeline, modules, intégrations, paramètres) pour ne bloquer aucune
 * fonctionnalité derrière une barre trop courte.
 */
export const BUSINESS_MOBILE_NAV: MobileNavItem[] = [
  { to: '/app/business', label: 'Accueil Grow', shortLabel: 'Accueil', icon: LayoutDashboard },
  { to: '/app/business/finance', label: 'Activité et ventes', shortLabel: 'Ventes', icon: Wallet },
  { to: '/app/business/crm', label: 'Prospects et clients', shortLabel: 'Prospects', icon: Users },
  { to: '/app/business/assistant', label: 'Assistant IA', shortLabel: 'Assistant', icon: Brain },
  { to: '#plus', label: 'Tout le menu Grow', shortLabel: 'Plus', icon: MoreHorizontal, opensDrawer: true },
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
