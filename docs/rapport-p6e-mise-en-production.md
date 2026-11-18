# P6e — Mise en production VYORA MCP : intégration `main`, backend, connexion front ↔ backend

Date : 2026-11-18 · Projet Supabase `xbuuhfwobrafcbgtdgjx` · PR **#22** fusionnée dans `main`.

Convention : **réel** = fait et vérifié en production par requête HTTP / lecture de la configuration ; **bloqué** = ne peut pas être fait sans une action de votre part, dite précisément ; **à vous** = test navigateur qui n'est pas réalisable depuis cet environnement (pas de navigateur, pas d'accès réseau sortant hors GitHub/npm).

---

## 1. Résultat en une page

| Demande | État |
| --- | --- |
| Audit préalable (`main`, branche, migrations, versions, cause de l'inaccessibilité) | **Fait** — §2 |
| Cause du « backend inaccessible depuis l'aperçu » | **Trouvée et corrigée** : URL relative quand `VITE_SUPABASE_URL` manque ; ni CORS ni authentification n'étaient en cause — §3 |
| Intégration dans `main` | **Faite** : `main` = **`c1d48b7`**, arbre identique à `82f2236` (branche de travail), PR #22 — §4 |
| Backend Supabase | **Déjà en production, rien à redéployer** : `mcp-client` v10, 5 migrations OAuth appliquées, 16 RPC `mcp_oauth_*`, Vault — §5 |
| Front ↔ backend (CORS, GoTrue, URL, JWT) | **Fait et prouvé en réel** pour l'aperçu e2b et pour `vyora.pages.dev` — §6 |
| Déploiement du front sur Cloudflare Pages | **Bloqué par 2 secrets absents** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) ; tout le reste est prêt ; le workflow s'est exécuté sur `main` et s'est arrêté proprement — §7 |
| Tests depuis le domaine de production | **À vous** (navigateur). Un chemin **réel immédiat** existe : l'aperçu `https://5173-ioh1tunc6fm4b8n31rvtk.e2b.app`, désormais branché sur le vrai backend — §8 |
| Netlify | **Aucun déploiement** ; builds désactivés par `ignore = "exit 0"` — §7 |

---

## 2. Audit préalable

| Point | Constat (réel) |
| --- | --- |
| `main` | `1706df4` — un seul commit squashé (#21). |
| `arena/0188834f-saas-ugc` | 137 commits au-dessus de `main` au départ (+2 P6e), `main` ancêtre direct : **0 commit divergent, 0 conflit possible**. |
| Règle « Protect main » | merge commit **interdit**, non-fast-forward interdit, suppression interdite ; méthodes autorisées : squash, rebase. |
| Migrations OAuth (`supabase_migrations.schema_migrations`) | `mcp_oauth_foundation`, `mcp_oauth_flows_p6c`, `mcp_oauth_outbound_p6c`, `mcp_oauth_secret_lire_p6c`, `mcp_oauth_p6d` — **toutes appliquées**. |
| RPC | 16 `mcp_oauth_*` (`flux_creer`, `flux_consommer`, `stocker`, `lire`, `detruire`, `secret_ecrire`, `secret_lire`, …) + 32 `mcp_*`. |
| Tables | 10 tables `mcp_*`, **RLS activée sur toutes**. `mcp_servers` : 0 ligne (nettoyage P6d). |
| Edge Functions | `mcp-client` **v10 ACTIVE `verify_jwt:false`** (auth en code) ; `vyora-mcp` v6 ; `store-import` v18 ; `store-connect` v9 ; `business-grow` v31. |
| GoTrue | `site_url=https://vyora-ugc.netlify.app` ; liste de redirection : Netlify, un ancien bac à sable e2b, localhost. |
| Secrets Edge | `VYORA_ALLOWED_ORIGINS` et `STORE_IMPORT_ALLOWED_ORIGINS` **absents** (donc liste par défaut seule). |
| Jeton GitHub de cet environnement | ne peut ni lire les secrets du dépôt (403) ni lancer un `workflow_dispatch` (403). |

---

## 3. Pourquoi le backend était « inaccessible » depuis l'aperçu

`src/mcp/serveurs.ts` construisait l'URL ainsi : `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1/mcp-client/gestion/…`. Sans `.env.local` (aperçu) — ou dans **tout build où la variable manque** — l'URL devenait **relative** : `fetch('/functions/v1/mcp-client/gestion/lister')` partait vers le serveur qui sert le front (Vite, Netlify, Cloudflare…), lequel répond la page `index.html` en **200**. Conséquences : pas d'erreur CORS, pas de 401, mais `listerServeurs()` retournait `[]` et `creerServeur()` « réussissait » sans que le backend soit jamais appelé. `src/mcp/api.ts` avait le même défaut pour l'URL affichée de `vyora-mcp`.

**Correction (`538619d`)** : les deux modules utilisent `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` de `src/lib/supabase.ts`, qui portent déjà le repli public du projet (même mécanisme que le client GoTrue). Test de régression `tests/mcp-url-backend.test.ts` (env vide ⇒ URL absolue). Vérifié dans le bundle de production : `xbuuhfwobrafcbgtdgjx.supabase.co` est compilé.

Ce qui n'était **pas** en cause (vérifié en réel, §6) : CORS (`*.e2b.app` déjà autorisé dans v10), authentification (JWT GoTrue relu côté serveur), `verify_jwt`.

---

## 4. Intégration dans `main`

- PR **#22** `arena/0188834f-saas-ugc` → `main`, 139 commits, `mergeable: MERGEABLE`.
- Merge commit refusé par la règle du dépôt ; **rebase refusé par GitHub** (« This branch can't be rebased ») ; **squash** = seule méthode restante, et c'est déjà la convention de `main` (#21).
- Résultat : `main` = **`c1d48b7`** ; `git diff 82f2236 origin/main` = **vide** (arbre identique). Aucun force push ; la branche de travail et ses 139 commits restent sur `origin` et dans la PR.
- Inclus et vérifiés présents : `supabase/functions/mcp-client/{index,oauth,oauth-http,oauth-egress,gestion,gestion-http,execution,loader}.ts`, `_artifacts/mcp-client.js` (v10), migrations `20261118120000_mcp_oauth_p6d.sql` + `20261121090000_mcp_oauth_foundation.sql`, `src/integrations/MesServeursMcpPage.tsx`, `src/mcp/serveurs.ts`, rapports P6/P6b/P6c/P6d, protocole SQL, workflow Cloudflare.

Commits P6e sur la branche : `538619d` (URL backend absolue), `82f2236` (Netlify → Cloudflare, origines, workflow), puis le commit de ce rapport.

---

## 5. Backend Supabase — rien à redéployer

Tout ce que P6c/P6d exigent est **déjà actif** et a été audité par 25 requêtes HTTP réelles (`docs/rapport-p6d-oauth-reel.md`). Je n'ai volontairement **pas** publié de v11 de `mcp-client` : la version validée reste en place ; l'ajout des origines Cloudflare passe par les secrets d'environnement (lus au démarrage de la fonction, sans redéploiement). La liste par défaut du code (`src/lib/origin-allowlist.ts`) contient aussi ces origines : elle prendra effet au prochain déploiement de chaque fonction, et le secret pourra alors être retiré.

Sécurité, inchangée : `verify_jwt:false` **uniquement** parce que `/oauth/callback` est visité par un navigateur sans JWT ; toutes les routes `/gestion/*` revérifient le JWT GoTrue en code (anonyme → 401, prouvé 14128–14131 ci-dessous) ; RLS sur toutes les tables ; isolation B→A prouvée en P6d (404).

Rollback backend : `update_edge_function mcp-client` avec le chargeur v9 (`7763f4b`, sha `73506e7b…`) ou v8 (`4675984`, sha `c4c830a7…`) ; les migrations sont additives, aucune à défaire.

---

## 6. Connexion réelle front ↔ backend

### Ce qui a été changé en production (réel)

| Élément | Avant | Après |
| --- | --- | --- |
| Secret Edge `VYORA_ALLOWED_ORIGINS` (lu par `mcp-client`, `store-connect`) | absent | `https://vyora.pages.dev,https://*.vyora.pages.dev` |
| Secret Edge `STORE_IMPORT_ALLOWED_ORIGINS` (lu par `store-import`) | absent | idem |
| GoTrue `uri_allow_list` | Netlify + ancien e2b + localhost | **+** `https://vyora.pages.dev/**`, `https://*.vyora.pages.dev/**`, `https://5173-ioh1tunc6fm4b8n31rvtk.e2b.app/**` (liste précédente conservée intégralement, `site_url` inchangé) |
| Code `DEFAULT_ALLOWED_ORIGINS` | — | + `vyora.pages.dev`, `*.vyora.pages.dev` (test ajouté) |

Non modifié, à dessein : `BUSINESS_GROW_ALLOWED_ORIGINS` (valeur existante illisible, donc non écrasée) — `business-grow` acceptera l'origine Cloudflare à son prochain déploiement via la liste par défaut.

### Preuve HTTP réelle (pg_net → `mcp-client` v10, `POST /gestion/lister` sans JWT)

| id | `Origin` envoyé | Statut | `access-control-allow-origin` renvoyé |
| --- | --- | --- | --- |
| 14128 | `https://5173-ioh1tunc6fm4b8n31rvtk.e2b.app` | 401 `authentification_requise` | `https://5173-ioh1tunc6fm4b8n31rvtk.e2b.app` |
| 14129 | `https://vyora.pages.dev` | 401 | `https://vyora.pages.dev` |
| 14130 | `https://preview-main.vyora.pages.dev` | 401 | `https://preview-main.vyora.pages.dev` |
| 14131 | `https://evil.example` | 401 | `null` |

Lecture : le navigateur pourra lire les réponses depuis l'aperçu et depuis Cloudflare ; une origine inconnue reste bloquée ; sans JWT la réponse est 401 quelle que soit l'origine — CORS n'a pas remplacé l'authentification.

### Chaîne complète côté front (code fusionné)

`supabase.auth.getSession()` → `Authorization: Bearer <JWT utilisateur>` + `apikey` publiable → `POST https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/gestion/<route>` → erreurs HTTP converties en `ErreurGestion{code,status}` affichées telles quelles (401 « Vous devez être connecté », 409 `auth_required` → bouton « Autoriser », 404 `server_not_found`, 422, 502…). Aucune donnée simulée : la page lit `lister`, crée via `creer`, lance `oauth-demarrer`, teste via `tester`, exécute via `executer`, révoque via `oauth-revoquer`.

---

## 7. Déploiement du front — Cloudflare Pages

### Fait

- `netlify.toml` : `ignore = "exit 0"` → **plus aucun build Netlify**, y compris sur `main` (réversible en une ligne). Vérifié : la fusion #22 n'a déclenché aucun déploiement Netlify.
- `.github/workflows/frontend-cloudflare-pages.yml` : déclenché par **push sur `main`** (production) et **manuellement** (preview/production) ; construit avec les valeurs publiques `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SITE_URL=https://vyora.pages.dev` ; vérifie le cachet `vyora-revision` et `dist/_redirects` (`/* /index.html 200` = routage SPA) ; publie via `wrangler pages deploy dist --project-name=vyora --branch=main`.
- Build de production vérifié localement : `✓ built`, `vyora-revision=538619d`, `_redirects` présent, URL backend absolue dans le bundle.
- **Exécution réelle sur `main`** (run `44247123554`) : étape « Préalables présents ? » → **secrets absents** → toutes les étapes suivantes **ignorées**, run neutre, résumé explicatif. **Rien n'a été publié.**

### Bloqué — ce que vous seul pouvez faire (≈ 5 minutes)

1. Cloudflare → Workers & Pages → **Create → Pages → Upload assets (Direct Upload)** → nom du projet **`vyora`** (exactement : les origines CORS/GoTrue posées ci-dessus en dépendent). Si `vyora.pages.dev` est déjà pris, choisissez un autre nom **et dites-le-moi** : je mets à jour les 3 listes.
2. Branche de production du projet : `main`.
3. Cloudflare → My Profile → API Tokens → **Create Token → « Edit Cloudflare Workers »** ou jeton personnalisé avec **Account → Cloudflare Pages → Edit**. Account ID : page d'accueil du compte (colonne de droite).
4. GitHub → `Settings → Secrets and variables → Actions` → `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
5. GitHub → Actions → « Frontend — publication Cloudflare Pages » → **Run workflow** (`environnement = production`) — ou tout push sur `main`.

Je ne peux pas faire ces étapes : pas d'accès à Cloudflare depuis cet environnement, et le jeton GitHub de la session ne peut ni créer des secrets ni lancer un workflow.

### Domaine

Production : **`https://vyora.pages.dev`** (dès le premier déploiement). Domaine personnalisé : à ajouter dans Pages → Custom domains ; il faudra alors l'ajouter à `VYORA_ALLOWED_ORIGINS`, `STORE_IMPORT_ALLOWED_ORIGINS`, à la liste GoTrue et à `VITE_SITE_URL` (je le fais sur demande). `vyora-ugc.netlify.app` ne redirige pas automatiquement : à annoncer ou à rediriger côté DNS.

### Rollback front

Cloudflare Pages conserve chaque déploiement : **Deployments → … → Rollback** (quelques secondes). Ou relancer le workflow sur un commit antérieur de `main` (`1706df4` = état d'avant #22).

---

## 8. Tests obligatoires — ce qui est prouvé, ce qui vous revient

Depuis cet environnement, **aucun test navigateur n'est possible**. Je ne déclare donc **aucune** des 12 étapes « réussie en production ». Voici ce qui est prouvé en réel par ailleurs, et comment constater chaque étape vous-même.

**Chemin immédiat (réel, sans attendre Cloudflare)** : `https://5173-ioh1tunc6fm4b8n31rvtk.e2b.app/app/connexions-mcp` — front corrigé, servi par cet environnement, **branché sur le backend de production** (CORS et GoTrue autorisés, preuve 14128). Il disparaît avec l'environnement ; il ne remplace pas Cloudflare.

| # | Étape | Preuve réelle existante | Comment constater dans le navigateur |
| --- | --- | --- | --- |
| 1 | Connexion | GoTrue en production, JWT relu par `mcp-client` (14128 : 401 sans jeton) | Onglet Réseau : `POST /auth/v1/token?grant_type=password` → 200 |
| 2 | Page Connexions MCP | route `/app/connexions-mcp` servie 200 | `POST …/mcp-client/gestion/lister` → **200 JSON** `{serveurs:[…]}` (et non une page HTML) |
| 3 | Création OAuth sans secret | `creer` 201 en P6d (14077) | `creer` → 201, carte en `auth_required` |
| 4 | Démarrage OAuth Linear | `oauth-demarrer` 200 + DCR réel (14076) | `oauth-demarrer` → 200 `{autorisationUrl, redirectUri}` |
| 5 | Redirection vers Linear | URL `https://mcp.linear.app/authorize?…code_challenge_method=S256…` | nouvel onglet Linear, page de consentement |
| 6 | Retour vers VYORA | callback audité (state unique, XSS, code forgé) | page **« Autorisation accordée — VYORA »** servie par `…/functions/v1/mcp-client/oauth/callback` (c'est le retour ; revenez à l'onglet VYORA et cliquez « Tester ») |
| 7 | Jetons dans Vault | `mcp_oauth_stocker` (P6d) | je vérifie sur demande : `vault.secrets` doit contenir `mcp_server_<id>` et `mcp_oauth_refresh_<id>` |
| 8 | Découverte des outils | `tester` → `tools/list` (P6b/P6c) | « Tester » → statut `connected`, liste d'outils |
| 9 | Exécution d'un outil de lecture autorisé | `executer` réel (P6b) | autoriser `list_issues` (ou équivalent lecture) → « Exécuter » → résultat JSON |
| 10 | Refus d'une exécution non autorisée | porte serveur (P6b) | outil non autorisé → 403 `tool_not_allowed` |
| 11 | Révocation | RFC 7009 réel vers Linear (14091) | « Retirer l'accès OAuth » → `{distant:"revoque", jetonsDetruits:2}` puis « Tester » → 409 `auth_required` |
| 12 | Isolation A/B | 404 systématiques (14085–14088) | second compte : liste vide ; `serverId` de A → 404 |

Quand vous aurez fait les étapes 3–11, je relis la base (Vault, `mcp_servers`, `mcp_oauth_flows`, journal) et je consigne les preuves dans ce rapport.

---

## 9. Blocages restants

1. **Secrets Cloudflare** (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) et projet Pages `vyora` — seule chose entre l'état actuel et `https://vyora.pages.dev`.
2. **Consentement OAuth humain** (étapes 5–6) — à faire dans votre navigateur.
3. `business-grow` : origine Cloudflare acceptée seulement à son prochain déploiement (liste par défaut) ; n'affecte pas MCP.
4. Dette inchangée : `_bg_artifact_parts` sans RLS ; rôle `anon` large sur `vyora_files`.

## 10. Rollback complet

| Couche | Action |
| --- | --- |
| Front Cloudflare | Deployments → Rollback ; ou workflow sur `1706df4` |
| Front Netlify | rétablir l'ancienne ligne `ignore = '[ "$HEAD" = … ]'` dans `netlify.toml` (historique Git) et recharger des crédits |
| `main` | `git revert c1d48b7` via PR (la règle interdit le force push) — tout le reste du dépôt reste intact |
| `mcp-client` | redéployer le chargeur v9 (`7763f4b`) ou v8 (`4675984`) |
| CORS / GoTrue | retirer les deux secrets `*_ALLOWED_ORIGINS` ; retirer les 3 entrées ajoutées à `uri_allow_list` |
| Base | rien à défaire (migrations additives, déjà en place avant P6e) |
