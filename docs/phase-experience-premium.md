# VYORA — Phase « expérience premium » : ce qui a été livré et ce qui reste

> État au 2026-11-14, branche de session issue de `develop`.
> Chaque section indique le fichier concerné et le comportement préservé.

---

## 0. Audit de l'architecture (avant modification)

| Élément | Constat |
|---|---|
| Stack | React 18 + Vite 6 + Tailwind 3 + TypeScript, react-three/fiber déjà présent |
| Backend | Supabase (Auth + PostgreSQL schéma `saas_ugc` / `saas_business`) + Edge Functions Deno |
| Routes protégées | `/app/*` derrière `ProtectedRoute`, `/admin` derrière `AdminRoute` (vérifié côté serveur) |
| **Espace 1 — Studio UGC** | `/app/studio*`, `/app/projets`, `/app/scripts`, `/app/prompts`, `/app/presets`, `/app/avatars`, `/app/bibliotheque`, `/app/historique`, `/app/credits`, `/app/abonnement` |
| **Espace 2 — Business Growth** | `/app/business*` (sections assistant, croissance, entreprise, mémoire, services IA, contrôle IA, intégrations), `/app/business/modules/*` (13 modules), `/app/business/abonnement` |
| Sélecteur | `/app` (`Home`) : choix entre les deux espaces |
| Administrateur | `/admin` (console propriétaire, hors espaces client) |
| Isolation | crédits Studio jamais lus/débités par Business Growth ; RLS par workspace ; admin sans workspace client |
| Moteur IA | `supabase/functions/_shared/ai-core/` : 7 adaptateurs, routeur, registre, mémoire, budgets |
| Composants réutilisables préexistants | `Button`, `Card`, `StatCard`, `Badge`, `Modal`, `EmptyState`, `Reveal`, `BrandLockup`, `HeroScene` |
| Tests | 75 fichiers / 1146 tests verts au démarrage de la phase |

**Aucune règle d'accès n'a été modifiée.** `ProtectedRoute` et `AdminRoute` sont
inchangés ; les redirections (`isAdmin` → `/admin`, `from` → `/app`) sont identiques.

---

## 1. Design system premium (livré)

| Fichier | Contenu |
|---|---|
| `src/index.css` | couche additive `vy-*` : surfaces, halos, boutons animés, champs, tuiles d'icônes, styles d'authentification, `prefers-reduced-motion` |
| `src/components/ui-premium.tsx` | `WorkspaceCard`, `FeatureCard`, `SectionHeader`, `MetricPill` |
| `src/components/WorkspaceDock.tsx` | barre d'identité d'espace (nom, univers, sorties) |

Principes :

- **Variables CSS par espace** : `--vy-accent` cyan en Studio, violet en Business
  Growth ; appliquées via `data-vy-scope` sur la racine de `Layout`, donc héritées par
  toute la page sans toucher aux composants existants.
- **Animations sobres** : uniquement `opacity` / `transform` / `filter`. Aucune
  animation ne conditionne la visibilité d'un contenu.
- **Accessibilité** : `prefers-reduced-motion` neutralise reflets, secousses et
  révélations ; focus visibles conservés ; cibles tactiles ≥ 44 px.
- **Aucune régression** : les classes historiques (`btn`, `card`, `input`, `badge`…)
  restent intactes ; les nouveaux styles sont préfixés.

---

## 2. Parcours d'authentification immersif (livré)

| Fichier | Rôle |
|---|---|
| `src/components/auth/AuthScene.tsx` | scène 3D (noyau distordu, deux anneaux orbitaux, particules) |
| `src/components/auth/useSceneCapability.ts` | détection WebGL / mouvement réduit / `saveData` / mémoire faible |
| `src/components/auth/AuthStage.tsx` | panneau visuel + repli CSS de même structure |
| `src/components/auth/AuthForm.tsx` | champs, messages, bouton à états, étapes, jauge de mot de passe |
| `src/components/AuthShell.tsx` | coquille (API publique inchangée + `variant`) |
| `src/pages/Login.tsx` | connexion immersive |
| `src/pages/Signup.tsx` | inscription en 3 étapes |
| `src/pages/ForgotPassword.tsx` | récupération d'accès |

**Performance de la 3D** : chunk `three.js` chargé en lazy, `dpr` plafonné à 1.5,
aucune ombre ni post-traitement, rendu mis en pause quand l'onglet est masqué,
parallaxe indépendante du framerate. Si WebGL manque, si le mouvement est réduit, si
`saveData` est actif ou si la mémoire est faible → **repli CSS** (anneaux + noyau), de
même structure : rien ne casse, rien ne clignote.

**Comportements préservés** (vérifiés par les tests existants) :

- messages de validation historiques au mot près ;
- `signIn` puis `bootstrap`, redirection `from` → `/app`, admin → `/admin` ;
- inscription : nom, e-mail, 8 caractères minimum, correspondance, conditions ;
- réinitialisation : message neutre (aucune divulgation de l'existence d'un compte).

**Ajouts** : états de saisie (valide/invalide), œil d'affichage du mot de passe,
jauge de robustesse **indicative** (la règle serveur reste 8 caractères), bouton à
trois états (repos / chargement / réussite avec coche dessinée), transitions entre
étapes, secousse discrète sur erreur de validation.

---

## 3. Accueil personnalisé (livré)

| Fichier | Rôle |
|---|---|
| `src/lib/welcome.ts` | banque de messages + extraction du prénom (pur, testé) |
| `src/pages/Home.tsx` | accueil premium : message, raccourcis, deux cartes d'espace |

Règles tenues :

- **Jamais de nom inventé** : le prénom ne vient que de `profile.display_name`.
  Un e-mail (`awa.traore@…`) n'est **pas** utilisé comme prénom ; un identifiant
  technique non plus. Sans nom exploitable → salutation sans prénom.
- Messages **variés mais stables** pendant la session (hash déterministe
  utilisateur + jour), différents entre première visite et retour.
- Aucune donnée chiffrée affichée si elle n'est pas réellement chargée (les crédits
  affichent « — » tant que le quota n'est pas disponible).

---

## 4. Séparation des deux espaces (livré)

- **Identité chromatique** : cyan (Studio) / violet (Business Growth), héritée par les
  cartes, boutons d'accent, champs et tuiles via variables CSS.
- **Barre d'espace** (`WorkspaceDock`) : nom de l'espace, univers, tableau de bord et
  retour au sélecteur — visible dans la barre latérale et le tiroir mobile.
- **Liseré latéral** cyan/violet sur la barre latérale.
- **Page d'entrée** (`/app`) refondue : message d'accueil, métriques réelles, deux
  cartes d'univers distinctes, raccourcis propres à chaque espace.
- **Tableau de bord Studio** : catalogue complet des fonctionnalités organisé en trois
  catégories (Créer et générer · Produire et publier · Piloter et financer).

**Permissions inchangées** : `ProtectedRoute`, `AdminRoute`, RLS et quotas n'ont pas
été touchés. Aucun bouton décoratif : chaque carte pointe vers une route réellement
implémentée.

---

## 5. Moteur IA multi-fournisseurs (préparé)

| Livrable | Fichier |
|---|---|
| Fiche de renseignement par fournisseur | `docs/moteur-ia-fournisseurs.md` |
| Architecture, routage, sécurité, procédure d'ajout | `docs/architecture-moteur-ia.md` |

Aucun endpoint, modèle ou tarif n'a été inventé : le document distingue explicitement
ce qui est **vérifié en production** (Groq, Gemini), ce qui est **écrit mais non
vérifié** (Mistral, DeepSeek, OpenRouter, Cloudflare, xAI) et ce qui **reste à
renseigner** par vos soins. Les clés ne sont jamais demandées dans Git : seuls les
**noms de variables** figurent dans la documentation, avec la procédure Supabase Secrets.

---

## 6. Reste à faire (proposé, non commencé)

| Étape | Contenu | Dépend de |
|---|---|---|
| A | Appliquer `AuthShell` `variant` aux écrans propriétaire (`/proprietaire*`) | — |
| B | Refonte visuelle de l'intérieur Business Growth (sections, cartes, en-têtes) | — |
| C | Refonte visuelle de l'intérieur Studio (générateur, catalogue, montage) | — |
| D | Catalogue de fonctionnalités Business (page d'accueil des modules par catégorie) | — |
| E | Intégration des fournisseurs IA au fur et à mesure des fiches reçues | vos informations |
| F | Captures d'écran de validation (ordinateur / tablette / mobile) | navigateur disponible |

**Aucune fusion vers `main`, aucun déploiement Netlify** n'a été déclenché : la
livraison s'arrête à `develop`, comme demandé.
