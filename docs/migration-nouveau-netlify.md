# Migration SORAHNEX vers un nouveau compte Netlify

> **Statut de ce document.** Il conserve l'historique des incidents et le détail
> du raisonnement. Pour AGIR, utiliser, dans cet ordre :
> 1. `docs/NETLIFY_DEPLOYMENT_CHECKLIST.md` — la procédure ordonnée.
> 2. `docs/NETLIFY_ENVIRONMENT_CHECKLIST.md` — l'inventaire des variables.
> 3. `docs/bascule-nouveau-netlify.md` — le changement de domaine et d'origines.
> 4. `docs/NETLIFY_POST_DEPLOY_SMOKE_TEST.md` — les vérifications après publication.
>
> L'identité du site autorisé ne se configure plus ici ni dans `netlify.toml` :
> elle vit dans **`netlify.site.conf`**, seule source de vérité lue par les deux
> rideaux de la garde.


Date de préparation : 2026-11-18. Source unique à importer : branche **`main`** du dépôt
`ibrahimdiango514/SaaS-UGC`. Le backend Supabase (`xbuuhfwobrafcbgtdgjx`) **ne change pas** :
seule l'origine qui sert le frontend change.

La future URL n'est pas connue au moment d'écrire ce document : elle est notée
`<NOUVELLE_URL_NETLIFY>` partout (forme attendue : `https://<nom-du-site>.netlify.app`, ou un
domaine personnalisé). **Rien dans le dépôt ne doit être modifié pour la renseigner** : tout passe
par des variables d'environnement ou des réglages de la console.

---

## 0. Ce qui a été vérifié avant d'écrire cette procédure

| Point | Résultat mesuré |
| --- | --- |
| URL Netlify codée en dur dans `src/` | Aucune. Le frontend ne lit que `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SITE_URL` (`src/lib/supabase.ts`, repli `window.location.origin`). `src/business/api.ts` détecte seulement « suis-je sur `*.netlify.app` » pour choisir l'ordre des transports : valable pour tout nouveau site Netlify. |
| Relais Netlify Edge (`netlify/edge-functions/*.js`) | Ciblent `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/...` : correct, le backend ne change pas. |
| Liste d'origines par défaut (`src/lib/origin-allowlist.ts`) | Contient l'ancien domaine et les aperçus ; la nouvelle origine se déclare par secret (voir §4) — aucune redéploiement d'Edge Function n'est nécessaire pour l'ajouter. |
| Outils de constat (`.github/workflows/production-check.yml`, `scripts/verify-production.mjs`) | Paramétrés : variable de dépôt `VYORA_SITE_URL` / variable d'environnement `VYORA_SITE_URL` / option `--site`. L'ancien domaine n'est qu'un repli. |
| Garde de build `netlify.toml` | **Deux rideaux**, testés par `tests/business-grow-deployment-guard.test.ts` (vrai `sh`). Site autorisé : **Site ID `fc88d197-fe0b-47c7-a6e3-fba44eeccda9`, nom `vyora-saas-ugc`** (`https://vyora-saas-ugc.netlify.app`). Les deux rideaux exigent les **quatre** mêmes conditions : `BRANCH=main` **et** `SITE_ID` = identifiant autorisé **et** `SITE_NAME=vyora-saas-ugc` **et** `VYORA_BUILD_ENABLED=true` ; le nom de l'ancien site (`vyora-ugc`) est en plus refusé explicitement. (1) `ignore` — avant toute installation — journalise les valeurs reçues puis annule (code 0) dès qu'une condition manque (variable absente = refus). (2) `scripts/netlify-build-guard.sh <id> <nom>`, en tête de la commande de build, revérifie les quatre conditions et fait échouer le build avant `npm ci` avec un message de refus explicite (aucun déploiement). |

---

## 0bis. Incident du 2026-11-18 — déploiement de `14a61ec` ignoré

- Garde en place : `ignore = '[ "$SITE_ID" != "fc88d197-…" ] || [ "$VYORA_BUILD_ENABLED" != "true" ] || [ "$BRANCH" != "main" ]'`.
- Constat Netlify : initialisation et build terminés, **déploiement ignoré** ; le Site ID réel du
  nouveau site est bien `fc88d197-fe0b-47c7-a6e3-fba44eeccda9`.
- Hypothèse émise sur le moment (sans journal) : `SITE_ID` non exposé à l'étape `ignore`, et
  `SITE_NAME` pas davantage. **Cette hypothèse est fausse** : le journal de `ca410d5` (§0ter) montre
  `SITE_ID` et `SITE_NAME` tous deux présents et corrects à cette étape.
- Cause réelle, établie a posteriori : la variable **`VYORA_BUILD_ENABLED` n'avait jamais été déclarée
  sur le nouveau site**. La condition `[ "$VYORA_BUILD_ENABLED" != "true" ]` était donc vraie → code 0
  → build annulé. Le déploiement de `14a61ec` a été ignoré pour la même raison que celui de `ca410d5`.
- Correction (PR #28, fondée sur l'hypothèse fausse) : identité du site tranchée dans la commande de
  build, tolérance de `SITE_ID` absent dans `ignore`, journalisation des valeurs reçues
  (`garde ignore: …` puis `GARDE NETLIFY — …`). Cette journalisation a produit la preuve de §0ter ;
  la tolérance a été retirée (PR #29) et la comparaison stricte de `SITE_ID` **et** `SITE_NAME`
  rétablie dans `ignore`.

## 0ter. Incident du 2026-11-18 (suite) — déploiement de `ca410d5` ignoré : variable absente

- Journal Netlify du nouveau site, étape `ignore` :
  `garde ignore: BRANCH=main VYORA_BUILD_ENABLED=absent SITE_ID=fc88d197-fe0b-47c7-a6e3-fba44eeccda9 SITE_NAME=vyora-saas-ugc`.
- Constat : « Building: Complete / Deployment: Ignored » et le message **« Canceled build due to no
  content change »**. Ce libellé est le texte générique que Netlify affiche pour **toute** annulation
  par la commande `ignore` (code 0), quelle qu'en soit la raison ; il n'a aucun rapport avec le contenu
  du commit et ne signifie pas que la garde a comparé des fichiers. Le rideau 2 n'a pas tourné : la
  commande de build n'est jamais lancée quand `ignore` annule.
- Cause : la variable **`VYORA_BUILD_ENABLED` n'est pas déclarée sur le nouveau site** (§3). La garde,
  fermée par défaut, a donc fait exactement ce qu'elle doit : rejouée localement avec ces valeurs,
  `ignore` renvoie 0 (annule) et le script renvoie 1 (« VYORA_BUILD_ENABLED doit valoir exactement
  « true » »). Aucune anomalie de code.
- Enseignement : ce journal prouve que Netlify **expose bien `SITE_ID` et `SITE_NAME` à l'étape
  `ignore`** — l'hypothèse de §0bis (« `SITE_ID` et `SITE_NAME` absents à cette étape ») est
  réfutée ; l'incident `14a61ec` s'expliquait déjà par la variable manquante. La garde exige donc désormais, aux deux
  rideaux, l'identité positive complète (ID **et** nom) en plus de l'opt-in et de la branche.
- Remède (sans toucher au code) : déclarer la variable (§3), puis **pousser sur `main`** — pas de
  déploiement manuel.

## 1. Avant de commencer — l'ancien compte

- **Ne déclencher aucun build sur l'ancien site `vyora-ugc`** (24 crédits restants).
- La garde de build de `main` refuse tout build déclenché par Git sur l'ancien site :
  rideau 1 (`ignore`) l'annule dès qu'une des quatre conditions manque — nom `vyora-ugc`, `SITE_ID`
  ou `SITE_NAME` différents de l'identité autorisée, branche ≠ `main`, opt-in absent
  (code 0 → « Canceled build due to no content change », aucun crédit consommé) ; sinon rideau 2
  (`scripts/netlify-build-guard.sh`) fait échouer le build en quelques secondes, avant `npm ci`,
  en écrivant dans le journal `SITE_ID`, `SITE_NAME`, `BRANCH` et `VYORA_BUILD_ENABLED` reçus.
  Le nouveau site a été renommé `vyora-saas-ugc` (2026-11-18) : les deux noms diffèrent de nouveau,
  et l'identifiant reste la preuve principale.
  Un bouton **Trigger deploy** manuel ignore le rideau 1 mais **pas** le rideau 2.
- Si l'ancien site doit être détaché du dépôt : *Site configuration → Build & deploy → Continuous
  deployment → Manage repository → Unlink*. Facultatif ; la garde suffit.
- Ne pas supprimer l'ancien site tant que la nouvelle URL n'a pas été ajoutée partout (§4 à §6) :
  les utilisateurs connectés sur l'ancienne URL doivent pouvoir terminer leur session.

---

## 2. Créer le site dans le nouveau compte

1. Netlify → **Add new site → Import an existing project → GitHub** → autoriser l'accès au dépôt
   `ibrahimdiango514/SaaS-UGC`.
2. Paramètres de build (tous déjà dans `netlify.toml`, à laisser tels quels si Netlify les lit) :

   | Réglage | Valeur |
   | --- | --- |
   | Branch to deploy | `main` |
   | Base directory | *(vide — racine du dépôt)* |
   | Build command | `npm ci && npm run build` |
   | Publish directory | `dist` |
   | Functions directory | *(aucune ; les Edge Functions Netlify sont dans `netlify/edge-functions`, déclarées par `netlify.toml`)* |
   | Node | `22` (`NODE_VERSION` dans `netlify.toml`) |

3. **Avant le premier déploiement**, renseigner les variables d'environnement (§3). Netlify lance
   un premier build automatiquement à la fin de l'import : si les variables ne sont pas encore
   saisies, ce build est annulé par la garde (aucun crédit consommé, message « Canceled build due to
   no content change ») — relancer ensuite par un push sur `main`. Éviter *Trigger deploy* : un
   déclenchement manuel saute le rideau 1 (le rideau 2 reste actif) et n'est pas la procédure retenue.
4. Désactiver les Deploy Previews et les branch deploys (*Site configuration → Build & deploy →
   Continuous deployment → Deploy contexts*) : la garde les annule de toute façon (`$BRANCH` ≠
   `main`), mais autant ne pas les déclencher.
5. Relever l'URL attribuée (`https://<nom>.netlify.app`) : c'est `<NOUVELLE_URL_NETLIFY>`.
   Si vous changez le nom du site (*Site configuration → Site details → Change site name*),
   faites-le **avant** les étapes 4–6, sinon tout est à refaire.

---

## 3. Variables d'environnement Netlify (Site configuration → Environment variables)

Toutes sont **publiques** (compilées dans le bundle ou lues par le build). Aucun secret.

| Variable | Valeur | Rôle |
| --- | --- | --- |
| `VYORA_BUILD_ENABLED` | `true` (exactement, minuscules, sans espace ni guillemets) | Opt-in technique de la garde de `netlify.toml`. **Absente** (cas de `ca410d5`) ou toute autre valeur (`false`, `TRUE`, `1`) = build annulé. |
| `SORAHNEX_DEPLOY_AUTHORIZED` | `true` (exactement) — **à ne déclarer qu'au moment voulu** | **Autorisation humaine de publier.** Absente = aucun déploiement, même sur `main` avec tout le reste correct. C'est le verrou de crédits du 2026-11-25 : voir §3bis. |
| `VITE_SUPABASE_URL` | `https://xbuuhfwobrafcbgtdgjx.supabase.co` | Projet Supabase (inchangé). |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | clé `sb_publishable_…` du projet (Supabase › Settings › API) | Clé publiable (publique, livrée au navigateur). La recopier depuis Supabase, jamais depuis un document. |
| `VITE_SITE_URL` | `<NOUVELLE_URL_NETLIFY>` sans `/` final | Adresse de retour après connexion / lien magique. Si absente, le code se replie sur `window.location.origin` ; la renseigner évite toute ambiguïté. |

Laisser la portée par défaut (*All scopes*, ou au minimum *Builds*) : la garde et Vite lisent ces
variables pendant le build. `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY` ont les mêmes
valeurs par défaut dans le code (`src/lib/supabase.ts`) : les renseigner rend la configuration
explicite, leur absence ne casse pas le build.
Facultatif : `NPM_FLAGS` et `NODE_VERSION` sont déjà dans `netlify.toml`.
**Ne jamais** y mettre `SUPABASE_SERVICE_ROLE_KEY`, une clé `sb_secret_*`, ni un secret serveur.

### Procédure exacte pour `VYORA_BUILD_ENABLED` (site `vyora-saas-ugc`)

1. Netlify → site **vyora-saas-ugc** → **Site configuration** → **Environment variables**.
2. **Add a variable** → *Add a single variable*.
3. **Key** : `VYORA_BUILD_ENABLED` — **Value** : `true` (exactement, minuscules).
4. **Scopes** : laisser *All scopes* (ou au minimum *Builds*). **Deploy contexts** : *All deploy
   contexts*, ou au minimum *Production* — la garde ne construit de toute façon que `main`.
5. **Create variable**, puis vérifier dans la liste que la clé apparaît bien avec la valeur `true`.
6. Déclencher la publication **par un push sur `main`** (fusion d'une PR validée). Le prochain journal
   doit montrer `garde ignore: … VYORA_BUILD_ENABLED=true …`, `garde ignore: build autorise`, puis
   `GARDE NETLIFY — build autorisé : site fc88d197-… (vyora-saas-ugc), branche main.` suivi de `npm ci`.
   Pas de *Trigger deploy* manuel.


---

## 3bis. Verrou de crédits (2026-11-25) — publier exige une autorisation humaine

### Ce que coûtent réellement les crédits

Tarification Netlify en vigueur (modèle à crédits, depuis le 4 septembre 2025) :

| Action | Coût |
| --- | --- |
| **Déploiement de production réussi** | **15 crédits** |
| Aperçu de PR (*Deploy Preview*), déploiement de branche | **0** |
| Build **annulé** par `ignore`, build en échec, retour arrière | **0** |
| Bande passante servie aux visiteurs | 20 crédits / Go |
| Requêtes web | 2 crédits / 10 000 |
| Compute des fonctions (dont les relais Edge) | 10 crédit / Go-heure |

Les minutes de build ne sont plus comptées : un build de 10 s et un build de 10 min
coûtent le même prix s'ils publient en production.

**Conséquence à ne pas ignorer :** la bande passante et les requêtes du site **déjà
en ligne** consomment le même pool. Avec 4 crédits restants, le site actuel peut
être **mis en pause par Netlify de lui-même** (épuisement du pool = tous les sites
de l'équipe en pause), sans qu'aucun déploiement n'ait eu lieu. S'abstenir de
publier ne garantit donc pas que l'ancienne URL reste servie. C'est une raison de
plus de préparer la bascule, et de ne pas compter sur l'ancienne URL pour les
vérifications de long terme.

### Pourquoi un cinquième verrou était nécessaire

Les quatre conditions historiques étaient **toutes vraies** sur le site en service
(`BRANCH=main`, bon `SITE_ID`, bon `SITE_NAME`, `VYORA_BUILD_ENABLED=true`) : il
publiait. Une simple fusion de PR vers `main` — geste normal de développement —
déclenchait donc un déploiement à 15 crédits. La garde protégeait contre les
**mauvais sites**, pas contre les **publications non désirées**.

`SORAHNEX_DEPLOY_AUTHORIZED` comble exactement ce trou : elle n'est déclarée
**nulle part**, donc les deux rideaux refusent, et le développement peut continuer
(pousser, ouvrir des PR, faire tourner la CI) sans qu'aucune fusion puisse publier.
`tests/business-grow-deployment-guard.test.ts` rejoue ce scénario précis avec le
vrai `sh` : « site en service + fusion vers `main`, sans autorisation → bloqué par
les deux rideaux ».

### Ce qui est sûr, ce qui ne l'est pas

| Opération | Effet Netlify | Autorisé pendant le gel |
| --- | --- | --- |
| Push sur `arena/**` | aperçu annulé par `BRANCH=main`, et de toute façon gratuit | oui |
| Ouvrir une PR vers `main` | aperçu annulé, gratuit | oui |
| CI GitHub (`ci.yml`), constat (`production-check.yml`) | aucun build Netlify ; quelques requêtes HTTP vers le site (≈ 0,002 crédit) | oui |
| **Fusionner une PR vers `main`** | build de production → **15 crédits** si le verrou est levé | **non** |
| « Trigger deploy » manuel, build hook | build de production | **non** |
| Workflow `frontend-cloudflare-pages.yml` | aucun (Cloudflare), `workflow_dispatch` uniquement | sur demande |

### Procédure pour publier, le jour venu (nouveau compte)

1. Créer le site (§2) et relever **son `SITE_ID` et son nom**.
2. Ouvrir une PR qui remplace l'identité épinglée aux **deux** endroits :
   `[build].command` (arguments de `netlify-build-guard.sh`) et `[build].ignore`.
   Les tests vérifient la cohérence des deux.
3. Déclarer sur le nouveau site : `VYORA_BUILD_ENABLED=true`, les `VITE_*` (§3),
   et **en dernier, au moment voulu**, `SORAHNEX_DEPLOY_AUTHORIZED=true`.
4. Fusionner la PR validée : c'est le seul geste qui publie. Un seul déploiement
   groupé vaut mieux que plusieurs (15 crédits chacun).
5. Vérifier §7. Puis, pour re-geler, retirer `SORAHNEX_DEPLOY_AUTHORIZED`.

Tant que l'étape 3 n'est pas faite, aucune fusion ne peut consommer de crédit.

---

## 4. Supabase — secrets des Edge Functions à **compléter** (valeurs à saisir manuellement)

Console Supabase → *Edge Functions → Secrets* (ou `supabase secrets set`). Chaque secret est une
liste séparée par des virgules ; **ajouter** la nouvelle origine, ne pas retirer l'ancienne tant que
l'ancien site sert encore des utilisateurs. Toute modification de secret redémarre les fonctions
(chaque version +1) : c'est normal.

| Secret | Fonctions qui le lisent | Action |
| --- | --- | --- |
| `VYORA_ALLOWED_ORIGINS` | `store-connect` (v13), `mcp-client` (v13), `reelora-owner-bootstrap` (v9, page « Propriétaire ») | Ajouter `<NOUVELLE_URL_NETLIFY>`. Sans cela : `access-control-allow-origin: null` (boutiques, MCP) et `403 origin_not_allowed` (propriétaire). |
| `STORE_IMPORT_ALLOWED_ORIGINS` | `store-import` (v22) — lit uniquement ce secret | Ajouter `<NOUVELLE_URL_NETLIFY>` |
| `BUSINESS_GROW_ALLOWED_ORIGINS` | `business-grow` (v33) | Ajouter `<NOUVELLE_URL_NETLIFY>`. Sur Netlify, le navigateur passe d'abord par le relais `/api/business-grow` (serveur → serveur, sans origine) : Grow fonctionne même avant cet ajout ; le secret couvre le transport direct de repli (`403 ORIGIN_NOT_ALLOWED` sinon). |
| `VYORA_PAYMENTS_ALLOWED_ORIGINS` | `vyora-payments`, `vyora-payments-reconcile`, `vyora-saspay-webhook` (bundle `vyora-saspay`) | **Créer** (n'existe pas aujourd'hui) avec `<NOUVELLE_URL_NETLIFY>` exacte. La liste codée n'accepte que l'ancien domaine et ses aperçus ; aucun joker n'est admis car l'origine sert aussi à construire l'adresse de retour après paiement. Sans cela : `403 ORIGIN_NOT_ALLOWED` à l'achat de crédits. |

Valeur actuelle de `VYORA_ALLOWED_ORIGINS` = `STORE_IMPORT_ALLOWED_ORIGINS` (publique, mesurée) :
`https://vyora-ugc.netlify.app,https://deploy-preview-*--vyora-ugc.netlify.app,https://vyora.pages.dev,https://*.vyora.pages.dev`
→ nouvelle valeur : la même + `,<NOUVELLE_URL_NETLIFY>`.

Fonctions **sans** liste d'origines (répondent `*`, rien à faire ; vérifié dans la source de
chaque fonction le 2026-11-18) : `reelora-video`, `reelora-video-worker`, `reelora-ai`,
`reelora-health`, `video-quote`, `vyora-ai`, `vyora-ai-providers`, `vyora-mcp`,
`vyora-provider-health`, `vyora-oauth` (source : branche `arena/vyora-mcp-connecteurs`, bundle
`4a3f6206…`). `vyora-bg-seed` n'est pas appelée par le navigateur.

Secrets serveur existants (28, inchangés, **noms seulement**) : `SUPABASE_*` (7, injectés),
`MUAPI_API_KEY`, `BUSINESS_GROW_{GROQ,GEMINI}_API_KEY`, `BUSINESS_GROW_{GROQ,GEMINI}_MODEL`,
`BUSINESS_GROW_PROVIDER_ORDER`, `BUSINESS_GROW_{OPENROUTER,GONKA,LLM7,OLLAMA}_API_KEY`,
`BUSINESS_GROW_CLOUDFLARE_API_TOKEN`, `BUSINESS_GROW_ALLOWED_ORIGINS`, `VYORA_ALLOWED_ORIGINS`,
`STORE_IMPORT_ALLOWED_ORIGINS`, `VYORA_OAUTH_ENCRYPTION_KEY`, `VYORA_OWNER_ADMIN_EMAIL`,
`VYORA_SASPAY_SECRET_KEY`, `VYORA_SASPAY_WEBHOOK_SECRET`, `SASPAY_SECRET_KEY`,
`SASPAY_WEBHOOK_SECRET`, `SOFIA_APP_BASE_URL` (autre produit). Aucun ne contient l'URL Netlify.

---

## 5. Supabase — Authentification (GoTrue)

Console Supabase → *Authentication → URL Configuration*.

| Réglage | Valeur actuelle | Nouvelle valeur |
| --- | --- | --- |
| Site URL | `https://vyora-ugc.netlify.app` | `<NOUVELLE_URL_NETLIFY>` |
| Redirect URLs (`uri_allow_list`) | ancien domaine, aperçus `deploy-preview-*--vyora-ugc.netlify.app`, `vyora.pages.dev`, `localhost` | **Ajouter** `<NOUVELLE_URL_NETLIFY>` et `<NOUVELLE_URL_NETLIFY>/**` ; conserver le reste pendant la transition |

Attention : la mise à jour de la liste **remplace** la liste entière — recopier les entrées
existantes puis ajouter la nouvelle. Le frontend envoie `emailRedirectTo` =
`VITE_SITE_URL/auth/callback` (inscription, mot de passe oublié) et
`VITE_SITE_URL/proprietaire/confirmation` (premier administrateur) — repli : origine courante ; si la nouvelle URL n'est pas dans la liste, GoTrue redirige vers le
`Site URL` et la connexion par lien échoue silencieusement.

Fournisseurs OAuth tiers (Google, Facebook, etc.) : aucun n'est activé dans GoTrue aujourd'hui
(`external_*_enabled = false`, mesuré le 2026-11-18) ; rien à mettre à jour. Le projet Supabase
héberge aussi d'autres produits (entrées `lovable.app`, `sbc-ai-agency-dashbord.netlify.app` dans la
liste) : ne pas les retirer sans vérification, et noter que `Site URL` est global au projet — il
désignait déjà SORAHNEX (`vyora-ugc`), le passer à la nouvelle URL ne change rien pour les autres. Les OAuth gérés par SORAHNEX (MCP sortant via `mcp-client`, connecteurs via
`vyora-oauth`) utilisent des URL de retour **côté Supabase**
(`https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/oauth/callback`, dérivée de
`SUPABASE_URL`) : elles ne dépendent pas de Netlify.

---

## 6. GitHub — après connaissance de l'URL

- *Settings → Secrets and variables → Actions → Variables* : créer `VYORA_SITE_URL` =
  `<NOUVELLE_URL_NETLIFY>`. Le workflow `production-check.yml` mesurera alors le nouveau site à
  chaque push sur `main` (aucun commit nécessaire).
- Facultatif, à faire dans une PR ultérieure une fois l'URL connue : ajouter le nouveau domaine à
  `DEFAULT_ALLOWED_ORIGINS` (`src/lib/origin-allowlist.ts`) et à `STATIC_ORIGINS`
  (`supabase/functions/_shared/saspay/http.ts`), puis régénérer/redéployer les artefacts
  concernés. Ce n'est **pas** requis pour fonctionner : les secrets du §4 suffisent.

---

## 7. Vérifications après le premier déploiement

Ne cocher que ce qui a été mesuré.

1. `curl -sI <NOUVELLE_URL_NETLIFY>/` → `200`, en-têtes `x-content-type-options: nosniff`,
   `x-frame-options: DENY`, `cache-control: no-cache, no-store, must-revalidate`.
2. `curl -s <NOUVELLE_URL_NETLIFY>/ | grep vyora-revision` → le SHA du commit `main` déployé.
3. SPA : `curl -sI <NOUVELLE_URL_NETLIFY>/app/studio` et `/connexion` → `200` (pas `404`).
4. Relais : `curl -si <NOUVELLE_URL_NETLIFY>/api/business-grow -X POST -H 'content-type: application/json' -d '{}'`
   → `401` JSON (jeton exigé), **pas** `404` ni `502`.
5. CORS : `curl -si https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/store-connect -X POST -H "origin: <NOUVELLE_URL_NETLIFY>" -H "apikey: <clé publiable>" -H "authorization: Bearer <clé publiable>" -H 'content-type: application/json' -d '{"action":"status"}'`
   → `401` avec `access-control-allow-origin: <NOUVELLE_URL_NETLIFY>` (et non `null`).
   Répéter pour `store-import`, `mcp-client`, `business-grow`, `vyora-payments`, et en `GET`
   pour `reelora-owner-bootstrap` (attendu : `200` avec `access-control-allow-origin` renseigné,
   pas `403 origin_not_allowed`).
6. Dans le navigateur : inscription / connexion → lien reçu pointe vers la nouvelle URL ; page
   *Intégrations* → état « non connectée » lisible (pas d'erreur réseau) ; *Grow* →
   réponse de l'assistant ; *Studio* → devis vidéo affiché.
7. `node scripts/verify-production.mjs --site <NOUVELLE_URL_NETLIFY>` → code 0.
8. Workflow GitHub *Constat de production* vert sur le prochain push `main`.

---

## 8. Ce qui attend la future URL (récapitulatif)

| Où | Quoi | Bloquant ? |
| --- | --- | --- |
| Netlify | `VITE_SITE_URL`, `VYORA_BUILD_ENABLED=true` | Oui (build + redirections) |
| Supabase secrets | `VYORA_ALLOWED_ORIGINS`, `STORE_IMPORT_ALLOWED_ORIGINS`, `BUSINESS_GROW_ALLOWED_ORIGINS` (ajouter), `VYORA_PAYMENTS_ALLOWED_ORIGINS` (créer) | Oui (CORS : boutiques, import, MCP, propriétaire, paiements ; Grow seulement pour le transport direct) |
| Supabase Auth | `site_url`, `uri_allow_list` | Oui (connexion par lien) |
| GitHub | variable `VYORA_SITE_URL` | Non (constat uniquement) |
| Dépôt | listes par défaut (§6, facultatif) | Non |

## 9. Contraintes à ne pas oublier

- **Ne pas supprimer** les branches `arena/0188834f-saas-ugc` et `arena/0820df15-saas-ugc` sur
  GitHub : les chargeurs Edge en production téléchargent leurs bundles à des commits de ces branches
  (`209748b`, `37884b8`, `e27e2f0`, `b1cc62c`). Un commit n'est garanti joignable que tant qu'une
  référence le retient.
- Le backend ne suit pas le dépôt automatiquement : toute modification d'une Edge Function doit
  être déployée explicitement (procédure dans `scripts/build-edge-artifact.mjs`).
- Aucune donnée n'est à migrer : les utilisateurs, ateliers, crédits et connexions restent dans le
  même projet Supabase.
