# Rapport — déploiement `main` sur Netlify (2026-11-18, matin)

> Version reconstituée le 2026-11-18 à partir des mesures de la session (le fichier original,
> commit local `f1aeec2`, n'a pas pu être poussé : le jeton GitHub de sa branche était verrouillé
> après la fusion de la PR #24). Seuls les faits mesurés figurent ici.

## Résultat

- `origin/main` = **`f641e60`** (PR #24, squash, 06:05 UTC) ← `0c47968` (#23) ← `c1d48b7` (#22).
- Site `https://vyora-ugc.netlify.app/` : sert la révision `f641e60` (cachet `vyora-revision`),
  SPA opérationnelle, relais `/api/business-grow` → `401` JSON (jeton exigé), check-run GitHub
  `134613969441` en succès. Mesures pg_net `14152`–`14182`.

## Backend Supabase (`xbuuhfwobrafcbgtdgjx`) — actions réellement effectuées

| Action | Avant | Après |
| --- | --- | --- |
| `store-import` (chargeur épinglé `209748b`) | v19 | **v21** (v20 + redémarrage secrets) |
| `store-connect` (chargeur épinglé `209748b`) | v10 | **v12** |
| Secret `VYORA_ALLOWED_ORIGINS` | absent | créé : Netlify + aperçus + `vyora.pages.dev` |
| Secret `STORE_IMPORT_ALLOWED_ORIGINS` | absent | créé : même valeur |

Preuve CORS (pg_net `14171`–`14176`) : `store-connect`, `store-import`, `mcp-client`,
`vyora-payments` répondent `access-control-allow-origin: https://vyora-ugc.netlify.app` à l'origine
Netlify et `null` à `https://evil.example`.

## Inventaire Edge aligné sur `main` (audit `get_edge_function` ×11)

store-import v21, store-connect v12, mcp-client v12 (`37884b8`), vyora-mcp v8, business-grow v33
(`e27e2f0`), vyora-ai v12, vyora-ai-providers v13, vyora-payments v6, vyora-payments-reconcile v6,
vyora-saspay-webhook v6, vyora-provider-health v9, reelora-video v23, reelora-health v16,
reelora-ai v15, video-quote v10, reelora-video-worker v13, reelora-owner-bootstrap v8,
vyora-oauth v3 (source hors `main`), vyora-bg-seed v6. Migrations : dernière appliquée
`20261118140000 ugc_import_progress_resume`, aucune en attente.

## Dettes relevées à ce stade (traitées dans `docs/migration-nouveau-netlify.md` et la PR suivante)

1. `store-connect` ne lisait que `VYORA_ALLOWED_ORIGINS` (pas la liste par défaut) ;
2. `public._bg_artifact_parts` sans RLS avec droits `anon`/`authenticated` ;
3. artefacts `store-import`/`store-connect` du dépôt désynchronisés des bundles (test de parité rouge) ;
4. test `business-grow-deployment-guard` obsolète après le passage à « seul `main` se construit ».
