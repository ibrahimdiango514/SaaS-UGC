# Banc local — paiements SasPay

Éprouve les migrations `20261113100000_vyora_saspay_payments.sql` et
`20261113110000_vyora_saspay_refunds_reconcile.sql`, ainsi que les Edge Functions
`vyora-payments`, `vyora-saspay-webhook` et `vyora-payments-reconcile`, sur un **PostgreSQL 17 réel,
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
| `mig.mjs` | Applique les trois migrations SasPay, dans l'ordre, deux fois (idempotence), contrôle la politique de prix créée par défaut (active, 1 000 FCFA, barème vide), puis la désactive pour les scénarios historiques. |
| `scenario.mjs` | Intégrité SQL : prix, idempotence, concurrence, gardes, droits, cloisonnement Studio / Business Grow. |
| `legacy.mjs` | Anciennes RPC du navigateur (`ugc_create_recharge_order`, `reelora_admin_confirm_recharge`) face aux gardes. |
| `refunds.mjs` | Remboursements Studio et Business Grow, attestation, forges en table, concurrence, entretien, sélection de réconciliation, anomalies, tâche planifiée (`net.http_post` remplacé par un enregistreur). |
| `audit.mjs` | Audit avant mise en production, avec des connexions réellement simultanées : Business Grow (deux formules, paiements tardifs, encaissement non applicable et son remboursement intégral), remboursements (fuseaux, jours entamés, concurrence avec un renouvellement ou une dépense, attestation), réconciliation (exécution unique, anomalies, prérequis). Rejouable sans réinitialiser la base. |
| `unconfirmed.mjs` | Demande Mobile Money restée sans réponse : tentative enregistrée avec son corps, rejeu borné (4 envois, 10 min), blocage de tout autre paiement du client (y compris par deux connexions simultanées et par insertion directe), passage en rapprochement manuel au lieu de l'expiration, candidates, rattachement, clôture attestée, réouverture sur encaissement tardif, Business Grow, droits. Rejouable sans réinitialiser la base. |
| `pricing.mjs` | Prix tout compris : vecteurs de calcul communs avec le moteur TypeScript (`pricing-vectors.json`), devis client sans détail interne, prix final figé sur la commande, rapprochement (frais réels, net, marge, alertes, rejeu, panne d'écriture), administration (politique, barème en ajout seul, import des tarifs, simulateurs, droits), rapport financier filtré. Rejouable ; remet la configuration dans l'état trouvé. |
| `e2e.mjs` | Bout en bout : vraies Edge Functions + base réelle + faux SasPay, dont la réconciliation planifiée (webhook perdu, réponse de création perdue, double encaissement, montant différent), l'audit (rafales de webhooks rejoués, pannes réseau, liste SasPay sans libellé, parcours Studio et Business Grow d'un même utilisateur) et la réponse de création perdue quand le client ne revient jamais (webhook d'une transaction inconnue, SasPay sans libellé, recherche par numéro, décision de l'administrateur, requête jamais reçue). Demande une base neuve (`base.mjs` puis `mig.mjs`). |

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
- `vault`, `cron` et `net` sont des **bouchons** (`pg.mjs`) : le banc prouve que
  la tâche est planifiée une seule fois, que le jeton est créé une seule fois et
  que l'appel sortant porte les bons en-têtes — pas que pg_cron l'exécute
  réellement toutes les 5 minutes, ni que Vault chiffre le jeton.
- Le faux SasPay de `e2e.mjs` applique l'idempotence de `softpay` et la recherche
  par numéro **telles que la documentation les décrit**. Ni l'une ni l'autre n'a
  été observée sur le vrai service (recette, lignes 13 à 15).
- Ce banc ne remplace pas un essai avec une clé SasPay de test réelle (recette :
  `docs/paiements-saspay.md`).

Lancer une seule étape : `node base.mjs && node mig.mjs && node audit.mjs`
(`base.mjs` repart d'une base neuve et laisse le serveur démarré).

Variables : `VYORA_PGTEST_PORT` (54329), `VYORA_PGTEST_DIR`, `VYORA_PGTEST_BIN`.
