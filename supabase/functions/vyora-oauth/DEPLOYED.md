# `vyora-oauth` — connecteur Google (Gmail, Drive, Calendar)

Connecte un compte Google à un utilisateur VYORA, avec **permissions séparées**
et **révocation réelle**. Cette fonction est le socle commun de Gmail, Google
Drive et Google Calendar.

## État actuel — ce qui marche et ce qui bloque

| Élément | État | Preuve |
|---|---|---|
| Socle OAuth (état CSRF, PKCE, chiffrement) | **opérationnel** | 40 tests + 34 tests unitaires |
| Tables `oauth_accounts` / `oauth_states` / `oauth_audit_log` | **en production** | 3 tables, RLS active, 20 colonnes vérifiées |
| 10 RPC, privilèges fermés | **en production** | `has_function_privilege` : 0 accessible à `anon` |
| Edge Function déployée | **v1 ACTIVE** | `30db5365-4f73-4eb3-8804-de76b07dc021` |
| Artefact (4 tranches, SHA-256) | **en production** | MD5 `58b0ca4c3e66c46dba102a89e93cfa89` |
| Clé de chiffrement `VYORA_OAUTH_ENCRYPTION_KEY` | **créée** | empreinte `26d2f83e8276…` vérifiée |
| **Identifiants Google** | **ABSENTS** | `start` → `503 google_not_configured` |

**Conséquence honnête** : aucun compte Google ne peut être connecté aujourd'hui.
Il manque `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`, qui ne peuvent être
produits que par le propriétaire du projet dans Google Cloud Console. Tout le
reste est écrit, déployé et testé.

## Preuves d'exécution réelle en production

Requêtes réelles contre `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth`
via `pg_net` (le sandbox de développement n'a aucun accès réseau vers
`*.supabase.co` ; le seul chemin réel est côté base) :

| Requête | Attendu | Obtenu |
|---|---|---|
| `POST` sans `Authorization` | refus | **401 `unauthorized`** |
| `GET ?action=callback&state=inconnu` (sans jeton) | CSRF refuse, mais route ouverte | **400 `state_invalid`** |
| `POST {action:start}` avec jeton | identifiants manquants | **503 `google_not_configured`** |

Le 401 sur la première requête prouve aussi que **le chargeur a bien recomposé
l'artefact** : un artefact absent ou altéré aurait renvoyé
`503 EDGE_ARTIFACT_UNAVAILABLE`.

## Architecture de sécurité

```
Navigateur ──(JWT Supabase)──► vyora-oauth ──► PostgREST (service_role)
                                    │                  │
                                    ▼                  ▼
                              Google OAuth      oauth_states (chiffré)
                                                oauth_accounts (chiffré)
```

- **Aucun jeton Google ne quitte le serveur.** La réponse de `callback` contient
  l'e-mail, les capacités et l'identifiant de compte — jamais un jeton. Un test
  vérifie que la réponse ne contient ni `ya29…` ni le refresh token.
- **Chiffrement AES-256-GCM**, clé en secret Supabase uniquement. Chaque jeton
  (access *et* refresh) possède **son propre IV et sa propre étiquette GCM** —
  réutiliser un IV sous la même clé détruirait la confidentialité. Deux tests
  de régression verrouillent ce point.
- **PKCE obligatoire** : le vérificateur est chiffré en base avant l'envoi vers
  Google, et n'est déchiffré qu'au retour.
- **État à usage unique** : `oauth_state_consume` pose `consumed_at` sous
  `for update`. Un rejeu concurrent ne peut pas aboutir deux fois. L'état est
  consommé **avant** l'échange de code, donc une erreur d'échange ne rouvre pas
  la fenêtre de rejeu.
- **Capacités déduites des scopes réellement accordés**, pas de ceux demandés :
  si l'utilisateur refuse une permission, elle n'est jamais enregistrée.
- **Révocation qui efface** : `oauth_revoke_account` met à `null` les
  cryptogrammes *et* leurs IV/étiquettes. Un jeton révoqué ne reste pas
  déchiffrable en base.

## Permissions séparées

| Capacité | Gmail | Drive | Calendar |
|---|---|---|---|
| `read` | `gmail.readonly` | `drive.readonly` | `calendar.readonly` |
| `draft` | `gmail.compose` | — | — |
| `send` | `gmail.send` | — | — |
| `modify` | `gmail.modify` | `drive.file` | `calendar.events` |

Une capacité non supportée par le fournisseur est **refusée explicitement**
(`capability_not_supported`), jamais ignorée. `send` n'est jamais impliqué par
`draft` : ce sont deux scopes distincts, vérifiés par test.

`include_granted_scopes` est volontairement **absent** de l'URL d'autorisation :
il élargirait silencieusement les permissions d'une autorisation antérieure.

## Routes

| Action | Méthode | Jeton requis | Rôle |
|---|---|---|---|
| `start` | POST | oui | crée état + PKCE, rend l'URL Google |
| `callback` | GET/POST | **non** | terminaison OAuth (redirection navigateur) |
| `list` | POST | oui | comptes connectés, sans aucun jeton |
| `revoke` | POST | oui | révoque chez Google puis efface localement |
| `refresh` | POST | oui | rafraîchit un jeton expiré |
| `check` | POST | oui | vérifie une capacité avant un appel métier |
| `audit` | POST | oui | journal des actions |

`callback` est la seule route sans JWT : Google redirige le navigateur sans
en-tête `Authorization`. Sa sécurité repose sur l'état à usage unique + PKCE,
qui sont précisément conçus pour cela.

## Pour activer Gmail (action requise du propriétaire)

1. **Google Cloud Console** → créer un projet (ou réutiliser).
2. **API et services → Bibliothèque** → activer *Gmail API* (puis *Google Drive
   API* et *Google Calendar API* selon les besoins).
3. **Écran de consentement OAuth** :
   - type *Externe*, mode *Test* suffit pour un premier essai ;
   - scopes : ceux listés ci-dessus, un par capacité réellement voulue ;
   - ajouter le compte Google testeur.
4. **Identifiants → Créer → ID client OAuth**, type *Application Web* :
   - URI de redirection autorisée :
     `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth?action=callback`
5. Fournir `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.

Dès que ces deux secrets existent, **aucun redéploiement n'est nécessaire** :
`start` les lit à l'exécution.

## Régénérer l'artefact après une modification du code

```bash
node scripts/build-edge-loader.mjs vyora-oauth   # écrit le bundle, le chargeur, la migration SQL
```

Puis, dans l'ordre :
1. republier les tranches : `delete from public._edge_function_artifact_slices
   where name = 'vyora-oauth';` puis une insertion **par tranche** (le canal
   n'accepte pas de `VALUES` multiples volumineux) ;
2. vérifier `select count(*), md5(string_agg(chunk, '' order by part))` ;
3. redéployer `supabase/functions/vyora-oauth/loader.ts` (3,5 Ko).

Le chargeur refuse d'exécuter un artefact dont la taille ou le SHA-256 ne
correspond pas : une divergence devient impossible en silence.

## Tests

| Fichier | Contenu |
|---|---|
| `tests/oauth-google.test.ts` | 34 tests — chiffrement AES-GCM, PKCE, scopes, échange de code, refresh, révocation, décodage du compte |
| `tests/oauth-connector.test.ts` | 40 tests — `start`, `callback`, isolation entre utilisateurs, garde de capacités, révocation effective, rafraîchissement, routage HTTP, absence de fuite de jeton |
| `tests/edge-loader-parity.test.ts` | parité dépôt ↔ artefact, `vyora-oauth` inclus automatiquement |

Ces tests utilisent un `fetch` injecté et un store en mémoire : ils ne
dépendent ni du réseau ni d'un secret. **Ils ne remplacent pas** un essai avec de
vrais identifiants Google — c'est la première chose à faire une fois les
secrets fournis.

## Non testé (à faire avec les identifiants réels)

- L'échange de code réel contre `oauth2.googleapis.com`.
- Le contenu réel des `id_token` renvoyés par Google.
- La révocation réelle côté Google.
- Le comportement si l'utilisateur refuse une permission dans l'écran de
  consentement (le code le gère, mais seul un essai réel le confirme).
