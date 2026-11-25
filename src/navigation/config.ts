import type { LucideIcon } from 'lucide-react';
import {
  BookOpen, Bot, Boxes, Brain, Clapperboard, Coins, CreditCard, Film, FolderKanban,
  HardDrive, History, LayoutDashboard, Menu, Scissors, Settings, Sparkles, Users, Wand2,
} from 'lucide-react';
import { GROWTH_OS_NAV } from '../business/os/modules';

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

/**
 * Navigation SORAHNEX Studio.
 *
 * Cinq groupes par intention, et non par technologie : piloter, créer,
 * préparer les contenus, retrouver ses fichiers, gérer son compte. Les
 * interfaces historiques (génération simplifiée, options avancées) restent
 * accessibles dans « Créer », étiquetées pour ce qu'elles sont.
 */
export const STUDIO_NAV_GROUPS: WorkspaceNavGroup[] = [
  {
    id: 'pilotage',
    label: 'Pilotage',
    hint: 'Vue d’ensemble et assistant',
    icon: LayoutDashboard,
    defaultOpen: true,
    items: [
      {
        to: '/app/studio/accueil',
        label: 'Tableau de bord',
        description: 'Projets, crédits et activité de création',
        icon: LayoutDashboard,
        keywords: ['accueil', 'dashboard', 'studio', 'credits', 'activite'],
      },
      {
        to: '/app/ai',
        label: 'Assistant SORAHNEX',
        description: 'Conversations, pièces jointes et analyse',
        icon: Bot,
        keywords: ['ia', 'chat', 'assistant', 'conversation', 'analyse', 'gpt'],
      },
      {
        to: '/app/historique',
        label: 'Historique des générations',
        description: 'Statuts, coûts et résultats de génération',
        icon: History,
        keywords: ['historique', 'generations', 'jobs', 'statut'],
      },
    ],
  },
  {
    id: 'creation',
    label: 'Créer',
    hint: 'Génération et montage',
    icon: Clapperboard,
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
        to: '/app/studio/montage',
        label: 'Montage vidéo',
        description: 'Assemblage, sous-titres et export',
        icon: Scissors,
        keywords: ['montage', 'editeur', 'sous-titres', 'export'],
      },
      {
        to: '/app/studio/classique',
        label: 'Génération simplifiée',
        description: 'Interface de génération réduite à l’essentiel',
        icon: Film,
        keywords: ['classique', 'simple', 'video'],
      },
      {
        to: '/app/studio/avance',
        label: 'Options avancées',
        description: 'Parcours historique et réglages experts',
        icon: Wand2,
        keywords: ['avance', 'legacy', 'options'],
      },
    ],
  },
  {
    id: 'contenus',
    label: 'Contenus',
    hint: 'Scripts, prompts et avatars',
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
      {
        to: '/app/avatars',
        label: 'Avatars IA',
        description: 'Personnages et cohérence visuelle',
        icon: Users,
        keywords: ['avatar', 'personnage', 'visage', 'ia'],
      },
      {
        to: '/app/presets',
        label: 'Réglages vidéo',
        description: 'Formats, durées et préférences de rendu',
        icon: Sparkles,
        keywords: ['reglages', 'formats', 'presets', 'rendu'],
      },
    ],
  },
  {
    id: 'bibliotheque',
    label: 'Bibliothèque',
    hint: 'Projets, créations et médias',
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
        label: 'Créations enregistrées',
        description: 'Vidéos et contenus prêts à réutiliser',
        icon: Sparkles,
        keywords: ['bibliotheque', 'creations', 'saved'],
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
    id: 'compte',
    label: 'Compte',
    hint: 'Formule, crédits et préférences',
    icon: Settings,
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

/**
 * Navigation SORAHNEX Grow.
 *
 * Dérivée du Growth OS : une seule source de vérité pour les modules métier.
 * Les anciens groupes dupliqués (`config.ts` vs `os/modules.ts`) divergeaient à
 * chaque ajout de module ; ce n'est plus possible.
 */
export const BUSINESS_NAV_GROUPS: WorkspaceNavGroup[] = [
  ...GROWTH_OS_NAV.map((group, index) => ({
    id: group.id,
    label: group.label,
    icon: group.items[0]?.icon ?? Boxes,
    defaultOpen: index < 2,
    items: group.items.map((item): WorkspaceNavItem => ({
      to: item.path,
      label: item.label,
      description: item.description,
      icon: item.icon,
      keywords: [item.shortLabel.toLowerCase(), item.key],
    })),
  })),
  {
    id: 'outils',
    label: 'Outils et compte',
    hint: 'Catalogue de modules, formule et préférences',
    icon: Boxes,
    items: [
      {
        to: '/app/business/modules',
        label: 'Modules métier',
        description: 'Catalogue complet des modules et de leurs données',
        icon: Boxes,
        badge: '21',
        matchPrefix: true,
        keywords: ['modules', 'outils', 'metier', 'catalogue'],
      },
      {
        to: '/app/business/abonnement',
        label: 'Formule SORAHNEX Grow',
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
  { to: '/app/bibliotheque', label: 'Créations', icon: Sparkles },
];

export const BUSINESS_SHORTCUTS: WorkspaceShortcut[] = [
  { to: '/app/business', label: 'Vue', icon: LayoutDashboard },
  { to: '/app/business/crm', label: 'CRM', icon: Users },
  { to: '/app/business/pipeline', label: 'Pipeline', icon: Boxes },
];

export interface MobileNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Ouvre le tiroir complet au lieu de naviguer (entrée « Plus »). */
  opensDrawer?: boolean;
}

/**
 * Barre du bas de SORAHNEX Studio.
 *
 * Quatre destinations réelles et une entrée « Plus » : les outils secondaires
 * (scripts, avatars, crédits, paramètres) restent dans le tiroir sans encombrer
 * l'écran d'un téléphone.
 */
export const STUDIO_MOBILE_NAV: MobileNavItem[] = [
  { to: '/app/studio/accueil', label: 'Accueil', icon: LayoutDashboard },
  { to: '/app/studio', label: 'Créer', icon: Clapperboard },
  { to: '/app/projets', label: 'Projets', icon: FolderKanban },
  { to: '/app/ai', label: 'Assistant', icon: Bot },
  { to: '', label: 'Plus', icon: Menu, opensDrawer: true },
];

/** Barre du bas de SORAHNEX Grow sur Android : quatre destinations + tiroir. */
export const BUSINESS_MOBILE_NAV: MobileNavItem[] = [
  { to: '/app/business', label: 'Accueil', icon: LayoutDashboard },
  { to: '/app/business/crm', label: 'Prospects', icon: Users },
  { to: '/app/business/pipeline', label: 'Ventes', icon: Boxes },
  { to: '/app/business/assistant', label: 'Assistant', icon: Brain },
  { to: '', label: 'Plus', icon: Menu, opensDrawer: true },
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
  return true;
}

export function activeGroupId(groups: WorkspaceNavGroup[], pathname: string, search: string): string | null {
  return groups.find((group) => group.items.some((item) => isNavItemActive(item, pathname, search)))?.id ?? null;
}
