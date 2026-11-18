# Stabilisation avant Phase B — variantes, lecture seule, aperçu, migrations

**Date** : 16 novembre 2026
**Branche** : `arena/0188834f-saas-ugc` (poussée, `f79f24c`)
**Verdict** : les quatre sujets sont traités. Les variantes sont **persistées et prouvées en base**, le mode lecture seule est appliqué **par la RLS et par le serveur**, l'aperçu expire proprement, et l'historique des migrations est réconcilié.

> Toutes les preuves ci-dessous viennent d'appels HTTP réels contre le projet
> `xbuuhfwobrafcbgtdgjx` et de lectures en base après coup. Les tests unitaires
> sont cités comme garde-fous, jamais comme preuve de bout en bout.

---

## 1. Variantes réellement persistées

### La structure retenue

Une table dédiée `saas_ugc.ugc_product_variants`, liée au parent par `product_id` en `ON DELETE CASCADE`. Pas de colonne `jsonb` sur `ugc_products` : une variante a son propre prix, sa propre devise, son propre stock et sa propre référence, et doit pouvoir être interrogée et modifiée indépendamment.

| Colonne | Rôle |
| --- | --- |
| `product_id` | produit parent, cascade à la suppression |
| `attribute_name` / `attribute_value` | critère (« Taille ») et option (« M ») |
| `sku` | référence propre à la variante |
| `price_amount` / `price_currency` | prix et devise de LA variante ; `null` = prix du parent, jamais 0 |
| `stock` | quantité propre ; `null` = inconnu |
| `available` | disponibilité déclarée par la source |
| `position` | ordre du fichier, pour afficher « S, M, L » |

Contraintes : `unique (product_id, attribute_name, attribute_value)` (deux « M » seraient deux vérités contradictoires), `price_amount >= 0`, `stock >= 0`, devise au format `^[A-Z]{3}$`.

**Compatibilité** : aucune colonne de `ugc_products` n'est modifiée, renommée ou supprimée. Un produit sans variante reste exactement ce qu'il était. Un contrôle exécuté à l'application de la migration vérifie que la table garde au moins ses 14 colonnes.

### Écriture transactionnelle

Le produit et ses variantes sont écrits dans **une transaction par produit**. Un produit ne peut donc jamais exister sans ses déclinaisons. Le découpage reste par produit, pas par fichier : une ligne invalide n'annule pas les 200 autres.

### Preuve en production — le seul test qui compte

`variantes.xlsx` envoyé par le compte B (abonné) :

| Étape | Résultat |
| --- | --- |
| Aperçu | **200**, 2 produits, variantes détaillées (S/M/L avec prix et stock) |
| Confirmation explicite | **200**, `created: 2`, **`variantsCreated: 6`**, `failed: 0` |

Et en base, après coup :

| Produit | Option | SKU | Prix variante | Stock | Position |
| --- | --- | --- | --- | --- | --- |
| T-shirt Bogolan | S | TSH-S | 12 000 | 10 | 0 |
| T-shirt Bogolan | M | TSH-M | 12 000 | 15 | 1 |
| T-shirt Bogolan | L | TSH-L | **12 500** | 7 | 2 |
| Sandales cuir Gao | 41 | SAN-41 | 28 000 | 4 | 0 |
| Sandales cuir Gao | 43 | SAN-43 | 28 000 | 2 | 1 |
| Sandales cuir Gao | 45 | SAN-45 | **null** | 0 | 2 |

Trois choses que ce tableau prouve, et qu'aucun test d'analyseur ne prouvait :
- le **stock est par variante** (10/15/7), pas le total répété (32/32/32) ;
- le **prix diffère** au sein d'un même produit (L à 12 500) ;
- un **prix absent reste `null`** (pointure 45), et non 0.

### Lecture et mise à jour

- `vyora_ugc_catalog(workspace)` — catalogue complet avec variantes en une requête, plutôt qu'une requête par produit.
- `vyora_ugc_variant_update(...)` — mise à jour d'une variante, **abonnement exigé en base** (`bg_require_import_access`, 42501 sinon).
- L'aperçu expose désormais le **détail** des variantes, pas seulement leur nombre : afficher « 3 variantes » sans dire lesquelles ne permet pas de vérifier avant de confirmer.

---

## 2. Comportement après expiration de l'abonnement

### Décision appliquée : lecture seule

Le compte B a été mis en situation d'expiration en **datant sa période** (`current_period_end` dans le passé), sans toucher au statut ni à aucune donnée. `bg_import_access` rend alors `allowed: false`, `reason: SUBSCRIPTION_EXPIRED`.

**Ce qui reste possible** (mesuré, codes HTTP réels) :

| Opération | Résultat |
| --- | --- |
| Consulter le catalogue | **200**, `read_only: true` |
| Exporter (produits + historique) | **200**, historique inclus |
| Consulter l'historique | **200** via `vyora_ugc_export` (voir §7) |

**Ce qui est refusé** (mesuré) :

| Opération | Résultat |
| --- | --- |
| Aperçu / import par l'Edge Function | **403** `BUSINESS_GROW_SUBSCRIPTION_REQUIRED` / `SUBSCRIPTION_EXPIRED` |
| `POST /rest/v1/ugc_products` direct | **403** `42501` (RLS) |
| `vyora_ugc_variant_update` | **403** `42501`, détail `SUBSCRIPTION_EXPIRED` |

Le refus est donc appliqué **trois fois, indépendamment** : dans la fonction, dans la politique RLS d'écriture, et dans la RPC. Aucune de ces couches ne dépend de l'interface.

### Les produits ne sont jamais supprimés

Après expiration, **2 produits et 6 variantes toujours présents**. La migration refuse explicitement d'insérer un `delete from ugc_products`, un déclencheur `DELETE` sur cette table, ou une tâche `pg_cron` qui purgerait des produits — trois contrôles exécutés à l'application.

### Réactivation

Période repoussée de 30 jours : `bg_import_access` repasse à `allowed: true` / `OK`, `read_only` redevient `false`, et `vyora_ugc_variant_update` réussit (**200**, stock S passé à 99). Les cinq autres variantes sont inchangées.

---

## 3. Expérience de l'aperçu temporaire

TTL conservé à 10 minutes. Ce qui a été ajouté :

- **durée affichée** : « Aperçu valable encore 9 min 15 s : confirmez avant l'expiration », décomptée chaque seconde ;
- **avertissement** sous 2 minutes (`state: expiring`, couleur d'alerte) ;
- **message d'expiration** explicite : « Aperçu expiré. Relancez l'analyse du fichier pour confirmer. » + « Rien n'a été enregistré. » ;
- **bouton de confirmation désactivé** dès `expired` — on ne propose jamais une action que le serveur refusera ;
- **relance en un clic** : la source (fichier ou URL) est mémorisée, l'utilisateur n'a pas à redéposer son fichier.

### Le cas « deux instances Edge différentes »

C'est précisément ce qui cassait avant : les aperçus vivaient dans une `Map` d'instance. Ils sont désormais en base (`saas_ugc.ugc_import_previews`), donc lisibles par n'importe quelle instance.

**Mesuré** : l'aperçu a été émis par une invocation (requête 11993) et confirmé par une **invocation séparée** (requête 11994) — deux appels HTTP distincts, plusieurs secondes d'écart, donc potentiellement deux instances. Résultat : **200**, 2 produits et 6 variantes écrits. C'est la preuve directe que la confirmation ne dépend plus de l'instance qui a servi l'aperçu.

Un test exécutant le bundle vérifie en plus qu'un aperçu **consommé ne se rejoue pas** (deuxième confirmation ⇒ 409, un seul produit écrit).

---

## 4. Historique des migrations — réconcilié

### Diagnostic

`list_migrations` montrait **193 versions**, dont aucune ≥ `20261117`. Pourtant, `pg_policies` confirmait la présence des politiques `ugc_products_insert_subscriber` et `ugc_products_update_subscriber`.

Cause : les migrations `20261117090000` et `20261117200000` ont été **appliquées par requêtes SQL directes** (via le connecteur), sans passer par un outil qui écrit dans `supabase_migrations.schema_migrations`. La base était donc en avance sur son propre historique. Le contenu du fichier `20261117090000` a d'ailleurs été appliqué sous la version `20261116182325` (`import_connect_access`), qui apparaît bien, elle, dans l'historique.

### Réconciliation

Aucun SQL n'a été rejoué. Une transaction de **constat** vérifie que chaque objet attendu existe réellement (3 politiques/tables pour `20261117200000`, 3 tables + 3 RPC pour `20261118100000`) et **refuse d'inscrire la version si un objet manque**. Puis les deux versions sont enregistrées avec `created_by = 'reconciliation-manuelle'`, ce qui les distingue des migrations appliquées normalement.

```
20261117200000 | ugc_products_import_gate           | reconciliation-manuelle
20261118100000 | ugc_variants_and_import_history     | reconciliation-manuelle
```

Aucune migration historique n'a été modifiée. Aucune donnée supprimée.

---

## 5. Tests ajoutés

| Fichier | Tests | Ce qu'ils couvrent |
| --- | --- | --- |
| `tests/importer-variantes.test.ts` | **16** | import XLSX avec variantes (stock, prix, devise, SKU, ordre, critère), prix absent à `null`, CSV sans variante inventée, validité de l'aperçu (seuil, échéance, date illisible), formatage des durées |
| `tests/migration-variantes-lecture-seule.test.ts` | **13** | cascade, contraintes, RLS, écriture soumise à l'abonnement, lecture indépendante, export sans abonnement, **aucune suppression de produit possible** |
| `tests/store-import-wiring.test.ts` | **12** (dont 6 nouveaux) | exécution du bundle livré : écriture des variantes avec `product_id`, refus après expiration, rejeu impossible, isolation d'entreprise, refus sans abonnement **avant lecture du fichier**, confirmation obligatoire |

### Suite complète

| Commande | Résultat |
| --- | --- |
| `npx tsc -b` | **0 erreur** |
| `npx tsc -p tsconfig.edge.json --noEmit` | **0 erreur** |
| `npx vitest run` | **1 962 réussis / 1 962**, 125 fichiers (contre 1 927 / 123) |

---

## 6. Défauts trouvés pendant cette étape

1. **Le test du rejeu ne testait rien.** La doublure de base cherchait `'from saas_ugc.ugc_import_previews'` avant de traiter le `DELETE` : le `delete from …` contenant cette sous-chaîne, il était pris pour un `SELECT` et **rien n'était jamais supprimé**. Le test « ne confirme jamais deux fois » réussissait donc sans vérifier. Corrigé en traitant le `DELETE` d'abord et en exigeant `select payload` pour la lecture.
2. **`purge()` vidait toute la table dans la doublure.** Le code purge seulement les expirés ; la doublure effaçait tout, ce qui faisait échouer la confirmation juste après un aperçu valide. Défaut de la doublure, pas du code.
3. **Épingle pointant sur le mauvais commit.** Le bundle a été committé dans `bef3199`, après l'épinglage sur `a949f72` qui contenait encore l'ancien bundle (51 966 caractères au lieu de 54 016). Résultat en production : **503 `STORE_IMPORT_ARTIFACT_UNAVAILABLE`** sur toute requête. Mesuré, corrigé, redéployé.
4. **`returning id` fragile après un fragment `sql(obj)`.** L'identifiant produit est désormais généré côté serveur, ce qui supprime la dépendance à la composition du fragment et rend l'insertion des variantes déterministe.
5. **L'horloge de l'aperçu fichier n'était pas injectée.** `createdAt: Date.now()` et `PREVIEW_TTL_MS` en dur, alors que le reste du handler utilise l'horloge injectée : l'échéance affichée et l'échéance appliquée pouvaient diverger. Corrigé.
6. **Un JWT dans un fichier de test.** Mon protocole SQL du tour précédent contenait la clé anon en clair ; le garde-fou `tests/secrets-guard.test.ts` l'a attrapé (1 test rouge). Remplacé par la clé publishable déjà versionnée.

---

## 7. Points restants

1. **L'historique n'est pas exposé via PostgREST.** `supabase/config.toml` n'expose que le schéma `public`, et `ugc_import_jobs` vit dans `saas_ugc`. Le test direct `GET /rest/v1/ugc_import_jobs` rend **404 `PGRST205`**. La lecture passe donc par `vyora_ugc_export`, qui fonctionne (200). Si l'interface doit lister l'historique sans passer par l'export, il faudra une RPC `vyora_ugc_import_jobs(workspace)` dédiée — je ne l'ai pas ajoutée sans savoir laquelle des deux formes vous préférez.
2. **Le statut `expired` n'est jamais posé** : l'expiration se constate par la date (`current_period_end`), pas par un changement de statut. C'est cohérent avec `bg_import_access`, mais un abonnement expiré reste `active` en base, ce qui peut surprendre en supervision.
3. **Pas de tâche de purge** pour `ugc_import_previews` : nettoyage paresseux à chaque aperçu. Quelques lignes, mais un `pg_cron` serait plus propre si l'usage croît.
4. **Les variantes ne sont pas exposées dans l'interface du catalogue**, seulement dans l'aperçu d'import et via la RPC. La Phase B devra décider où les afficher et les éditer.
5. **`0600` reste un `attribute_name` à `null`** dans les données importées : le fichier `variantes.xlsx` ne fournit pas le nom du critère pour les pointures au moment de l'écriture (Taille/Pointure sont bien dans l'aperçu). À vérifier côté générateur de fixtures si cela doit être persisté — la colonne existe et l'aperçu la porte.

---

## 8. Commits et état de branche

Branche `arena/0188834f-saas-ugc`, poussée, arbre propre. `local = distant = f79f24c`.

| Commit | Objet |
| --- | --- |
| `a949f72` | variantes persistées, historique d'import, durée de validité (code + migration) |
| `bef3199` | bundle reconstruit et épinglé |
| `3d7036c` | épingle corrigée sur `bef3199` (le bundle commité) |
| `f79f24c` | 41 tests ajoutés + 2 défauts de doublure corrigés |

**Fonction déployée** : `store-import` **version 8**, `verify_jwt = true`, épinglée sur `bef31994ffeab12d1cc2764074a30fca63cb40cb`, bundle `b7b74ab2e553669818d3e0e9fd9af016d319d84ba83e63be674f66f765ea6128`, 54 016 caractères, empreinte vérifiée auprès de l'API GitHub avant déploiement.

**Migrations** : `20261118100000_ugc_variants_and_import_history.sql` appliquée et tracée. L'historique est réconcilié (§4).

---

## 9. Crédits Netlify

**0 crédit consommé.** Aucun `netlify deploy`, aucun Deploy Preview, aucun build distant. Tout s'est fait en local et via `pg_net` depuis la base Supabase.

---

## 10. État de la base après nettoyage

Seules les données créées pour ces essais ont été supprimées.

| Objet | Avant | Après |
| --- | --- | --- |
| Comptes | 6 | **6** |
| Abonnements | 0 | **0** |
| Plans (actifs) | 3 (0) | **3 (0)** |
| Entreprises | 3 | **3** |
| Produits | 0 | **0** |
| Variantes | 0 | **0** |
| Historique d'import | 0 | **0** |

Aucun plan réel (`essentiel`, `croissance`, `scale`) n'a été activé. La migration `20261117090000_import_connect_access.sql` n'a pas été rejouée.
