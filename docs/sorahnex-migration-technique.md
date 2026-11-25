# SORAHNEX — migration technique de la marque

État au 25 novembre 2026. Branche de développement uniquement : **aucune
ressource de production n'a été modifiée, renommée ou supprimée** dans le cadre
de ce document.

Ce document répond à trois questions, dans cet ordre :

1. quelles ressources portent encore `VYORA` / `REELORA` ;
2. lesquelles peuvent être renommées maintenant, lesquelles exigent une
   transition, lesquelles ne doivent pas bouger ;
3. comment revenir en arrière à chaque étape.

---

## 1. Périmètre et méthode

La règle appliquée est celle demandée : **aucun remplacement massif**. Chaque
ressource est traitée selon sa nature, parce que le coût d'une erreur n'est pas
le même pour un libellé d'interface et pour une clé étrangère.

| Nature | Conséquence d'un renommage brutal |
| --- | --- |
| Texte d'interface | Aucune, hors cohérence visuelle |
| Nom de fonction Edge | `404` immédiat pour tout appelant déployé |
| Fonction SQL / RPC | Appel frontend cassé, grants et `SECURITY DEFINER` perdus |
| Table ou colonne | Données inaccessibles, clés étrangères invalides |
| Bucket | Fichiers et URL signées cassés |
| Secret / variable d'environnement | Fonction qui démarre mais échoue à l'exécution |
| Domaine, callback OAuth | Boucle de connexion, webhook rejeté |
| Artefact Edge épinglé | `503 ARTIFACT_UNAVAILABLE` (incident déjà vécu) |

Deux sources de vérité ont été utilisées :

- le dépôt (recherche exhaustive, insensible à la casse) ;
- la base de production **en lecture seule** (`pg_proc`, `pg_class`,
  `storage.buckets`) pour ne pas confondre un nom présent dans une migration
  historique avec un objet réellement déployé.

Cette distinction a immédiatement corrigé une hypothèse : `vyora_files` et
`reelora_avatars` sont des **tables**, pas des buckets. Les buckets ne portent
aucune marque.

---

## 2. Inventaire mesuré

### 2.1 Dépôt

| Zone | Occurrences `vyora`/`reelora` | Décision |
| --- | --- | --- |
| `supabase/**` | ~2 855 | Sources Edge épinglées et migrations appliquées : traitées par procédure, pas par `sed` |
| `src/**` | ~400 avant cette PR | Marque visible et noms d'appels techniques : traités |
| `docs/**` | ~580 | Documentation historique conservée, nouvelle documentation SORAHNEX |
| `tests/**` | ~730 | Tests de parité et de contrat : conservés tels quels |
| `scripts/**` | ~123 | Outils de build et de vérification : conservés |
| `netlify/**`, `netlify.toml` | 5 | Domaine historique encore servi : conservé |
| `.github/**` | 24 | Workflows : conservés (noms de secrets) |

### 2.2 Base de production (lecture seule)

| Objet | Nombre | Détail |
| --- | --- | --- |
| Fonctions SQL préfixées | **185** sur 736 | `vyora_*` (paiements, IA, administration, fichiers, catalogue) et `reelora_*` (Studio, quotas, générations) |
| Relations (tables/vues) | **15** | 10 dans `public`, 5 dans `saas_ugc` |
| Buckets de stockage | **0** | `ugc-assets`, `payment-proofs` : déjà neutres |
| Colonnes de marque | 0 trouvée | Les colonnes métier sont neutres (`status`, `user_id`, `service_key`…) |

Relations à migrer, avec leur cible :

| Actuel | Cible |
| --- | --- |
| `public.reelora_avatars` | `public.sorahnex_avatars` |
| `public.reelora_prompt_templates` | `public.sorahnex_prompt_templates` |
| `public.reelora_generation_presets` | `public.sorahnex_generation_presets` |
| `public.reelora_plans` | `public.sorahnex_plans` |
| `public.reelora_subscriptions` | `public.sorahnex_subscriptions` |
| `public.reelora_usage_events` | `public.sorahnex_usage_events` |
| `public.reelora_notifications` | `public.sorahnex_notifications` |
| `public.reelora_audit_logs` | `public.sorahnex_audit_logs` |
| `public.reelora_video_models` | `public.sorahnex_video_models` |
| `public.vyora_files` | `public.sorahnex_files` |
| `saas_ugc.vyora_payment_initiations` | `saas_ugc.sorahnex_payment_initiations` |
| `saas_ugc.vyora_fee_schedule` | `saas_ugc.sorahnex_fee_schedule` |
| `saas_ugc.vyora_payment_reconciliations` | `saas_ugc.sorahnex_payment_reconciliations` |
| `saas_ugc.vyora_payment_reconcile_runs` | `saas_ugc.sorahnex_payment_reconcile_runs` |
| `saas_ugc.vyora_payment_anomalies` | `saas_ugc.sorahnex_payment_anomalies` |

### 2.3 Edge Functions

Douze fonctions sur dix-neuf portent la marque.

| Actuel | Cible | Dépendances à vérifier |
| --- | --- | --- |
| `vyora-ai` | `sorahnex-ai` | frontend (`src/lib/api.ts`), `business-grow`, crons IA |
| `vyora-ai-providers` | `sorahnex-ai-providers` | cron `vyora-ai-providers-probe` |
| `vyora-mcp` | `sorahnex-mcp` | clients MCP externes, OAuth, `/.well-known/oauth-protected-resource` |
| `vyora-payments` | `sorahnex-payments` | frontend paiements, webhook SasPay, retours de paiement |
| `vyora-payments-reconcile` | `sorahnex-payments-reconcile` | cron de réconciliation |
| `vyora-provider-discovery` | `sorahnex-provider-discovery` | administration IA |
| `vyora-provider-health` | `sorahnex-provider-health` | crons `vyora-provider-health-*`, en-tête `x-vyora-cron` |
| `vyora-saspay-webhook` | `sorahnex-saspay-webhook` | URL déclarée chez SasPay (à faire basculer côté fournisseur) |
| `reelora-video` | `sorahnex-video` | Studio, devis, artefacts épinglés, tests de parité |
| `reelora-video-worker` | `sorahnex-video-worker` | cron `reelora-video-tick`, en-tête `x-reelora-worker-token` |
| `reelora-health` | `sorahnex-health` | supervision |
| `reelora-owner-bootstrap` | `sorahnex-owner-bootstrap` | amorçage propriétaire |

Fonctions sans marque, laissées telles quelles : `business-grow`,
`mcp-client`, `store-connect`, `store-import`, `studio-runtime`,
`universal-catalog`, `video-quote` — leurs noms cibles sont documentés dans
`src/lib/platform-identity.ts` lorsque la marque doit apparaître
(`sorahnex-business-grow`, `sorahnex-studio-runtime`, …), mais aucune migration
n'est nécessaire pour elles.

### 2.4 Interfaces internes

| Objet | Actuel | Cible | Compatibilité |
| --- | --- | --- | --- |
| En-tête cron | `x-vyora-cron` | `x-sorahnex-cron` | Les deux acceptés pendant la transition |
| En-tête worker | `x-reelora-worker-token` | `x-sorahnex-worker-token` | Les deux acceptés |
| Jeton MCP | `vyora_mcp_…` | `sorahnex_mcp_…` | Ancien format accepté jusqu'à expiration des jetons émis |
| Clés de stockage local | `vyora.*` | `sorahnex.*` | Lecture de l'ancienne clé puis migration silencieuse |
| Préfixe RPC | `vyora_`, `reelora_` | `sorahnex_` | Alias SQL, voir §5 |

---

## 3. Ce qui est fait dans cette PR

Uniquement du code applicatif, de la documentation et de l'outillage. Rien qui
touche la production.

1. `src/lib/platform-identity.ts` — source unique de l'identité et de la table
   de correspondance `legacy` / `canonical` (Edge, en-têtes, buckets, relations,
   préfixes RPC).
2. Tous les appels frontend passent par `edgeFunctionName(id)` : plus aucun nom
   de fonction en dur dans `src/lib/api.ts`, `src/lib/payments.ts`,
   `src/mcp/api.ts`, `src/integrations/McpConnectionsPage.tsx`.
3. `scripts/generate-sorahnex-sql-aliases.mjs` — génère la couche d'alias SQL
   `sorahnex_*` **et** son retour arrière, à partir d'un instantané `pg_proc`.
4. Tests d'invariants (`tests/sorahnex-spaces.test.ts`) : noms cibles uniques,
   en-têtes doublés, buckets neutres, relations sans collision.
5. Documentation d'architecture et procédures ci-dessous.

Le mode de nommage reste `legacy` par défaut : l'application continue d'appeler
les fonctions réellement déployées. Basculer se fait par configuration :

```bash
VITE_SORAHNEX_EDGE_NAMING=canonical   # uniquement après déploiement vérifié
```

---

## 4. Procédure Edge Functions (à exécuter hors production d'abord)

Le renommage d'une fonction Edge n'est **jamais** un `git mv`.

1. Créer le dossier cible (`supabase/functions/sorahnex-ai/`) avec le même
   `index.ts`, en important `../_shared/*`.
2. Régénérer l'artefact épinglé avec le script de build du projet, puis vérifier
   que le hash publié correspond (`tests/edge-bundle-parity` et
   `tests/edge-artifact-*` doivent rester verts).
3. Déployer la nouvelle fonction dans un projet de **développement** :
   `verify_jwt` identique, mêmes secrets, mêmes variables.
4. Vérifier une réponse authentifiée : un appel sans jeton doit répondre `401`
   (ou `-32001` pour MCP), **jamais** `503`. Un `503` signale un artefact ou un
   secret manquant, pas un problème d'authentification.
5. Faire accepter à la fonction les deux en-têtes internes
   (`x-sorahnex-cron` **et** `x-vyora-cron`).
6. Déployer dans le projet de production, l'ancienne fonction restant en place.
7. Basculer `VITE_SORAHNEX_EDGE_NAMING=canonical` sur un déploiement de
   prévisualisation, pas en production.
8. Repointer les crons un par un (`cron.unschedule` puis `cron.schedule`), en
   conservant l'ancien nom de job tant que le nouveau n'a pas tourné une fois.
9. Repointer les webhooks côté fournisseur (SasPay) et les callbacks OAuth.
10. Après une période d'observation, supprimer l'ancienne fonction. Cette
    suppression est une action distincte, autorisée séparément.

Retour arrière : à l'étape 7, revenir à `legacy` suffit. Aux étapes 8–9,
repointer vers l'ancienne fonction, toujours présente.

### Pourquoi pas un simple renommage de dossier ?

Deux mécanismes du projet s'y opposent :

- les **artefacts épinglés** (empreinte SHA-256 d'un bundle chargé depuis
  GitHub) : renommer la source sans régénérer l'artefact désynchronise le
  déploiement et produit un `503 BUSINESS_GROW_ARTIFACT_UNAVAILABLE` ;
- les **tests de parité** comparent le bundle livré aux octets produits par le
  générateur. Un renommage sans régénération fait échouer la CI, ce qui est le
  comportement souhaité.

---

## 5. Procédure SQL et RPC

185 fonctions portent la marque. Les renommer directement casserait les appels
frontend et, pour les fonctions `SECURITY DEFINER`, ferait perdre les droits
accordés.

La stratégie est une **couche d'alias**, jamais un renommage en place :

```bash
# 1. dans un projet de DÉVELOPPEMENT, collecter l'instantané pg_proc
#    (requête fournie en tête de scripts/generate-sorahnex-sql-aliases.mjs)

# 2. générer le SQL, le relire
node scripts/generate-sorahnex-sql-aliases.mjs --snapshot pg-proc.json --out supabase/naming/up.sql

# 3. appliquer dans le projet de développement seulement
#    puis vérifier chaque fonction : mêmes arguments, même résultat, mêmes rôles

# 4. générer le retour arrière
node scripts/generate-sorahnex-sql-aliases.mjs --snapshot pg-proc.json --down --out supabase/naming/down.sql
```

Propriétés de la couche générée :

- `LANGUAGE sql`, `SECURITY INVOKER`, `search_path = ''` : l'alias n'élargit
  aucun droit ; la fonction historique garde son `SECURITY DEFINER` et son
  propriétaire ;
- `REVOKE ALL ... FROM public` puis `GRANT EXECUTE` aux rôles lus dans l'ACL
  d'origine : la surface d'exécution est identique, pas plus large ;
- aucun `DROP`, aucun `ALTER` sur l'objet existant ;
- les signatures ambiguës (arguments sans nom) sont **refusées** et listées en
  commentaire plutôt que devinées.

Le retour arrière supprime uniquement les fonctions `sorahnex_*` générées.

### Tables

Une table ne se renomme pas sans les objets qui la référencent. Procédure
retenue, par table :

1. créer la vue `sorahnex_<nom>` en `SELECT *` sur la table historique ;
2. migrer les lectures du frontend vers la vue ;
3. migrer les écritures (RPC) vers un nom canonique ;
4. renommer la table, recréer la vue historique pour la compatibilité ;
5. supprimer la vue historique après une période d'observation.

Aucune étape n'est exécutée dans cette PR.

---

## 6. Secrets, variables et configuration

Règle : un secret ne se renomme pas, il se **double**.

| Actuel | Cible | Méthode |
| --- | --- | --- |
| `vyora_payments_reconcile_token` | `sorahnex_payments_reconcile_token` | Nouveau secret écrit, ancien conservé, fonction lisant `sorahnex_* ?? vyora_*` |
| `vyora_provider_health_cron_token` | `sorahnex_provider_health_cron_token` | Idem |
| `vyora_saspay_webhook_secret` | `sorahnex_saspay_webhook_secret` | Rotation coordonnée avec SasPay |
| `reelora_worker_token` | `sorahnex_worker_token` | Idem |
| `VITE_*` | — | Les variables publiques peuvent être renommées au déploiement suivant |

Aucune valeur de secret n'est écrite, journalisée ou documentée ici.

Cron jobs : `vyora-provider-health-{daily,fresh-guard,watchdog,collect}`,
`vyora-ai-providers-probe`, `vyora-payments-reconcile*`, `reelora-video-tick`.
Renommage = planifier le nouveau job, laisser l'ancien actif une période, puis
désinscrire l'ancien.

OAuth / MCP : le nom du serveur devient `sorahnex-mcp`. L'URL de métadonnées
(`/.well-known/oauth-protected-resource`) doit être servie à la nouvelle URL
**avant** de retirer l'ancienne, sinon les clients déjà configurés perdent
l'authentification.

Netlify / GitHub / domaines : `vyora-ugc.netlify.app`, `vyora.pages.dev` et les
origines autorisées restent servis. Le domaine `sorahnex.app` s'ajoute à
l'allowlist avant toute bascule ; retirer une origine autorisée est une décision
de sécurité distincte, pas un nettoyage cosmétique.

---

## 7. Risques identifiés

| Risque | Probabilité | Impact | Mitigation |
| --- | --- | --- | --- |
| Artefact épinglé désynchronisé | Élevée si renommage sans régénération | `503` production | Ne pas toucher `supabase/**` dans une PR de renommage ; cycle dédié |
| RPC renommée cassant le frontend | Élevée | Pages en erreur | Couche d'alias, jamais de `DROP` |
| Secret manquant après renommage | Moyenne | Fonction qui répond mais échoue | Double lecture, vérification `401 ≠ 503` |
| Callback OAuth retiré trop tôt | Moyenne | Clients MCP déconnectés | Servir les deux URLs avant retrait |
| Webhook SasPay pointant l'ancienne URL | Moyenne | Paiements non confirmés | Coordonner avec le fournisseur |
| Bucket renommé | **Nulle (mesuré)** | — | Aucun bucket ne porte la marque |

---

## 8. Retour arrière

| Étape | Action |
| --- | --- |
| Mode de nommage | Repasser `VITE_SORAHNEX_EDGE_NAMING=legacy`, redéployer |
| Edge Functions | Les anciennes restent déployées : repointer les appelants |
| Crons | `cron.unschedule(nouveau)` puis `cron.schedule(ancien)` |
| SQL | `supabase/naming/down.sql` (supprime uniquement les alias) |
| Tables | La vue historique n'est supprimée qu'après observation : la recréer |
| Secrets | L'ancien nom n'est jamais supprimé pendant la transition |

---

## 9. Ce qui reste à faire

1. Exécuter la procédure Edge sur un projet de développement, fonction par
   fonction, en commençant par `provider-health` (aucune dépendance frontend).
2. Collecter l'instantané `pg_proc` du projet de développement et générer la
   couche d'alias SQL ; la valider avant toute application.
3. Doubler les secrets et vérifier `401 ≠ 503` sur chaque fonction planifiée.
4. Migrer les tables via vues de compatibilité.
5. Basculer les webhooks SasPay et les callbacks OAuth.
6. Ajouter `sorahnex.app` à l'allowlist avant retrait des anciennes origines.
7. Cycle séparé pour les artefacts épinglés : régénérer, merger, réépingler sur
   le commit de `main`, redéployer, vérifier.
