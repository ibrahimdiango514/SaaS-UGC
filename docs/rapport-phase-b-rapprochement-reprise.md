# Phase B — rapprochement intelligent et reprise des imports

**Date** : 2026-11-14 · **Branche** : `arena/0188834f-saas-ugc` · **Projet** : `xbuuhfwobrafcbgtdgjx`
**Commit de tête** : `d28e104` · **`store-import` déployée** : version **11**

Ce rapport ne présente comme fait que ce qui a une preuve. Trois niveaux sont
distingués : **prouvé en production**, **prouvé en test**, **non vérifié**.

---

## 1. Déduplication intelligente — livré, branché, prouvé en test

### 1.1 Ce qui a changé, et pourquoi

L'ancienne déduplication comparait le **nom exact** (casse et accents ignorés).
Deux défauts concrets en découlaient :

- un produit **renommé à la source** — même référence, nouveau libellé — était
  recréé : deux fiches pour un seul produit ;
- deux produits **réellement différents** dont le nom se ressemble n'étaient
  pas distingués, et un homonyme pouvait être écrasé.

Le rapprochement utilise désormais des **niveaux de confiance nommés**, jamais
un score unique avec un seuil :

| Niveau | Règle | Décision |
| --- | --- | --- |
| `platform-id` | identifiant du produit chez la source (Shopify `id`/`handle`, Woo `id`) | mise à jour |
| `sku` | référence produit **ou de variante** identique | mise à jour |
| `name-exact` | nom identique après normalisation | mise à jour (comportement historique conservé) |
| `name-near` | nom proche (mot significatif commun + inclusion ou Dice ≥ 0,82) | **ambigu — jamais appliqué** |
| — | identifiant présent sur plusieurs fiches / désaccord entre indices fiables | **ambigu** |
| — | même produit deux fois dans le lot | doublon interne, non écrit |

**Aucune fusion automatique sur une ressemblance.** Une ligne ambiguë n'est pas
importable : elle est affichée avec ses candidats et attend une décision.

### 1.2 Branchement effectif

| Exigence | État | Preuve |
| --- | --- | --- |
| SKU / référence produit | **branché** | `matching.ts` → `handler.ts` `rapprocher()` ; tests `matching-catalogue` (26) |
| Identifiant de la plateforme source | **branché** | `sources.ts` (Shopify/Woo) + `files.ts` (en-tête `platformId`) |
| Nom normalisé | **branché** | niveau `name-exact`, 25 tests de bout en bout |
| Variantes et références de variantes | **branché** | `variantSkus` relu par `listExistingProducts` |
| Ambiguïtés **présentées** dans l'aperçu | **branché** | champs `match`, `matchReason`, `candidates` |
| Préserver id interne, variantes, vidéos | **branché** | `updateExisting` cible `targetId` : le `id` ne change pas |
| Jamais d'écrasement par une valeur vide | **branché** | `coalesce(nullif(...))` + prix remplacé seulement s'il est connu |
| Comportement historique si options désactivées | **conservé** | `duplicate` / `importable` gardent leur sens |

L'aperçu porte maintenant, par ligne :

```jsonc
{
  "match": "create" | "update" | "ambiguous" | "duplicate-in-batch",
  "matchReason": "Même référence CHE-1 : le produit existant sera mis à jour.",
  "candidates": [{ "id": "…", "name": "Chemise indigo" }],
  "targetId": "…"   // null sauf décision `update`
}
```

Les décisions sont **figées avec l'aperçu** (`PreviewRecord.matches`) : un
catalogue qui change entre l'aperçu et la confirmation ne déplace pas l'écriture
sur une autre fiche.

### 1.3 Tests

- `tests/matching-catalogue.test.ts` — 26 tests (module pur) ;
- `tests/matching-import-fichier.test.ts` — 8 tests (bout en bout fichier) ;
- `tests/store-import-wiring.test.ts` — **25 tests**, dont 6 nouveaux exécutant
  le **bundle livré** dans un contexte isolé : mise à jour par SKU, nom proche
  ambigu, homonymes en conflit, nom identique (historique), doublon interne,
  non-écrasement par valeur absente.

---

## 2. Reprise des imports interrompus — livré, prouvé en test et en base

### 2.1 Mécanisme

- Table `saas_ugc.ugc_import_progress` : une ligne par **produit réellement
  écrit**, clé d'unicité `(workspace_id, import_key, line_key)`.
- `import_key` est une **empreinte stable du lot** (origine + références
  triées), pas le `previewId` : les aperçus expirent, la clé doit survivre.
- Action `resume` — **lecture seule** : elle dit où l'import s'est arrêté et
  n'écrit rien. Elle n'est jamais appelée automatiquement.
- À la confirmation avec `importKey`, la progression est **relue** ; seules les
  lignes absentes du journal sont retraitées. Si tout est fait : **rien n'est
  réécrit** et la réponse le dit (`alreadyDone`).
- Si la lecture de progression échoue, le lot est traité entièrement : le
  rapprochement transforme alors les produits déjà présents en **mises à jour**
  au lieu de doublons. Moins efficace, jamais dupliquant.

### 2.2 Preuves

| Exigence | Preuve |
| --- | --- |
| Progression conservée | tests `reprise-import` (17), `store-import-wiring` |
| Reprise du seul reste à faire | test « ne réécrit que les lignes restantes » : 1 produit écrit sur 2 |
| Aucun doublon | test « idempotent : lot entièrement fait n'écrit rien » |
| Reprise après expiration de session | clé d'empreinte de lot, indépendante de l'aperçu |
| Jamais de relance sans vérifier l'état | `resume` en lecture seule + relecture avant écriture |
| Erreurs conservées dans l'historique | `recordImport` inchangé (testé en Phase B-1) |

**En base (production)** :

- RPC `public.vyora_ugc_import_progress(uuid, text)` appelée sous identité
  réelle (`role authenticated`, `request.jwt.claims.sub`) ⇒ **200**, `lines: []`.
- Même appel avec un autre `sub` ⇒ **42501 `progress_forbidden:WORKSPACE_ACCESS_DENIED`**.
- `insert` direct par `authenticated` ⇒ **42501 permission denied** (lecture
  seule par conception).
- Rejeu d'une même ligne (`on conflict do nothing`) ⇒ **1 ligne conservée**.

### 2.3 Migration

`supabase/migrations/20261118140000_ugc_import_progress_resume.sql` a été
**appliquée en production** : table, index unique, RLS propriétaire en lecture,
RPC `security definer` avec `search_path = ''`, et bloc `do $verif$` de
contrôles. Le fichier de migration est committé avec le code.

---

## 3. Sécurité et abonnements — inchangés, re-vérifiés

| Exigence | État | Preuve |
| --- | --- | --- |
| Business Grow actif **et payé** pour importer | **conservé** | `bg_import_access` lue côté serveur avant toute écriture |
| Contrôle serveur, pas client | **conservé** | aucune valeur d'abonnement ne vient du navigateur |
| Aucun accès inter-entreprises | **conservé** | `bg_require_workspace` + filtre `workspace_id` |
| Imports personnels d'un collègue invisibles | **conservé** | progression filtrée sur `user_id` **et** `workspace_id` |
| Expiration = lecture seule | **conservé** | `canWrite` faux ⇒ `import` refusé (403) |
| Aucune suppression automatique du catalogue | **conservé** | aucun `delete` de produit ; seules les variantes sont réécrites |

La nouvelle lecture de progression applique **`user_id` ET `workspace_id`** :
une clé de lot reçue du client ne peut pas donner accès à la progression d'un
autre utilisateur de la même entreprise.

Pendant la vérification, un abonnement de test a été créé puis **supprimé** ;
les plans ont été remis à leur état d'origine. État final contrôlé : 3
entreprises, **0 produit**, **0 abonnement actif**, **0 plan payant**, 0 secret
de test, 0 fonction de test.

---

## 4. Vérifications techniques

| Contrôle | Résultat |
| --- | --- |
| `npx tsc -b` | **0 erreur** |
| `npx tsc -p tsconfig.edge.json --noEmit` | **0 erreur** |
| `npx vitest run` | **2113 tests, 133 fichiers, 0 échec** |
| Artefact `store-import` | **64 820 caractères**, sha256 `f0897096…` |
| Épingle du chargeur | commit `c536aab` (contenu vérifié par `curl` : 200, taille et empreinte conformes) |
| Fonction déployée | **version 11**, `verify_jwt = true` |
| Sonde réelle `OPTIONS`/`resume` via `pg_net` | la fonction répond **depuis notre handler** (401 `UNAUTHENTICATED`), donc le bundle épinglé s'exécute |
| Netlify | **0 crédit consommé** |

---

## 5. Non vérifié — à ne pas présenter comme validé

Le **parcours HTTP complet** de `store-import` (aperçu → confirmation →
reprise) n'a **pas** été exécuté avec un jeton de session réel : la passerelle
Supabase exige un jeton signé par GoTrue, et aucun mot de passe utilisateur
n'est disponible dans cet environnement. Ce qui **a** été prouvé :

- le bundle épinglé **se charge et s'exécute** en production (v11) ;
- la logique complète est prouvée sur le **bundle livré**, exécuté dans un
  contexte isolé avec des doublures fidèles (25 tests) ;
- les composants SQL (RPC de progression, SQL de lecture du catalogue) ont été
  **exécutés en production** sous identité réelle.

Il reste donc à faire confirmer par un test navigateur authentifié, en une
seule passe, quand un compte de test sera disponible.

---

## 6. Reste à faire

1. **PrestaShop** : connecteur complet (auth sécurisée, déclinaisons,
   prix/devises, stock, SKU, attributs, pagination, aperçu, confirmation,
   mise à jour, rapport) sur le moteur commun.
2. **OpenCart** : même architecture, sans dupliquer le moteur.
3. `PublicCatalog.platform` est encore figé à `'shopify' | 'woocommerce'` :
   à élargir avant d'ajouter ces deux plateformes.

---

## 7. Détail des fichiers touchés

| Fichier | Nature |
| --- | --- |
| `src/business/importer/matching.ts` | rapprochement (livré au tour précédent, désormais branché) |
| `src/business/importer/resume.ts` | **nouveau** : clés de lot/ligne, plan de reprise, résumé |
| `supabase/functions/store-import/handler.ts` | `rapprocher()`, `decisionApercu()`, action `resume`, progression |
| `supabase/functions/store-import/index.ts` | identité dans `product_facts`, lecture par jointure latérale, `readProgress`/`recordProgress`, cibles de mise à jour |
| `supabase/migrations/20261118140000_ugc_import_progress_resume.sql` | progression + RPC + contrôles |
| `scripts/build-edge-artifact.mjs` | **correctif** : liaison postgres renommée `$r` par esbuild, regex élargie à `$` |
| `tests/reprise-import.test.ts` | **nouveau** : 17 tests |
| `tests/store-import-wiring.test.ts` | +6 tests de bout en bout, 25 au total |

### Correctif notable : génération de l'artefact

esbuild renomme la liaison `postgres` en `$r` lorsque le nom court est déjà
pris. La regex du script n'acceptait que `\w`, laissait l'instruction `import`
dans le bundle, et l'erreur affichée (« bundle contient encore une instruction
import ») ne désignait pas la cause. La regex accepte désormais `$`.
