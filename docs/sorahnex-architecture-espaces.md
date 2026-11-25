# SORAHNEX — architecture des espaces, navigation et responsive

Ce document décrit l'organisation de l'application telle qu'elle est
implémentée dans cette branche, les raisons des choix, et ce qui reste à faire.
Il ne décrit pas une intention : chaque point est relié au fichier qui le porte.

---

## 1. Diagnostic de l'existant

Mesures relevées avant modification :

| Constat | Chiffre |
| --- | --- |
| Groupes de navigation Studio | 10 groupes pour 17 destinations |
| Groupes de navigation Grow | 6 groupes pour 21 modules dans `os/modules.ts` |
| Sources de navigation Grow | **2**, en divergence (`navigation/config.ts` et `business/os/modules.ts`) |
| Barre de navigation mobile Grow | 5 entrées, dont un tiroir |
| Barre de navigation mobile Studio | 4 entrées, sans accès au tiroir |
| Barre collante du Growth OS | `top-0` sous un en-tête global de 64 px : elle passait **derrière** lui |
| Navigation latérale Grow | visible à partir de 1024 px seulement : les tablettes (768–1023 px) n'avaient que le menu mobile |
| Retour arrière | position de défilement perdue |
| Changement d'espace | un lien texte « Tous les espaces » puis un choix, sans indication de l'espace courant |

Les trois problèmes réels n'étaient donc pas esthétiques :

1. **deux sources de vérité** pour la navigation métier, qui divergent à chaque
   ajout de module ;
2. **pas de repère d'espace** permanent : l'utilisateur devait se souvenir s'il
   était dans Studio ou dans Grow ;
3. **défilement et barres collantes** qui se chevauchent, et position perdue au
   retour.

---

## 2. Architecture cible

### 2.1 Deux espaces, un sélecteur

```
SORAHNEX
├── Sélecteur d'espace (permanent)          « Studio » · « Grow » · grille
│
├── SORAHNEX Studio — créer et produire
│   ├── Pilotage        Tableau de bord · Assistant · Historique
│   ├── Créer           Générer · Montage · Génération simplifiée · Options avancées
│   ├── Contenus        Scripts · Prompts · Avatars · Réglages vidéo
│   ├── Bibliothèque    Projets · Créations · Fichiers
│   └── Compte          Abonnement · Crédits · Paramètres
│
├── SORAHNEX Grow — piloter et encaisser
│   ├── Pilotage        Vue générale · Rapports
│   ├── Clients et ventes  CRM · Pipeline · Ventes · Relances · Tâches
│   ├── Opérations      Produits et stock · Achats · Vitrine
│   ├── Finance         Finance · Trésorerie · Recouvrement
│   ├── Croissance et IA  Assistant · Automatisations · Marketing
│   └── Réglages        Entreprise · Mémoire · Services IA · Contrôle IA · Intégrations
│
└── Administration (propriétaire, hors sélecteur)
```

Le regroupement suit **l'intention**, pas la technique : « Produits et stock »
n'est pas dans « Finance » parce qu'il produit de la valeur, et « Ventes » est
avec « Clients » parce qu'une vente est la suite d'un prospect. Un utilisateur
qui cherche « où je gagne de l'argent » trouve le groupe Ventes ; un utilisateur
qui cherche « où j'encaisse » trouve Finance.

### 2.2 Une seule source de navigation métier

`src/business/os/modules.ts` (`GROWTH_OS_NAV`) est désormais l'unique définition
des modules métier. `src/navigation/config.ts` en dérive `BUSINESS_NAV_GROUPS`
au lieu de dupliquer la liste. Ajouter un module à un seul endroit suffit, et le
test `tests/sorahnex-spaces.test.ts` vérifie que chaque module apparaît
exactement une fois dans la navigation globale.

### 2.3 Repères permanents

| Composant | Rôle |
| --- | --- |
| `SpaceSwitcher` | Deux boutons `Studio` / `Grow` + accès au sélecteur général. L'espace courant est marqué `aria-current` et coloré (cyan = Studio, violet = Grow) |
| `WorkspaceDock` | Rappelle le nom complet de l'espace et propose son accueil |
| En-tête de module | `SORAHNEX Grow · <module>` + titre + description |
| Barre basse | Quatre destinations réelles + « Plus » qui ouvre le tiroir |

Le passage d'un espace à l'autre se fait en un clic, depuis l'en-tête, la
barre latérale ou le tiroir mobile. Aucun état n'est perdu : les filtres et le
travail en cours restent dans les URL.

### 2.4 Fonctionnalités secondaires

Elles ne disparaissent pas, elles sortent du chemin :

- Studio : les interfaces historiques (`/app/studio/classique`,
  `/app/studio/avance`) restent dans « Créer », nommées pour ce qu'elles sont ;
- Grow : le catalogue complet reste accessible par « Modules métier » et par la
  recherche de la barre latérale ;
- mobile : tout ce qui n'est pas dans la barre basse est dans « Plus ».

Aucune fonctionnalité n'a été supprimée.

---

## 3. Correspondance ancienne → nouvelle navigation

### Studio

| Destination | Ancien groupe | Nouveau groupe |
| --- | --- | --- |
| Tableau de bord | Vue d'ensemble | Pilotage |
| Assistant SORAHNEX | Assistant IA | Pilotage |
| Historique | Historique | Pilotage |
| Créer une vidéo | Création et génération | Créer |
| Montage vidéo | Production vidéo | Créer |
| Génération simplifiée | Création et génération | Créer |
| Options avancées | Création et génération | Créer |
| Scripts IA | Scripts et contenus | Contenus |
| Prompts | Scripts et contenus | Contenus |
| Avatars IA | Avatars et personnages IA | Contenus |
| Réglages vidéo | Production vidéo | Contenus |
| Projets | Projets et bibliothèque | Bibliothèque |
| Créations enregistrées | Projets et bibliothèque | Bibliothèque |
| Fichiers et médias | Projets et bibliothèque | Bibliothèque |
| Abonnement Studio | Crédits et paramètres | Compte |
| Crédits Studio | Crédits et paramètres | Compte |
| Paramètres | Crédits et paramètres | Compte |

### Grow

| Ancien groupe | Nouveau groupe |
| --- | --- |
| Pilotage (Vue, Rapports) | Pilotage |
| Commercial (CRM, Pipeline, Tâches, Relances) | Clients et ventes |
| Commercial (Ventes et facturation) | Clients et ventes |
| Catalogue (Produits, Achats, Vitrine) | Opérations |
| Finance (Finance, Recouvrement) | Finance |
| Finance (Trésorerie) | Finance |
| Intelligence (Assistant, Automatisations, Marketing) | Croissance et IA |
| Configuration (Entreprise, Mémoire, Services IA, Contrôle IA, Intégrations) | Réglages |

Les URL ne changent pas : `/app/business/crm` reste `/app/business/crm`. Aucun
lien existant, favori ou notification ne casse.

---

## 4. Défilement

Règles appliquées :

1. **Un seul conteneur défile** : la fenêtre. Aucune zone `overflow-y: auto`
   plein écran n'englobe le contenu des pages.
2. **Navigation vers le haut** : changer de page ou d'espace ouvre le nouvel
   écran en haut (`useScrollRestoration`).
3. **Retour arrière restauré** : revenir sur une liste retrouve la position
   exacte, mémorisée par entrée d'historique et non par URL.
4. **Barres collantes sous l'en-tête** : la barre mobile du Growth OS est
   collée à `top-16`, donc sous l'en-tête global de 64 px, avec `z-20` pour
   rester sous les menus (`z-30`/`z-50`).
5. **Barre latérale limitée à la fenêtre** : `max-height: calc(100vh - 5.5rem)`
   et défilement propre, sans dépasser sous le bas de l'écran.
6. **Pas de scroll horizontal de page** : les rangées d'actions rapides et les
   tableaux défilent dans leur propre conteneur, jamais le document.

Le crochet est dans `src/hooks/useScrollRestoration.ts`, appelé une fois par
`src/components/Layout.tsx`.

---

## 5. Responsive : trois contextes, pas trois CSS

| Contexte | Largeur | Navigation | Contenu |
| --- | --- | --- | --- |
| Téléphone | < 768 px | Barre basse 4 + « Plus » ; tiroir plein écran ancré à gauche, verrou de défilement, fermeture par Échap | Une colonne, marges de safe-area, cibles ≥ 44 px |
| Tablette | 768–1023 px | Barre latérale visible (`md:grid-cols-[212px_…]`) | Deux colonnes de cartes, tableaux défilants |
| Ordinateur | ≥ 1024 px | Barre latérale 230 px + dock | Contenu jusqu'à 1400 px, grilles multi-colonnes |

Décisions concrètes :

- la barre latérale Grow apparaît à 768 px et non à 1024 px : sur une tablette
  en paysage, cacher la navigation était le vrai défaut ;
- le tiroir mobile est ancré **à gauche** et borné à `min(86vw, 320px)` : il ne
  déborde plus vers la droite ;
- `padding-bottom` du contenu tient compte de la barre basse et de
  `env(safe-area-inset-bottom)` ;
- les champs et boutons de navigation font au moins 44 px de haut sur mobile
  (`min-h-11`/`min-h-12`), y compris la recherche et le bouton « Tout déplier » ;
- le tiroir et le menu Growth OS se ferment au changement d'écran et par Échap,
  ce qui compte au clavier Android.

---

## 6. Refonte de SORAHNEX Grow

### Ce qui change

- **Navigation par objectif** (voir §2), avec 21 modules répartis en 6 groupes
  au lieu de 6 groupes hétérogènes.
- **Actions rapides** dans l'en-tête : Prospect, Vente, Encaissement, Assistant.
  Elles pointent vers des écrans existants ; aucune mutation n'est déclenchée
  depuis ce bandeau.
- **En-tête de module** explicite : espace, module, description.
- **Sélecteur d'espace** dans la barre latérale et dans le tiroir.
- **Barre latérale visible sur tablette**, avec défilement interne maîtrisé.
- **Barre mobile corrigée** (position, hauteur, fermeture).
- **Regroupement du catalogue** : « Modules métier » reste une entrée dédiée,
  pour ne pas confondre le catalogue complet avec les six groupes d'usage.

### Ce qui ne change pas

- les URL et les écrans métier : aucune page n'a été supprimée ou déplacée ;
- les données, les permissions et les appels backend ;
- le nom fonctionnel de l'espace dans les messages métier ;
- les parcours de paiement et d'abonnement.

### Ce qui reste à faire

- refonte écran par écran des tableaux métier (colonnes prioritaires sur mobile,
  filtres repliables) : les écrans existent et fonctionnent, ils n'ont pas été
  réécrits dans cette PR ;
- tableau de bord : hiérarchiser les indicateurs selon l'activité réelle de
  l'utilisateur plutôt que selon un ordre fixe ;
- formulaires longs : découpage en étapes sur téléphone.

Aucune de ces trois refontes n'est nécessaire pour que la navigation actuelle
soit cohérente ; elles demandent une validation produit écran par écran.

---

## 7. Tests

`tests/sorahnex-spaces.test.ts` vérifie :

- cinq groupes Studio au maximum, sans destination dupliquée ;
- toutes les destinations Studio pointent vers une route déclarée dans
  `src/App.tsx` ;
- les 17 fonctionnalités Studio historiques restent accessibles ;
- chaque module Grow apparaît exactement une fois dans la navigation globale ;
- six groupes Grow, clés et URL uniques ;
- les actions rapides pointent vers des modules réels ;
- les barres mobiles tiennent en cinq entrées avec un seul tiroir ;
- aucune marque héritée dans les libellés de navigation ni dans la coquille
  Grow ;
- l'identité technique reste en mode `legacy` tant que le déploiement n'a pas
  basculé, et chaque nom cible est unique.

Ce que ces tests ne prouvent pas : le rendu visuel. Aucune capture d'écran ni
inspection de navigateur n'a été effectuée dans cette phase ; le rendu doit être
vérifié en prévisualisation sur un téléphone, une tablette et un ordinateur.
