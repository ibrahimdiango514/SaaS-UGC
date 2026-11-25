# Récupération du travail Freebuff et réconciliation SORAHNEX

Date : 2026-11-25. Base de production au départ : `main` = `ec8d46d`.

## 1. Ce qui a été retrouvé

Le clone de départ était *shallow* (un seul commit, `grafted`). L'historique complet
et toutes les branches distantes ont été récupérés (`git fetch --unshallow` avec une
référence explicite `+refs/heads/*`). Aucun worktree, stash ou reflog local ne
contenait de travail : tout était sur GitHub.

Deux lignées SORAHNEX existaient, **aucune n'était en production** :

| Lignée | Tête | Contenu | Écart vs `main` |
| --- | --- | --- | --- |
| A — `sorahnnex/reconcile-main` | `7939722` | renommage visible, mobile Grow, accès MCP depuis Paramètres → Intégrations, Chariow, Studio lot16/lot17, artefacts Edge reconstruits et réépinglés, 6 documents d'audit | 7 commits, 0 retard |
| B — `feat/sorahnex-validation-ux` | `bcdb01b` | PR empilées #48/#49/#50 : identité SORAHNEX, espaces et navigation par intention, `SpaceSwitcher`, restauration du scroll, cibles tactiles, alias SQL, harnais de validation visuelle | 23 commits, 2 retard |

Autres branches examinées et écartées : `freebuff/435ebbb1…` (déjà fusionnée par
#45), `freebuff/85fbf35e…` (ancêtre de A), `develop` et les branches `arena/*`
antérieures (contenu déjà dans `main`), `security/dependency-fixes` (0 commit
propre).

## 2. Base de fusion réelle

Les PR #45 et #47 ont été **squashées** : `main` contient leur contenu mais pas
leurs commits. La base commune Git était donc ancienne (`318adca`) et produisait
**94 conflits artificiels**.

Constat vérifié : `git diff 54d0443 main` est **vide** (0 fichier). L'arbre de
`54d0443`, base de la lignée B, est identique à celui de `main`. La fusion a été
faite avec cette base (`git merge-recursive 54d0443 -- HEAD bcdb01b`), ramenant les
conflits à **73, tous réels**. Conséquence utile : tout `supabase/**` a fusionné
sans conflit, B ne touchant pas cette couche.

## 3. Règles de résolution

- **Branding : B gagne.** Son script (`scripts/rename-brand.mjs`) utilise des
  limites de mots. Celui de A remplaçait par sous-chaîne : il avait abîmé des
  identifiants techniques (`ReeloraModelStatus` → `SorahnnexModelStatus`,
  `VyoraFile` → `SorahnnexFile`) et introduit la coquille **`sorahnnex`** (N en
  trop) dans les noms d'assets et de documents. Identifiants restaurés, coquille
  corrigée partout, assets `sorahnnex-*` retirés au profit de `sorahnex-*`
  (images bit-à-bit identiques, vérifié par hash Git).
- **Studio lot16/lot17 : A gagne** sur `src/studio/UniversalStudio.tsx`
  (`JsonResult`, quotas, motifs de blocage, matrice de plans). B n'y avait que du
  renommage.
- **`src/lib/api.ts` : fusion manuelle.** La réconciliation de A avait laissé deux
  **régressions** vers du code supprimé en production : repli vers `reelora-ai`
  et fournisseurs Groq/Gemini en dur dans `AiEngineHealth`. Elles ne sont pas
  réintroduites. Les ajouts réels de A sont conservés : validation défensive du
  catalogue admin (`CATALOG_INVALID_RESPONSE`), quotas universels
  (`UniversalQuotaItem`/`UniversalQuotas`), champs `plan_allowed`,
  `technical_blockers`, `quota_family`, `billing`, compteurs `configurable` et
  `technical_test_passed`.
- **Navigation, `Layout`, `GrowthOsLayout`, cibles tactiles : B gagne** (plus
  récent, testé, et conserve l'entrée « Plus » du tiroir mobile).
- **Libellés : normalisation sur « SORAHNEX Grow »** (69 fichiers). L'arbre
  mélangeait « Business Grow », « Grow » et « SORAHNEX Grow ».
- `scripts/rename-brand-visible.mjs` (A) est retiré : supersédé par
  `scripts/rename-brand.mjs` (B) et dangereux à réexécuter (il réabîmerait les
  identifiants). Il reste dans l'historique de la branche récupérée.

## 4. Identifiants techniques volontairement conservés

Variables `VYORA_*`/`REELORA_*`, slugs Edge `vyora-*`/`reelora-*`, RPC SQL
`vyora_*`/`reelora_*`, tables, buckets, site Netlify `vyora-saas-ugc`, dépôt
GitHub, classes CSS internes `vyora-*`, types TypeScript `ReeloraModelStatus` /
`VyoraFile`, en-tête `VYORA-EDGE-SHA256`, code promo réel `REELORA2026`, boîte
`support@vyora.app`. Le texte d'une migration SQL reste « Business Grow » :
c'est un artefact technique, pas un affichage.

## 5. Artefacts Edge

Les modules `src/` inlinés dans les bundles (`src/business/importer/**`,
`src/lib/origin-allowlist.ts`) sont **inchangés** par la fusion. Les quatre
chargeurs épinglés restent en parité SHA-256 avec l'arbre fusionné :

| Fonction | Commit épinglé | Contrôle |
| --- | --- | --- |
| `business-grow` | `12927d4` | artefacts à jour (86 204 caractères) |
| `store-import` | `12927d4` | chargeur à jour (113 982) |
| `store-connect` | `12927d4` | chargeur à jour (81 320) |
| `mcp-client` | `12927d4` | chargeur à jour (72 823) |

Aucun réépinglage n'était donc nécessaire. La production, elle, exécutait encore
le chargeur épinglé sur `2a7e125` (bundle d'avant renommage).

## 6. Vérifications exécutées

| Contrôle | Résultat |
| --- | --- |
| `npm run typecheck` | 0 erreur |
| `npm run typecheck:edge` | 0 erreur |
| `npx vitest run` | **227 fichiers / 3 474 tests verts** |
| `npm run build` | OK (14,4 s) |
| `npm run verify:sorahnex-aliases` | 11/11 (PGlite, base isolée) |
| `npm run check:edge-imports` | conforme |
| Parité des 4 artefacts Edge | à jour |
| Assets référencés | tous présents, aucun 404 |

Trois tests ont été réalignés, sans être affaiblis : une assertion portait sur le
texte d'une migration SQL (artefact technique, revenu à « Business Grow »), et
deux utilisaient `getByText` sur un nom d'espace désormais présent plusieurs fois
dans la vitrine (`getAllByText` avec exigence de présence).

## 7. État de la base de production

Projet `xbuuhfwobrafcbgtdgjx` (eu-central-1). Comparaison faite **par nom**
(l'historique Supabase horodate ses propres versions) puis **par existence
d'objets**, car plusieurs migrations ont été appliquées hors journal.

- `sorahnex_platform_identity` et `sorahnex_keep_support_mailbox` : **déjà
  appliquées** (le nom de plateforme en base est déjà SORAHNEX).
- `mcp_external_connections` : objets `public.mcp_servers` et
  `public.mcp_servers_secrets` **présents** — déjà appliquée hors journal.
- **Studio lot16/lot17 : absent.** Les 6 migrations
  (`studio_endpoint_resolution`, `studio_runtime_prepare`,
  `studio_quota_plan_policy`, `studio_family_policy_lot16`,
  `studio_json_result_training_lot17`, `studio_external_actions`) ne sont pas
  appliquées : ni `saas_ugc.studio_quota_families`, ni
  `saas_ugc.studio_external_actions`, ni `public.studio_prepare_runtime`.

## 8. Ce qui est livré, ce qui ne l'est pas

**Livré côté frontend** : branding SORAHNEX complet, navigation par intention,
`SpaceSwitcher`, restauration du scroll, ergonomie Android de Grow, cibles
tactiles, accès MCP depuis Paramètres → Intégrations, Chariow, Studio lot16/17
(interface).

**Compatibilité descendante vérifiée dans le code** : l'appel `quotas` du Studio
universel est en `.catch(() => {})` et `page.plan`, `model.plan_allowed` sont
optionnels. Sans le backend lot16/17, le panneau de quotas ne s'affiche pas et la
page reste fonctionnelle — aucune erreur bloquante.

**Non déployé, assumé** : le backend Studio lot16/17 (`studio-runtime`) et ses 6
migrations. Elles remplacent des fonctions de facturation vivantes
(`public.reelora_consume_quota`, deltas de portefeuille) et retirent une surcharge
de `public.studio_save_muapi_detail`. Ce paquet exige un test authentifié de bout
en bout (génération réelle, débit et remboursement de crédits) qu'aucun compte de
test ne permet ici. La page admin « matrice de plans » récupérée restera donc en
erreur tant que ce backend n'est pas déployé. Rien n'est prétendu fonctionnel sans
avoir été testé.

## 9. Retour arrière

- Frontend : redéployer le commit `ec8d46d` (aucune migration requise pour le
  branding, `sorahnex_platform_identity` était déjà en base).
- Edge : redéployer le chargeur épinglé sur `2a7e125` pour `business-grow` ; les
  anciens chargeurs des trois autres fonctions sont dans l'historique de `main`.
- Aucune migration appliquée par cette récupération : rien à défaire en base.
