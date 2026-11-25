# Rapport de préparation — repo prêt pour le nouveau site Netlify

**Date :** 25 novembre 2026 · **Branche :** `arena/397677d5-saas-ugc` · **PR :** #54 (ouverte, non fusionnée)
**Aucun crédit Netlify consommé. Aucun déploiement, aucun build Netlify, aucun deploy preview.**

---

## 1. La réponse directe à ta question

**Le repo est-il prêt à être connecté à un nouveau site Netlify ? Oui — sous trois
conditions que tu seul peux lever**, détaillées en §5. Aucun blocage technique ne
subsiste côté code.

**Le backend est-il prêt ? Oui pour le scénario réaliste** (le nouveau Netlify pointe
sur le Supabase actuel) : c'est un changement d'hébergement, pas de base de données.
**Non pour un projet Supabase neuf**, et c'est le point le plus important de ce
rapport : **le socle de la base n'a jamais été versionné** (§3).

**Le site existe ?** Non. Rien n'a été créé.

---

## 2. Ce qui a été corrigé pendant cette préparation

| Correctif | Pourquoi c'était un vrai problème |
|---|---|
| **Garde Netlify refondue** — 8 règles fermées par défaut, identité dans un seul fichier (`netlify.site.conf`) | Migrer un site = changer deux lignes, sans toucher au code de la garde. Autorisation **désactivée par défaut** ; site inconnu, mal formé, production non autorisée ou nom contourné → refus. 51 tests. |
| **`.env.example` nettoyé** | Il documentait des secrets serveur comme s'ils étaient à remplir. Trois tests existants l'ont refusé, à juste titre. Désormais : **aucune variable assignable hors `VITE_`**, tout le reste en documentation commentée. |
| **40 vues `public` versionnées** | Elles n'existaient dans **aucune** migration. Sur une base neuve, **toutes** les lectures du frontend échouaient — Studio, Grow, caisse, réglages — alors que les fichiers SQL paraissaient complets. |
| **`scripts/audit-origins.mjs`** | Rend visible le piège CORS : une origine oubliée produit « backend injoignable » alors que la fonction répond. 13 tests, dont un qui échouera si une liste devient bloquante. |
| **`scripts/verify-grow-writes.mjs`** | Prouve que les écritures de Grow **persistent** (création → relecture → modification → relecture → suppression → vérification de disparition). Un 200 ne suffit jamais. Opt-in, nettoyé, 9 tests dont 3 qui vérifient qu'il **refuse** une écriture fantôme. |
| **`verify-production.mjs`** | Il retombait sur le site **mort** `vyora-ugc` : il aurait rendu un rapport vert sur un site fermé. Désormais refus explicite, code 2. |
| **4 documents de vérité** | Inventaire des variables, checklist de déploiement, smoke test, état des migrations, audit Auth. |

## 3. La découverte importante : la base ne se reconstruit pas depuis ce dépôt

C'est le résultat le plus utile de cet audit, et il n'était documenté nulle part.

- Le frontend interroge `public`, les tables vivent dans `saas_ugc`, et **les schémas
  eux-mêmes ne sont créés par aucune migration**.
- **32 tables de production n'ont jamais été créées par le dépôt**, dont
  `ugc_workspaces`, `ugc_wallets`, `ugc_credit_ledger`, `ugc_generation_jobs`.
- Il manque aussi leurs contraintes, index, déclencheurs, **politiques RLS**, les
  fonctions `ugc_private` et les données de référence.

**Ce que cela ne veut PAS dire :** le backend n'est pas cassé. En production, les
33 Edge Functions, les 23 tables interrogées et les 94 RPC répondent.

**Ce que cela veut dire :** le socle d'avant le 8 novembre 2026 n'a jamais été
versionné, il n'existe que dans la base actuelle. Un **projet Supabase neuf** exige
de le capturer d'abord — procédure `pg_dump` complète dans
`docs/MIGRATIONS_STATUS.md` §3, scénario B. **Non exécutée : elle demande ton
autorisation.**

Si le nouveau Netlify garde le Supabase actuel — le cas probable — **ce trou ne
bloque rien**.

## 4. Vérifications réellement exécutées

| Vérification | Résultat |
|---|---|
| `npm test` (suite complète) | **233 fichiers / 3572 tests verts** |
| `npm run typecheck` | ✅ |
| `npm run typecheck:edge` | ✅ |
| `npm run check:edge-imports` | ✅ imports Deno conformes |
| `npm run build` (local, pas Netlify) | ✅ 16,6 s |
| Artefacts `studio-runtime` / `universal-catalog` | ✅ à jour |
| `npm run audit:origins` | **0 bloquant**, 15 constats |
| DDL des 40 vues exécuté sur la base **en transaction annulée** | ✅ aucune erreur, rien modifié |
| Garde Netlify | 51 tests · Secrets | 4 · Origines | 13 · Écritures Grow | 9 · Migrations | 10 · Auth | 9 |
| Config Supabase Auth | relevée et documentée |
| RLS des 15 tables sensibles | activée partout, **0 politique `anon`** |
| Vues de production | 40/40 en `security_invoker=true` |

**Je n'ai pas exécuté** — et je ne prétends donc pas l'avoir fait : les harnais
authentifiés (pas de réseau vers la production depuis cet environnement, ils tournent
sur GitHub Actions), le smoke test post-déploiement, et aucune migration en écriture.

## 5. Ce qui exige ta décision ou une autorisation

1. **Nom, ID et informations du nouveau site Netlify** — sans eux, je ne peux pas
   remplir `netlify.site.conf`.
2. **Autorisation explicite de déployer**, quand le moment viendra. Rien ne partira
   avant.
3. **Décider du backend** : même projet Supabase (recommandé, zéro travail) ou projet
   neuf (il faut alors capturer le socle avec `pg_dump` — autorisation requise).
4. **SMTP** : sans lui, le « mot de passe oublié » est plafonné à **2 e-mails par
   heure**. Invisible aujourd'hui (`mailer_autoconfirm = true`), bloquant le jour où
   un client clique. Il me faut des identifiants SMTP.
5. **Configurer les secrets CORS** sur Supabase au moment de la bascule (4 variables,
   liste exacte fournie par `npm run audit:origins`).
6. **Mettre à jour `site_url` et `uri_allow_list`** — attention : l'API **remplace**
   la liste, elle ne l'ajoute pas.
7. **Migrations lot16/17 du Studio** : procédure prête, non appliquée (elle touche à
   la facturation).

## 6. Les risques qui restent, dits franchement

- **Les Edge Functions codent en dur `vyora-ugc.netlify.app` comme « production »**,
  site fermé. Le site réellement servi ne passe que par des secrets CORS. Perdre un
  secret casse Grow sans qu'aucune ligne de code ne change. Corriger exige de modifier
  du code Edge : **hors périmètre sans ton accord**, mais l'audit chiffre le risque.
- **La clé publiable reste en repli** dans `src/lib/supabase.ts` et
  `scripts/verify-authenticated.mjs`. Elle est publique par nature, mais ce repli
  **masque une variable oubliée** : un build sans `VITE_SUPABASE_PUBLISHABLE_KEY`
  fonctionnerait quand même, en silence.
- **`password_min_length = 6`** — faible pour un compte qui donne accès à des crédits
  payants. Une ligne à changer, décision produit.
- **`store-import-live-check.ts`** mentionne encore l'ancien domaine : c'est un
  scénario de test auto-suffisant, pas une cible. Laissé tel quel volontairement.

## 7. Les documents qui font foi

| Document | Contenu |
|---|---|
| `docs/NETLIFY_DEPLOYMENT_CHECKLIST.md` | 9 étapes ordonnées, de « informations à recevoir » à « après publication » |
| `docs/NETLIFY_ENVIRONMENT_CHECKLIST.md` | Inventaire des variables : nom, usage, frontend/backend, obligatoire, fonctionnalité dépendante, risque |
| `docs/NETLIFY_POST_DEPLOY_SMOKE_TEST.md` | 9 sections + table de diagnostic — **préparé, pas exécuté** |
| `docs/MIGRATIONS_STATUS.md` | État mesuré des migrations, le trou de reconstruction, les deux scénarios |
| `docs/AUTH_CONFIG_AUDIT.md` | Config Auth relevée, SMTP et autoconfirm, procédure de bascule |
| `docs/bascule-nouveau-netlify.md` | Procédure de bascule, identité dans un seul fichier |
| `netlify.site.conf` | **La** source de vérité : `SITE_ID`, `SITE_NAME`, `ANCIEN_SITE_NAME` |

## 8. Ce que je peux dire honnêtement

Le repo est **prêt à être connecté**. La garde protège réellement, la configuration
est portable sans édition répétée du code, les variables sont inventoriées, les
parcours d'authentification sont compris et documentés, et les outils d'audit rendent
visibles les pièges qui se paient après publication.

Le site **n'existe pas encore**. Aucun crédit Netlify n'a été consommé.

Deux choses **ne sont pas** prêtes, et je ne les présenterai pas autrement : le
**socle de la base n'est pas reconstructible** en l'état (§3), et le **SMTP n'est pas
configuré** (§5.4). Ni l'une ni l'autre n'empêche la bascule vers le même Supabase —
mais les deux doivent être sues avant d'ouvrir à des clients payants.
