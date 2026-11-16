# Revue finale — PR #11

`arena/vyora-connect-ui` → `develop` · commit `ac52c73` · 23 commits · 123 fichiers

**Rien n'a été fusionné, rien n'a été déployé.** Ce rapport est la base de la
décision.

---

## 1. Verdict

| Point de contrôle | Résultat |
|---|---|
| Cohérence des commits | **oui**, mais la PR porte deux blocs distincts (voir §2) |
| Modifications accidentelles | **aucune** détectée |
| Source ↔ bundles Edge | **7/7 synchronisés** |
| Protections OAuth | **corrigées et testées** |
| Protections MCP | **en place** |
| Tests de non-régression | **1596 passent**, 1 échec préexistant prouvé |
| Documentation Google | **complète**, affirmations vérifiées dans le code |

**Recommandation : PR fusionnable.** Deux réserves à lever avant la production,
détaillées en §7 — dont une qui n'était pas connue jusqu'à cette revue.

---

## 2. Cohérence des commits — un point à connaître avant de fusionner

La PR contient **deux blocs de travail d'origines différentes** :

| Bloc | Commits | Contenu |
|---|---|---|
| AI / Business Growth / expérience premium | 14 (`3733a58` → `ca0d541`) | +12 770 −1 704, 90 fichiers |
| VYORA Connect / OAuth / MCP | 9 (`1480da4` → `ac52c73`) | +9 272, 34 fichiers |

**Ces 14 commits ne sont pas dans `develop`.** Ils viennent de `ca0d541`
(« rapport de preuves des appels réels des cinq fournisseurs »), présent sur
`arena/vyora-mcp-connecteurs`, `arena/vyora-mcp-core` et
`arena/bfcedd89-saas-ugc`, mais pas sur `develop`.

Conséquence : **fusionner #11 dans `develop` y fera entrer aussi tout le travail
AI/Business.** Ce n'est pas un défaut de la PR — c'est la réalité de son
ascendance — mais c'est une décision produit, pas technique. Si ce travail doit
arriver sur `develop` séparément, la base de #11 doit changer.

Aucun commit vide, aucun commit de fusion, aucune réécriture d'historique.

---

## 3. Modifications accidentelles — aucune

Contrôles effectués :

- **Aucun fichier entièrement supprimé** (`--diff-filter=D` : vide).
- Les 1 704 lignes supprimées par le bloc AI sont des **réécritures** : chaque
  fichier concerné gagne aussi des lignes (`providers.ts` −382/+256,
  `Home.tsx` −133/+179, `registry.ts` −121/+43).
- **Secrets en dur** : aucun (`sk-…`, `ya29.…` introuvables hors tests).
- **`SERVICE_ROLE` dans le frontend** : seule occurrence = un commentaire
  d'avertissement dans `src/lib/supabase.ts`.
- **RLS désactivée** : jamais (`disable row level security` introuvable).
- **10 migrations, toutes en ajout**, aucune en suppression ou modification.

Trois fichiers hors du périmètre Connect apparaissent dans mes commits, tous
légitimes :

| Fichier | Nature |
|---|---|
| `.env.example` | +11 lignes documentant les 4 secrets OAuth, en commentaires |
| `scripts/build-edge-loader.mjs` | +5 lignes déclarant la cible `vyora-oauth` |
| `tests/google-tools.test.ts` | nouveau fichier de tests MCP |

---

## 4. Source ↔ bundles Edge

**7/7 bundles synchronisés** (`build-edge-loader.mjs --check`) :
`business-grow`, `reelora-video`, `vyora-ai`, `vyora-ai-providers`,
`vyora-oauth`, `vyora-provider-health`, `vyora-saspay`.

Cohérence interne de `vyora-oauth` vérifiée :

| Élément | Valeur |
|---|---|
| Taille source | 34 126 car. |
| SHA-256 | `b2101d1416d60022c8e26f0861449e145822a5bcf446d8f15f3529b082689ad0` |
| Tranches | 7 |
| Présent dans le bundle | `/auth/v1/user`, `auth_unavailable`, `propriete_refusee` |
| Absent du bundle | l'ancienne extraction naïve (`header.slice(7).trim()`) |

`tests/edge-loader-parity.test.ts` : **14/14**.

---

## 5. Protections OAuth et MCP

### Ordre des contrôles dans `createHandler`

```
ligne 731  action === 'callback'  → public (CSRF + PKCE)
ligne 756  resolveCaller()        → identité vérifiée auprès d'Auth
ligne 774  switch (action)        → logique métier
```

Aucune action privée ne peut être atteinte sans identité vérifiée : c'est
structurel, pas une vérification répétée dans chaque branche.

### Garanties vérifiées dans le code livré

- `callerId()` (l'extraction naïve) **n'existe plus**.
- Rejet d'un UUID nu **sans appel réseau** : l'attaque échoue même si Auth est
  injoignable.
- `401`/`403` d'Auth → `401` ; panne, `5xx`, non-JSON → `503`. Les confondre
  afficherait « session expirée » pendant une panne.
- `list` et `audit` : filtre explicite `user_id=eq.` **et** RLS.
- Refus de propriété journalisé sur les **4** opérations (`tools_call`,
  `revoke`, `refresh`, `check`), avec `userId` vérifié et codes fixes.
- Aucun jeton dans une réponse : les 11 occurrences d'`access_token` sont des
  cryptogrammes, des noms de colonnes à retirer, ou `access_token_length`.
- Capacité MCP contrôlée **avant tout appel réseau**.

### Vérifications en production (lecture seule)

| Contrôle | Résultat |
|---|---|
| RLS activée sur les 3 tables | oui |
| Politiques permissives `using (true)` | **0** |
| Tables lisibles par `anon`/`authenticated` | **non** (6/6 `false`) |
| Privilèges RPC (9 fonctions × 3 rôles) | **27/27** conformes |
| RPC de secrets réservées à `service_role` | oui |
| `provider_status()` présent, `anon` refusé | oui |
| Comptes OAuth existants | **0** |

---

## 6. Tests exécutés

| Périmètre | Résultat |
|---|---|
| Suite complète | **1596 passent / 1597** |
| OAuth + Connect + MCP (9 fichiers) | **295/295** |
| Parité des chargeurs Edge | 14/14 |
| `npx tsc -b` | **0 erreur** |
| `npm run build` | **vert** en 13,11 s |

### L'échec unique est prouvé préexistant

`tests/business-modules.test.tsx:84` — `leak-leads` attend `75000`, reçoit
`100000`.

Vérification décisive : **le test échoue à l'identique sur `origin/develop`**
(26/27). Il est donc antérieur à la PR, qui ne touche ni ce cas de test ni la
fonction `computeRevenueLeaks`.

---

## 7. Risques résiduels

### R1 — Le code corrigé n'est pas déployé (bloquant pour la production)

`vyora-oauth` est en **version 1** en production. Cette version contient encore
la faille d'authentification. Le chargeur déployé attend 18 868 caractères et
4 tranches ; le dépôt en produit 34 126 et 7 tranches.

**Tant que la migration d'artefact n'est pas appliquée, la production reste
vulnérable.** C'est le point le plus important de ce rapport.

### R2 — `vyora-mcp` est hors du périmètre de cette PR

`vyora-mcp` est déployé en **version 3**, mais son code source vit sur
`arena/vyora-mcp-connecteurs` — **pas dans cette PR**. La PR modifie donc
`vyora-oauth` sans pouvoir aligner `vyora-mcp` sur le même commit.

À examiner avant toute mise en production conjointe.

### R3 — Découverte pendant la revue : l'outil de publication n'est pas dans le dépôt

Le script `scripts/publish-edge-artifact.mjs` produit le message
`Publication de l'artefact "vyora-oauth"` présent dans le commit `2747195`…
**mais ce fichier n'existe pas dans le dépôt.**

La procédure de publication d'un artefact n'est donc pas reproductible depuis le
dépôt seul. C'est une lacune de traçabilité, à combler avant la production.

### R4 — Aucune validation de bout en bout en production

Le bac à sable n'a pas d'accès réseau à `supabase.co` (seuls github/npm/pypi
sont joignables). La correction est validée par tests unitaires et par lecture du
bundle, **pas par un appel HTTP réel**. Les quatre cas à vérifier après
déploiement sont listés en §8.

### R5 — Aucun test avec deux vrais utilisateurs

Il n'existe **aucun compte OAuth en production**. L'isolation entre deux comptes
réellement connectés n'a jamais été observée. Les tests simulent PostgREST et
Auth.

### R6 — Identifiants Google toujours absents

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et `VYORA_OAUTH_REDIRECT_URI` ne sont
pas configurés. Aucune connexion réelle n'est possible ; les fournisseurs Google
restent à « Configuration requise », ce qui est le comportement attendu et testé.

### R7 — Scopes Gmail restreints par Google

Les scopes Gmail sont classés *restreints*. En mode Test, seuls les comptes
ajoutés comme testeurs peuvent autoriser l'application, et les jetons de
rafraîchissement expirent à 7 jours. La vérification Google est à prévoir avant
toute ouverture à des utilisateurs réels.

### R8 — Rafraîchissement non planifié

Le code de `refresh` existe, mais aucune tâche `pg_cron` ne l'appelle. Les jetons
expireront silencieusement jusqu'à la première action de l'utilisateur.

---

## 8. Étapes pour passer en production

Dans cet ordre — chaque étape est vérifiable avant la suivante.

### Étape 1 — Décider du périmètre de fusion

Trancher si les 14 commits AI/Business doivent entrer dans `develop` avec cette
PR (§2). Sinon, rebaser #11 sur une base plus étroite.

### Étape 2 — Fusionner #11

Après autorisation. Aucune migration n'est encore appliquée à ce stade.

### Étape 3 — Appliquer les migrations

Les 10 migrations sont idempotentes (`create table if not exists`,
`create or replace function`, `drop policy if exists`) et peuvent être rejouées
sans risque sur une base qui possède déjà l'état — vérifié : les 10 fonctions
OAuth et les 3 tables existent déjà en production.

### Étape 4 — Publier l'artefact `vyora-oauth`

Le contenu à publier est dans `20261116040000_vyora_oauth_artifact.sql` :
7 tranches, sha256 `b2101d14…`, 34 126 caractères.

**Prérequis** : reconstituer `scripts/publish-edge-artifact.mjs` (R3), absent du
dépôt.

### Étape 5 — Vérifier le comportement après déploiement

Quatre appels, à effectuer dans cet ordre :

| Cas | Attendu |
|---|---|
| `POST` sans en-tête | `401 unauthorized` |
| `POST` avec `Bearer <uuid>` | `401 unauthorized` |
| `POST` avec un JWT valide | l'action s'exécute |
| `GET ?action=callback` sans jeton | atteint le handler (`400 state_invalid`) |

Le troisième et le quatrième sont les plus importants : ils prouvent que la
correction protège sans casser le flux OAuth.

### Étape 6 — Configurer Google

Suivre `docs/mcp/configuration-google.md`. Puis vérifier, dans l'ordre :

1. `action=status` renvoie `google: true` ;
2. un bouton « Connecter » apparaît sur Gmail dans `/app/connect` ;
3. le flux revient sur `?action=callback` sans `redirect_uri_mismatch` ;
4. le compte affiche ses **permissions réellement accordées** ;
5. `oauth_accounts` contient une ligne dont les colonnes de jeton sont des
   cryptogrammes, jamais un `ya29.…` en clair ;
6. un `tools_call` sur `vyora_gmail_search` renvoie des messages, sans jeton
   dans la réponse.

### Étape 7 — Planifier le rafraîchissement

Brancher `pg_cron` sur `refresh` (R8).

### Étape 8 — Traiter R2

Aligner `vyora-mcp` sur le même commit que `vyora-oauth`, depuis
`arena/vyora-mcp-connecteurs`.

---

## 9. Documentation

| Document | Contenu |
|---|---|
| `docs/mcp/configuration-google.md` | 6 sections : secrets, création du client Google Cloud, renseignement, scopes, vérification, dépannage |
| `docs/mcp/preuves-isolation.md` | 8 sections : preuves local/prod, faille et sa correction, journalisation, limites |
| `docs/mcp/connecteurs-oauth.md` | architecture, état réel, outils MCP |

Les affirmations techniques de `configuration-google.md` ont été vérifiées dans
le code, pas supposées : exigence d'en-tête sur `status`, distinction
`503 oauth_not_configured` / `503 google_not_configured`, dépendance à
`VYORA_OAUTH_ENCRYPTION_KEY`, scopes exacts de `google.ts`, `format=metadata`,
`sent: false` sur le brouillon, `destructiveHint` réservé à l'envoi.

---

## Conclusion

Le travail VYORA Connect est **cohérent, testé et documenté**. Les deux
corrections demandées sont réellement appliquées, pas seulement annoncées.

Deux points demandent une décision avant la production :

1. **Le périmètre de fusion** (§2) — 14 commits AI/Business entreraient dans
   `develop` avec cette PR.
2. **L'outil de publication d'artefact manque** (§7 R3) — la procédure n'est pas
   reproductible depuis le dépôt.

Et un rappel : **la production reste vulnérable** tant que l'étape 4 n'est pas
faite. Le code corrigé est prêt, mais pas déployé.
