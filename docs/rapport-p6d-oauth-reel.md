# P6d — Validation OAuth réelle du client MCP, révocation, et front hors Netlify

Branche : `arena/0188834f-saas-ugc` · Production : `mcp-client` **v10** (`verify_jwt: false`, authentification en code) · Projet Supabase `xbuuhfwobrafcbgtdgjx`.

Convention : **réel** = requête HTTP réellement envoyée en production (depuis `pg_net`, car cet environnement n'a pas d'accès réseau sortant aux domaines de production) et réponse relue dans `net._http_response` ; **simulé** = test Vitest ; **non réalisable ici** = exige un navigateur humain.

---

## 1. Résultat en une page

| Demande | État |
| --- | --- |
| Fournisseur MCP de test avec OAuth réel | **Trouvé** : Linear (`https://mcp.linear.app/mcp`). Six autres vérifiés compatibles, un (GitHub) incompatible — §2. |
| Audit HTTP réel du callback de production | **Fait**, 25 requêtes réelles, aucune fuite — §3. Un défaut démontré, corrigé en v10 — §5. |
| Cycle OAuth complet (10 étapes) | **5 étapes réelles réussies** (démarrage/DCR, callback défensif, stockage, renouvellement réel, révocation réelle), **5 étapes non réalisables sans navigateur** (consentement humain) — §4. L'URL d'autorisation est prête à être ouverte par un humain. |
| `POST /gestion/oauth-revoquer` | **Livrée et prouvée en production** (RFC 7009 réel vers Linear) — §4.10. |
| Page unifiée « Connexions MCP » | Examinée en aperçu local ; un manque corrigé (barre d'actions absente en mode intégré) — §6. |
| Front sans Netlify | **Analysé, pas déployé** : recommandation Cloudflare Pages + workflow manuel prêt, 5 prérequis bloquants listés — §7. |
| Données / fonctions existantes | Conservées. Toute donnée de test détruite (vérification « 0 reste », §8). `vyora-mcp` v6 intact. |

---

## 2. Fournisseurs testés (réel, métadonnées + enregistrement)

Pour chaque candidat : `GET /.well-known/oauth-protected-resource` sur l'URL MCP, puis `GET /.well-known/oauth-authorization-server` sur le serveur d'autorisation annoncé, puis un **vrai** `POST` d'enregistrement dynamique (RFC 7591) là où il est annoncé.

| Fournisseur | URL MCP | Serveur d'autorisation | DCR | PKCE | Auth client | Révocation | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Linear** | `https://mcp.linear.app/mcp` | `https://mcp.linear.app` | **201 réel** (client public `cONJztR_4WhKyp3F`) | S256 | `none` | `revocation_endpoint` annoncé, **utilisé en réel** | **Retenu** |
| Notion | `https://mcp.notion.com/mcp` | `https://mcp.notion.com` | 201 réel | S256 | `none` | annoncé | compatible |
| Sentry | `https://mcp.sentry.dev/mcp` | `https://mcp.sentry.dev` | 201 réel | S256 | `none` | annoncé | compatible |
| Atlassian | `https://mcp.atlassian.com/v1/mcp` | `https://mcp.atlassian.com` | annoncé | S256 | `none` | annoncé | compatible (non enregistré, pour ne pas créer de client inutile) |
| Cloudflare | `https://mcp.cloudflare.com/mcp` | idem | annoncé | S256 | `none` | — | compatible |
| Stripe | `https://mcp.stripe.com` | idem | annoncé | S256 | `none` | — | compatible |
| Vercel | `https://mcp.vercel.com` | idem | annoncé | S256 | `none` | — | compatible |
| **GitHub** | `https://api.githubcopilot.com/mcp/` | `https://github.com/login/oauth` | **absent** | S256 | secret requis | — | **Incompatible sans action humaine** : il faut créer une OAuth App GitHub à la main et saisir `client_id` + secret. Le client répond **422 `enregistrement_indisponible`** (réel, requête 14080) au lieu de planter ou d'inventer un flux. |
| Hugging Face | `https://huggingface.co/mcp` | — | — | — | — | — | 404 sur les métadonnées : pas d'OAuth MCP exposé. |

Ce que ça établit : il n'y a **pas** un flux unique. Deux familles réellement rencontrées : (a) DCR + PKCE + client public (7 fournisseurs), que le client gère de bout en bout ; (b) client pré-enregistré avec secret (GitHub), que le client **refuse proprement** tant que l'utilisateur n'a pas fourni ses identifiants. Les formes mixtes (secret saisi + DCR absent) sont acceptées : `creer` en mode `oauth` accepte désormais un secret facultatif, stocké au Vault sous `mcp_oauth_client_secret_<id>`.

---

## 3. Audit HTTP réel du callback et des routes de gestion

Toutes les requêtes sont consignées avec leur `id` dans `net._http_response` (identifiants ci-dessous). Les comptes A et B sont des comptes réels GoTrue créés pour la campagne (JWT obtenus par `grant_type=password`), détruits ensuite.

### 3.1 Callback `GET /oauth/callback` (anonyme par nature)

| # | Cas | Réponse réelle | Preuve |
| --- | --- | --- | --- |
| 14064 / 14078 | `state` absent/inconnu, `error=access_denied`, description contenant `<script>` | **400** page « Autorisation refusée », balises **échappées** (`&lt;script&gt;`) | v8 et v9 : aucune réflexion de HTML |
| 14063 | Sonde avec en-tête `apikey` manquant (v8) | 403 (passerelle) | montre que le callback doit rester hors `verify_jwt` — il l'est |
| 14079 | `state` **réel** (issu de 14076) + `code` forgé | **502** « Échange refusé » — Linear a répondu `invalid_grant : Invalid authorization code format` | le code forgé est passé au vrai point de jeton, **rien n'a été stocké**, l'état est **consommé** |
| 14083 | Rejeu du **même** `state` | **400** « Autorisation expirée » | usage unique prouvé |
| 14084 | Flux créé puis `expire_le` dans le passé | **400** « Autorisation expirée » | expiration honorée |
| — | Liaison utilisateur + connexion | le flux porte `user_id` + `server_id` ; `mcp_oauth_flux_consommer` lève `state_invalide` pour tout état non strictement identique | l'état est 32 octets aléatoires, consommé en une transaction |
| 14096 | `oauth-demarrer` avec `redirectUri` / `redirect_uri` hostiles dans le corps | **200**, `redirectUri` renvoyé = canonique (`…/functions/v1/mcp-client/oauth/callback`), l'URL d'autorisation ne contient pas l'hôte hostile | redirect_uri **non paramétrable** par le client |

PKCE : vérifié côté fournisseur (S256 exigé par les métadonnées des 7 fournisseurs) ; le `code_verifier` ne quitte jamais la base (table `mcp_oauth_flows`, RLS, lu par RPC `security definer`). Un fournisseur n'annonçant que `plain` est refusé **422** (simulé).

### 3.2 Routes de gestion (`/gestion/*`)

| # | Appelant | Route | Réponse réelle |
| --- | --- | --- | --- |
| 14085 | B | `lister` | 200 `serveurs: []` — B ne voit pas les serveurs de A |
| 14086 / 14087 / 14088 / 14057 | B sur le serveur de A | `tester` / `executer` / `oauth-revoquer` / `oauth-demarrer` | **404 `server_not_found`** (pas 403 : l'existence n'est pas divulguée) |
| 14089 / 14101 | anonyme | `oauth-revoquer` / `lister` | **401 `authentification_requise`** |

Fuite : aucune réponse (gestion ou callback) ne contient de `code`, de jeton d'accès, de refresh ou de secret client ; `lister` ne renvoie que `oauth_client_id` (public par nature) et `status`.

---

## 4. Cycle OAuth complet — Linear, compte A, serveur `a463db88…`

| Étape | Résultat | Preuve |
| --- | --- | --- |
| 1. Démarrer | **Réussie (réel)** — 14076 : `200`, DCR réel chez Linear, `autorisationUrl` avec `code_challenge_method=S256`, `resource=https://mcp.linear.app/mcp`, `scope=read write`, `redirect_uri` canonique | `clientEnregistre:true`, `client_id` persisté dans `mcp_servers.oauth_client_id` |
| 2. Page d'autorisation du fournisseur | **Non réalisable ici** — exige un navigateur et une session Linear humaine | l'URL est régénérable à la demande (`oauth-demarrer`) ; aucun jeton ne transite par le front |
| 3. Accepter | **Non réalisable ici** (même raison) | — |
| 4. Callback avec un vrai `code` | **Non réalisable ici** ; en revanche le callback a été exercé en réel avec vrai `state` + faux `code` (502, rien stocké) et avec rejeu/expiration (400) | §3.1 |
| 5. Échange du code | **Mécanisme prouvé en réel** : le client a bien appelé le vrai point de jeton Linear (réponse `invalid_grant` relayée en 14079) ; l'échange d'un vrai code dépend de l'étape 3 | — |
| 6. Stockage Vault | **Réussie (réel, base)** : `mcp_oauth_stocker` → 2 secrets (`mcp_server_<id>`, `mcp_oauth_refresh_<id>`), lisibles uniquement par RPC `security definer`, jamais renvoyés au front | comptages relus |
| 7. Découverte des outils | **Non réalisable ici** (exige un jeton réel) ; simulée (tests `tools/list`) | — |
| 8. Exécution d'un outil | **Non réalisable ici** avec un vrai jeton ; prouvée en réel pour le chemin « jeton expiré » (étape 9) | — |
| 9. Expiration + renouvellement | **Réussie (réel)** — 14095 (v9) puis 14100 (v10) : accès marqué expiré, refresh factice → le client a **appelé le vrai point de jeton Linear**, qui a refusé `invalid_grant : Invalid token format` → réponse **409 `auth_required`** avec le motif, serveur basculé `auth_required`, aucun outil exécuté | v9 répondait 502 sans motif : défaut corrigé (§5) |
| 10. Révocation | **Réussie (réel)** — 14091 : `POST /gestion/oauth-revoquer` → `200 {distant:"revoque", jetonsDetruits:2, status:"auth_required"}` ; appel **RFC 7009 réel** vers `https://mcp.linear.app/revoke` (`token_type_hint=refresh_token` puis `access_token`) ; Vault : 0 secret ; flux : 0 ; `secret_ref` null ; `tools` vidé ; `oauth_client_id` conservé | Puis 14092 `executer` → **409 `connexion_indisponible`** ; 14093 `tester` → **409 `auth_required`** ; 14094 re-`demarrer` → 200 **sans nouveau DCR** (client réutilisé) |

Honnêtement : **les étapes 2, 3, 4 (vrai code), 7 et 8 (vrai jeton) n'ont pas été réalisées**, parce qu'elles nécessitent qu'un humain se connecte à Linear dans un navigateur. Tout ce qui les entoure (avant : démarrage réel ; après : stockage, renouvellement réel, révocation réelle, blocage) a été exécuté en production. Pour terminer : ouvrir la page « Connexions MCP », créer un serveur `https://mcp.linear.app/mcp` en mode OAuth, cliquer « Autoriser », accepter chez Linear ; le callback de production fera le reste.

### Contrat de `POST /gestion/oauth-revoquer`

Entrée `{ serverId }`. Sortie 200 : `{ ok:true, distant: "revoque" | "refuse" | "indisponible" | "aucun_jeton", detailDistant?, jetonsDetruits, status:"auth_required" }`. Erreurs : 400 `mode_non_oauth`, 401, 404 `server_not_found`, 500 `destruction_impossible` (les secrets locaux n'ont pas pu être détruits — jamais silencieux). Le distant est appelé **avant** la destruction locale (sinon on ne peut plus le révoquer), mais un refus/indisponibilité distante **n'empêche pas** la destruction locale : l'accès est coupé de notre côté quoi qu'il arrive. L'historique non sensible (`mcp_servers`, `oauth_client_id`, `oauth_as`, journal d'exécution) est conservé.

---

## 5. Défauts démontrés et corrigés (rien d'autre n'a été touché)

| Défaut (démontré par) | Correction | Version |
| --- | --- | --- |
| `oauth-demarrer` v8 : 422 `enregistrement_refuse` — le DCR réel échouait parce que `redirect_uri` n'était pas une URL https publique (14056) | `resoudreUrlCallback` : URL canonique dérivée de `SUPABASE_URL` (ou `MCP_CLIENT_CALLBACK_URL`), jamais lue depuis la requête | v9 |
| Échec de l'échange : le fournisseur répondait un JSON d'erreur non remonté (502 « Échange refusé » sans cause) (14079) | `codeErreurOAuth` appliqué au statut non-2xx du point de jeton : le `error` RFC 6749 est relayé | v9 |
| `creer` en mode OAuth imposait un secret factice (14055) | secret facultatif en mode `oauth` ; stocké au Vault seulement s'il est fourni | v9 |
| Renouvellement refusé → **502** sans motif alors que `tester` répondait 409 (14095) | `statutHttp('auth_required')` → **409** ; message = motif du fournisseur (14100) | v10 |
| Page unifiée : pas de bouton « Ajouter un serveur » quand le composant est intégré sans en-tête | barre d'actions rendue aussi en mode `sansEnTete` | front (non déployé) |

Non touchés, volontairement : `safe-egress.ts`, `pinned-fetch.ts`, `vyora-mcp`, les politiques RLS existantes.

---

## 6. Page unifiée « Connexions MCP »

Vérifiée en aperçu local (Vite, `/app/connexions-mcp`, 200). Mode OAuth : champ secret facultatif, bouton « Autoriser » (ouvre l'`autorisationUrl` dans un nouvel onglet, jamais de jeton côté front), état `auth_required` lisible, bouton « Retirer l'accès OAuth » (appelle `oauth-revoquer`, affiche `distant`/`jetonsDetruits`). Tests : `tests/mcp-connexions-page.test.tsx` 10/10, `tests/mcp-oauth.test.ts` 60/60.

---

## 7. Déploiement du front sans Netlify — analyse, pas d'action

### Ce que Netlify faisait (à remplacer à l'identique)

`netlify.toml` : build `npm ci && npm run build`, publication `dist`, repli SPA `/* → /index.html 200` (aussi dans `public/_redirects`), un relais `/api/business-grow` (edge function + `netlify/functions/business-grow.mjs`, sans secret). Hors Netlify, `src/business/api.ts` bascule de lui-même sur les transports `direct` puis `relay` : **le relais Netlify n'est pas nécessaire**.

### Options

| Option | Coût | SPA | Domaine | Retour arrière | Réserve |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Pages** (recommandé) | gratuit (500 builds/mois, bande passante illimitée) | `_redirects` natif | domaine perso + TLS gratuits | bouton « Rollback » sur chaque publication | aucune bloquante |
| Vercel | gratuit (Hobby) **mais usage commercial interdit** sur Hobby → plan Pro payant | `vercel.json` à ajouter | oui | oui | SaaS = plan payant |
| GitHub Pages | gratuit | repli SPA bricolé (`404.html`) | oui | redéployer l'ancien commit | **CGU : pas de SaaS/commerce** — à exclure |
| Supabase Storage + CDN | inclus | non (pas de repli SPA) | non | manuel | inadapté à une SPA |

### Ce qui est prêt dans le dépôt

`.github/workflows/frontend-cloudflare-pages.yml` : **déclenchement manuel uniquement** (`workflow_dispatch`), build + `wrangler pages deploy dist`, environnement `preview` par défaut. Il échoue immédiatement, sans rien publier, si les secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` manquent.

### Prérequis bloquants avant tout déploiement (à faire par vous)

1. **Compte + projet Cloudflare Pages** en « Direct Upload », et les deux secrets de dépôt.
2. **CORS Edge** : la nouvelle origine (`https://<projet>.pages.dev` et/ou domaine perso) doit être ajoutée à `VYORA_ALLOWED_ORIGINS` des fonctions `mcp-client`, `store-import`, `store-connect`, `business-grow` (ou à `DEFAULT_ALLOWED_ORIGINS` dans `src/lib/origin-allowlist.ts`, ce qui demande un redéploiement de ces fonctions). Sans ça : connexion OK mais **tous les appels MCP refusés** depuis le nouveau domaine.
3. **GoTrue** : ajouter l'origine aux URL de redirection autorisées (Auth → URL Configuration) et définir `VITE_SITE_URL` au build, sinon liens magiques et réinitialisations renvoient vers Netlify.
4. **Domaine** : décider si `vyora-ugc.netlify.app` est abandonné (le DNS d'un domaine perso bascule sans interruption ; l'URL `netlify.app` elle, ne se redirige pas une fois les crédits coupés).
5. **Rollback** : premier déploiement en `preview` seulement ; passage en `production` après vérification du constat (`.github/workflows/production-check.yml` accepte `site_url`).

---

## 8. Isolation, nettoyage, versions, commits

**Isolation** : RLS sur `mcp_servers`, `mcp_servers_secrets`, `mcp_oauth_flows` ; toute route de gestion filtre `user_id = auth.uid()` avant tout accès Vault ; B n'a jamais obtenu autre chose que `[]`, 404 ou 401 en réel.

**Nettoyage (réel, vérifié « 0 reste »)** : comptes `p6d-*`, espaces « P6d test », serveurs de test (dont `a463db88…` Linear et `d6e3f6cf…` GitHub), secrets Vault, flux, tables/fonctions `_p6d_*`. Le client public `cONJztR_4WhKyp3F` reste enregistré chez Linear (le DCR ne prévoit pas de suppression ; il est inerte sans jeton). Protocole reproductible : `supabase/tests/mcp-oauth/00-protocole-p6d.sql`.

**Production** :

| Fonction | Version | Épinglage | Rollback |
| --- | --- | --- | --- |
| `mcp-client` | **v10** ACTIVE, `verify_jwt:false` | `COMMIT=37884b8…`, `ARTIFACT_SHA256=e98767ac…` | v9 (`7763f4b`, `73506e7b…`), v8 (`4675984`, `c4c830a7…`) |
| `vyora-mcp` | v6 | inchangé | — |
| Migration | `mcp_oauth_p6d` appliquée | `supabase/migrations/20261118120000_mcp_oauth_p6d.sql` | — |

**Commits de la phase** (tous poussés sur `arena/0188834f-saas-ugc`, pas de fusion dans `main`) : `3329a63` (callback canonique, erreurs RFC relayées, secret facultatif, révocation, tests), `7763f4b` (artefact v9), `07cbcb9` (chargeur v9), `6b7d371` (409 `auth_required` + motif), `37884b8` (artefact v10), `fd928e8` (chargeur v10), puis le commit de ce rapport (workflow Cloudflare manuel, protocole SQL, rapport).

**Tests** : suite Vitest complète relancée après v10 (3062/3062, 173 fichiers), `tsc -b` 0, `tsconfig.edge` 0.

---

## 9. Limites, sans détour

- Le consentement OAuth humain (étapes 2–4, 7–8 avec vrai jeton) **n'a pas eu lieu** : à faire par vous dans un navigateur ; tout est en place pour.
- Le front corrigé (page unifiée, bouton de révocation) **n'est pas déployé** : Netlify est hors service et je n'ai pas déployé ailleurs sans votre feu vert (§7).
- `oauth-revoquer` sur un fournisseur **sans** `revocation_endpoint` renvoie `distant:"indisponible"` et détruit le local : prouvé en simulé seulement (tous les fournisseurs réels testés annoncent un endpoint ou n'ont pas été connectés).
- Dette inchangée et hors périmètre : `_bg_artifact_parts` sans RLS ; rôle `anon` trop large sur `vyora_files`.
