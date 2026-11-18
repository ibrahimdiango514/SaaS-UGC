# Import CSV/XLSX — validation bout en bout

**Date** : 16 novembre 2026
**Branche** : `arena/0188834f-saas-ugc` (poussée, base `2278ce6`)
**Verdict** : **le parcours fonctionne pour un abonné et le blocage serveur est intégral pour un non-abonné** — mais au prix de **six défauts réels**, dont trois auraient rendu la fonctionnalité inutilisable en production.

> Ce rapport ne s'appuie sur aucun test unitaire seul. Chaque affirmation
> ci-dessous vient d'un appel HTTP réel contre l'URL publique du projet
> `xbuuhfwobrafcbgtdgjx`, avec de vrais jetons GoTrue, et d'une lecture en base
> après coup. Les tests unitaires sont cités comme garde-fous, jamais comme
> preuve de bout en bout.

---

## 1. Ce qui a été testé

### Fichiers (données entièrement fictives)

| Fichier | Taille | Contenu |
| --- | --- | --- |
| `produits.csv` | 6 651 o | 13 produits, 3 devises (XOF, EUR, XYZ inconnue), 1 doublon interne, 2 prix illisibles, 1 stock négatif, 1 nom vide, 1 tentative d'injection de formule `=HYPERLINK(...)`, guillemets et virgules échappés |
| `produits.xlsx` | 6 094 o | même catalogue en classeur ; la ligne à formule est refusée (écart CSV/XLSX assumé et figé par test) |
| `variantes.xlsx` | 5 383 o | `parent_sku, variant_name, variant_option` — 2 fiches (T-shirt 3 tailles, Sandales 3 pointures), stock additionné (32 = 10+15+7), prix par variante |

Ces trois fichiers sont versionnés sous `supabase/tests/import-fichiers/` et
régénérables par `python3 supabase/tests/import-fichiers/generer.py`.

### Comptes

| Compte | Abonnement | Rôle dans les essais |
| --- | --- | --- |
| `import-a@vyora-test.invalid` | **aucun** | doit être refusé partout |
| `import-b@vyora-test.invalid` | actif (plan interne `import_test`) | parcours nominal |
| `import-c@vyora-test.invalid` | actif | tentative d'import chez B (isolation) |

---

## 2. Résultats **avant** confirmation

Aperçu de `produits.csv` par B (`POST /functions/v1/store-import`, `action: preview`) :

| Mesure | Valeur observée |
| --- | --- |
| Code HTTP | **200** |
| Produits détectés | **13** |
| Importables | **12** |
| Doublons internes au lot | **1** (`sac en toile koulikoro`) |
| Déjà au catalogue | 0 |
| Sans prix | 2 |
| Produits écrits en base à cette étape | **0** |
| Adresse contactée par le serveur | `""` (chaîne vide : aucune sortie réseau) |

Avertissements remontés, tels quels :

- `Aucun produit n'a été créé : cette étape est une prévisualisation.`
- `Des doublons internes au fichier sont ignorés : aucun produit n'est écrit deux fois.`
- `devise « XYZ » non prise en charge, remplacée par XOF pour « Statuette Dogon »`
- `prix illisible pour « Marmite en fonte »`
- `stock négatif, écarté`

Prix normalisés à l'aperçu : `18 500 F CFA`, `24,90 €`, `45 000 F CFA`, `prix à compléter` (jamais `0`).

---

## 3. Résultats **après** confirmation explicite

`POST` avec `action: import`, `previewId` réel, `confirmed: true`, sans champ
`selection` (le serveur retient alors les seuls produits importables).

| Mesure | Valeur |
| --- | --- |
| Code HTTP | **200** |
| `created` | **12** |
| `failed` | **0** |
| Produits réellement en base | **12** |

Contrôles sur les lignes écrites :

| Produit | `price_amount` | `price_currency` | Attendu |
| --- | --- | --- | --- |
| Sac en toile Koulikoro | `18500.00` | XOF | ✅ 18 500 (et **non** 185) |
| Théière Bamako | `24.90` | EUR | ✅ décimales préservées |
| Tableau d'art Dogon | `45000.00` | XOF | ✅ |
| Marmite en fonte | `null` | XOF | ✅ prix à compléter, jamais zéro |
| Panier tressé Ségou | `null` | XOF | ✅ |
| `sac en toile koulikoro` (doublon) | — | — | ✅ **absent** : pas de doublon créé |

Traçabilité : `product_facts` contient `{"source":"file","platform":"file","reference":"fichier","imported_at":"…"}`.

Rejeu du même `previewId` ⇒ **409 `PREVIEW_EXPIRED`**, aucun produit
supplémentaire : un aperçu ne se rejoue pas.

---

## 4. Compte **sans abonnement** — refus serveur

| Essai | Requête | Réponse |
| --- | --- | --- |
| Aperçu de fichier | `action: preview` + `fileBase64` | **403** `BUSINESS_GROW_SUBSCRIPTION_REQUIRED` (`reason: NO_SUBSCRIPTION`) |
| Import direct, sans aperçu | `action: import` + `previewId` forgé | **403** `BUSINESS_GROW_SUBSCRIPTION_REQUIRED` |
| Import dans l'entreprise de B | `action: import`, `workspaceId` de B | **403** `BUSINESS_GROW_SUBSCRIPTION_REQUIRED` |
| **Écriture PostgREST directe** | `POST /rest/v1/ugc_products` avec le jeton de A | **403** `42501` — *row-level security policy* |

Produits créés par A lors de ces quatre essais : **0**.

Le quatrième essai est le plus important : c'est **le contournement qui
existait**. Avant correctif, le même appel renvoyait **201** et créait le
produit. Voir §6, défaut n° 3.

---

## 5. Isolation entre utilisateurs

| Essai | Résultat |
| --- | --- |
| C (abonné) demande un aperçu dans l'entreprise de B | **403** `WORKSPACE_ACCESS_DENIED` |
| C (abonné) confirme un import dans l'entreprise de B | **403** `WORKSPACE_ACCESS_DENIED` |
| Produits dans l'entreprise de B après ces tentatives | **12**, inchangé |
| C confirme l'aperçu **émis pour B** | impossible : l'aperçu est lié à `(userId, workspaceId)` et consommé à la première confirmation |

Refus périphériques, tous propres (aucune trace, aucun produit) :

| Cas | Réponse |
| --- | --- |
| `fileBase64` non base64 (`!!!pas-du-base64***`) | **400** `INVALID_FILE_ENCODING` |
| Fichier de 14 Mo encodé | **413** `FILE_TOO_LARGE` (limite 8 Mio) |
| `import` sans `confirmed: true` | **400** `CONFIRMATION_REQUIRED` |
| `import` avec `previewId` inconnu | **409** `PREVIEW_EXPIRED` |
| `import` sans entreprise valide | **400** `INVALID_WORKSPACE` |

---

## 6. Défauts corrigés — tous trouvés en testant, aucun en relisant le code

### 1. Import de fichier impossible côté serveur (`index.ts`)

`index.ts` appelait `importFile` **sans l'importer**. Le bundle se construisait
sans broncher (esbuild laisse un identifiant libre tel quel) et échouait à
l'appel : `ReferenceError: importFile is not defined`, masqué en **500
`STORE_IMPORT_BACKEND_ERROR`**. Tout import de fichier échouait.

*Pourquoi aucun test ne le voyait* : `tsconfig.json` ne couvrait que `src/` et
`tests/`. Les Edge Functions n'étaient vérifiées par **aucun** `tsc`.

### 2. Prix XOF divisé par cent (`index.ts`)

`productRow` calculait `priceMinor / 10 ** produit.currencyExponent` — propriété
**inexistante** sur `NormalizedProduct`, donc `undefined`, donc repli sur `2`.
12 000 XOF serait devenu **120**. Corrigé par `minorToDecimal`, qui applique le
bon exposant (0 pour XOF). Vérifié en base après écriture.

### 3. Écriture PostgREST directe non protégée (migration + panneau)

La politique RLS `ugc_products_insert_editor` ne vérifiait que l'appartenance à
l'entreprise (`can_edit_workspace`). Or `can_edit_workspace` ouvre aussi
l'interface d'import : le panneau analysait le CSV en local puis écrivait les
produits par des `insert` PostgREST successifs. **Un compte sans abonnement
pouvait donc créer des produits en appelant l'API directement** — exactement ce
que la Phase A devait rendre impossible.

Mesuré : `POST /rest/v1/ugc_products` avec le jeton de A ⇒ **201**, produit
réellement créé.

Corrigé sur les deux plans, il faut les deux :

- `StoreImportPanel.tsx` n'écrit plus aucun produit : il appelle `previewFile`
  puis `importStore`, donc la garde d'abonnement s'applique avant toute analyse ;
- la politique RLS (migration `20261117200000`) exige désormais l'abonnement, en
  plus de l'appartenance, via `vyora_import_connect_access()` — `SECURITY
  DEFINER` et déjà accordée à `authenticated`, donc un client ne peut pas la
  sonder.

Après correctif, re-mesure du **même** appel : **403**, produit non créé. Et un
abonné légitime écrit toujours normalement (201, vérifié).

### 4. Produits en double dans un même lot (`handler.ts`)

La sélection par défaut retenait **tous** les indices de l'aperçu, y compris
ceux marqués non importables : un doublon interne au lot était donc écrit deux
fois, alors que l'interface annonçait l'inverse. `lireSelection` retient
désormais les seuls produits importables ; une sélection explicite reste
honorée. Le bouton de confirmation est désactivé quand rien n'est importable.

### 5. Aperçus perdus entre instances (`handler.ts` + `index.ts`)

Les aperçus vivaient dans une `Map` locale à l'instance Edge. Supabase en lance
plusieurs : la confirmation, servie par une autre instance, ne trouvait pas
l'aperçu et répondait `PREVIEW_EXPIRED`. **Mesuré : 3 échecs sur 4 tentatives**,
sans qu'aucune donnée ne soit en cause — l'import était impossible à confirmer.

Corrigé par une interface `PreviewStore` et une implémentation Postgres
(`saas_ugc.ugc_import_previews`, RLS sans politique, droits clients retirés).
Le repli mémoire reste disponible pour les tests.

### 6. Payload d'aperçu stocké comme chaîne (`index.ts`)

`payload` était passé comme objet JS ; le pilote `postgres` le sérialise en
* ligne composée* `(...)`, que `::jsonb` convertit en **texte**. La colonne
contenait donc une chaîne (`jsonb_typeof = 'string'`), jamais relisible. Même
symptôme que le défaut 5 : `PREVIEW_EXPIRED` malgré un aperçu valide.

Corrigé par `(payload::text)::jsonb`. Vérifié en base : `jsonb_typeof = 'object'`,
13 produits relus.

### Défaut latent corrigé du même passage

`scripts/build-edge-artifact.mjs` mettait à jour le chargeur **sans jamais
réécrire** `supabase/functions/_artifacts/store-import.js`. Le chargeur annonçait
donc une taille et une empreinte que le fichier committé ne pouvait pas
satisfaire. L'artefact est désormais écrit, committé et vérifié sur GitHub
(`api.github.com/…/contents/…`) avant chaque déploiement.

---

## 7. Tests exécutés

| Commande | Résultat |
| --- | --- |
| `npx tsc -b` | **0 erreur** |
| `npx tsc -p tsconfig.edge.json --noEmit` | **0 erreur** (nouveau) |
| `npx vitest run` | **1 927 réussis / 1 927**, 123 fichiers |

Garde-fous ajoutés pour que ces défauts ne reviennent pas :

- `tests/store-import-wiring.test.ts` — **exécute le bundle livré** dans un
  contexte isolé (globale `Deno` et connexion Postgres remplacées), capture le
  gestionnaire `Deno.serve` et lui envoie un vrai aperçu puis une vraie
  confirmation. Chercher des noms de fonctions ne prouverait rien : le bundle
  est minifié, et un identifiant manquant ne se voit qu'à l'appel. Le test est
  **discriminant** : avec l'ancien code il rend **409**, avec le nouveau **200**.
- `tests/store-import-file.test.ts` — 22 tests sur le contrat serveur du chemin
  fichier (refus, tailles, encodage, sélection, erreurs partielles).
- `tsconfig.edge.json` + `supabase/functions/types/npm-postgres.d.ts` —
  `npm run typecheck:edge` vérifie enfin les Edge Functions.

---

## 8. État de la base après nettoyage

Seules les données de test ont été supprimées (`99-teardown-import-fichiers.sql`).

| Objet | Avant essais | Après nettoyage |
| --- | --- | --- |
| Comptes | 6 | **6** |
| Abonnements | 0 | **0** |
| Plans | 3 (0 actif) | **3 (0 actif)** |
| Entreprises | 3 | **3** |
| Produits | 0 | **0** |
| Aperçus en attente | 0 | **0** |

Aucun plan réel (`essentiel`, `croissance`, `scale`) n'a été activé. La migration
`20261117090000_import_connect_access.sql` n'a pas été rejouée.

---

## 9. Commits et état de branche

Branche `arena/0188834f-saas-ugc`, poussée. Commits de cette session (du plus
ancien au plus récent) :

| Commit | Objet |
| --- | --- |
| `14d8759` | Panneau d'import branché sur l'Edge Function (fichier comme URL) ; sélection par défaut = produits importables |
| `ead38b7` | Bundle reconstruit |
| `0b816f3` | Le générateur d'artefact écrit aussi le fichier téléchargé |
| `5a66e14` | Chargeur épinglé |
| `061551b` | **Import manquant, prix XOF faux, `tsconfig.edge.json`** |
| `61e12e0` | Test du bundle exécuté (attrape les trois défauts) |
| `7bc03c3` | **Aperçus persistés en base** |
| `529d76c` | **Payload JSON et non ligne composée** |
| `4532ae1` | Protocole SQL rejouable + teardown |

La migration `20261117200000_ugc_products_import_gate.sql` est **appliquée en
base** (politiques RLS, table d'aperçus) et **versionnée** dans le dépôt. Note :
elle a été appliquée par requêtes directes avant son commit ; l'état du dépôt et
celui de la base sont alignés, mais `supabase migration list` ne l'enregistrera
pas comme appliquée tant qu'elle n'est pas rejouée par la CLI.

Fonction déployée : `store-import` **version 6**, `verify_jwt = true`, épinglée
sur le commit `529d76c` (bundle `08925060…`, 51 633 caractères, empreinte
vérifiée auprès de l'API GitHub avant déploiement).

---

## 10. Crédits Netlify

**0 crédit consommé.** Aucun `netlify deploy`, aucun `Deploy Preview`, aucun
build distant. Tout le développement et tous les tests ont eu lieu en local ou
via `pg_net` depuis la base Supabase.

---

## 11. Limites restantes — à lire avant de promettre quoi que ce soit

1. **Un seul import réel a été exécuté en production** (12 produits, notes au
   §3). C'est une preuve, pas une batterie de charge. Les cas de fichiers
   volumineux et de catalogues à plusieurs milliers de lignes n'ont pas été
   éprouvés au-delà des limites codées.
2. **L'aperçu expire en 10 minutes.** Aperçu et confirmation doivent être
   enchaînés. C'est voulu (rien ne s'écrit à l'aveugle), mais un utilisateur lent
   recevra `PREVIEW_EXPIRED` et devra relancer — comportement à expliquer dans
   l'interface.
3. **Les variantes ne sont pas écrites comme telles** : `variantes.xlsx` produit
   bien 2 fiches avec stock et prix par variante dans l'aperçu, mais
   `ugc_products` ne possède pas de colonne de variantes. Elles restent dans les
   métadonnées du produit. À trancher avant d'annoncer « variantes importées ».
4. **`ugc_import_previews` n'a pas de purge planifiée** : le nettoyage se fait
   paresseusement à chaque aperçu/confirmation. Une table de quelques lignes, mais
   un `pg_cron` serait plus propre si l'usage croît.
5. **La politique RLS d'écriture exige l'abonnement pour créer ET modifier un
   produit.** Conséquence assumée : un compte dont l'abonnement a expiré ne peut
   plus corriger son catalogue. La lecture et la suppression restent ouvertes. À
   confirmer comme décision produit.
6. **`product_facts.platform` vaut `file`** et `reference` vaut `fichier` : la
   traçabilité dit le type de source, pas le nom du fichier déposé. Le nom est
   bien dans l'aperçu (`origin.reference`), pas dans la ligne écrite.
