# ÉTAPE 1 — Rapport de renommage visible SORAHNEX

Statut : **terminée et vérifiée** (typecheck, build de production, tests de garde).
Portée appliquée : **marque visible uniquement**. Les identifiants techniques
risqués sont conservés et catalogués ci-dessous, conformément à la décision
« marque visible d'abord, identifiants techniques conservés ».

Aucun push, aucun déploiement, aucune migration destructive.

---

## 1. Ce qui a été renommé

| Surface | Avant | Après |
| --- | --- | --- |
| Nom de marque | SORAHNEX / SORAHNEX | **SORAHNEX** |
| Espaces produit | « SORAHNEX Grow », « SORAHNEX Grow », « Grow », « Grow » | **SORAHNEX Grow**, « Grow » |
| Paire d'espaces | « Studio & Grow » | **« Studio & Grow »** |
| Assistant | « Assistant SORAHNEX » | « Assistant SORAHNEX » |
| `package.json` | `name: "vyora"` | `name: "sorahnnex"` |
| Favicon | `public/vyora-mark.svg` | `public/sorahnnex-mark.svg` |
| Visuels de marque | `public/brand/vyora-{hero,growth,cta}.jpg` | `public/brand/sorahnnex-{hero,growth,cta}.jpg` |
| `index.html` | titre, description, Open Graph, favicon | SORAHNEX (vérifié par test) |
| Textes d'interface | libellés, `aria-label`, titres de pages, messages, documentation | SORAHNEX |

Le remplacement n'a pas été global : `scripts/rename-brand-visible.mjs` applique
un mapping par sentinelles qui met de côté les identifiants protégés avant
substitution, puis les restaure.

Volumétrie : **341 fichiers** modifiés par le script de renommage (lots 17-18 et
renommage confondus : 417 entrées dans `git status`, dont 368 modifications,
4 renommages, 45 fichiers nouveaux).

## 2. Preuves de vérification (exécutées)

| Contrôle | Commande | Résultat |
| --- | --- | --- |
| Types | `npm run typecheck` | **succès** (exit 0) |
| Build de production | `npm run build` (`tsc -b && vite build`) | **succès**, 14,5 s |
| Garde de marque visible | `npx vitest run tests/brand-visible-sorahnex.test.ts` | **3/3 succès** |
| Tests ciblés nav Grow / layout | `npx vitest run tests/layout-notifications.test.tsx tests/growth-workspace.test.tsx tests/business-grow.test.tsx tests/business-modules.test.tsx tests/brand-visible-sorahnex.test.ts` | **87/87 succès** |

La garde `tests/brand-visible-sorahnex.test.ts` échoue si `SORAHNEX`, `Sorahnnex`,
`SORAHNEX` ou `Sorahnnex` réapparaissent comme **mot entier** dans `src/`, `public/`
ou `index.html` (hors variables `SORAHNEX_*` / `SORAHNEX_*` explicitement protégées).

### Ce qui n'a pas été vérifié

- **Aucune revue visuelle** de l'application (pas de navigateur connecté) : le
  rendu est validé par compilation et par tests, pas à l'œil.
- La suite de tests **complète** (≈ 3 380 tests) n'a pas été relancée d'un bout à
  l'autre dans cette session : l'exécution parallèle dépasse la mémoire de la VM
  et la limite de 5 minutes par commande. Les lots exécutés (87 tests ciblés +
  garde de marque) passent.
- Les anciennes marques peuvent subsister dans des **identifiants techniques**
  (voir §3) et dans `dist/` (cachet de révision), volontairement.

## 3. Catalogue des identifiants techniques conservés

Chaque entrée est conservée parce qu'elle est référencée par un contrat externe
ou déjà appliquée en production. Aucune n'est affichée à l'utilisateur.

### 3.1 Variables d'environnement / secrets (20)

`VYORA_ALLOWED_ORIGINS`, `VYORA_BUILD_ENABLED`, `VYORA_KEEP`,
`VYORA_MCP_RESOURCE_URL`, `VYORA_MCP_WRITE_ENABLED`, `VYORA_OAUTH_ENCRYPTION_KEY`,
`VYORA_OWNER_ADMIN_EMAIL`, `VYORA_PAYMENTS_ALLOWED_ORIGINS`, `VYORA_PGRST_AI_PORT`,
`VYORA_PGRST_BIN`, `VYORA_PGRST_DIR`, `VYORA_PGRST_EDGE_PORT`, `VYORA_PGRST_PG_PORT`,
`VYORA_PGRST_PORT`, `VYORA_PGTEST_BIN`, `VYORA_PGTEST_DIR`, `VYORA_PGTEST_PORT`,
`VYORA_SASPAY_SECRET_KEY`, `VYORA_SASPAY_WEBHOOK_SECRET`, `VYORA_SITE_URL`.

Plus 9 variables `SORAHNEX_*` côté backend :
`REELORA_DOMAIN_BOUNDARIES`, `REELORA_PROJECT_REF`, `REELORA_RENDER_WORKER_TOKEN`,
`REELORA_RENDER_WORKER_URL`, `REELORA_TOOL_PROPOSALS`, `REELORA_VIDEO_PROVIDER`,
`REELORA_VIDEO_TIMEOUT`, `REELORA_VIDEO_UNAVAILABLE`, `REELORA_WEBHOOK_BASE_URL`.

**Raison** : secrets et configuration déjà déclarés sur Netlify/Supabase. Les
renommer imposerait une double déclaration et une fenêtre de rollback.
**Migration future** : créer les alias `SORAHNEX_*`, lire d'abord le nouveau nom
puis l'ancien en repli, basculer, puis supprimer l'ancien.

### 3.2 Edge Functions déployées (slugs)

`vyora-ai`, `vyora-ai-providers`, `vyora-mcp`, `vyora-payments`,
`vyora-payments-reconcile`, `vyora-provider-discovery`, `vyora-provider-health`,
`vyora-provider-health-collect`, `vyora-provider-health-daily`,
`vyora-provider-health-fresh-guard`, `vyora-provider-health-watchdog`,
`vyora-saspay-webhook`, `reelora-ai`, `reelora-health`,
`reelora-owner-bootstrap`, `reelora-video`, `reelora-video-worker`,
`business-grow`, `store-connect`, `store-import`, `studio-runtime`,
`universal-catalog`, `video-quote`, `mcp-client`.

**Raison** : URL publiées, redirections Netlify (`/api/reelora-video`), crons et
appelants frontend. **Migration future** : déployer des alias `sorahnnex-*` en
plus, réécrire les appelants, puis retirer les anciens.

### 3.3 Contrats techniques internes

- En-têtes : `x-vyora-cron`, `x-reelora-worker-token`.
- Bucket Storage : `ugc-assets` (chemins de fichiers existants).
- Fonctions SQL : **166** fonctions `public.reelora_*` / `public.vyora_*` créées
  par `supabase/migrations/` (231 occurrences si l'on compte les appels).
  Les migrations sont **appliquées** : aucune réécriture, aucune nouvelle
  migration de renommage.
- Outils MCP exposés : **13** outils `vyora_*` (`vyora_account_info`,
  `vyora_stores_list`, `vyora_products_list`, …). Les `name` sont conservés
  (contrat des agents déjà connectés) ; seuls les `title` / `description`
  affichés ont été renommés.
- Resource OAuth MCP : `resource_name` affiché en SORAHNEX.
- Cachet de build : `<meta name="vyora-revision">` injecté par `vite.config.ts`,
  lu par `scripts/verify-production.mjs` — invisible pour l'utilisateur.

### 3.4 Plateformes externes

| Élément | Valeur | État |
| --- | --- | --- |
| Netlify `SITE_ID` | `fc88d197-fe0b-47c7-a6e3-fba44eeccda9` | conservé (immuable) |
| Netlify `SITE_NAME` | `vyora-saas-ugc` | conservé — garde de build dans `netlify.toml` |
| Supabase `project_id` | `xbuuhfwobrafcbgtdgjx` | conservé (immuable) |
| Dépôt GitHub | `ibrahimdiango514/SaaS-UGC` | conservé — action propriétaire requise |

## 4. Références restantes et leur justification

Les seules occurrences `vyora|reelora` encore présentes dans `src/` sont des
**identifiants**, jamais du texte affiché :

| Occurrence | Nature |
| --- | --- |
| `app_scope: 'vyora'` (`src/lib/api.ts`) | valeur écrite en base, lue par des triggers |
| `reeloraModelStatus()` (`src/studio/model.ts`) | nom de fonction interne |
| `reelora:project-created` (`src/pages/Projects.tsx`) | nom d'évènement DOM interne |
| `@keyframes vyora*` (`src/index.css`) | noms d'animations CSS, sans affichage |
| `'vyora'` (repli de nom de fichier) | valeur de secours dans un export |
| `commentaires` Cloudflare Pages / PostgREST | documentation interne |

`docs/git-flow-vyora.md` conserve son **nom de fichier** (liens existants) ; son
contenu est renommé.

## 5. Restauration

```bash
git checkout backup/pre-sorahnnex-318adca                          # code commité
git stash apply 8835e62e09d2d38cc9528b8fa3d8898d8b6f959c          # travail d'avant renommage
```

Ces deux références sont locales (non poussées). Le renommage lui-même est
réversible par `git checkout` des fichiers concernés tant qu'il n'est pas commité.
