# Phase A — rapport de vérification en production

**Date** : 2026-11-16 · **Projet Supabase** : `xbuuhfwobrafcbgtdgjx` (eu-central-1)
**Branche** : `arena/0188834f-saas-ugc` · **Base** : `develop@2278ce6`

---

## 1. Commit exact déployé

| Élément | Valeur |
|---|---|
| Branche de travail (HEAD) | `cfd51f9` — épinglage du correctif |
| Commit chargé par `business-grow` | `e27e2f002175fe021f1f9394ba42aab93331eb86` |
| Bundle `business-grow.edge.js` | 88 237 caractères (88 260 octets), `bf0b55895d2ecf84c918b9fb99fbf81d311d38f496808566fb261c76101915c9` |
| Commit chargé par `store-import` | `b9d0a8ba9992367bb8a0c8b73ed2ec9206f9bffd` |
| Bundle `_artifacts/store-import.js` | 37 387 caractères (37 623 octets), `74dc20bb77c78fcb0f69b31e720279456be9886170f1337ca65fdbf30987d718` |

`main` reste à `1706df4` : **la branche n'est pas fusionnée dans `main`.**

## 2. Statut de la fusion PR #21

- **Fusionnée** le 2026-11-16 en **squash**, commit `1706df4568bc679a08820bb401b453a7b3fc0a6e`. PR **MERGED**.
- Vérifié lors de la session précédente : la PR ne portait que des changements Phase A, aucun conflit, CI verte, historique préservé (squash sur `main`, aucune réécriture).
- Les travaux de cette session **ne sont pas** dans cette PR : ils sont sur `arena/0188834f-saas-ugc`.

## 3. Versions des Edge Functions déployées

| Fonction | Version | ID | `verify_jwt` | État |
|---|---|---|---|---|
| `store-import` | **v2** | `b53d8821-c70a-4e6c-982c-96a0cf25ae54` | `true` | ACTIVE |
| `business-grow` | **v31** | `6e29e1f3-a9e1-4258-a399-460ed2576d07` | `true` | ACTIVE |

Aucune autre fonction n'a été déployée. `business-grow` est passée de v30 à v31 **uniquement** pour corriger la garde Import & Connect (§5).

## 4. Résultats des tests HTTP réels — deux comptes isolés

### Méthode

Le poste de travail n'a aucun accès réseau à Supabase. Les appels ont donc été émis **depuis la base**, via `pg_net`, contre l'URL publique du projet — de vrais appels HTTP sortants, pas des simulations.

Authentification **réelle** : les comptes de test ont obtenu un jeton GoTrue par `POST /auth/v1/token?grant_type=password`, avec un secret aléatoire de 32 octets généré en base, immédiatement remplacé après obtention du jeton. Les jetons n'ont jamais quitté la base ; aucun mot de passe n'a été copié ni partagé.

Comptes : `phasea-a@vyora-test.invalid` (aucun abonnement), `phasea-b@vyora-test.invalid` (abonnement `active`, plan de test dédié `phasea_test`).

### Compte A — sans abonnement admissible

| Test | Appel | Résultat réel |
|---|---|---|
| Aperçu d'import refusé | `store-import` `preview` | **403** `BUSINESS_GROW_SUBSCRIPTION_REQUIRED` / `NO_SUBSCRIPTION` |
| Import confirmé refusé | `store-import` `import` (`confirmed: true`) | **403** `…SUBSCRIPTION_REQUIRED` / `NO_SUBSCRIPTION` |
| Demande de connexion refusée | `business-grow` `integrations.request` | **403** `…SUBSCRIPTION_REQUIRED` / `NO_SUBSCRIPTION` |
| Connexions d'autrui refusées | `business-grow` `integrations.list` | **403** — aucune connexion divulguée |
| Réponses cohérentes, sans fuite | — | Motif, statut, plan et date renvoyés **nuls** ; aucune donnée d'autrui |

L'import a été refusé **avant toute écriture** : `ugc_products` est resté à **0**.

### Compte B — abonnement admissible

| Test | Appel | Résultat réel |
|---|---|---|
| Accès autorisé | `business-grow` `integrations.list` | **200 OK** `{"connections":[]}` |
| Connexion de boutique autorisée | `business-grow` `integrations.request` (`shopify`) | **409** `BUSINESS_GROW_UPGRADE_REQUIRED` — garde franchie |
| Aperçu fonctionnel | `store-import` `preview` | Garde franchie : réponse métier (voir ci-dessous) |

**Sur l'aperçu** : la garde est franchie et le moteur répond honnêtement, mais aucun catalogue marchand n'a pu être extrait pendant la fenêtre de test :

| URL | Réponse |
|---|---|
| `demo.shopify.com` | 502 `SOURCE_UNREACHABLE` |
| `www.allbirds.com` | 413 `RESPONSE_TOO_LARGE` (> 256 Ko de HTML) |
| `gymshark.com` | 502 `CATALOG_UNAVAILABLE` |
| `www.myshopify.com` | 502 `SOURCE_UNREACHABLE` |
| `maisonbacon.com` | 400 `URL_REFUSED` (DNS) |
| `www.storegrow.com` | 422 `PLATFORM_UNKNOWN` |

Ces réponses prouvent que les gardes réseau fonctionnent (taille bornée, refus DNS, refus d'inventer des produits sur une plateforme non identifiée), mais **la preuve d'un aperçu productif (produits réellement extraits) reste à faire** avec une boutique Shopify/WooCommerce atteignable. C'est le principal point ouvert.

### Après expiration et suspension

| État de l'abonnement | `store-import` | `business-grow` |
|---|---|---|
| `active` | autorisé | autorisé (200 / 409 métier) |
| `expired` (période échue) | **403** `SUBSCRIPTION_EXPIRED`, `status: expired`, dates renvoyées | **403** `SUBSCRIPTION_EXPIRED` |
| `past_due` (suspension) | — | **403** `PAYMENT_FAILED`, `status: past_due` |
| `canceled` | **403** `SUBSCRIPTION_CANCELED` | cohérent |

Les deux fonctions renvoient désormais **le même motif pour le même état**, ce qui n'était pas le cas avant le correctif §5.

## 5. Défaut trouvé et corrigé pendant la vérification

**`business-grow` refusait aussi les abonnés.**

`saas_business.bg_import_access` renvoie **un seul `jsonb`**, pas une table. La lecture `select * from …bg_import_access(…)` exposait donc une colonne unique nommée d'après la fonction : `row.allowed` valait toujours `undefined`, et la garde refusait **tout le monde**. `store-import` lisait correctement (colonne nommée `droits`) ; seule la seconde implémentation de la même garde était fautive.

- Constaté par HTTP réel : compte B → `403 reason "UNKNOWN"`, alors que `bg_import_access` répondait `{"allowed": true, "reason": "OK", "status": "active"}` pour ce même compte.
- Corrigé par une lecture nommée + la clé `status` réellement renvoyée.
- **Aucun test existant ne pouvait le voir** : les tests du handler injectent la dépendance et n'exécutent jamais le SQL. Un test dédié (`tests/import-connect-access-read.test.ts`, 5 tests) verrouille désormais la source ; il échoue bien sur l'ancien code (vérifié) et passe sur le correctif.
- Rejoué en production après déploiement de v31 : compte B franchit la garde, compte A toujours refusé.

**Sans la vérification HTTP à deux comptes, ce défaut serait passé inaperçu : la Phase A aurait été déclarée active avec un module qui ne fonctionnait pour personne.**

## 6. Confirmation que les données de production n'ont pas été altérées

| Métrique | Avant | Après nettoyage |
|---|---|---|
| Comptes `auth.users` | 6 | **6** |
| Comptes de test | 0 | **0** |
| Abonnements | 0 | **0** |
| Plans actifs | 0 (3 au total) | **0** (3 au total) |
| Entreprises | 3 | **3** (créées les 10–11/11, propriétaires intacts) |
| Produits | 0 | **0** |

- **Aucun abonnement client réel n'a été touché** : les abonnements créés portaient le plan de test `phasea_test`, supprimé depuis ; les 3 plans réels n'ont jamais été modifiés.
- Le compte `7b56a2fb…` utilisé en session précédente n'a pas été modifié.
- Nettoyage exécuté : comptes, identités, sessions, abonnement, plan de test, entreprise de test, table de travail, fonction d'orchestration, réponses `pg_net`.
- La migration `20261117090000_import_connect_access.sql` **n'a pas été ré-appliquée**.

## 7. Interface

**Non vérifié dans cette session** — aucun navigateur connecté, et le préview Netlify est volontairement désactivé (contrainte de crédits). Les points 4 de la demande (présentation commerciale, « Revérifier », absence d'état de chargement ouvrant prématurément l'accès) restent **à confirmer** :

- Les gardes d'interface (`ImportConnectGate.tsx`, `useImportAccess.ts`) sont couvertes par `import-connect-gate.test.tsx` (10/10) au niveau composant.
- Une vérification visuelle réelle exige un déploiement Netlify ou un accès navigateur authentifié.

## 8. Problèmes encore ouverts

1. **Aperçu productif non démontré** : aucune boutique réelle n'a livré de catalogue pendant les tests (§4). À refaire avec une boutique Shopify/WooCommerce atteignable, ou via un import CSV/XLSX.
2. **Interface non vérifiée en réel** (§7).
3. **`integrations.request` renvoie 409 `BUSINESS_GROW_UPGRADE_REQUIRED`** même pour une entreprise neuve. Un protocole d'entreprise semble manquant (`getWorkspaceProtocol`) ; comportement métier à confirmer, mais il n'est pas un défaut d'accès.
4. **Branche non fusionnée** : les commits `e6326c1`, `e27e2f0`, `cfd51f9` sont sur `arena/0188834f-saas-ugc`, pas sur `main`. Production exécute ces commits via l'épinglage GitHub, ce qui est voulu — mais `main` ne les contient pas encore.
5. **Phase B non commencée**, conformément à la consigne : elle attend que les points 1 et 2 ci-dessus soient levés.

## 9. Coût

- **Netlify : 0 crédit.** Aucun déploiement, aucun Deploy Preview ; `netlify.toml` ignore toujours `arena/0188834f-saas-ugc`.
- **Supabase : 1 déploiement de fonction** (`business-grow` v30 → v31). `store-import` n'a pas été redéployé. Aucune migration appliquée.
