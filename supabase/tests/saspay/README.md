# Banc local — paiements SasPay

Éprouve la migration `20261113100000_vyora_saspay_payments.sql` et les Edge
Functions `vyora-payments` / `vyora-saspay-webhook` sur un **PostgreSQL 17 réel,
local et jetable**. Aucun appel à Supabase ni à SasPay : SasPay est simulé en
mémoire, la base n'écoute que sur `127.0.0.1` et vit dans le répertoire
temporaire du système.

```bash
cd supabase/tests/saspay
npm install      # binaires PostgreSQL (paquet embedded-postgres) + pilote pg
npm test         # Node ≥ 22.6
```

| Étape | Rôle |
| --- | --- |
| `base.mjs` | Monte la base : rôles Supabase, `prod_subset.sql`, migrations Business Grow du dépôt. |
| `mig.mjs` | Applique la migration SasPay deux fois (idempotence). |
| `scenario.mjs` | Intégrité SQL : prix, idempotence, concurrence, gardes, droits, cloisonnement Studio / Business Grow. |
| `legacy.mjs` | Anciennes RPC du navigateur (`ugc_create_recharge_order`, `reelora_admin_confirm_recharge`) face aux gardes. |
| `e2e.mjs` | Bout en bout : vraies Edge Functions + base réelle + faux SasPay. |

## Limites à connaître

- `prod_subset.sql` est une **copie partielle** du schéma de production relevée
  le 2026-11-12 (le schéma de base `saas_ugc` n'est créé par aucune migration du
  dépôt). `has_role` et `reelora_assert_admin` y sont réécrites à la main, et le
  trigger d'immuabilité du grand livre n'y figure pas. Si la production évolue,
  ce fichier doit être rafraîchi.
- `base.mjs` et `legacy.mjs` contiennent des bouchons (`ugc_workspaces`,
  `ugc_country_pricing`, `ugc_is_admin`, catalogue Business Grow de la migration
  de production `20261112054553`, absente du dépôt).
- Les prix Business Grow utilisés (25 000 XOF, 400 unités) sont **fictifs** :
  aucune formule n'a de prix en production.
- Ce banc ne remplace pas un essai avec une clé SasPay de test réelle.

Variables : `VYORA_PGTEST_PORT` (54329), `VYORA_PGTEST_DIR`, `VYORA_PGTEST_BIN`.
