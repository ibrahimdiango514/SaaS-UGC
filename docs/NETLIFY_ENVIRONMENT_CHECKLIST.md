# Inventaire des variables d'environnement — SORAHNEX

> Référence unique. Chaque variable est vérifiée contre le code : le nom exact,
> l'endroit où il est lu, et ce qui cesse de fonctionner sans lui.
>
> Fichier de valeurs : **`.env.example`** (noms et placeholders uniquement, aucune
> valeur réelle). Procédure : `docs/NETLIFY_DEPLOYMENT_CHECKLIST.md`.
>
> Dernière vérification du code : 2026-11-25 (`grep` sur `src/` et
> `supabase/functions/`, + lecture des secrets réellement déclarés sur le projet).

## Comment lire ce document

| Colonne | Sens |
| --- | --- |
| **Où** | `Frontend` = figé dans le bundle au build. `Netlify` = lu par la garde. `Supabase` = secret d'Edge Function. |
| **Oblig.** | `Oui` = sans elle, la fonctionnalité concernée ne marche pas. `Non` = repli documenté. |
| **Si absente** | Le comportement réel, pas une supposition. |

**Règle de sécurité** : tout ce qui commence par `VITE_` est **public** (présent
dans le bundle JavaScript, lisible par n'importe qui). Aucune clé secrète ne doit
jamais porter ce préfixe. L'inverse est vérifié automatiquement par
`tests/secrets-guard.test.ts`.

---

## 1. Variables frontend publiques (`VITE_`)

Figées **au moment du build**. Les modifier exige un **nouveau déploiement** — donc
15 crédits Netlify. À valider avant de publier, pas après.

| Nom | Où | Oblig. | Fonctionnalité dépendante | Valeur à fournir | Si absente |
| --- | --- | --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Frontend (`src/lib/supabase.ts`) | Oui | Toute l'application : Auth, base, Edge Functions | `https://xbuuhfwobrafcbgtdgjx.supabase.co` | Repli codé en dur sur le projet canonique. Fonctionne, mais un changement de projet passerait inaperçu. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Frontend (`src/lib/supabase.ts`) | Oui | Toute l'application | Clé `sb_publishable_…` (Supabase › Settings › API) | Repli codé en dur sur la clé publique actuelle. Fonctionne, mais masque une clé oubliée. |
| `VITE_SITE_URL` | Frontend (`src/lib/supabase.ts` → `SITE_URL`) | **Oui en production** | Liens de confirmation d'inscription, réinitialisation de mot de passe, retour après connexion | `https://<nouveau-site>.netlify.app` (sans `/` final) | Repli sur `window.location.origin`. Fonctionne si l'utilisateur ouvre le site par la bonne adresse ; échoue si un domaine secondaire est utilisé. **Doit être présent dans `uri_allow_list` de Supabase Auth.** |
| `VITE_BUSINESS_GROW_FUNCTION_URL` | Frontend (`src/business/api.ts`) | Non — **jamais en production** | Développement local uniquement (proxy Vite vers Supabase local) | `http://127.0.0.1:54321/functions/v1/business-grow` | Aucun effet hors développement. En production la valeur est ignorée (mode dev seulement). |
| `VITE_SORAHNEX_EDGE_NAMING` | Frontend (`src/lib/platform-identity.ts`) | Non | Choix des noms d'Edge Functions (`legacy` ou `canonical`) | Laisser **absent** | Les noms techniques historiques restent utilisés : c'est le comportement voulu pour la compatibilité. |

> **Attention** : `VITE_*` ne sont pas « secretes », mais elles sont **figées**. Une
> valeur fausse au build ne se corrige pas sans redéployer.

---

## 2. Variables Netlify runtime

Lues par la garde de build (`scripts/netlify-guard-lib.sh`), jamais par
l'application. **`SITE_ID`, `SITE_NAME` et `BRANCH` sont fournis par Netlify** : ne
pas les déclarer à la main, cela masquerait la vraie valeur.

| Nom | Où | Oblig. | Rôle | Valeur exacte | Si absente |
| --- | --- | --- | --- | --- | --- |
| `VYORA_BUILD_ENABLED` | Netlify (garde) | Oui pour publier | Opt-in de build du site | `true` | Build annulé (rideau 1) et refusé (rideau 2). C'est le comportement attendu d'un site non préparé. |
| `SORAHNEX_DEPLOY_AUTHORIZED` | Netlify (garde) | Oui pour publier | **Autorisation humaine** : un humain assume la dépense de 15 crédits | `true` | Publication impossible. C'est le verrou de crédits. |
| `SORAHNEX_DEPLOY_AUTHORIZED_NAME` | Netlify (garde) | Oui pour publier | Second facteur du verrou : garantit que la variable ci-dessus a été posée **pour ce mécanisme** | `sorahnex-deploy` | Publication impossible, même si la variable précédente vaut `true`. |

### Variables fournies par Netlify — ne pas déclarer

| Nom | Rôle dans la garde |
| --- | --- |
| `SITE_ID` | Identité du site, comparée à `netlify.site.conf` |
| `SITE_NAME` | Identité du site, comparée à `netlify.site.conf` ; refus explicite de l'ancien nom |
| `BRANCH` | Seule `main` publie |

### Identité du site autorisé — dans le dépôt, pas dans Netlify

| Fichier | Contenu |
| --- | --- |
| `netlify.site.conf` | `SITE_ID` (fait foi), `SITE_NAME` ou `SITE_NAME_FACULTATIF`, `ANCIEN_SITE_NAME`, `ANCIEN_SITE_ID`. **Seule source de vérité**, lue par les deux rideaux. Migrer = `sh scripts/netlify-autoriser-site.sh <SITE_ID> <SITE_NAME>`, qui déplace l'ancien sur `ANCIEN_SITE_ID`. |

---

## 3. Secrets backend Supabase (Edge Functions)

**Jamais** côté navigateur, **jamais** sur Netlify. Se déclarent par
`supabase secrets set NOM=valeur` ou dans Supabase › Edge Functions › Secrets.

### 3.1 Injectés automatiquement — ne pas déclarer

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.

### 3.2 Obligatoires selon la fonctionnalité

| Nom | Lu par | Oblig. | Fonctionnalité | Si absente |
| --- | --- | --- | --- | --- |
| `MUAPI_API_KEY` | `reelora-video`, `universal-catalog`, `studio-runtime` | Oui pour générer | Génération Studio (vidéo, image, i2v, scripts) | Studio affiche les modèles mais aucune génération n'aboutit. `reelora-health` signale `ai: false`. |
| `FREE_LLM_API_KEY` | `vyora-ai`, `reelora-health` | Oui pour l'assistant Studio | Briefs, scripts, hooks, amélioration de prompt | L'assistant IA ne répond pas ; Studio reste utilisable manuellement. |
| `FREE_LLM_API_BASE_URL` | `vyora-ai` | Oui avec la précédente | URL de l'instance FreeLLMAPI | Appels IA en échec. `127.0.0.1` **n'est pas joignable** depuis une Edge Function : l'instance doit être publique en HTTPS. |
| `BUSINESS_GROW_<FOURNISSEUR>_API_KEY` | `business-grow` (`providers.ts`) | Non, mais **bloquant pour l'assistant Grow** | Réponses de l'assistant d'entreprise | `business-grow › status` renvoie `enabled:false, config_status:"missing"` pour tous les fournisseurs. Grow répond à toutes les actions de données ; **seule la génération de texte est indisponible**. Vérifié en production le 2026-11-25 : aucun `BUSINESS_GROW_*` n'est déclaré. |

> **Piège à connaître** : le fournisseur IA de Grow et la passerelle `vyora-ai`
> lisent des noms **différents** (`BUSINESS_GROW_*` vs `FREE_LLM_*`). Déclarer
> `FREE_LLM_*` ne configure pas Grow, et inversement.
>
> `BUSINESS_GROW_<FOURNISSEUR>_BASE_URL`, `_MODEL`, `_API_TOKEN`, `_ACCOUNT_ID`
> et `BUSINESS_GROW_PROVIDER_ORDER` sont optionnels (repli sur le registre).
> `BUSINESS_GROW_DATABASE_URL` est optionnel (repli `SUPABASE_DB_URL`).

### 3.3 Paiement

| Nom | Lu par | Oblig. | Si absente |
| --- | --- | --- | --- |
| `SASPAY_SECRET_KEY` / `VYORA_SASPAY_SECRET_KEY` | `vyora-payments`, `saspay-*` | Oui pour encaisser | Achats et recharges de crédits indisponibles. **Le code lit les deux noms** : déclarer celui du compte actif. |
| `SASPAY_WEBHOOK_SECRET` / `VYORA_SASPAY_WEBHOOK_SECRET` | `vyora-saspay-webhook`, `saspay-webhook` | Oui pour encaisser | Les webhooks de confirmation sont rejetés : un paiement peut être débité sans créditer le compte. **Critique.** |

### 3.4 OAuth et MCP

| Nom | Lu par | Oblig. | Si absente |
| --- | --- | --- | --- |
| `VYORA_OAUTH_ENCRYPTION_KEY` | `vyora-oauth`, `mcp-client` | Oui pour connecter un compte externe | Les jetons OAuth ne peuvent être chiffrés : la connexion échoue proprement. |
| `MCP_CLIENT_CALLBACK_URL` | `mcp-client` | Non | Repli : `${SUPABASE_URL}/functions/v1/mcp-client/oauth/callback`. À déclarer seulement pour un domaine personnalisé. |
| `VYORA_MCP_RESOURCE_URL` | `vyora-mcp` | Non | Repli dérivé de `SUPABASE_URL`. |
| `VYORA_MCP_WRITE_ENABLED` | `vyora-mcp` | Non | Les outils d'écriture ne sont **pas** proposés. Défaut sûr : laisser absent. |
| `VYORA_OWNER_ADMIN_EMAIL` | bootstrap propriétaire | Non | Aucun propriétaire promu automatiquement. |

### 3.5 CORS — les plus sensibles lors d'une migration de domaine

| Nom | Lu par | Si la nouvelle origine manque |
| --- | --- | --- |
| `BUSINESS_GROW_ALLOWED_ORIGINS` | `business-grow` | Le navigateur bloque les réponses de Grow : écran vide ou erreurs réseau. **Ajouter la nouvelle origine AVANT de retirer l'ancienne.** |
| `VYORA_ALLOWED_ORIGINS` | `mcp-client`, `vyora-*` | Idem pour MCP et les fonctions vyora-*. |
| `STORE_IMPORT_ALLOWED_ORIGINS` | `store-import` | Idem pour l'import de boutiques. |
| `VYORA_PAYMENTS_ALLOWED_ORIGINS` | `vyora-payments` | Idem pour le paiement. |

> Les valeurs de ces quatre variables sont **des origines complètes**
> (`https://mon-site.netlify.app`), séparées par des virgules. Une barre finale ou
> un `*` mal placé ne correspond à rien.

### 3.6 Bases dédiées (facultatif)

`STORE_IMPORT_DATABASE_URL`, `STORE_CONNECT_DATABASE_URL`,
`BUSINESS_GROW_DATABASE_URL` — repli sur `SUPABASE_DB_URL` si absentes.

---

## 4. Variables facultatives / par connecteur

Aucune n'est nécessaire pour que l'application fonctionne.

| Groupe | Noms | Sans elles |
| --- | --- | --- |
| Connecteurs sociaux | `META_APP_ID`, `TIKTOK_CLIENT_KEY`, `GOOGLE_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, `PINTEREST_APP_ID` | Les connecteurs concernés s'affichent « indisponible » dans le catalogue. **État actuel en production : aucune n'est déclarée** — et l'interface le dit correctement. |
| Catalogues | `MAGENTO_ALLOW_KEYS`, `WIX_API_KEY`, `BIGCOMMERCE_API_KEY`, `SQUARESPACE_API_KEY` | Ces sources de catalogue ne peuvent pas être interrogées par API. L'import de fichier reste disponible. |
| Boutiques sans variable | Shopify, WooCommerce, PrestaShop, **Chariow** | Aucune configuration globale : le marchand fournit sa clé, vérifiée côté serveur. Fonctionnent **sans** variable d'environnement. |

---

## 5. Ce qui reste à faire par vous (impossible depuis le dépôt)

| # | Action | Où | Pourquoi |
| --- | --- | --- | --- |
| 1 | Fournir le **nom** et le **Site ID** du nouveau site | — | Nécessaires pour `netlify.site.conf` |
| 2 | Créer le site et le relier au dépôt | Netlify | Hors dépôt |
| 3 | Déclarer les 3 variables `VITE_*` | Netlify | Sans elles, le site ne joint pas le backend |
| 4 | Déclarer `VYORA_BUILD_ENABLED=true` | Netlify | Opt-in de build |
| 5 | Déclarer les 2 variables d'autorisation **au dernier moment** | Netlify | Verrou de crédits |
| 6 | Mettre à jour `site_url` et `uri_allow_list` | Supabase Auth | Liens de confirmation et de réinitialisation |
| 7 | Ajouter la nouvelle origine aux 4 variables CORS | Supabase secrets | Sinon le navigateur bloque Grow, MCP, import et paiement |
| 8 | Décider de configurer un fournisseur IA pour Grow | Supabase secrets | Sinon l'assistant Grow ne génère pas de texte |

Procédure détaillée, dans l'ordre : `docs/NETLIFY_DEPLOYMENT_CHECKLIST.md`.
