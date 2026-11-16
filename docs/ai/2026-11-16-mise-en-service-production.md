# Mise en service VYORA — 16 novembre 2026

Rapport factuel. Trois catégories distinguées : **développé**, **déployé**,
**vérifié en production**. Une fonctionnalité n'est marquée vérifiée qu'avec une
mesure réelle, jamais parce qu'un build passe.

## 1. Ce qui est en production

| Élément | État | Preuve |
| --- | --- | --- |
| Branche `main` | À jour | `main` = commit de publication, `develop` fusionné |
| Application web | **Servie** | `HTTP 200`, cachet `vyora-revision` présent dans le HTML |
| Edge Function `store-import` | **Déployée et répond** | `POST` anonyme → `401 UNAUTHORIZED_NO_AUTH_HEADER` |
| RPC d'administration des fournisseurs IA | **Créées en base** | `pg_proc` : présentes, `secdef`, `auth=true`, `anon=false` |
| Migrations du noyau IA | Appliquées (objets vérifiés un par un) | tables `ai_catalog_models`, `ai_call_leases`, `ai_routing_log`… présentes |

### Le cachet de révision

`dist/index.html` contient :

```html
<meta name="vyora-revision" content="<sha7>" />
```

Il rend la question « le site public sert-il la nouvelle version ? » vérifiable
en une requête, au lieu de la supposer :

```bash
curl -s https://vyora-ugc.netlify.app/ | grep -o 'vyora-revision" content="[^"]*"'
```

Constat réel observé : le site a servi `799ae49`, puis `6082be4` — c'est-à-dire
que **le déploiement automatique fonctionne**, avec un décalage de quelques
minutes après chaque merge (temps de build : `npm ci` + `vite build`).

## 2. Défaut de production trouvé et corrigé

**Deux RPC appelées par le frontend n'existaient pas en base** :
`vyora_ai_admin_provider_upsert` et `vyora_ai_admin_provider_disable`.

- Détection par **inventaire des objets** (`pg_proc`), pas par numéro de version :
  cinq migrations de ce dépôt ont été appliquées sous un autre horodatage
  (`20261114205847` pour `20261115200000`, etc.). Comparer les versions aurait
  conclu à tort que tout était appliqué.
- Conséquence réelle : les boutons d'ajout et de désactivation d'un fournisseur
  dans l'administration IA échouaient à l'exécution.
- Correctif : migration `20261116030000_vyora_ai_admin_provider_rpcs.sql`, sans
  aucune suppression de données. `upsert` délègue à `vyora_ai_provider_upsert`
  (validation unique) ; `disable` désactive le fournisseur et coupe ses règles de
  routage sans jamais rien supprimer.
- Garde-fou : `tests/migrations-object-parity.test.ts` échoue si une RPC du code
  n'a pas de définition dans les migrations.

## 3. Ce qui n'est PAS encore vérifié

### Test d'import réel sur une boutique autorisée

La fonction répond (`401` sans jeton), ce qui prouve que le **chargeur démarre**
et que l'artefact est chargeable. Mais l'import effectif d'une URL de catalogue
demande un **jeton utilisateur et une boutique autorisée** : cette étape n'a pas
encore été exécutée en production.

Commande, à lancer avec un jeton réel et une boutique de test autorisée :

```bash
curl -sS -X POST https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/store-import \
  -H "authorization: Bearer $TOKEN_UTILISATEUR" \
  -H "apikey: $CLE_PUBLIQUE" \
  -H 'content-type: application/json' \
  -d '{"action":"preview","url":"<URL_BOUTIQUE_AUTORISEE>"}'
```

Attendu : un aperçu avec `previewId`, ou un refus explicite (`403` domaine non
autorisé, `409` aperçu expiré, `503` artefact indisponible). Aucune de ces issues
n'est un succès d'import : seul un résultat `confirmed === true` suivi de
l'import l'est.

### Connexions réelles des fournisseurs IA

`0` fournisseur n'est marqué `implemented` en base, et c'est volontaire : la
règle du projet interdit `implemented = true` sans sonde réelle réussie. Le
registre, le routage, les sondes planifiées et les diagnostics sont déployés ;
les connexions effectives dépendent des clés, qui ne sont jamais lues ni
recopiées par l'outillage.

## 4. Moyens de vérification

- **Runner GitHub** : `.github/workflows/production-check.yml`, déclenché à
  chaque push sur `main` et sur les branches de travail. Il mesure le code HTTP
  du site, le cachet servi, le refus anonyme de la fonction, et écrit le tout
  dans des annotations lisibles par l'API (les journaux bruts ne sont pas
  récupérables : `failed to get run log: EOF`).
- **Local** : `node scripts/verify-production.mjs` — sortie `0` (concordance),
  `1` (écart mesuré), `2` (mesure impossible). Aucun secret utilisé.

## 5. Limite de l'environnement de développement

Le bac à sable de développement n'a **aucun accès réseau** à `*.supabase.co` ni
à `*.netlify.app` (egress limité à GitHub et npm). Toutes les preuves de
production ci-dessus proviennent donc du runner GitHub, jamais d'une supposition
locale.
