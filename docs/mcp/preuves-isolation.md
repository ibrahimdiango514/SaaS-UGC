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
| **L'identité de l'appelant est-elle authentifiée ?** | **NON — faille ouverte** | [PROD] configuration |

La dernière ligne est la conclusion importante de ce document. Elle est
détaillée en section 6.

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

## 6. FAILLE OUVERTE — l'identité de l'appelant n'est pas authentifiée

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

Cette correction **n'a pas été appliquée** : elle modifie une fonction déjà
déployée et opérationnelle, ce qui dépasse l'autorisation donnée pour ce tour
(« renforcer les tests d'isolation »). Elle attend un accord explicite.

---

## 7. Manque constaté : un refus de propriété n'est pas journalisé

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

Non corrigé pour la même raison que la section 6 : cela modifie une fonction
déployée. L'ajout est pourtant de trois lignes — un `store.audit()` avant chaque
`return fail(403, 'forbidden')`.

## 8. Ce qui reste non vérifié

- **Aucun test de bout en bout avec deux vrais utilisateurs** : il n'existe aucun
  compte OAuth en production, donc l'isolation réelle entre deux comptes
  connectés n'a jamais été observée. Les tests locaux simulent PostgREST ; ils ne
  prouvent pas le comportement de la RLS sur des données réelles.
- **Aucun appel HTTP direct à l'Edge Function déployée** : le bac à sable de cette
  session n'a pas d'accès réseau à `supabase.co` (seuls github/npm/pypi sont
  joignables). Les constats [PROD] viennent de l'API de gestion Supabase et de
  requêtes SQL, pas d'appels `curl`. La faille de la section 6 est donc établie
  par lecture de configuration et de code, **pas** par exploitation réelle.
- **Le serveur MCP (`vyora-mcp`)** n'a pas été réexaminé ici : il vit sur une
  autre branche (`arena/vyora-mcp-connecteurs`). L'isolation vérifiée dans ce
  document est celle du chemin `vyora-oauth → tools/call`.
