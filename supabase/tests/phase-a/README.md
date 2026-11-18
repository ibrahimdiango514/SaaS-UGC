# Vérification Phase A — protocole rejouable

Ce dossier contient le protocole qui a servi à vérifier la Phase A **en
production**, avec deux comptes isolés, le 2026-11-16. Le rapport figure dans
`docs/rapport-phase-a-production-2026-11-16.md`.

## Pourquoi ces fichiers existent

La vérification a prouvé quelque chose que **aucun test unitaire ne pouvait
montrer** : `business-grow` refusait aussi les abonnés, parce que
`select * from saas_business.bg_import_access(…)` exposait une colonne unique
(la fonction renvoie un `jsonb`, pas une table). Les tests du handler injectent
la dépendance, donc n'exécutent jamais ce SQL.

Le protocole est conservé pour être **rejouable après chaque changement** de la
garde d'accès, sans reconstruire les comptes à la main.

## Ordre d'exécution

| Fichier | Rôle |
|---|---|
| `01-comptes-test.sql` | Crée les deux comptes isolés + la table de travail privée |
| `02-abonnement.sql` | Plan de test dédié + abonnement `active` du compte B |
| `99-teardown.sql` | Supprime **tout** ce qui a été créé et contrôle l'état final |

Entre `01` et `99`, les appels HTTP sont émis avec `pg_net` (voir ci-dessous) :
le poste de développement n'a aucun accès réseau à Supabase, la base si.

## Points de sécurité respectés

- **Zone DNS non routable** : `@vyora-test.invalid`.
- **Aucun abonnement client touché** : plan dédié `phasea_test`, supprimé au
  nettoyage ; les plans réels n'ont jamais été modifiés.
- **Aucun mot de passe partagé durablement** : secret aléatoire de 32 octets,
  remplacé dès le jeton obtenu.
- **Aucune clé de service copiée** : les secrets du projet sont hachés côté API
  et ne sont jamais lisibles depuis ce poste. L'authentification se fait par
  GoTrue, pas par une clé d'administration.
- **Nettoyage vérifié** : `99-teardown.sql` affiche les compteurs finaux
  (comptes, abonnements, plans, entreprises, produits).

## Vérifier l'état après coup

```sql
select
  (select count(*) from auth.users) as comptes_auth,
  (select count(*) from auth.users where email like '%@vyora-test.invalid') as comptes_test,
  (select count(*) from saas_business.subscriptions) as abonnements,
  (select count(*) from saas_business.plans where active) as plans_actifs,
  (select count(*) from saas_ugc.ugc_products) as produits;
```

Attendu hors protocole : `comptes_test = 0`, `abonnements = 0`,
`plans_actifs = 0`, `produits = 0`.
