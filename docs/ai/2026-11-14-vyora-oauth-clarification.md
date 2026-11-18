# `vyora-oauth` en production — ce qu'elle est, et pourquoi elle n'entre pas en collision avec `vyora-mcp`

> Constat établi le 2026‑11‑17 par lecture seule de la production
> (projet `xbuuhfwobrafcbgtdgjx`), sans redéploiement ni modification.
> Toutes les valeurs ci-dessous sont soit lues en base, soit extraites des
> tranches d'artefact réellement servies, soit relevées par requête HTTP réelle.

## 1. Nature : un chargeur, pas un serveur OAuth

`vyora-oauth` est une fonction Edge **active, version 1**, jamais redéployée :

| champ | valeur |
|---|---|
| id | `30db5365-4f73-4eb3-8804-de76b07dc021` |
| version | `1` |
| `verify_jwt` | `false` |
| créée / mise à jour | `1794796048363` (identique) |

Son corps est un **chargeur** de 3 501 octets qui lit l'artefact
`vyora-oauth` dans `public._edge_function_artifact_slices`, le recompose, et
vérifie `SHA256 = 4a3f620661d713904679674d1d2d991579e56ebdbe9c6d47e73aef0f439a8888`
et `CHARS = 18868` **avant** de l'exécuter (`new Function(CODE)()`), avec repli
`503 EDGE_ARTIFACT_UNAVAILABLE`.

Décodage vérifié : les 4 tranches en base (7 764 caractères base64) se
décompressent en **18 868 caractères** dont l'empreinte SHA‑256 est exactement
celle annoncée par le chargeur. L'artefact servi en production est donc
authentique et intègre ; il n'est pas nécessaire de le reconstruire.

## 2. Rôle : les connecteurs, pas l'autorisation MCP

Le bundle porte des **scopes Google** (`gmail`, `google_drive`,
`google_calendar`, `openid`, `email`, `profile`, `offline_access`) et sept
actions accessibles via `?action=` ou un corps JSON :

| action | effet |
|---|---|
| `start` | démarre une autorisation fournisseur |
| `callback` | échange le code fournisseur |
| `list` | liste les comptes connectés |
| `revoke` | révoque un compte (révocation distante incluse) |
| `refresh` | rafraîchit un jeton fournisseur |
| `check` | vérifie une capacité |
| `audit` | journalise |

Les jetons fournisseurs sont chiffrés en **AES‑GCM** avec
`VYORA_OAUTH_ENCRYPTION_KEY`. Toute action autre que `callback` exige une
session utilisateur.

**C'est un gestionnaire de connexions OAuth tierces (Google), pas un serveur
d'autorisation OAuth 2.1.** Aucune des routes du serveur MCP n'y figure :
ni `/oauth/authorize`, ni `/oauth/token`, ni `/oauth/register`, ni
`/.well-known/oauth-*` (recherche exhaustive dans le bundle décodé).

## 3. Aucune dépendance partagée avec `vyora-mcp`

| objet | `vyora-oauth` | `vyora-mcp` (v6) |
|---|---|---|
| client OAuth | — | `public.mcp_oauth_clients` |
| jetons | — | `public.mcp_tokens`, `public.mcp_oauth_refresh` |
| codes | — | `public.mcp_oauth_codes` |
| connexions | `oauth_state`, `oauth_accounts` | `public.mcp_connections` |
| RPC | `oauth_*` (7 fonctions `SECURITY DEFINER`) | `mcp_*` |
| secrets | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `VYORA_OAUTH_ENCRYPTION_KEY`, `SUPABASE_*` | `SUPABASE_*` |

Les seules tables communes sont `public._edge_function_artifact_slices`
(une ligne par nom de fonction : `vyora-mcp` n'y touche que son propre nom) et
`auth.users` (identité, en lecture).

Point de vigilance vérifié : `public.oauth_accounts` est **vide** (0 ligne) et
`public.oauth_audit_log` ne contient qu'**1** ligne. Aucun jeton Google n'est
stocké actuellement, donc aucune connexion utilisateur n'est concernée.

## 4. Le serveur d'autorisation MCP est `vyora-mcp` lui‑même

`supabase/functions/vyora-mcp/index.ts` fixe `emetteur: RESSOURCE`, où
`RESSOURCE = https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp`.
`metadonneesAutorisation(emetteur)` dérive donc :

- `issuer` = `…/vyora-mcp`
- `authorization_endpoint` = `…/vyora-mcp/oauth/authorize`
- `token_endpoint` = `…/vyora-mcp/oauth/token`
- `registration_endpoint` = `…/vyora-mcp/oauth/register`

Le nom `vyora-oauth` n'apparaît que comme **espace de noms** dans
`PREFIXE_CSRF = 'vyora-oauth-csrf-v1:'` (`consentement.ts`) : c'est un
préfixe de sel, pas un appel réseau. Aucun code du dépôt n'appelle la fonction
`vyora-oauth`.

## 5. Risque de divergence dépôt ↔ production

Il existe, mais il est circonscrit et **volontairement laissé en l'état** :

- `vyora-oauth` (prod) et `vyora-ai`, `vyora-ai-providers`,
  `vyora-provider-health` lisent leur code **en base** ;
- `store-import` et `store-connect` lisent un bundle **épinglé sur GitHub**
  (`raw.githubusercontent.com/…/<commit>/…`) ;
- `vyora-mcp` (v6) lit son artefact **en base**.

Deux canaux coexistent donc. Ce n'est pas une incohérence à corriger dans cette
mission : toucher `vyora-oauth` reviendrait à redéployer une fonction v1
jamais modifiée, ce que la consigne interdit sans justification et validation
explicites.

## 6. Décision

- **Ne pas** redéployer, remplacer, renommer ni supprimer `vyora-oauth`.
- **Ne pas** toucher à ses secrets ni à ses jetons.
- La laisser hors du périmètre du déploiement `vyora-mcp` : elle ne sert
  aucune route MCP et ne partage aucune donnée métier avec lui.

Le déploiement de `vyora-mcp` v6 n'a d'ailleurs touché que les lignes
`name = 'vyora-mcp'` de la table d'artefacts ; les lignes `vyora-oauth`,
`vyora-ai`, `vyora-ai-providers` et `vyora-provider-health` sont inchangées
(empreintes md5 relevées avant et après : identiques).
