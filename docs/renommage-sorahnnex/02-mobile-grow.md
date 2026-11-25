# ÉTAPE 2 — Expérience mobile Android de SORAHNEX Grow

Statut : **corrections structurelles appliquées et testées** ; validation sur
appareil réel non effectuée (pas de navigateur connecté dans cette session).

## 1. Audit — défauts réels constatés dans le code

| # | Défaut | Preuve | Portée |
| --- | --- | --- | --- |
| 1 | Tiroir mobile **non défilable** : contenu en `h-full` sans `overflow-y-auto`. Avec 7 groupes de navigation Grow, les derniers liens sortaient de l'écran et devenaient inaccessibles. | `src/components/Layout.tsx` (drawer) | Grow + Studio |
| 2 | **Défilement de la page derrière le tiroir** : aucun verrou de `body`, Android faisait défiler le contenu sous le panneau. | `src/components/Layout.tsx` | Grow + Studio |
| 3 | Aucune fermeture au clavier (`Escape`), ni `role="dialog"` / `aria-modal` : panneau traité comme du contenu ordinaire. | `src/components/Layout.tsx` | Grow + Studio |
| 4 | **Libellés de la barre du bas tronqués au premier mot** : `label.split(' ')[0]` produisait « Vue » (« Vue d'ensemble ») et « Smart » (« Smart CRM ») — deux onglets ambigus et sans sens. | `src/components/Layout.tsx:353` (avant) | Grow + Studio |
| 5 | **Navigation Grow mobile incomplète** : 4 entrées seulement (`Vue d'ensemble`, `Assistant`, `Smart CRM`, `Modules`) ; les sections Croissance, Entreprise, Mémoire, Services IA, Contrôle IA, Intégrations n'étaient atteignables que par le tiroir, sans entrée « Plus ». | `src/navigation/config.ts:529` (avant) | Grow |
| 6 | **Cibles tactiles < 44 px** sur les deux sélecteurs de section Grow (`px-3 py-2` ≈ 36 px, `py-2.5` ≈ 40 px) : erreurs de tap sur Android. | `src/business/growth/GrowthWorkspace.tsx:344`, `src/business/BusinessGrowWorkspace.tsx:2509` | Grow |
| 7 | Aucun garde-fou horizontal sur la coque applicative : une carte ou un tableau large pouvait faire défiler **toute la page** latéralement. | `src/components/Layout.tsx` (racine) | Tout l'app |

Constats inverses (déjà corrects, non modifiés) : `viewport-fit=cover` présent,
`.safe-bottom` en `env(safe-area-inset-bottom)`, `<main>` en `pb-28` sous la
barre fixe, `.table-wrap { overflow-x-auto }` + `.table { min-w-[640px] }` sur
tous les tableaux de page, et les tableaux de l'importateur déjà encadrés par un
conteneur `overflow-x-auto`.

## 2. Corrections appliquées

1. **Tiroir** : `overflow-y-auto overscroll-contain` + `safe-bottom`,
   `max-w-full`, `role="dialog"`, `aria-modal="true"`, `aria-label`, bouton de
   fermeture nommé.
2. **Verrou de défilement** au montage du tiroir, restauré à la fermeture
   (valeur précédente conservée, pas écrasée).
3. **Fermeture par `Escape`** via un écouteur clavier monté uniquement quand le
   tiroir est ouvert.
4. **Barre du bas** : libellé explicite `shortLabel` par entrée, plus aucune
   découpe de chaîne. Chaque entrée a une largeur `flex-1 min-w-0` et un libellé
   `truncate` centré.
5. **Nouvelle navigation Grow mobile (5 entrées)** :
   `Accueil · Activité · Prospects · Assistant · Plus` — « Plus » est un bouton
   (`aria-haspopup="dialog"`) qui ouvre le tiroir complet, au lieu d'un lien
   factice. Les entrées pointent vers des routes existantes :
   `/app/business`, `?section=growth&growthTab=overview`,
   `?section=growth&growthTab=crm`, `?section=chat`.
6. **Cibles tactiles** : `min-h-11` (44 px) sur les sélecteurs de section Grow et
   sur les onglets Growth OS.
7. **Garde horizontal** : `overflow-x-hidden` sur la racine de la coque ; les
   zones réellement larges (tableaux) gardent leur propre défilement interne.

## 3. Vérification

| Contrôle | Résultat |
| --- | --- |
| `npm run typecheck` | **succès** |
| `npm run build` | **succès** |
| `tests/layout-notifications.test.tsx`, `tests/growth-workspace.test.tsx`, `tests/business-grow.test.tsx`, `tests/business-modules.test.tsx`, `tests/brand-visible-sorahnnex.test.ts` | **87/87 succès** |

**Non vérifié** : rendu réel sur 360×640, 390×844, 412×915 et en paysage, tenue
du clavier virtuel dans le composeur de l'assistant, et défilement du tiroir sur
appareil. Ces contrôles demandent un navigateur et une session authentifiée.

## 4. Reste à faire sur cette étape

- Vérifier le composeur de chat Grow quand le clavier virtuel est ouvert
  (hauteur visible et `scrollIntoView` du dernier message).
- Contrôler visuellement les tableaux de l'administrateur sur 360 px (ils
  défilent dans `.table-wrap`, mais l'alignement des colonnes reste à valider).
- Décider si `Activité` doit pointer vers `growthTab=overview` ou vers un futur
  onglet « Ventes » dédié : aucune vue « ventes » n'existe aujourd'hui côté Grow,
  donc l'entrée réutilise la vue d'ensemble plutôt que d'inventer un écran.
