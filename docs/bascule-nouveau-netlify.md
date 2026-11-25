# Bascule vers le nouveau site Netlify — procédure vérifiée

> Objet : préparer le déploiement final sur le **nouveau compte Netlify**, sans
> consommer les derniers crédits de l'ancien compte. Aucune étape de ce document
> n'a été exécutée : ce sont des **instructions prêtes à l'emploi**.
>
> État au 2026-11-25 : le site en service reste `https://vyora-saas-ugc.netlify.app`
> (`main` = `e7c77a9`). Il n'est ni supprimé, ni remplacé.

## 0. Ce qui est déjà vérifié (ne pas refaire)

| Élément | État constaté |
| --- | --- |
| Frontend servi | HTTP 200, cachet `e7c77a9` = `main`, identité SORAHNEX |
| Edge Functions déployées | `business-grow` v43, `store-import` v30, `store-connect` v21, `mcp-client` v19, toutes ACTIVE |
| Chargeurs épinglés | commit `0e49773…`, empreintes conformes, parité vérifiée |
| Grow authentifié | `status`, `quota.status`, `conversations.list`, `memory.get`, `tools.list` → 200 ; modules CRM / caisse / catalogue → 200 |
| Import & Connect authentifié | 403 `BUSINESS_GROW_SUBSCRIPTION_REQUIRED` (restriction voulue, pas une panne) |
| CORS depuis la production | origine acceptée par les quatre fonctions |
| GoTrue | `site_url` et liste autorisée corrigés le 2026-11-25 (voir §1) |

## 1. Correctif d'authentification appliqué (fait)

`get_auth_config` a révélé deux défauts qui rendaient les liens de réinitialisation
inutilisables depuis la production :

- `site_url` valait `https://vyora-ugc.netlify.app` — l'**ancien site**, refusé
  explicitement par la garde de déploiement ;
- `uri_allow_list` ne contenait pas `https://vyora-saas-ugc.netlify.app`, l'origine
  pourtant utilisée par `src/lib/api.ts` (`emailRedirectTo`, `resetPasswordForEmail`)
  et `src/pages/OwnerBootstrap.tsx`.

Corrigé : `site_url` = `https://vyora-saas-ugc.netlify.app`, et la liste autorisée
ouvre cette origine, ses prévisualisations et la **future** origine Netlify. Toutes
les entrées existantes ont été préservées (Supabase exige la liste complète).

## 2. Variables à déclarer sur le NOUVEAU site

À créer dans **Site configuration → Environment variables**, avant toute publication.

### 2.1 Obligatoires au build

| Nom | Valeur | Pourquoi |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `https://xbuuhfwobrafcbgtdgjx.supabase.co` | Backend (même projet, rien à migrer côté base) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | clé `sb_publishable_…` du projet | Clé **publique** ; la clé secrète ne doit jamais entrer dans un build frontend |
| `VITE_SITE_URL` | `https://<nouveau-site>.netlify.app` | Origine des redirections e-mail ; sans elle le code se replie sur `window.location.origin`, ce qui fonctionne mais reste ambigu |
| `VYORA_BUILD_ENABLED` | `true` | Rideau 1 de la garde |
| `SORAHNEX_DEPLOY_AUTHORIZED` | **`true`, en dernier** | Rideau 2 : autorisation humaine explicite. Tant qu'elle manque, aucun build ne part |

### 2.2 Identité du site — DEUX endroits à mettre à jour

La garde compare le nom **et** l'identifiant du site. Une seule mise à jour laisse
la publication bloquée (c'est le comportement voulu) :

1. `netlify.toml`, ligne `ignore` : remplacer
   `SITE_ID` (`fc88d197-fe0b-47c7-a6e3-fba44eeccda9`) et `SITE_NAME`
   (`vyora-saas-ugc`) par ceux du nouveau site ;
2. `scripts/netlify-build-guard.sh` : les mêmes deux valeurs.
3. **Par PR, jamais par un push direct sur `main`.**
4. Conserver `SITE_NAME != "vyora-ugc"` : c'est le refus explicite de l'ancien site.

### 2.3 Côté Supabase, à faire au moment de la bascule

`update_auth_config` exige **toute** la liste : reprendre l'existante et y ajouter
la nouvelle origine, sinon les entrées actuelles sont perdues.

| Réglage | Valeur cible |
| --- | --- |
| `site_url` | `https://<nouveau-site>.netlify.app` |
| `uri_allow_list` | liste actuelle **+** `https://<nouveau-site>.netlify.app/**` **+** ses prévisualisations |
| `BUSINESS_GROW_ALLOWED_ORIGINS` (secret Edge) | ajouter la nouvelle origine ; l'ancienne peut rester pendant la transition |
| `VYORA_ALLOWED_ORIGINS`, `STORE_IMPORT_ALLOWED_ORIGINS` (secrets Edge) | idem |

Ne pas retirer l'ancienne origine avant d'avoir constaté que le nouveau site
fonctionne : cela casserait le site encore en service.

## 3. Ce qui est réellement configuré côté fournisseurs (constaté)

Liste des secrets Edge existants (noms seulement) et conséquence sur les
fonctionnalités :

| Domaine | Secret présent | Effet |
| --- | --- | --- |
| Paiement | `SASPAY_SECRET_KEY`, `SASPAY_WEBHOOK_SECRET`, `VYORA_SASPAY_SECRET_KEY`, `VYORA_SASPAY_WEBHOOK_SECRET` | Opérationnel |
| Génération Studio | `MUAPI_API_KEY` | Opérationnel |
| Assistant | `FREE_LLM_API_KEY`, `FREE_LLM_API_BASE_URL`, `FREE_LLM_MODEL` | Opérationnel |
| OAuth | `VYORA_OAUTH_ENCRYPTION_KEY` | Chiffrement des jetons prêt |
| Connexion sociale | **aucun** (`META_APP_ID`, `TIKTOK_CLIENT_KEY`, `GOOGLE_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, `PINTEREST_APP_ID` absents) | Les connecteurs sociaux restent affichés « indisponibles » — et c'est exact, le catalogue le dit déjà |
| Boutiques | Aucune clé globale nécessaire | Shopify / WooCommerce / PrestaShop / Chariow se connectent par clé fournie par le marchand, vérifiée côté serveur |
| FOURNISSEUR BUSINESS GROW | **aucun** `BUSINESS_GROW_*_API_KEY` | `business-grow · status` renvoie tous les fournisseurs `enabled: false, status: unverified, config_status: missing` |

**Point d'attention réel** : l'assistant d'entreprise (Grow) n'a aucun fournisseur
de modèle configuré. `FREE_LLM_*` alimente `vyora-ai`, pas Grow — les deux lisent
des noms de variables différents (`BUSINESS_GROW_<FOURNISSEUR>_API_KEY`). Grow
répond, mais ne peut pas générer de réponse tant qu'une clé fournisseur n'est pas
déclarée. À décider avec l'utilisateur, pas à improviser : ajouter une clé
consomme le quota du fournisseur choisi.

## 4. Vérification après publication

1. `node scripts/verify-production.mjs` avec `VYORA_SITE_URL` sur le nouveau site.
2. Workflow **Vérification authentifiée** (`workflow_dispatch`) : il obtient une
   vraie session et sonde Grow, ses modules, MCP et Studio. Le rapport complet est
   téléchargeable en artefact (`rapport-verification-authentifiee`).
3. Parcours manuel : inscription, connexion, mot de passe oublié → le lien doit
   revenir sur le **nouveau** site.
4. Contrôle du badge et de l'identité SORAHNEX.

## 5. Retour arrière

- Frontend : redéployer `e7c77a9` sur l'ancien site, ou republier `ec8d46d`.
- Edge : versions précédentes conservées côté Supabase (v42 / v29 / v20 / v18).
- Base : **aucune migration appliquée** par la récupération ; rien à annuler.
- GoTrue : rétablir `site_url` = `https://vyora-saas-ugc.netlify.app` et retirer la
  nouvelle origine de la liste.
