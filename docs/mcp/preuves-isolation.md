# VYORA — preuves d'isolation OAuth et MCP

Ce document consigne **ce qui a été vérifié, et comment**. Il distingue
systématiquement :

- **[LOCAL]** : vérifié par des tests exécutés dans ce dépôt, reproductibles par
  `npx vitest run tests/oauth-isolation.test.ts` et suivants.
- **[PROD]** : vérifié contre le projet Supabase déployé
  (`xbuuhfwobrafcbgtdgjx`), par requête SQL ou lecture de la configuration.

Aucune ligne n'est une intention. Ce qui n'a pas pu être vérifié est écrit
comme tel, dans la section « Ce qui reste non vérifié ».

---

## Résumé

| Question | Réponse | Preuve |
|---|---|---|
| Les tables OAuth sont-elles isolées par RLS ? | **oui** | [PROD] + [LOCAL] |
| Les tables sont-elles inaccessibles à `anon`/`authenticated` ? | **oui** | [PROD] |
| Les RPC de secrets sont-elles réservées à `service_role` ? | **oui** | [PROD] 27/27 |
| B peut-il lire, révoquer, rafraîchir le compte de A ? | **non** | [LOCAL] |
| B peut-il appeler `tools/call` sur le compte de A ? | **non** | [LOCAL] |
| Un refus croisé contacte-t-il Google ? | **non** | [LOCAL] |
| **L'identité de l'appelant est-elle authentifiée ?** | **OUI — corrigé** | [LOCAL] + [PROD] config |
| Un `Bearer <uuid>` ouvre-t-il encore quelque chose ? | **non, 401** | [LOCAL] |
| `callback` reste-t-il public ? | **oui** | [LOCAL] |
| Les refus de propriété sont-ils journalisés ? | **oui** | [LOCAL] |

Les sections 6 et 7 décrivent la faille et le manque **tels qu'ils ont été
trouvés**, puis la correction appliquée. Elles sont conservées parce qu'elles
expliquent pourquoi le code est écrit ainsi aujourd'hui.

---

## 1. RLS sur les tables OAuth [PROD]

```sql
select c.relname, c.relrowsecurity, count(p.polname)
from pg_class c ... where c.relname in
  ('oauth_accounts','oauth_states','oauth_audit_log') group by ...
```

| Table | RLS activée | Politiques |
|---|---|---|
| `oauth_accounts` | `true` | 1 |
| `oauth_audit_log` | `true` | 1 |
| `oauth_states` | `true` | 0 |

`oauth_states` a la RLS active sans politique : **aucun accès possible**, ce qui
est le comportement voulu (les états CSRF ne sont manipulés que par les RPC
serveur).

Politiques permissives (`using (true)`) : **0**. Vérifié par requête :

```sql
select count(*) from pg_policy p ... where pg_get_expr(p.polqual, p.polrelid) = 'true';
-- → 0
```

## 2. Privilèges de table [PROD]

`has_table_privilege` pour `anon` et `authenticated` sur les trois tables :

| Table | anon SELECT | anon INSERT | authenticated SELECT | authenticated INSERT |
|---|---|---|---|---|
| `oauth_accounts` | `false` | `false` | `false` | `false` |
| `oauth_audit_log` | `false` | `false` | `false` | `false` |
| `oauth_states` | `false` | `false` | `false` | `false` |

**Aucun rôle client ne peut lire ces tables directement**, y compris avec un JWT
valide. L'accès passe obligatoirement par les RPC. La RLS et le `revoke` se
doublent : une erreur de politique ne suffirait pas à exposer les données.

## 3. Privilèges des RPC [PROD]

27 combinaisons (9 fonctions × 3 rôles) vérifiées par `has_function_privilege`.

**RPC de secrets** — `anon: false`, `authenticated: false`, `service_role: true` :

- `oauth_account_secret`
- `oauth_account_set_status`
- `oauth_account_upsert`
- `oauth_audit_write`
- `oauth_state_create`
- `oauth_state_consume`

Ces six fonctions manipulent des cryptogrammes **sans contrôle de propriétaire** :
elles font confiance à l'appelant. Les réserver à `service_role` est donc la
protection essentielle — un client qui pourrait les appeler lirait les jetons
chiffrés de n'importe qui.

**RPC utilisateur** — `anon: false`, `authenticated: true`, bornées par `auth.uid()` :

- `oauth_list_accounts`
- `oauth_revoke_account`
- `oauth_audit_list`

## 4. État réel des données [PROD]

| Objet | Valeur |
|---|---|
| Comptes OAuth | **0** |
| États en attente | **0** |
| Journal d'audit | 1 entrée |

Aucun compte n'existe : il n'y a donc **aucune donnée utilisateur à exposer
aujourd'hui**. C'est précisément pourquoi la faille de la section 6 n'a pas
encore eu de conséquence réelle — et pourquoi il faut la corriger avant le
premier compte connecté.

## 5. Ce que les tests locaux démontrent

`tests/oauth-isolation.test.ts` (25 tests) attaque l'isolation du point de vue
d'un utilisateur B :

- `list` ne rend que les comptes de B, et transmet **le JWT de B**, jamais la
  clé `service_role` (qui contournerait la RLS)
- les colonnes de jeton sont retirées même si PostgREST les renvoyait
- B ne peut ni révoquer, ni rafraîchir, ni vérifier le compte de A → `403`
- **aucun appel réseau vers Google** n'a lieu lors d'un refus croisé
- le jeton n'apparaît dans aucune réponse, y compris pour son propriétaire
  (`check` renvoie un booléen)
- un compte révoqué est inaccessible **à son propre propriétaire**
- les capacités de B ne s'étendent jamais à celles de A
- contre-épreuve : A réussit là où B échoue (un contrôle qui refuserait tout le
  monde ne prouverait rien)

`tests/oauth-rls-contract.test.ts` (17 tests) vérifie que le schéma **déclare**
ces protections, et empêche leur régression silencieuse. Deux sabotages ont été
introduits volontairement pour confirmer que ces tests mordent :

| Sabotage | Test devenu rouge |
|---|---|
| suppression du `revoke ... from authenticated` | « les tables sont révoquées pour anon ET authenticated » |
| retrait de `and user_id = v_user` dans la révocation | « ne révoque que si le compte appartient à l'appelant » |

---

## 6. FAILLE (CORRIGÉE) — l'identité de l'appelant n'était pas authentifiée

> **État : corrigée.** Cette section conserve l'analyse d'origine, parce qu'elle
> explique la forme du code actuel. La correction est décrite en section 6 bis.

### Le constat [PROD]

```
get_edge_function('vyora-oauth') → verify_jwt: false
```

Vérifié sur le déploiement réel, pas dans un fichier de configuration.

### La cause [code]

`callerId()` dans `supabase/functions/vyora-oauth/index.ts` :

```ts
const header = request.headers.get('Authorization') ?? '';
return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() || null : null;
```

La chaîne après `Bearer ` est retournée **telle quelle**. Aucune vérification de
signature, d'expiration, ni même de format. Elle devient ensuite `userId` dans :

```ts
if (row.user_id !== userId) return fail(403, 'forbidden');
```

### La conséquence

`Authorization: Bearer <uuid-de-la-victime>` suffit à se faire passer pour elle.
Le contrôle de propriété compare alors la victime **à elle-même** et laisse
passer. Ce n'est pas un défaut d'isolation — les comparaisons sont justes —
c'est un défaut d'**authentification** qui les rend inopérants.

Le commentaire d'en-tête du fichier affirme pourtant :

> La fonction est déployée `verify_jwt: true` : toute requête doit porter un JWT
> Supabase valide.

C'est **faux** pour le déploiement actuel. Le commentaire décrit une intention,
pas la réalité.

Portée exacte, sans exagération :

- **Exploitable** : `list` et `audit` (les RPC s'appuient sur `auth.uid()`, qui
  lit le JWT vérifié par PostgREST — une valeur forgée n'y donne rien, mais
  `handleList` transmet le porteur à PostgREST qui, lui, le rejette : `502`).
  Autrement dit, la RLS tient, mais le code croit une identité fausse.
- **Non exploitable aujourd'hui** : `tools_call`, `revoke`, `refresh`, `check`
  comparent `row.user_id` à l'identité forgée. Un attaquant qui présente l'UUID
  de la victime **réussit** ce contrôle. Il ne lui reste qu'à fournir
  l'`account_id` d'un compte de la victime — ce qui est précisément ce que
  l'isolation devait empêcher. **Aucun compte n'existe actuellement**, donc
  aucune exploitation possible en l'état, mais la protection est nulle dès le
  premier compte connecté.
- **Non exploitable** : `oauth_list_accounts`, `oauth_revoke_account`,
  `oauth_audit_list` appellent `auth.uid()` en base, qui ne peut pas être forgé.

### Les tests qui documentent la faille

`tests/oauth-auth-faille.test.ts` — 5 tests, dont 4 marqués `it.fails`. Ils
encodent le comportement **souhaité** et passent aujourd'hui parce que la
protection manque. Le jour où elle sera ajoutée, ils deviendront rouges : c'est
le signal qu'il faut les passer en `it`.

C'est une dette visible, pas un faux vert.

### La correction recommandée

Ne pas passer à `verify_jwt: true` seul : cela casserait `callback`, que Google
appelle sans en-tête. La correction doit distinguer les actions :

1. `callback` reste public (sécurité assurée par l'état CSRF à usage unique et
   PKCE, ce qui est leur rôle).
2. Toutes les autres actions vérifient le jeton **auprès de Supabase Auth**
   avant toute logique métier. Le motif existe déjà dans ce dépôt
   (`authUserId()` dans `business-grow/index.ts`) :

   ```ts
   const result = await fetch(`${supabaseUrl}/auth/v1/user`, {
     headers: { apikey: anonKey, Authorization: authorization },
   });
   if (!result.ok) return null;               // 401/403 → refus
   const user = await result.json();
   return typeof user.id === 'string' ? user.id : null;
   ```

3. `userId` doit provenir de cet appel, **jamais** du corps de la requête.
4. Corriger le commentaire d'en-tête pour qu'il décrive la réalité.

Cette correction a été appliquée — voir section 6 bis.

## 6 bis. Correction appliquée

### Le module

`supabase/functions/vyora-oauth/auth.ts` expose `resolveCaller()`, qui :

1. **rejette sur la forme, sans appel réseau**, tout ce qui ne peut pas être un
   JWT (trois segments base64url). Un UUID nu — le cas exact de l'attaque — est
   donc refusé même si Auth est injoignable ;
2. **présente le jeton à `GET /auth/v1/user`** et n'accepte l'identité que si
   Auth la reconnaît (signature, expiration, révocation vérifiées par Auth) ;
3. **distingue les causes** : `401`/`403` d'Auth = identité refusée → `401` pour
   le client ; panne réseau, `5xx`, réponse non-JSON = indisponibilité → `503`.
   Confondre les deux ferait afficher « session expirée » pendant une panne.

L'identité retournée vient **exclusivement** de la réponse d'Auth.

### Le routage

Dans `createHandler`, la vérification est placée **après** le traitement de
`callback` et **avant** le `switch` des actions. Aucune action privée ne peut
donc être atteinte sans identité vérifiée — c'est structurel, pas une
vérification à répéter dans chaque branche.

`callerId()` a été **supprimée** : la laisser disponible aurait invité à la
réutiliser.

### `list` et `audit` : double bornage

Ces deux actions lisent PostgREST directement. Elles reçoivent désormais le
`userId` vérifié **et** le porteur brut :

- un filtre explicite `user_id=eq.<userId>` borne la requête ;
- le JWT est transmis, donc la RLS s'applique aussi.

Si l'un des deux mécanismes se cassait, l'autre tiendrait encore.

### Configuration de déploiement requise

**Rien à changer sur `verify_jwt` : `false` est correct et doit le rester.**
Le passer à `true` casserait `callback`.

| Élément | Valeur requise | État vérifié |
|---|---|---|
| `verify_jwt` | **`false`** | conforme |
| `SUPABASE_URL` | auto-injecté | présent |
| `SUPABASE_ANON_KEY` | requis pour interroger Auth | **présent** |
| `VYORA_OAUTH_ENCRYPTION_KEY` | requis (chiffrement) | présent |
| `GOOGLE_CLIENT_ID` / `_SECRET` | requis pour connecter | **absents** |

Sans `SUPABASE_ANON_KEY`, `resolveCaller` renvoie `auth_unavailable` (503) et
**aucune** action privée ne fonctionne : le refus est sûr, jamais permissif.
`SUPABASE_PUBLISHABLE_KEY` est acceptée en repli.

Le porteur brut n'est plus qu'un moyen de faire appliquer la RLS, jamais une
identité.

---

## 7. Manque (CORRIGÉ) : un refus de propriété n'était pas journalisé

> **État : corrigé.** Voir « Correction » en fin de section.

Trouvé en écrivant les tests, pas en relisant le code.

`handleToolCall` journalise les refus de **capacité** (`outcome: 'denied'`,
`detail: 'capacite_non_accordee'`). Mais une violation de **propriété** — le cas
où B désigne le compte de A — renvoie `403 forbidden` **sans écrire au journal**.
Même chose pour `revoke`, `refresh` et `check`.

C'est un angle mort : une tentative d'accès croisé est précisément l'événement
qu'on veut voir dans un journal de sécurité. Aujourd'hui elle ne laisse aucune
trace.

Test associé : `tests/oauth-isolation.test.ts` →
« un refus de PROPRIÉTÉ devrait être journalisé (ne l'est pas aujourd'hui) »,
marqué `it.fails`. Il passera en `it` quand la journalisation sera ajoutée.

### Correction

Un helper `auditOwnershipDenial()` est appelé sur les **quatre** sites qui
renvoient `403 forbidden` : `tools_call`, `revoke`, `refresh`, `check`.

L'entrée journalisée est volontairement pauvre, pour qu'aucune donnée sensible
ne puisse y entrer :

| Champ | Valeur |
|---|---|
| `userId` | identité **vérifiée** de l'appelant (issue d'Auth) |
| `account_id` | l'identifiant technique demandé |
| `action` | `denied` |
| `outcome` | `denied` |
| `detail` | code fixe `propriete_refusee:<operation>` |

Ni nom, ni e-mail, ni jeton, ni contenu de requête. Un compte inexistant et un
compte appartenant à autrui produisent la même entrée : le journal ne devient
pas un annuaire des comptes existants.

Tests : `tests/oauth-isolation.test.ts` vérifie la présence de l'entrée pour
chacune des quatre opérations (une seule oubliée suffirait à rendre une attaque
invisible), l'attribution à l'appelant et jamais à la victime, et l'absence de
jeton, d'e-mail et de nom de compte.

## 8. Ce qui reste non vérifié

Limites assumées, énoncées pour qu'elles ne soient pas découvertes plus tard.

### La correction n'est pas déployée

Le code corrigé est dans le dépôt et dans le bundle
(`supabase/functions/vyora-oauth.edge.js`, sha256 `b2101d14…`), mais **la
version déployée reste la v1**, qui contient la faille. Tant qu'aucun
déploiement n'est autorisé, la production conserve le comportement décrit en
section 6.

Aucun déploiement n'a été effectué : il attend une autorisation explicite.

### Aucun test de bout en bout contre l'Edge Function réelle

Le bac à sable n'a pas d'accès réseau à `supabase.co` (seuls github/npm/pypi
sont joignables). La correction est donc validée par :

- `tests/oauth-auth-faille.test.ts` (23 tests) — `resolveCaller` face à toutes
  les catégories de jetons, avec `/auth/v1/user` simulé ;
- la lecture du bundle déployable, qui contient bien l'appel à `/auth/v1/user`
  et plus l'extraction naïve.

Elle n'est **pas** validée par un appel HTTP réel à la fonction déployée. Le
premier appel après déploiement devra confirmer :

| Cas | Attendu |
|---|---|
| `POST` sans en-tête | `401 unauthorized` |
| `POST` avec `Bearer <uuid>` | `401 unauthorized` |
| `POST` avec un JWT valide | l'action s'exécute |
| `GET ?action=callback` sans jeton | atteint le handler (`400 state_invalid`) |

### Aucun test avec deux vrais utilisateurs

Il n'existe **aucun compte OAuth en production** (0 vérifié). L'isolation entre
deux comptes réellement connectés n'a donc jamais été observée. Les tests
simulent PostgREST et Auth ; ils prouvent la logique, pas le comportement de la
RLS sur des données réelles.

### Ce qui n'a pas été touché

- Le serveur MCP (`vyora-mcp`) vit sur une autre branche : l'isolation vérifiée
  ici est celle du chemin `vyora-oauth → tools/call`.
- Le rafraîchissement planifié (pg_cron) reste à brancher.
- Les trois secrets Google restent absents : aucune connexion réelle possible.
