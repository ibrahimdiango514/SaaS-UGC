# P6c — OAuth 2.1 sortant du client MCP et page « Connexions MCP »

Date : 2026-11-18 · Branche : `arena/0188834f-saas-ugc` · Projet Supabase : `xbuuhfwobrafcbgtdgjx`

Ce rapport sépare **réel** (exécuté en production ou contre un vrai socket),
**simulé** (tests avec espions) et **indisponible** (non exercé, à ne pas
annoncer comme compatible).

---

## 1. L'objectif, et où il en est

> SORAHNEX doit pouvoir se connecter à une application tierce protégée par OAuth
> (Shopify, Notion, GitHub, un serveur MCP d'entreprise…), sans jamais demander
> à l'utilisateur de coller un jeton, et sans qu'un jeton transite par le
> navigateur. L'écran doit distinguer clairement les deux sens du protocole.

**État : le flux complet est écrit, testé, déployé (`mcp-client` v8), et ses
routes répondent en production. Il n'a pas encore été exercé de bout en bout
contre un fournisseur OAuth réel.** C'est l'étape qui reste et qui conditionne
toute promesse de compatibilité.

---

## 2. Ce qui a été construit

### 2.1 Le flux OAuth, côté Edge (`supabase/functions/mcp-client/`)

| Fichier | Rôle |
|---|---|
| `oauth.ts` | Découverte RFC 9728 (`/.well-known/oauth-protected-resource`) puis RFC 8414 (`/.well-known/oauth-authorization-server`), PKCE S256, enregistrement dynamique RFC 7591 si aucun `client_id` n'est fourni, échange du code, renouvellement, révocation RFC 7009. |
| `oauth-egress.ts` | Sortie réseau **dédiée** à OAuth. La sortie MCP (`safe-egress.ts`) n'autorise que `application/json`, or RFC 6749 impose `application/x-www-form-urlencoded` au point de jeton. Même politique que la sortie MCP : HTTPS seul, port 443, IP publiques uniquement, épinglage DNS, **zéro redirection suivie** (un 3xx est un échec), corps ≤ 64 Kio, délai 15 s. `safe-egress.ts` n'a **pas** été assoupli. |
| `oauth-http.ts` | `POST /gestion/oauth-demarrer` (JWT requis) et `GET /oauth/callback` (navigateur, HTML français, aucun jeton dans la page). |
| `oauth-acces.ts` | Accès SQL : état de flux à usage unique (10 min), stockage des jetons dans Vault via `mcp_oauth_stocker`, lecture via `mcp_oauth_lire`, destruction via `mcp_oauth_detruire`. |
| `execution.ts` | Avant chaque appel d'outil : si le jeton expire dans moins de 60 s et qu'un refresh existe, renouvellement ; si le renouvellement ne peut être persisté, refus (`renouvellement_non_persiste`) ; expiré sans refresh ⇒ `auth_required`, **avant tout octet réseau**. |

Règle PKCE retenue : si le serveur n'annonce pas `code_challenge_methods_supported`,
on poursuit en S256 et on l'indique à l'UI (`pkceAnnonce: false`) ; s'il n'annonce
que `plain`, on refuse (`422 pkce_non_supporte`).

### 2.2 La base

Migrations appliquées : `mcp_oauth_flows_p6c`, `mcp_oauth_outbound_p6c`,
`mcp_oauth_secret_lire_p6c`. Table `mcp_oauth_flows` avec RLS activée, **aucun
SELECT** pour `anon` ni `authenticated`. Secrets dans `vault.secrets` sous les
noms `mcp_server_<id>` et `mcp_oauth_client_secret_<id>`.

### 2.3 L'interface

Nouvelle page `/app/connexions-mcp` (entrée Sidebar « Connexions MCP »), un seul
`h1`, deux sections :

- **A. Connecter SORAHNEX à mes IA** — SORAHNEX est le *serveur* : clés pour Claude,
  Cursor, ChatGPT… (contenu de l'ancienne `/app/connexions-ia`).
- **B. Connecter mes applications à SORAHNEX** — SORAHNEX est le *client* : mes serveurs
  MCP externes, avec le bouton **« Autoriser via OAuth »** quand `authKind = oauth`.

Les anciennes routes `/app/connexions-ia` et `/app/mes-serveurs-mcp` restent
servies. Un encart dans la section A précise que la compatibilité avec les
clients MCP tiers est **attendue, pas certifiée**.

---

## 3. Preuves

### 3.1 Réel — production, `mcp-client` v8 (`verify_jwt: false`, auth en code)

Chargeur épinglé sur le commit `4675984`, artefact
`sha256 c4c830a7…` (68 979 caractères). Requêtes émises depuis la base
(`pg_net`), réponses relues dans `net._http_response` :

| Requête | Attendu | Obtenu |
|---|---|---|
| `GET /oauth/callback` sans paramètre | 400 HTML | **400**, « Requête incomplète — SORAHNEX » |
| `GET /oauth/callback?state=etat-inexistant&code=…` | 400 HTML (état refusé par la RPC réelle) | **400**, « Autorisation expirée… » |
| `GET /gestion/lister` | 405 | **405** `methode_non_autorisee` |
| `POST /gestion/oauth-demarrer` sans jeton | 401 | **401** `authentification_requise` |
| `POST /gestion/oauth-demarrer` avec `Bearer jeton.bidon.xyz` | 401 (refus GoTrue) | **401** |
| `POST /gestion/lister` sans jeton | 401 (contrat inchangé) | **401** |
| `POST /gestion/executer` sans jeton | 401 (contrat inchangé) | **401** |

Le passage de `verify_jwt` à `false` était **obligatoire** : le navigateur de
l'utilisateur revient sur `/oauth/callback` sans aucun en-tête `Authorization`.
L'identité reste vérifiée par le code (`/auth/v1/user`) sur toutes les routes de
gestion, comme `vyora-mcp` le fait déjà. Aucune route n'est devenue anonyme.

### 3.2 Réel — base de données

- `mcp_oauth_secret_ecrire` / `mcp_oauth_secret_lire` : aller-retour exact.
- `mcp_oauth_flux_consommer('etat-inexistant')` : **lève** `state_invalide`
  (un état inconnu ne peut pas être consommé silencieusement).
- `mcp_oauth_lire(uuid inexistant)` : objets nuls, pas d'erreur.
- Secrets de test supprimés après vérification (`vault.secrets name like '\_test%'` → 0).

### 3.3 Simulé — tests

- `npx tsc -b` → 0 erreur ; `npx tsc -p tsconfig.edge.json --noEmit` → 0.
- `npx vitest run` → **172 fichiers, 3 032 tests verts**.
- `tests/mcp-oauth.test.ts` (40) : vecteur PKCE de la RFC 7636 reproduit à
  l'octet (`dBjftJeZ4CVP-…` → `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`),
  découverte, enregistrement, échange, refresh, serveur HTTP local **réel** pour
  l'egress OAuth (socket injecté : TLS **non** exercé).
- `tests/mcp-connexions-page.test.tsx` (6) : deux titres, un seul `h1`, bouton
  OAuth présent/absent selon `authKind`, navigation vers l'URL d'autorisation,
  refus serveur affiché tel quel.

Base et Vault sont remplacés par des espions dans ces tests.

---

## 4. Indisponible — à ne pas annoncer comme compatible

| Point | Statut | Pourquoi |
|---|---|---|
| Flux complet contre un fournisseur OAuth réel | **Non exercé** | Aucun fournisseur public joignable depuis le sandbox ; l'essai doit être fait depuis un navigateur avec un compte réel. |
| `redirect_uri` déduit de `request.url` | **Non vérifié en réel** | Derrière le proxy Supabase, l'URL vue par la fonction doit être exactement `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/oauth/callback`. À confirmer au premier essai réel. |
| TLS de la sortie OAuth | **Simulé** | Le banc remplace le socket. La politique (443, épinglage) est testée, pas la poignée de main. |
| Révocation côté fournisseur | **Code présent, pas de route** | `revoquer()` existe dans `oauth.ts` ; la route `/gestion/oauth-revoquer` n'est pas branchée. La suppression locale (`detruireOAuth`) fonctionne. |
| Clients MCP tiers (section A) | **Non testés de bout en bout** | L'UI l'affiche explicitement. |
| Front | **Non déployé** | La page `/app/connexions-mcp` n'est visible qu'en local/preview. |

---

## 5. Prochaines étapes, dans l'ordre

1. **Essai réel** : enregistrer un serveur MCP OAuth (le plus simple : un serveur
   supportant l'enregistrement dynamique RFC 7591), cliquer « Autoriser via
   OAuth », noter chaque écart (`redirect_uri`, portées, format du jeton,
   `pkceAnnonce`). Le rapport sera mis à jour avec le résultat **réel**.
2. Route `/gestion/oauth-revoquer` + bouton « Retirer l'accès » dans la section B.
3. Déploiement du front, puis retrait éventuel des anciennes entrées Sidebar.

---

## 6. Commits de la phase

- `bdb35c9` — flux OAuth sortant, page unifiée, 46 tests.
- `4675984` — artefact `mcp-client.js` P6c.
- `6c9c93c` — chargeur épinglé sur `4675984` (v8).

Retour arrière possible : redéployer le chargeur de `ed0d4ea` (v7, épinglé sur
`db17aa4`) — la table `mcp_oauth_flows` et les RPC sont inertes sans le code.
