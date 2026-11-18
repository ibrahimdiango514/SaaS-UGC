# Phase B — catalogue, variantes et historique des imports

**Date** : 2026-11-14 · **Branche** : `arena/0188834f-saas-ugc` · **Projet** : `xbuuhfwobrafcbgtdgjx`

Ce rapport distingue ce qui est **terminé et prouvé**, ce qui est **livré mais
non vérifié en production**, et ce qui **reste à faire**. Rien n'est présenté
comme fait sans une preuve correspondante.

---

## 1. Terminé et prouvé

### 1.1 Décision 1 — variantes intégrées à la fiche produit

| Exigence | État | Où |
| --- | --- | --- |
| Section « Variantes » par produit (consulter, ajouter, modifier, désactiver) | **fait** | `src/business/importer/ProductVariantsSection.tsx` |
| SKU, attributs, prix, devise, stock gérés indépendamment | **fait** | `variants-model.ts` (validation), RPC `vyora_ugc_variant_create/update` |
| Tableau clair, ordre conservé | **fait** | ordre `position` de la source, vérifié par test |
| Lien au produit parent visible | **fait** | la section vit dans la carte du produit ; aucune variante n'est un produit |
| Import et mise à jour depuis CSV/XLSX | **fait** | `store-import` + `updateExisting` |
| Respect des accès et du mode lecture seule | **fait** | RPC (serveur) + `readOnly` (interface) |

Points de conception qui répondent à des pièges réels :

- **Un prix absent n'est pas zéro.** Une variante sans prix propre affiche
  « Prix du produit : 12 000 F CFA », jamais « 0 ». Le stock inconnu affiche
  « — », jamais « Rupture ».
- **Désactiver, pas supprimer.** La colonne `active` retire la variante de la
  vente en conservant sa référence et son stock ; un bouton la remet en vente.
  Aucune fonction ne fait de `delete` sur `ugc_product_variants` (sauf la
  réécriture explicite en mode mise à jour, voir 1.3).
- **Un produit sans variante n'affiche pas une section repliée** : sinon
  l'explication « aucune variante » et le bouton d'ajout disparaîtraient.

### 1.2 Décision 2 — historique des imports par RPC sécurisée

| Exigence | État | Où |
| --- | --- | --- |
| Date/heure, origine (CSV, XLSX, URL), fichier ou source | **fait** | `ImportHistoryPanel.tsx`, `history-model.ts` |
| Statut (en cours, terminé, partiel, échoué) | **fait** | `STATUS_LABELS` / `STATUS_TONES` |
| Produits créés, variantes créées, nombre d'erreurs | **fait** | `vyora_ugc_import_history` |
| Détail des erreurs et consultation du rapport | **fait** | `vyora_ugc_import_report` (chargé seulement s'il y a des erreurs) |
| Identité vérifiée côté serveur | **fait** | `auth.uid()`, `security definer`, `search_path = ''` |
| Résultats limités à l'entreprise autorisée | **fait et vérifié** | refus `WORKSPACE_ACCESS_DENIED` |
| Jamais les imports d'un autre utilisateur | **fait et vérifié** | filtre `user_id`, voir 2.1 |
| Aucune portée dépendant d'un identifiant fourni sans validation | **fait** | `p_workspace_id` n'est qu'un désignateur, validé par appartenance |
| Aucune donnée interne sensible exposée | **fait** | ni `payload`, ni `user_id`, ni clés techniques |
| Un compte expiré consulte son historique | **fait et vérifié** | lecture indépendante de l'abonnement |

### 1.3 Import et mise à jour des variantes depuis CSV/XLSX

`action: "import"` accepte `updateExisting: true` :

- le produit est retrouvé par son nom dans l'entreprise, puis **mis à jour dans
  la même transaction** que ses variantes ; il garde son identifiant, donc ses
  vidéos restent liées ;
- les variantes du fichier remplacent les précédentes **uniquement** dans ce
  mode explicite ;
- hors de ce mode, le comportement historique est inchangé (création + avertissement) ;
- le prix mis à jour passe par le même `productRow` que la création : les deux
  chemins ne peuvent pas diverger sur la conversion de devise ;
- le résultat distingue `created`/`updated` et `variantsCreated`/`variantsUpdated`.

---

## 2. Preuves en base réelle

Toutes les sondes ont été exécutées dans une transaction annulée par
`rollback`. Vérification finale : **6 comptes, 3 entreprises, 0 produit,
0 variante, 0 job, 0 abonnement actif, 0 plan actif** — état initial intact.

### 2.1 Sécurité et isolation

| Appel | Résultat |
| --- | --- |
| `vyora_ugc_catalog` sans session | **42501** `catalog_forbidden:NOT_AUTHENTICATED` |
| `vyora_ugc_import_history` sans session | **42501** `history_forbidden:NOT_AUTHENTICATED` |
| `vyora_ugc_import_history` sur une entreprise étrangère | **42501** `WORKSPACE_ACCESS_DENIED` |
| Membre `admin` de la même entreprise, historique du propriétaire | **`total = 0`** |
| Membre `admin`, rapport du propriétaire | **42501** `NOT_FOUND` |
| Rapport d'un import inexistant | **42501** `NOT_FOUND` (même message) |
| Propriétaire, son propre historique | `total = 1`, fichier retrouvé |
| `vyora_ugc_variant_create` sans abonnement | **42501** `import_connect_forbidden:NO_SUBSCRIPTION` |
| `vyora_ugc_variant_set_active` sans abonnement | **42501** `NO_SUBSCRIPTION` (désactiver est une écriture) |
| `vyora_ugc_catalog` sans abonnement | **200**, `read_only = true` |
| `vyora_ugc_catalog` avec abonnement actif | **200**, `read_only = false` |

### 2.2 Cycle d'écriture des variantes

| Étape | Résultat |
| --- | --- |
| Création (`M`, `SONDE-M`, 1200 XOF, stock 5) | objet complet renvoyé |
| Persistance relue en base | 1 ligne, `position 0`, `active true`, prix 1200 |
| Deuxième création de la même option | **23505** `variant_invalid:DUPLICATE_OPTION` |
| Mise à jour (SKU `APRES`, prix `null`, stock 9) | `price_amount` reste `null`, devise du parent conservée |
| Désactivation puis réactivation | `active` suit, la ligne est conservée |

### 2.3 Historique

Réponse réelle de `vyora_ugc_import_history` : `total`, `limit`, `offset`,
`workspace_id` et par import `id`, `created_at`, `source`, `reference`,
`status`, `products_created`, `products_failed`, `variants_created`,
`errors_count`, `format`. `format` vaut `url` pour une source web, `xlsx` /
`csv` selon l'extension, `fichier` sinon.

Réponse réelle de `vyora_ugc_import_report` : mêmes champs plus `failures`
(`[{ name, reason }]`).

### 2.4 Migrations

| Version | État |
| --- | --- |
| `20261118100000_ugc_variants_and_import_history` | tracée, `created_by = reconciliation-manuelle` |
| `20261118120000_ugc_variants_editing_and_import_history_rpc` | tracée, `created_by = reconciliation-manuelle` |

Aucune migration historique n'a été réécrite ; aucune donnée n'a été supprimée.

### 2.5 Edge Function `store-import`

- version **9**, `verify_jwt = true`, épinglée sur `b47909f2ad30503fe38e00ebf69d3844a4970cc6` ;
- `ARTIFACT_CHARS = 55232`, `ARTIFACT_SHA256 = dbcb7eb7…5ee4a0b2` ;
- vérification indépendante via `api.github.com` au commit épinglé : **55 232
  caractères, sha256 identique** ;
- `--check` : « chargeur à jour ».

---

## 3. Livré mais non vérifié en production

Un seul point, et il faut le dire clairement.

**Le parcours HTTP complet de `store-import` v9 n'a pas pu être rejoué depuis
ce poste de travail.** La sandbox n'a d'accès sortant que vers GitHub et les
registres de paquets : `xbuuhfwobrafcbgtdgjx.supabase.co` est injoignable
(`SSL_ERROR_SYSCALL`). Ce qui EST vérifié :

1. l'artefact réellement publié au commit épinglé a la bonne empreinte et la
   bonne taille (vérifié via GitHub) ;
2. le bundle exécuté dans un contexte isolé répond correctement, y compris le
   nouveau mode mise à jour (`tests/store-import-wiring.test.ts`, 14 tests) ;
3. le chargeur déployé (v9) contient les mêmes constantes que le fichier
   versionné.

Ce qui RESTE à faire : un appel réel `preview` puis `import` sur v9 depuis un
navigateur (ou un poste avec accès réseau à Supabase). C'est une vérification
de 2 minutes, non un développement.

---

## 4. Reste à faire

Par ordre de priorité de la Phase B.

| # | Sujet | État |
| --- | --- | --- |
| 1 | Expérience catalogue et variantes | **terminé** |
| 2 | Historique des imports | **terminé** |
| 3 | Détection des plateformes et formats | existant, non étendu cette session |
| 4 | Normalisation des catalogues | existant, non étendu |
| 5 | Déduplication et mises à jour | **partiel** : mise à jour par nom livrée ; pas de fusion de doublons proches |
| 6 | Imports partiels, reprises, rapports d'erreurs | **partiel** : rapports et imports partiels existent ; pas de reprise d'un import interrompu |
| 7 | Architecture pour connecteurs (PrestaShop, OpenCart) | non commencé |

Précisions utiles :

- **Déduplication** : la reconnaissance se fait sur le nom exact (casse et
  espaces ignorés). Deux écritures du même produit (« Sérum éclat » / « Serum
  Eclat ») restent deux produits. Une normalisation plus tolérante demanderait
  une décision explicite : fusionner est destructif.
- **Reprise** : un aperçu expiré ne se rejoue pas (TTL 10 min, conservé). Un
  import interrompu à mi-parcours laisse les produits déjà écrits en base, ce
  qui est le comportement voulu, mais aucune interface ne propose de
  « reprendre là où ça s'est arrêté ».
- **Connecteurs** : `supabase/functions/store-import/platform.ts` isole déjà la
  détection. PrestaShop et OpenCart demanderaient un adaptateur par plateforme
  et un stockage de jetons par entreprise (`integration_connections` existant).

---

## 5. Qualité

| Contrôle | Résultat |
| --- | --- |
| `npx vitest run` | **2051 tests, 130 fichiers, tous verts** |
| `npx tsc -b` | 0 erreur |
| `npx tsc -p tsconfig.edge.json --noEmit` | 0 erreur |
| `npx vite build` | OK |
| `build-edge-artifact --check` | chargeur à jour, 55 232 caractères |

Tests ajoutés cette session : 4 fichiers, ~66 tests.

- `variantes-modele.test.ts` (20) — prix absent ≠ 0, stock inconnu ≠ rupture,
  ordre conservé, validations ;
- `variantes-section.test.tsx` (11) — rendu, lecture seule, écriture, doublon ;
- `import-historique.test.ts` (15) — normalisation, statut inconnu ≠ succès ;
- `import-historique-panneau.test.tsx` (8) — aucun appel inutile, refus affiché ;
- `migration-rpc-edition-historique.test.ts` (32) — garde-fous SQL ;
- `store-import-wiring.test.ts` (+2) — mise à jour sans doublon de fiche.

### Deux défauts trouvés pendant la session, et corrigés

1. **Historique trop large.** La première version filtrait sur l'entreprise
   seule : un collègue voyait les imports des autres, ce qui contredit la
   demande. Corrigé sur les deux RPC, et prouvé par un cas réel (membre admin →
   `total = 0`, rapport refusé).

2. **Épingle du chargeur fausse.** Générer le chargeur sur `HEAD` juste après
   avoir committé le code, sans l'artefact, produit une épingle cohérente sur
   disque et **fausse en dépôt** : le chargeur déployé aurait téléchargé
   l'ancien bundle et répondu 503. C'est le deuxième incident de ce type.
   Corrigé, puis **verrouillé par un test** qui lit l'artefact avec
   `git show <commit>:<chemin>` et compare empreinte et nombre de caractères.
   Vérifié en neutralisant l'épingle : le test échoue bien.

---

## 6. Commits

| Commit | Contenu |
| --- | --- |
| `d9541f3` | variantes + historique (code, tests, migration) |
| `3a5b280` | portée personnelle de l'historique |
| `ef7d984` | mise à jour des produits/variantes depuis CSV/XLSX |
| `b47909f` | artefact régénéré |
| `9e33b39` | test d'épingle par `git show` |
| `6e80f91` | correction de l'épingle + redéploiement v9 |

Aucun déploiement Netlify n'a été déclenché : 0 crédit consommé.
