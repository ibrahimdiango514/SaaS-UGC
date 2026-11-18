# Rapport — Correction des intégrations en production, abonnement Business Grow, nouveau Netlify

Date : 2026-11-18 (UTC). Dépôt `ibrahimdiango514/SaaS-UGC`. PR **#27** fusionnée (squash) dans
`main` → **`14a61ec`**. Travail préparé sur `arena/51dab05a-saas-ugc` (commits `2538511`, `25246dd`).

## 1. État réel constaté au départ

| Point | Constat (mesuré) |
| --- | --- |
| Site Netlify | `https://vyora-ugc.netlify.app` → 200, `vyora-revision 3171a9d` (#26). Nouveau compte, **même nom** `vyora-ugc` que l'ancien site ; Site ID fourni : `fc88d197-fe0b-47c7-a6e3-fba44eeccda9`. |
| Garde de build | `netlify.toml` comparait `$SITE_NAME` à `vyora-ugc` → aurait aussi annulé les builds du **nouveau** site homonyme. |
| Formules Business Grow | `saas_business.plans` : `essentiel`, `croissance`, `scale` — `billing_enabled=false`, `monthly_price_minor=null` ; `commercial_config('pricing').billing_enabled=false`, `payment_providers=[]`. |
| Abonnements | `saas_business.subscriptions` : **0 ligne**. Toute lecture d'intégrations renvoyait `403 BUSINESS_GROW_SUBSCRIPTION_REQUIRED` (motif `NO_SUBSCRIPTION`). |
| Interface client | Ce 403 était affiché « État inconnu / État des intégrations indisponible » — faux : ce n'était pas une panne. |
| Moyen d'attribuer une formule | Aucun : le trigger `guard_subscription_activation` exigeait un fournisseur de paiement et un plan facturable pour activer un abonnement. |
| Wording | « Business Ground » présent dans `bg_import_access` (SQL), Edge `business-grow`/`store-connect`/`store-import`, frontend, tests, docs. |
| Administrateurs | Un seul rôle admin en base (`d54cb18f…`), contrainte d'unicité `ugc_user_roles_single_admin_idx`. |
| Connecteurs | `integration_providers` : 28 fournisseurs ; implémentés : chariow, custom-api, prestashop, shopify, woocommerce. Meta (`facebook`, `instagram`) : `oauth2`, non implémentés, **pas d'application Meta**. |

## 2. Changements effectués

### 2.1 Garde Netlify (nouveau site)
`netlify.toml` : `ignore = '[ "$SITE_ID" != "fc88d197-fe0b-47c7-a6e3-fba44eeccda9" ] || [ "$VYORA_BUILD_ENABLED" != "true" ] || [ "$BRANCH" != "main" ]'`.
Seul le site portant cet identifiant, déclarant `VYORA_BUILD_ENABLED=true`, construit `main`. Testé par
`tests/business-grow-deployment-guard.test.ts` (12 cas, `sh -c` réel). Doc : `docs/migration-nouveau-netlify.md`.

### 2.2 Base de données — migration `20261122090000_business_grow_admin_subscription.sql`
**Appliquée en production** via le connecteur Supabase (projet `xbuuhfwobrafcbgtdgjx`), enregistrée
`supabase_migrations.schema_migrations` version **`20261118084946`** (`business_grow_admin_subscription`).
- Formules `essentiel`/`croissance`/`scale` : `active=true`, **`billing_enabled=false`, prix `null`** (assertions dans la migration : toute activation de facturation ou de prix fait échouer la migration).
- `guard_subscription_activation` : tolère `billing_provider='manual'` sur une formule active ; reste strict pour les fournisseurs de paiement.
- **`public.vyora_admin_set_business_subscription(p_user_id, p_plan_key, p_period_end, p_note)`** : `security definer`, `search_path=''`, `ugc_private.reelora_assert_admin()` (rôle vérifié en base), refus d'auto-attribution, cible existante et client VYORA non admin, formule active, date de fin future ≤ 366 j, pas d'écrasement d'un abonnement payé ; upsert `billing_provider='manual'`, référence `manual:<uuid>` ; **audit** `ugc_audit_logs` (`business_grow_subscription_set`) + **notification** client ; renvoie l'accès recalculé par `bg_import_access`.
- **`public.vyora_admin_revoke_business_subscription(p_user_id, p_note)`** : même contrôle admin ; passe l'attribution manuelle à `canceled` ; audit `business_grow_subscription_revoked`.
- Droits : `revoke … from public, anon` ; `grant execute … to authenticated` (le refus non-admin est fait **dans** la fonction).
- `bg_import_access` : libellés « Business Grow » ; règles d'expiration inchangées (`current_period_end` → `SUBSCRIPTION_EXPIRED`).
- Aucune souscription automatique, aucun accès gratuit par défaut : `subscriptions` reste vide tant qu'un administrateur n'agit pas.

### 2.3 Frontend
- **Administration** (`/app/admin` → Utilisateurs → bouton « Business Grow », masqué pour les comptes admin) : `src/pages/admin/BusinessGrowSubscriptionManager.tsx` — choix de formule (catalogue public), date de fin (raccourcis 30/90/180/365 j, bornes identiques à la RPC), motif journalisé, résiliation avec confirmation ; affiche uniquement le résultat renvoyé par le serveur. Client : `adminSetBusinessSubscription`, `adminRevokeBusinessSubscription`, `listBusinessGrowPlans` (`src/lib/api.ts`).
- **Espace client** : `BusinessGrowApiError.details` + `subscriptionRefusalOf()` (`src/business/api.ts`) ; `CatalogPage.tsx` : bannière « Abonnement Business Grow requis » (motif précis : aucun / expiré / résilié / impayé, lien `/app/business/abonnement`, bouton « Revérifier »), badge « Abonnement requis » sur chaque fiche, aucune action proposée ; `BusinessGrowWorkspace.tsx` distingue refus d'abonnement et panne (y compris sur une mutation refusée).
- Wording « Business Ground » → « Business Grow » partout.

### 2.4 Edge Functions (bundles régénérés, chargeurs épinglés sur `25385118f1ebc3e418fbae17d07e5262dafe3db9`)
| Fonction | Version déployée | Bundle | Taille / SHA-256 |
| --- | --- | --- | --- |
| `business-grow` | **v34** (était v33) | `supabase/functions/business-grow.edge.js` | 88235 car. / `ca9f76e5…bdfe7` |
| `store-connect` | **v14** (était v13) | `supabase/functions/_artifacts/store-connect.js` | 81356 car. / `d765772d…e4d3` |
| `store-import` | **v23** (était v22) | `supabase/functions/_artifacts/store-import.js` | 113906 car. / `e23ed55a…9954` |

Preuve que GitHub sert exactement ces bundles au commit épinglé (pg_net ids 14380–14382, HTTP 200,
taille et SHA-256 identiques). Preuve de démarrage après déploiement (pg_net 14384–14386, origine
`https://vyora-ugc.netlify.app`) : `business-grow` → 401 `UNAUTHENTICATED`, `store-connect` → 400
`UNKNOWN_ACTION`, `store-import` → 401 `UNAUTHENTICATED`, tous avec `access-control-allow-origin:
https://vyora-ugc.netlify.app` — le code métier est chargé (un échec de chargement répond 503).

### 2.5 Meta
`docs/connecteur-meta-preparation.md` : noms de secrets (`META_APP_ID`, `META_APP_SECRET`,
`META_OAUTH_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN`) à poser **uniquement** dans les secrets Edge,
étapes Meta for Developers (compte, portefeuille Business, application, Login for Business, permissions
à soumettre en App Review, testeurs, passage en Live), et ce que VYORA activera ensuite. Aucun secret
n'a été créé ni collé ; `facebook`/`instagram` restent non implémentés.

## 3. Preuves des tests

### 3.1 Production (SQL, transaction annulée — aucune donnée conservée) — 2026-11-18 08:50 UTC
Comptes de test créés dans la transaction ; admin réel (`d54cb18f…`) simulé par ses seuls claims JWT.

| # | Scénario | Résultat |
| --- | --- | --- |
| 0 | Compte sans abonnement | `allowed=false`, `NO_SUBSCRIPTION`, « Aucun abonnement Business Grow : souscription requise. » |
| 1 | **Non-admin** appelle la RPC | `refuse: forbidden` |
| 2 | **Admin** attribue `essentiel` à J+30 | `status=active`, `billing_provider=manual`, `access=OK`, « Abonnement Business Grow actif. » |
| 2b | Journal / notification | 1 ligne `ugc_audit_logs` (`business_grow_subscription_set`), 1 notification client |
| 3 | **Isolation** : autre compte | `allowed=false`, `NO_SUBSCRIPTION` |
| 4 | **Expiration** : lecture à J+31 | `allowed=false`, `SUBSCRIPTION_EXPIRED` |
| 5 | **Renouvellement** (`croissance`, nouvelle date) | `renewed=true`, `plan=croissance`, 1 seule ligne, accès à J+31 `true` |
| 6 | Garde-fous | `period_end_must_be_future`, `period_end_too_far`, `plan_not_found`, `self_assignment_forbidden`, `target_not_found` |
| 7 | Statut `past_due` | `allowed=false`, `PAYMENT_FAILED` |
| 8 | **Révocation** | `status=canceled`, `SUBSCRIPTION_CANCELED` |
| 9 | RPC client `vyora_import_connect_access()` | `{allowed:false, reason:SUBSCRIPTION_CANCELED, plan_key:croissance}` |

Après `rollback` : `subscriptions` = 0, comptes de test = 0. Contrôle post-migration : 3 formules
`active=true / billing_enabled=false / prix null`, `business_grow_catalog()` = 3 formules.

### 3.2 Dépôt (commit `25246dd`, identique au contenu fusionné)
- `npm run typecheck` ✓ · `npm run typecheck:edge` ✓ · `npm run check:edge-imports` ✓ · `npm run build` ✓
- `vitest run` : **176 fichiers / 3096 tests ✓** (main précédent : 175 / 3078).
  - Nouveau `tests/business-grow-admin-subscription.test.tsx` (14) : garde-fous de la migration ; client — activation autorisée, non-admin refusé, expiration (client + serveur + affichage), renouvellement, isolation ; modale admin — attribution, refus non-admin, résiliation.
  - `tests/business-grow.test.tsx` : +2 scénarios « Abonnement requis » (lecture refusée, mutation refusée).
  - `tests/business-grow-deployment-guard.test.ts` : 12 cas (garde `SITE_ID`).
  - Parité artefacts/chargeurs (`store-import-artifact`, `business-grow-artifact`, `business-grow-loader`, `edge-loader-parity`) ✓ sur le commit épinglé.
- CI GitHub « Vérification de production » sur `main@14a61ec` : succès.

## 4. Version réellement déployée

| Composant | Version |
| --- | --- |
| Base de données | migration `20261118084946` (`business_grow_admin_subscription`) appliquée |
| Edge `business-grow` / `store-connect` / `store-import` | v34 / v14 / v23, bundles du commit `2538511` |
| `main` | `14a61ec` (PR #27) |
| Site Netlify `https://vyora-ugc.netlify.app` | **à vérifier** : au moment de la rédaction (09:21 UTC, ~10 min après fusion) le site servait encore `vyora-revision 3171a9d`. Voir §5. |

## 5. Points d'attention / à faire par le titulaire des comptes

1. **Déploiement Netlify de `14a61ec`** : si *Deploys* montre « Build cancelled » pour `main`, la garde a
   lu un `SITE_ID` différent de `fc88d197-fe0b-47c7-a6e3-fba44eeccda9`. Vérifier *Site configuration →
   General → Site details → Site ID* ; si l'identifiant diffère, corriger la valeur dans `netlify.toml`
   par PR. Vérifier aussi que `VYORA_BUILD_ENABLED=true` est bien déclarée sur le nouveau site.
   Une fois construit, `https://vyora-ugc.netlify.app` doit afficher `vyora-revision 14a61ec`
   (`node scripts/verify-production.mjs --site https://vyora-ugc.netlify.app`).
   Tant que ce build n'est pas passé, les Edge Functions v34/v14/v23 servent déjà le nouveau wording
   et la RPC admin est utilisable ; seule l'interface (« Abonnement requis », modale admin) attend.
2. **Attribuer une première formule** : `/app/admin` → Utilisateurs → « Business Grow » sur le compte
   visé → formule + date de fin → « Attribuer la formule ». Le client voit alors ses intégrations.
3. **Meta** : suivre `docs/connecteur-meta-preparation.md` ; transmettre uniquement l'**App ID** ; poser
   l'App Secret directement dans les secrets Edge.
4. `vars.VYORA_SITE_URL` (GitHub) reste à définir pour que `production-check.yml` cible le bon site.
5. PR #9–#13 restent ouvertes (périmètres MCP/Connect), non fusionnées volontairement.
