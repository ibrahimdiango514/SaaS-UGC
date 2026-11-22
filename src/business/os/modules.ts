import {
  BarChart3, BellRing, Brain, Building2, ClipboardList, Landmark, LayoutDashboard, Mail,
  Megaphone, Package, Plug, Shield, ShoppingCart, Store, Target, Truck, Users, Wallet, Workflow, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Navigation du nouveau Growth OS.
 *
 * Un module = une URL réelle (`/app/business/...`), pas un onglet caché dans
 * une page unique. L'ancien cockpit « Croissance » n'est plus rendu.
 */
export type GrowthOsModule =
  | 'overview' | 'crm' | 'pipeline' | 'tasks' | 'relances'
  | 'sales' | 'catalog' | 'suppliers' | 'storefront' | 'finance' | 'cash' | 'recouvrement' | 'reports'
  | 'automation' | 'marketing' | 'assistant'
  | 'company' | 'memory' | 'providers' | 'integrations' | 'ai';

export interface GrowthOsNavItem {
  key: GrowthOsModule;
  label: string;
  shortLabel: string;
  description: string;
  path: string;
  icon: LucideIcon;
}

export interface GrowthOsNavGroup {
  id: string;
  label: string;
  items: readonly GrowthOsNavItem[];
}

export const GROWTH_OS_NAV: readonly GrowthOsNavGroup[] = [
  {
    id: 'pilotage',
    label: 'Pilotage',
    items: [
      {
        key: 'overview', label: 'Vue générale', shortLabel: 'Vue',
        description: 'Chiffres clés, alertes et activité du jour',
        path: '/app/business', icon: LayoutDashboard,
      },
      {
        key: 'reports', label: 'Rapports et analyses', shortLabel: 'Rapports',
        description: 'Conversion, sources, encaissements et recouvrement',
        path: '/app/business/reports', icon: BarChart3,
      },
    ],
  },
  {
    id: 'commercial',
    label: 'Commercial',
    items: [
      {
        key: 'crm', label: 'CRM', shortLabel: 'CRM',
        description: 'Contacts, fiches, segments et doublons',
        path: '/app/business/crm', icon: Users,
      },
      {
        key: 'pipeline', label: 'Pipeline commercial', shortLabel: 'Pipeline',
        description: 'Opportunités, étapes et prévisions',
        path: '/app/business/pipeline', icon: Target,
      },
      {
        key: 'tasks', label: 'Tâches et activités', shortLabel: 'Tâches',
        description: 'Aujourd’hui, retards, agenda et suivi',
        path: '/app/business/tasks', icon: ClipboardList,
      },
      {
        key: 'relances', label: 'Relances', shortLabel: 'Relances',
        description: 'Messages préparés, canaux et historique',
        path: '/app/business/relances', icon: Mail,
      },
      {
        key: 'sales', label: 'Ventes et facturation', shortLabel: 'Ventes',
        description: 'Devis, commandes et factures reliés au CRM',
        path: '/app/business/sales', icon: ShoppingCart,
      },
      {
        key: 'catalog', label: 'Produits et stock', shortLabel: 'Catalogue',
        description: 'Catalogue, mouvements et alertes de stock',
        path: '/app/business/catalog', icon: Package,
      },
      {
        key: 'suppliers', label: 'Achats et fournisseurs', shortLabel: 'Achats',
        description: 'Fournisseurs, commandes, réceptions et dépenses',
        path: '/app/business/suppliers', icon: Truck,
      },
      {
        key: 'storefront', label: 'Vitrine commerciale', shortLabel: 'Vitrine',
        description: 'Catalogue partageable et demandes de commande',
        path: '/app/business/storefront', icon: Store,
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    items: [
      {
        key: 'finance', label: 'Finance', shortLabel: 'Finance',
        description: 'Créances, paiements, soldes et échéances',
        path: '/app/business/finance', icon: Wallet,
      },
      {
        key: 'recouvrement', label: 'Recouvrement', shortLabel: 'Recouvrement',
        description: 'Priorités, promesses, litiges et risques',
        path: '/app/business/recouvrement', icon: BellRing,
      },
      {
        key: 'cash', label: 'Trésorerie et dépenses', shortLabel: 'Trésorerie',
        description: 'Encaissements réels, dépenses et solde',
        path: '/app/business/cash', icon: Landmark,
      },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    items: [
      {
        key: 'automation', label: 'Automatisations', shortLabel: 'Automatisations',
        description: 'Signaux, règles et actions confirmées',
        path: '/app/business/automation', icon: Workflow,
      },
      {
        key: 'marketing', label: 'Marketing et fidélisation', shortLabel: 'Marketing',
        description: 'Segments, campagnes et messages préparés',
        path: '/app/business/marketing', icon: Megaphone,
      },
      {
        key: 'assistant', label: 'Assistant IA', shortLabel: 'Assistant',
        description: 'Conversation reliée au CRM et aux finances',
        path: '/app/business/assistant', icon: Brain,
      },
    ],
  },
  {
    id: 'settings',
    label: 'Configuration',
    items: [
      {
        key: 'company', label: 'Contexte entreprise', shortLabel: 'Entreprise',
        description: 'Activité, offre et priorités',
        path: '/app/business/company', icon: Building2,
      },
      {
        key: 'memory', label: 'Mémoire métier', shortLabel: 'Mémoire',
        description: 'Faits consentis utilisés par l’assistant',
        path: '/app/business/memory', icon: Brain,
      },
      {
        key: 'providers', label: 'Services IA', shortLabel: 'Services IA',
        description: 'Fournisseurs vérifiés et routage',
        path: '/app/business/providers', icon: Zap,
      },
      {
        key: 'ai', label: 'Contrôle IA', shortLabel: 'Contrôle IA',
        description: 'Mémoire de l’agent et consentement',
        path: '/app/business/ai', icon: Shield,
      },
      {
        key: 'integrations', label: 'Intégrations', shortLabel: 'Intégrations',
        description: 'Connecteurs et autorisations',
        path: '/app/business/integrations', icon: Plug,
      },
    ],
  },
];

export const GROWTH_OS_MODULES: readonly GrowthOsNavItem[] = GROWTH_OS_NAV.flatMap((group) => group.items);

export function growthOsModule(key: GrowthOsModule): GrowthOsNavItem {
  return GROWTH_OS_MODULES.find((item) => item.key === key) ?? GROWTH_OS_MODULES[0];
}

/** Résout le module depuis l'URL réelle, avec repli honnête sur la vue générale. */
export function growthOsModuleFromPath(pathname: string): GrowthOsModule {
  const rest = pathname.replace(/^\/app\/business\/?/, '').replace(/\/+$/, '');
  const segment = rest.split('/')[0] ?? '';
  const match = GROWTH_OS_MODULES.find((item) => item.key === segment);
  return match?.key ?? 'overview';
}

/** Anciennes URL (`?section=...&growthTab=...`) redirigées vers les nouveaux modules. */
export function legacyGrowthOsPath(section: string | null, growthTab: string | null): string | null {
  if (section === 'chat') return '/app/business/assistant';
  if (section === 'company') return '/app/business/company';
  if (section === 'memory') return '/app/business/memory';
  if (section === 'providers') return '/app/business/providers';
  if (section === 'integrations') return '/app/business/integrations';
  if (section === 'ai') return '/app/business/ai';
  if (section === 'growth') {
    if (growthTab === 'relations') return '/app/business/crm';
    if (growthTab === 'finance') return '/app/business/finance';
    return '/app/business/reports';
  }
  return null;
}
