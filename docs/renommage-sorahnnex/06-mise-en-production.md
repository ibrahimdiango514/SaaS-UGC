# ÉTAPE 6 — Réconciliation et mise en production

Statut : **réconciliation terminée et vérifiée ; déploiement NON exécuté — les
identifiants de déploiement sont absents de cet environnement.**

Ce document sépare strictement ce qui a été mesuré de ce qui reste à faire.

---

## 1. Base de production réelle (mesurée)

| Élément | Valeur constatée |
| --- | --- |
| Branche de production | `origin/main` = `ec8d46d` |
| Révélation côté live | `https://vyora-saas-ugc.netlify.app` → `<meta name="vyora-revision" content="ec8d46d">` |
| Titre servi | `VYORA — Create. Evolve. Grow.` (le renommage n'est **pas** en production) |
| `origin/develop` | `af11226` — 46 commits que `main` ne contient pas, 15 commits de `main` qu'il ne contient pas |
| Base de notre branche | `318adca`, ancêtre commun avec `main` |
| Écart avec `main` | `main` = `318adca` + `2a7e125` (#45) + `ec8d46d` (#47) ; nous avions `318adca` + 4 commits |
| Worktree | **propre** avant fusion |

Fonctions Supabase réellement en ligne (sondées, `xbuuhfwobrafcbgtdgjx`) :

| Fonction | Réponse |
| --- | --- |
| `reelora-health` | `200` · `{"status":"ok","configured":{"ai":true,"muapi":true,"supabase":true,"worker":true}}` |
| `business-grow` | `401 UNAUTHORIZED_NO_AUTH_HEADER` — déployée et protégée |
| `store-connect` | `401 UNAUTHORIZED_NO_AUTH_HEADER` — déployée et protégée |
| `vyora-mcp` | `405` + message JSON-RPC explicite — déployée et répond |

## 2. Réconciliation effectuée

Fusion de `origin/main` dans une branche dédiée `sorahnnex/reconcile-main`
(aucune réécriture de la branche validée, aucun push forcé).

**31 conflits**, traités par famille :

1. **Artefacts générés** (4 HTML, 3 bundles, 4 chargeurs, 1 migration
   d'artefact) : pris côté production puis **régénérés** depuis l'arbre fusionné.
   Les empreintes ne sont jamais saisies à la main.
2. **Code production + renommage** (11 fichiers source, 6 tests) : version de
   production conservée, puis **renommage visible réappliqué** par
   `scripts/rename-brand-visible.mjs` (déterministe, idempotent, 0 jeton restant
   hors identifiants protégés).
3. **Suppressions de production honorées** : `src/business/growth/GrowthPanels.tsx`,
   `src/business/growth/GrowthWorkspace.tsx`, `supabase/functions/reelora-ai/index.ts`
   et `tests/groq.test.ts` avaient été supprimés par la release #45. Ils restent
   supprimés : les ressusciter aurait réintroduit du code mort.
4. **Contrats de types** : `src/lib/api.ts` et `src/lib/types.ts` conservés dans
   leur version complète (celle qui porte les types Studio des lots 16-18), sinon
   `UniversalStudio` et `UniversalCatalogHealth` ne compilaient plus.

Deux régressions trouvées pendant la réconciliation, corrigées :

- **Garde de marque inversée** : le script de renommage réécrivait les jetons
  interdits *à l'intérieur du test*, qui se mettait alors à interdire SORAHNEX.
  Les anciens noms sont désormais assemblés à l'exécution, et le test + le script
  sont exclus du renommage.
- **Visuel 404** : `src/pages/Home.tsx` pointait encore vers
  `/brand/vyora-hero.jpg`, fichier inexistant. Corrigé vers
  `/brand/sorahnnex-hero.jpg`.

## 3. Contenu de la release (branche `sorahnnex/reconcile-main`)

```
7939722  Réépingler sur l'arbre fusionné et corriger deux régressions de renommage
12927d4  Reconstruire tous les artefacts Edge depuis l'arbre fusionné
8f77d59  Réconcilier SORAHNEX avec la base de production (main ec8d46d)
cb57486  Rendre la connexion MCP atteignable depuis Paramètres → Intégrations
d37f836  Réépingler les chargeurs Edge sur le commit des nouveaux bundles
cf92ca3  Reconstruire les bundles Edge store-import, store-connect, mcp-client et business-grow
5126343  SORAHNEX : renommage visible, mobile Grow et artefacts Edge réalignés
```

Migrations ajoutées par rapport à `main` (**6**, aucune DDL destructive) :

```
20261120190000_studio_endpoint_resolution.sql
20261120210000_studio_runtime_prepare.sql
20261120230000_studio_quota_plan_policy.sql
20261121000000_studio_family_policy_lot16.sql
20261121010000_studio_json_result_training_lot17.sql
20261121020000_studio_external_actions.sql
```

`20261121000000_studio_family_policy_lot16.sql` contient des `DELETE` : ils sont
**à l'intérieur de fonctions de nettoyage** (réservations expirées, devis
périmés, événements d'usage d'un job annulé), pas des suppressions exécutées à
l'application de la migration. Aucun `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`.

## 4. Vérifications exécutées sur l'arbre réconcilié

| Contrôle | Résultat |
| --- | --- |
| `npm run typecheck` | succès |
| `npm run build` | succès (15,98 s) |
| Marque visible (garde) | 3/3 |
| Navigation, layout, réglages, Grow, MCP, sécurité, ai-core — 18 fichiers | **236/236** |
| Parité Edge : chargeurs, bundles, artefacts, épinglage GitHub | **107/107** (après régénération de `reelora-video.edge.js`, désynchronisé par la release #45) |
| Empreintes distantes au commit épinglé `12927d4` | `store-import`, `store-connect`, `mcp-client`, `business-grow` : **identiques** aux `ARTIFACT_SHA256` des chargeurs |
| Bundle construit | `dist/index.html` = `<title>SORAHNEX …`, `og:site_name=SORAHNEX` ; le JS contient « Tout le menu Grow », `overscroll-contain` et « Connexion MCP » |
| Assets référencés | tous résolus dans `public/` (aucun 404) |

**Non exécuté** : suite complète (~3 400 tests), rendu navigateur, tests sur
appareil mobile réel.

## 5. Déploiement — procédure exacte

### Blocage actuel

Aucun identifiant de déploiement n'est présent dans cet environnement :
`NETLIFY_AUTH_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `GITHUB_TOKEN`/`GH_TOKEN` sont
absents, `gh` n'est pas authentifié, les CLI `netlify` et `supabase` ne sont pas
installées. Rien n'a donc été déployé, et rien ne sera déclaré déployé sans
preuve côté live.

### Ordre de mise en production

1. **PR** : `sorahnnex/reconcile-main` → `main`
   `https://github.com/ibrahimdiango514/SaaS-UGC/pull/new/sorahnnex/reconcile-main`
2. **Migrations** (avant ou avec le frontend) :
   `supabase link --project-ref xbuuhfwobrafcbgtdgjx`
   `supabase db push` — ou appliquer les 6 fichiers listés au §3, dans l'ordre.
3. **Edge Functions** (la source déployée est le chargeur, pas `index.ts`) :
   ```
   node scripts/build-edge-artifact.mjs store-import --check
   node scripts/build-edge-artifact.mjs store-connect --check
   node scripts/build-edge-artifact.mjs mcp-client --check
   node scripts/build-business-grow-artifact.mjs --check
   node scripts/build-edge-loader.mjs --check vyora-ai
   supabase functions deploy store-connect store-import mcp-client business-grow \
     vyora-ai vyora-ai-providers vyora-provider-health vyora-mcp
   ```
   Puis appliquer les migrations d'artefacts à tranches (`*_artifact.sql`) si
   elles ne sont pas déjà poussées.
4. **Frontend** : fusion dans `main` = déclencheur Netlify. La garde
   `ignore` n'autorise le build que si `BRANCH=main`, `SITE_NAME=vyora-saas-ugc`,
   `SITE_ID=fc88d197-…` et `VYORA_BUILD_ENABLED=true`. **Ne pas renommer ces
   variables** dans cette release.

### Vérification après déploiement (à exécuter, pas à supposer)

```bash
# 1. le frontend sert bien le nouveau commit
curl -s https://vyora-saas-ugc.netlify.app | grep -o 'vyora-revision" content="[^"]*"'
curl -s https://vyora-saas-ugc.netlify.app | grep -o '<title>[^<]*</title>'
# 2. les fonctions répondent
curl -s https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/reelora-health
curl -s -o /dev/null -w '%{http_code}\n' https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/store-connect
# 3. la connexion de boutique échoue proprement (401, jamais 503 d'artefact)
```

Attendu : révision = commit fusionné sur `main`, titre `SORAHNEX …`, health `ok`,
`store-connect`/`business-grow` en `401` (et non `503 …_ARTIFACT_UNAVAILABLE`).

### Rollback

| Cible | Procédure |
| --- | --- |
| Frontend | Netlify → Deploys → déploiement `ec8d46d` → **Publish deploy** (instantané, aucun rebuild) |
| Code | `git revert -m 1 <commit de fusion>` sur `main` (aucun force push) |
| Edge Functions | redéployer les chargeurs de `main@ec8d46d` ; les bundles de ce commit existent toujours (URL par SHA) |
| Base | les 6 migrations sont additives ; rollback = `DROP` des seuls objets créés (`studio_*`), aucune donnée utilisateur supprimée |
