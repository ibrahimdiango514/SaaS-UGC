# ÉTAPE 0 — Inventaire, point de restauration et plan de migration SORAHNEX

Statut : **audit terminé, aucune modification de code effectuée**. Aucun renommage
n'a été appliqué, aucun push, aucun déploiement.

---

## 1. État Git réel et point de restauration

| Élément | Valeur constatée |
| --- | --- |
| `HEAD` local | `318adca` — `feat(muapi): adaptateur runtime pour sorties texte déclarées (#44)` |
| Branche courante | `freebuff/muapi-reprise` |
| Commit annoncé `ec8d46d` | **absent de ce clone** (`fatal: Not a valid object name`) |
| `origin` | `https://github.com/ibrahimdiango514/SaaS-UGC.git` |
| `origin/develop` après `fetch` | `af11226` — *Merge PR #30* |
| Divergence | `318adca` est **13 commits devant** et **46 derrière** `develop` ; ancêtre commun absent (`ancestor=no`) |
| Travail non commité | **76 entrées** (`lot 17` et `lot 18` : Studio universel, JSON borné, MCP/actions externes, tests) |

Point de restauration créé (local, non poussé) :

```
backup/pre-sorahnnex-318adca   → 318adca202f0…  (HEAD, code commité)
backup/pre-sorahnnex-worktree  → 8835e62e09d2…  (stash commit de l'état de travail)
```

Restauration :

```bash
git checkout backup/pre-sorahnnex-318adca            # code commité
git stash apply 8835e62e09d2d38cc9528b8fa3d8898d8b6f959c   # travail non commité
# ou : git tag -l 'backup/pre-sorahnnex-*'
```

Un second point de restauration hors Git est disponible en copiant
`supabase/migrations/`, `netlify.toml`, `supabase/config.toml` et
`public/brand/` avant la première modification (fait au début de l'étape 1).

> **Blocage de vérification** : le commit de production annoncé `ec8d46d`
> n'existe pas dans ce dépôt. Il faut confirmer la base de départ avant de
> créer la branche de renommage, sinon la PR sera divergente.

---

## 2. Volumétrie des références de marque

Recherche insensible à la casse, hors `node_modules` et `.git`.

| Zone | Fichiers | Occurrences |
| --- | ---: | ---: |
| `src/` (frontend) | 150 | 748 |
| `supabase/functions/` | 90 | 713 |
| `supabase/migrations/` | 88 | 1 560 |
| `docs/` | 69 | 734 |
| `tests/` | 115 | 873 |
| `scripts/` | 19 | 119 |
| `netlify/` | 3 | 8 |
| **Total dépôt** | **531 fichiers SORAHNEX** | **4 476** |
| | **211 fichiers SORAHNEX** | **1 400** |

La migration SQL représente à elle seule 1 560 occurrences : ce sont des
**identifiants historiques appliqués en production**, pas des textes d'interface.

---

## 3. Matrice de décision — ce qui se renomme, ce qui ne se renomme pas

| Surface | Exemples constatés | Décision |
| --- | --- | --- |
| Textes d'interface | `SORAHNEX`, `Sorahnnex`, libellés, `aria-label`, titres de pages | **Renommer immédiatement** (SORAHNEX / SORAHNEX Studio / SORAHNEX Grow) |
| Composant de marque | `src/components/Brand.tsx` (`BrandLockup`, `BrandSymbol`) | **Renommer le contenu**, conserver les noms d'export |
| `index.html` | `<title>SORAHNEX — Create. Evolve. Grow.</title>`, `theme-color` | **Renommer** |
| Assets publics | `public/vyora-mark.svg`, `public/brand/vyora-*.jpg` | **Renommer les fichiers + références** (aucune URL publique figée dans un contrat) |
| Documentation | `docs/git-flow-vyora.md` et 50 autres | **Renommer le contenu** ; les noms de fichiers peuvent rester (liens à vérifier) |
| `package.json` | `"name": "vyora"` | **Renommer** (`sorahnnex`) — sans impact runtime |
| Nom Netlify / `SITE_NAME` | `vyora-saas-ugc`, `VYORA_BUILD_ENABLED` | **Ne pas renommer dans cette étape** : garde de build, URL publique, callbacks OAuth. Nécessite un plan de bascule (nom, DNS, variable). |
| `SITE_ID` Netlify | `fc88d197-fe0b-47c7-a6e3-fba44eeccda9` | **Jamais renommer** (identifiant immuable) |
| Projet Supabase | `project_id = xbuuhfwobrafcbgtdgjx` | **Jamais renommer** ; seul le nom d'affichage du tableau de bord peut changer |
| Bucket Storage | `ugc-assets` | **Conserver** (chemins de fichiers existants) |
| Edge Functions déployées | `vyora-ai`, `vyora-mcp`, `reelora-video`, `reelora-ai`, `business-grow`, `store-connect`, `store-import`… | **Conserver les slugs** : le renommage exige un déploiement double + réécriture des appelants. Alias `sorahnnex-*` en phase ultérieure. |
| En-têtes internes | `x-vyora-cron`, `x-reelora-worker-token` | **Conserver** (contrats entre cron/worker et fonctions) |
| Fonctions SQL | **231** fonctions `public.reelora_*` / `ugc_private.*` | **Conserver**. Les migrations sont appliquées ; un renommage casserait RPC, MCP, frontend et tests. |
| Outils MCP exposés | `vyora_account_info`, `vyora_stores_list`, `vyora_products_list`… | **Conserver les noms de tools** (contrat pour les agents déjà connectés) ; renommer les **titres/descriptions** affichés. |
| OAuth | `resource_name: 'SORAHNEX MCP'` | **Renommer** (métadonnée affichée, pas un identifiant) |
| Secrets / variables | `VYORA_SASPAY_SECRET_KEY`, `VYORA_PAYMENTS_ALLOWED_ORIGINS` | **Conserver** (secrets existants) ; documenter de futurs alias. |
| Dépôt GitHub | `ibrahimdiango514/SaaS-UGC` | **Action externe** : renommage côté GitHub, hors dépôt ; à planifier avec les URLs de clone. |
| Redirection Netlify | `/api/reelora-video` | **Conserver** tant que la fonction `reelora-video` est déployée sous ce nom. |
| Migrations historiques | contenu de `supabase/migrations/*.sql` | **Ne jamais réécrire** : elles sont appliquées. Toute évolution passe par une nouvelle migration. |

Règle appliquée : *on ne renomme un identifiant que si aucun contrat externe
(fichier existant, jeton, URL, agent connecté, migration appliquée) ne le
référence.*

---

## 4. Inventaire fonctionnel et état constaté

| Domaine | Emplacement réel | État constaté |
| --- | --- | --- |
| Studio universel | `src/studio/UniversalStudio.tsx`, `supabase/functions/studio-runtime/` | Préparé : 812 configurations / 867, **0 opérationnel** (clé fournisseur absente, quotas non arbitrés). Testé hors ligne, pas de génération réelle. |
| Studio classique / montage | `src/studio/GenerationStudio.tsx`, `VideoStudio.tsx`, `VideoEditor.tsx` | Présent, tests unitaires ; **non revalidé** dans cette mission. |
| Grow | `src/business/*`, `supabase/functions/business-grow/` | Présent, 16 modules (`src/business/modules/registry.ts`), agent IA et rapports. Mobile à corriger (étape 2). |
| Assistant IA | `src/pages/Assistant.tsx`, `vyora-ai`, `reelora-ai` | Présent ; dépend de clés fournisseurs. |
| Paiements | `vyora-payments`, `vyora-saspay`, `vyora-payments-reconcile` | Présent, tests ; secrets externes requis. |
| MCP serveur | `supabase/functions/vyora-mcp/` (828 lignes), `core.ts`, `oauth.ts`, `consentement.ts` | **Réel** : 12+ outils lecture et outils écriture conditionnés, OAuth avec consentement, portées. Parcours utilisateur existant : `src/pages/McpConnections.tsx`, `MesServeursMcp`. |
| Client MCP | `supabase/functions/mcp-client/` | Présent (OAuth, ingestion de serveurs externes). |
| Connexion boutiques | `store-connect` (PrestaShop, Chariow), `store-import` (Shopify/Woo en lecture publique) | **Cause probable de l'échec de connexion** : seuls PrestaShop et Chariow ont un parcours authentifié ; Shopify/Woo n'ont pas de connexion, seulement une lecture anonyme du catalogue public ; les autres plateformes sont déclarées mais non fonctionnelles (`docs/audit-connexions-boutiques.md`). |
| Admin | `src/pages/Admin.tsx`, `src/pages/admin/*` | Présent, écrans de quotas/prix/portefeuille. |
| Migrations | `supabase/migrations/` — 109 fichiers | Historique complet, non réappliqué ici. |
| Tests | 218 fichiers, 3 379 tests | Dernière exécution complète : **3 377 réussis, 2 ignorés, 0 échec**. |

---

## 5. Risques de casse identifiés

| Risque | Déclencheur | Parade |
| --- | --- | --- |
| RPC introuvable | renommage d'une fonction SQL `reelora_*` | interdiction de renommage ; alias SQL seulement si nécessaire |
| Worker/cron rejeté | changement de `x-reelora-worker-token` / `x-vyora-cron` | conserver, ou accepter les deux en-têtes pendant la transition |
| MCP cassé pour les agents connectés | renommage des outils `vyora_*` | conserver les `name`, changer `title`/`description` |
| Build Netlify annulé | renommage `SITE_NAME`/`SITE_ID`/`VYORA_BUILD_ENABLED` | bascule planifiée, variable et garde mises à jour ensemble |
| OAuth invalidé | changement d'origine/URL de callback | décision de domaine avant toute bascule |
| Fichiers 404 | renommage des assets `public/brand/vyora-*` | mettre à jour toutes les références dans le même commit |
| Import boutiques | changement des slugs d'Edge Functions | déploiement double + réécriture des appelants |
| Perte du travail lot 17-18 | nettoyage du worktree | tags `backup/pre-sorahnnex-*` |

---

## 6. Plan d'exécution

### Phase 1A — Marque visible (sans risque de contrat)
1. `src/components/Brand.tsx` : SORAHNEX + baseline « Studio / Grow ».
2. `index.html` : titre, description, Open Graph, `theme-color`.
3. Assets : `public/brand/*` et `public/vyora-mark.svg` renommés + toutes références.
4. Textes d'interface : `src/**` (748 occurrences) — remplacement **par contexte**,
   pas global : `SORAHNEX` → `SORAHNEX`, `Studio`/`Grow` selon l'espace, `Sorahnnex` → `SORAHNEX Studio`.
5. SEO, pages légales, écrans d'authentification, e-mails/notifications.
6. `package.json` : `name: "sorahnnex"`.
7. Tests de marque : aucun `SORAHNEX`/`SORAHNEX` visible dans le rendu.

Vérification : `rg -i "vyora|reelora" src index.html public` ne doit plus
retourner de **texte affiché** ; les identifiants techniques restent et sont
listés dans un fichier d'exceptions.

### Phase 1B — Documentation et libellés d'intégration
1. `docs/**` : contenu et titres.
2. `README.md`.
3. Titres/descriptions MCP (`core.ts`), `resource_name` OAuth.
4. Libellés admin/paramètres.

### Phase 1C — Identifiants techniques (sous conditions)
1. Edge Functions : créer des alias `sorahnnex-*` déployés **en plus** des
   fonctions actuelles, puis basculer les appelants, puis retirer les anciennes.
   Nécessite un déploiement — **hors de cette étape**.
2. SQL : aucune réécriture ; nouvelle migration uniquement pour des libellés
   (noms d'offres, fournisseurs affichés).
3. Netlify/GitHub/Supabase : actions externes planifiées avec retour arrière.

### Phase 2 — Grow mobile
1. Audit `src/navigation/config.ts`, `src/components/Layout.tsx`,
   `WorkspaceNav`, `WorkspaceDock`, drawers, modales, tableaux.
2. Reproduction sur 360×640, 390×844, 412×915, paysage.
3. Navigation cible étudiée : Accueil · Activité · Prospects · Assistant · Plus.
4. Corrections : panneaux en `fixed` avec largeur `min(100vw, …)`, suppression du
   scroll horizontal, cibles tactiles ≥ 44 px, formulaires et tableaux en cartes.

### Phase 3 — Intégrations
1. Reproduire l'échec de connexion boutique (plateforme concernée à préciser).
2. Vérifier `store-connect` : méthodes, Vault, callbacks, permissions.
3. États d'interface : connectée / non connectée / configuration requise /
   expirée / erreur / synchronisation.
4. Ne jamais afficher « connecté » si le backend ne l'est pas.

### Phase 4 — MCP
1. Auditer le serveur existant (déjà réel) : endpoint, OAuth, portées, outils.
2. Compléter le parcours `Paramètres → Intégrations → Connexion MCP`.
3. Vérifier l'exécution réelle des outils lecture/écriture et la révocation.

### Phase 5 — Audit global
Grille en 6 états (opérationnel testé / présent non testé / défectueux /
incomplet / simulé / configuration externe requise), sans déclarer validé ce qui
n'a pas été exécuté.

---

## 7. Blocages et configurations externes nécessaires

1. **`ec8d46d` introuvable** : confirmer la base de production, ou indiquer la
   branche/commit réel à utiliser.
2. **Plateforme de la boutique en échec** : préciser laquelle (PrestaShop,
   Chariow, Shopify, WooCommerce, autre) et le message exact.
3. **Comptes** : actions Netlify (nom du site), GitHub (renommage du dépôt),
   Supabase (nom d'affichage) — nécessitent un accès propriétaire.
4. **Clés fournisseurs** pour tout test réel de génération ou de connexion
   authentifiée.
5. **Domaine final** de SORAHNEX (impacte OAuth, callbacks, SEO, redirections).

Aucune de ces actions n'a été simulée : aucune intégration n'est déclarée
réparée, aucun renommage n'est déclaré effectué.
