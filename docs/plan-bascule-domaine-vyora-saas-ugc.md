# Plan de bascule vers `https://vyora-saas-ugc.netlify.app` — valeurs exactes, rien d'appliqué

Date : 2026-11-18, ~10:00 UTC. `main` = `ca410d5` (PR #28 fusionnée à 09:47 UTC).
**Aucune des modifications ci-dessous n'est appliquée** : ce document présente les valeurs exactes
à valider avant toute action sur les secrets ou la configuration de production.

## 0. État mesuré du déploiement `ca410d5`

| Contrôle | Résultat |
| --- | --- |
| Fusion #28 | `main` = `ca410d5` (squash), CI « Vérification de production » ✓ |
| `https://vyora-saas-ugc.netlify.app/` | 200 — mais `vyora-revision` = **`3171a9d`** à 09:48, 09:50, 09:53, 09:56, 09:57 UTC (10 min après la fusion) |
| Statut de commit GitHub pour `ca410d5` | aucun statut Netlify publié (comme pour les commits `main` précédents) |
| Journal Netlify (« GARDE NETLIFY — build autorisé ») | **non vérifiable d'ici** : aucun accès à l'API ni aux journaux Netlify depuis cet environnement |

Conclusion provisoire : soit le build est encore en file d'attente, soit le rideau 2 a refusé le
build (message explicite dans le journal). La ligne à lire dans *Deploys → `ca410d5` → log* :
- `garde ignore: BRANCH=main VYORA_BUILD_ENABLED=… SITE_ID=… SITE_NAME=…` (rideau 1) ;
- puis `GARDE NETLIFY — build autorisé : site fc88d197-… (vyora-saas-ugc), branche main.` **ou**
  `GARDE NETLIFY — build refusé : <raison>` suivi des valeurs reçues.
Le second cas donne directement la correction à faire (identifiant, variable ou branche).

## 1. Edge Functions — origines CORS (mesure du 2026-11-18 09:57 UTC, origine `https://vyora-saas-ugc.netlify.app`)

| Fonction | Réponse aujourd'hui | Verdict |
| --- | --- | --- |
| `business-grow` v34 | 401 `UNAUTHENTICATED`, `access-control-allow-origin: https://vyora-saas-ugc.netlify.app` | **OK** (déjà admise) |
| `store-connect` v14 | 400, `access-control-allow-origin: null` | **bloquée** par le navigateur |
| `store-import` v23 | **403 `ORIGIN_NOT_ALLOWED`** | **bloquée** |
| `mcp-client` v13 | 401, `access-control-allow-origin: null` | **bloquée** |
| `reelora-owner-bootstrap` v9 | **403 `origin_not_allowed`** | **bloquée** (page Propriétaire) |
| `vyora-payments` v6 | **403 `ORIGIN_NOT_ALLOWED`** | **bloquée** (achat de crédits) |
| `vyora-mcp` v8, `vyora-ai` v12 | `access-control-allow-origin: *` | OK |

### Changements proposés (secrets Edge — **autorisation requise**)

| Secret | Valeur actuelle (publique, documentée et mesurée) | Nouvelle valeur proposée |
| --- | --- | --- |
| `VYORA_ALLOWED_ORIGINS` | `https://vyora-ugc.netlify.app,https://deploy-preview-*--vyora-ugc.netlify.app,https://vyora.pages.dev,https://*.vyora.pages.dev` | `https://vyora-saas-ugc.netlify.app,https://vyora-ugc.netlify.app,https://deploy-preview-*--vyora-ugc.netlify.app,https://vyora.pages.dev,https://*.vyora.pages.dev` |
| `STORE_IMPORT_ALLOWED_ORIGINS` | identique à `VYORA_ALLOWED_ORIGINS` (même empreinte, même date) | identique à la nouvelle valeur ci-dessus |
| `VYORA_PAYMENTS_ALLOWED_ORIGINS` | **n'existe pas** (la liste codée n'admet que `vyora-ugc.netlify.app` et ses aperçus) | **créer** : `https://vyora-saas-ugc.netlify.app` (origine exacte, aucun joker : elle sert à construire l'adresse de retour après paiement) |
| `BUSINESS_GROW_ALLOWED_ORIGINS` | inconnue (empreinte seule) — mais la nouvelle origine est **déjà acceptée** | **ne pas toucher** |

Effets : chaque secret modifié redémarre les fonctions qui le lisent (version +1, code inchangé —
ce n'est pas un déploiement de code). Fonctions concernées : `store-connect`, `mcp-client`,
`reelora-owner-bootstrap` (`VYORA_ALLOWED_ORIGINS`) ; `store-import` (`STORE_IMPORT_ALLOWED_ORIGINS`) ;
`vyora-payments`, `vyora-payments-reconcile`, `vyora-saspay-webhook` (`VYORA_PAYMENTS_ALLOWED_ORIGINS`).
L'ancienne origine est **conservée** pendant la transition (sessions ouvertes) ; son retrait fera
l'objet d'une étape ultérieure, séparée. Aucune donnée, abonnement ou intégration n'est touché :
seules des listes d'origines changent. Vérification après application : mêmes appels pg_net
qu'au §1, attendu `access-control-allow-origin: https://vyora-saas-ugc.netlify.app` partout et
disparition des 403 `ORIGIN_NOT_ALLOWED`.

Option (non retenue par défaut) : ajouter `https://deploy-preview-*--vyora-saas-ugc.netlify.app` —
inutile tant que la garde annule tous les Deploy Previews.

## 2. Supabase Auth (GoTrue) — **autorisation requise** (configuration, pas un secret)

Mesuré le 2026-11-18 (`get_auth_config`) :

| Réglage | Valeur actuelle | Nouvelle valeur proposée |
| --- | --- | --- |
| `site_url` | `https://vyora-ugc.netlify.app` (**404 aujourd'hui** : les liens e-mail par défaut sont cassés) | `https://vyora-saas-ugc.netlify.app` |
| `uri_allow_list` | `https://vyora-ugc.netlify.app/**,https://vyora-ugc.netlify.app,https://deploy-preview-*--vyora-ugc.netlify.app/**,https://deploy-preview-*--saas-ugc-growth.netlify.app/**,https://saas-ugc-growth.netlify.app/**,https://5173-iu476i6ok9qrn5o47a39w.e2b.app/**,https://4173-iu476i6ok9qrn5o47a39w.e2b.app/**,https://97d6ef90-61c6-4ec6-b348-69682d45357c-thr_*.lovableproject.com/**,https://97d6ef90-61c6-4ec6-b348-69682d45357c.lovableproject.com/**,https://id-preview*--97d6ef90-61c6-4ec6-b348-69682d45357c.lovable.app/**,https://project--97d6ef90-61c6-4ec6-b348-69682d45357c-dev.lovable.app/**,https://project--97d6ef90-61c6-4ec6-b348-69682d45357c.lovable.app/**,https://sbc-ai-agency-dashbord.netlify.app,http://localhost:5173/**,http://localhost:4173/**,https://vyora.pages.dev/**,https://*.vyora.pages.dev/**,https://5173-ioh1tunc6fm4b8n31rvtk.e2b.app/**` | la **même liste**, avec en tête `https://vyora-saas-ugc.netlify.app/**,https://vyora-saas-ugc.netlify.app,` — **rien n'est retiré** (le projet héberge d'autres produits : `lovable.app`, `sbc-ai-agency-dashbord`) |

Tous les autres réglages (`jwt_exp`, `disable_signup`, `mailer_autoconfirm`, fournisseurs externes
tous désactivés, rotation des jetons…) sont **repassés à l'identique** : l'API de mise à jour exige
la liste complète, elle sera recopiée telle quelle. Effet : liens de confirmation / réinitialisation /
confirmation propriétaire valides sur le nouveau domaine. Les sessions existantes ne sont pas
invalidées.

## 3. Variables Netlify (site `vyora-saas-ugc`, Site ID `fc88d197-…`) — à saisir dans la console Netlify

| Variable | Valeur attendue | Rôle |
| --- | --- | --- |
| `VYORA_BUILD_ENABLED` | `true` (exactement, toutes portées ou au moins *Production*) | opt-in des deux rideaux |
| `VITE_SITE_URL` | `https://vyora-saas-ugc.netlify.app` | `emailRedirectTo` (inscription, mot de passe oublié, propriétaire) ; repli = origine courante, donc déjà correct par défaut |
| `VITE_SUPABASE_URL` | `https://xbuuhfwobrafcbgtdgjx.supabase.co` | inchangée |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz` | inchangée |

Je n'ai pas d'accès à l'API Netlify : ces valeurs sont à vérifier/saisir dans l'interface.
Changer une variable `VITE_*` nécessite un nouveau build (prochain push sur `main` ou, par vous,
*Clear cache and deploy* — le rideau 2 s'applique aussi aux déploiements manuels).

## 4. GitHub — variable de dépôt (à saisir dans Settings → Secrets and variables → Actions → Variables)

| Variable | Valeur | Rôle |
| --- | --- | --- |
| `VYORA_SITE_URL` | `https://vyora-saas-ugc.netlify.app` | cible de `.github/workflows/production-check.yml` (`scripts/verify-production.mjs`) ; repli codé = ancien domaine (404 aujourd'hui), le contrôle échouera jusqu'à ce que la variable existe |

L'API des variables de dépôt répond 403 à l'intégration utilisée ici : saisie manuelle nécessaire.

## 5. Dépôt — replis codés sur l'ancien domaine (PR séparée, après votre accord)

| Fichier | Aujourd'hui | Proposition |
| --- | --- | --- |
| `src/lib/origin-allowlist.ts` (`DEFAULT_ALLOWED_ORIGINS`) | `https://vyora-ugc.netlify.app` | ajouter `https://vyora-saas-ugc.netlify.app` (défaut des Edge qui l'importent — effet seulement après régénération des bundles et redéploiement : à planifier, pas maintenant) |
| `supabase/functions/_shared/saspay/http.ts` (`STATIC_ORIGINS`) | ancien domaine | idem (le secret `VYORA_PAYMENTS_ALLOWED_ORIGINS` couvre d'ici là) |
| `supabase/functions/business-grow/index.ts` (`productionOrigins`) | ancien domaine | idem |
| `.github/workflows/production-check.yml`, `scripts/verify-production.mjs` | repli `https://vyora-ugc.netlify.app` | repli `https://vyora-saas-ugc.netlify.app` |
| `docs/*` | ancien domaine | mise à jour |

## 6. Ordre d'application proposé (après votre feu vert explicite, étape par étape)

1. Lecture du journal Netlify de `ca410d5` (vous) → si « build refusé », correction ciblée par PR.
2. Secrets Edge (§1) : `VYORA_ALLOWED_ORIGINS`, `STORE_IMPORT_ALLOWED_ORIGINS`, création de
   `VYORA_PAYMENTS_ALLOWED_ORIGINS` → vérification pg_net immédiate.
3. GoTrue (§2) : `site_url` + `uri_allow_list` (ajout en tête, rien retiré) → relecture `get_auth_config`.
4. Netlify (§3) et GitHub (§4) : saisie par vous ; je vérifie ensuite `vyora-revision` et le workflow.
5. PR de nettoyage des replis codés (§5), sans redéploiement d'Edge tant que non validé.
