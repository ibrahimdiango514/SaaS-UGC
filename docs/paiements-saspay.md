# Paiements SasPay — VYORA Studio et Business Grow

État : **livré dans le dépôt, non déployé, désactivé par défaut.** Aucun appel
réel à SasPay n'a été effectué et rien n'a été appliqué à la base de production.

## 1. Ce que fait l'intégration

- **Encaissement uniquement.** Le code n'appelle que sept routes SasPay : tarifs
  du compte, paiement Mobile Money (`softpay`), session de paiement hébergée,
  état d'une session, vérification d'un paiement, liste des encaissements et
  soldes marchands (ces trois dernières en lecture). Aucun décaissement, transfert
  ni recharge de portefeuille n'existe dans le code — y compris pour rembourser.
- **Studio** : achat d'un pack ou recharge libre → crédits Studio.
- **Business Grow** : souscription d'une formule pour 30 jours, sans
  renouvellement automatique → abonnement et unités Business Grow.
- Les deux produits ont leurs propres commandes, portefeuilles et historiques.
  Aucune fonction ne crédite l'un à partir d'un paiement de l'autre.

## 2. Parcours d'un paiement

```
Navigateur ──(intention : article, réseau, numéro)──▶ Edge Function vyora-payments
                                                        │ prix relu en base, commande créée
                                                        ▼
                                                     SasPay (softpay ou page hébergée)
                                                        │
SasPay ──(webhook signé)──▶ Edge Function vyora-saspay-webhook ─┐
Navigateur ──(« où en est ma commande ? »)──▶ vyora-payments ───┤
                                                                ▼
                                    GET /payments/{id}/verify/ chez SasPay
                                                                ▼
                          base : règlement idempotent (crédit une seule fois)
```

Le crédit n'est accordé que si la **vérification serveur** auprès de SasPay
renvoie `SUCCESS` avec le montant et la devise de la commande. Ni le webhook
seul, ni l'adresse de retour, ni le navigateur ne peuvent déclencher un crédit.

### Réconciliation planifiée (filet de sécurité)

Un webhook peut se perdre, un client peut fermer sa page. Une tâche pg_cron
(`vyora-payments-reconcile`, toutes les 5 minutes) appelle
`public.vyora_payments_reconcile_dispatch()` :

1. **Entretien SQL, sans réseau** : clôt les commandes jamais parvenues à SasPay
   (expirées depuis 15 min) ; fait expirer les abonnements Business Grow échus
   depuis plus d'une heure et ramène leur quota à la valeur par défaut (hors
   abonnement).
2. **S'il n'y a rien à vérifier, elle s'arrête là** : aucun appel sortant.
3. Sinon elle appelle l'Edge Function `vyora-payments-reconcile` (en-tête
   `x-vyora-cron: payments-reconcile` + jeton aléatoire stocké dans Vault), qui :
   - revérifie chaque commande en attente par `GET /payments/{id}/verify/` —
     après 2 min, puis toutes les 4 min (1re heure), 30 min (1er jour), 6 h
     (30 jours) ; une commande en échec est revérifiée toutes les 6 h pendant
     72 h, car SasPay permet de relancer un paiement échoué ;
   - au plus une fois par quart d'heure, **balaie les encaissements réussis** des
     72 dernières heures (`GET /transactions/`) et retrouve la commande par sa
     référence interne (`VYS-…`/`VYB-…`), que VYORA place dans le libellé de
     chaque paiement. C'est ce qui rattrape une réponse de création perdue.

Dans tous les cas la livraison passe par le même règlement idempotent, après la
même vérification unitaire : la liste sert à **repérer** un paiement, jamais à
le croire.

Ce que la tâche ne décide pas seule est consigné comme **anomalie**, visible dans
l'administration (onglet SasPay) et notifié une fois aux administrateurs :

| Anomalie | Ce qui s'est passé | Ce que fait VYORA |
| --- | --- | --- |
| `duplicate_payment` | Deux encaissements réussis pour une même commande | Livre une fois ; le second est à rendre au client |
| `payment_conflict` | Un encaissement porte la référence d'une commande liée à une autre transaction | Ne livre rien |
| `amount_mismatch` | Montant ou devise encaissés ≠ commande | Ne livre rien |
| `payment_not_found` | SasPay ne connaît pas la transaction | Clôt la commande après 24 h (un succès tardif la rouvre) |
| `order_stuck` | Commande toujours en attente après 24 h | Continue de la revérifier |

## 2 bis. Remboursements

**SasPay n'a ni route ni événement de remboursement** (vérifié dans sa
documentation : un remboursement y est un décaissement ordinaire du marchand).
VYORA n'envoie donc **aucun argent**. Un remboursement se fait en deux temps,
depuis l'administration (onglet SasPay), sur un paiement confirmé :

1. **Enregistrer le remboursement** (motif obligatoire). VYORA reprend ce qui a
   été livré et clôt la commande, définitivement :
   - *Studio* : les crédits de l'achat encore disponibles sont retirés du solde
     (écriture `refund` au grand livre, clé `refund:<commande>`). Si une partie a
     été dépensée, le remboursement doit être confirmé comme **partiel** et le
     montant est plafonné au prorata des crédits repris. Le solde ne devient
     jamais négatif. Si des crédits manquent et que des générations sont en
     cours, le remboursement est refusé jusqu'à leur fin (leurs crédits réservés
     peuvent encore revenir au solde).
   - *Business Grow* : la période payée est retirée de l'abonnement ; s'il ne
     reste rien, l'abonnement est résilié et le quota ramené à la valeur par
     défaut (hors abonnement). Montant plafonné au prorata des jours restants (journée entamée
     comptée au client).
2. **Rendre l'argent hors de VYORA** (transfert Mobile Money, décaissement depuis
   le tableau de bord SasPay), puis **attester le versement** avec sa référence.
   VYORA ne vérifie pas ce versement : la référence saisie fait foi.

Entre les deux, la commande apparaît « Remboursement en cours » (client comme
administrateur) et un rappel « remboursement(s) à verser » reste affiché. Le
motif et la référence du versement sont des notes internes, jamais montrées au
client. Chaque étape est tracée dans `ugc_audit_logs`
(`saspay_refund_recorded`, `saspay_refund_settled`).

Une commande remboursée ne peut être ni repayée, ni re-remboursée, ni modifiée ;
un webhook de paiement rejoué ne relivre rien.

## 3. Garanties, et où elles sont tenues

| Garantie | Tenue par |
| --- | --- |
| Prix et crédits jamais fournis par le navigateur | Base (`vyora_payment_quote`, `create_*_order`) |
| Un paiement ne crédite qu'une fois (rejeux, webhook + vérification simultanés) | Base (verrou de ligne, événement unique `saspay:success:<id>`, grand livre idempotent) |
| Pas de validation manuelle d'une commande SasPay | Base (trigger `vyora_recharge_order_guard`) |
| Pas de fausse commande « SasPay » créée par l'ancienne RPC du navigateur | Base (nom de prestataire réservé) |
| Montant, devise, utilisateur, référence immuables ; commande payée terminale | Base (triggers) |
| Écritures réservées au serveur | Base (droits : `service_role` uniquement, RLS forcée) |
| Webhook authentique et non rejoué | Edge (HMAC-SHA256 du corps brut, comparaison à temps constant, fenêtre de 300 s) |
| Clé de production inutilisable en mode test, et inversement | Edge (`PAYMENT_MODE_MISMATCH`) |
| Aucune clé dans le navigateur ni dans les journaux | Edge (secrets serveur, masquage `sk_***`), vérifié sur le bundle |
| Numéro du payeur jamais stocké en clair | Edge + base (`+223••••••56`) |
| Remboursement réservé à l'administrateur, plafonné, définitif, sans solde négatif | Base (`vyora_admin_refund_*`, triggers `refund_is_immutable`) |
| Remboursement concurrent d'une dépense : un seul des deux aboutit | Base (verrou du portefeuille) |
| Tâche planifiée non déclenchable par un tiers | Edge (en-tête dédié, puis jeton Vault comparé à temps constant) ; base (`dispatch` sans rôle d'API) |
| Une seule réconciliation à la fois | Base (verrou consultatif + journal des exécutions) |
| La clé SasPay n'est jamais envoyée ailleurs qu'à SasPay | Edge (curseur de pagination restreint à l'API configurée) |
| Clé SasPay propre à VYORA | Edge (`VYORA_SASPAY_SECRET_KEY` seule ; aucun repli sur `SASPAY_SECRET_KEY`) |

## 4. Fichiers

| Fichier | Rôle |
| --- | --- |
| `supabase/migrations/20261113100000_vyora_saspay_payments.sql` | Migration additive et idempotente |
| `supabase/migrations/20261113110000_vyora_saspay_refunds_reconcile.sql` | Remboursements, réconciliation, anomalies, tâche planifiée (additive, idempotente) |
| `supabase/functions/vyora-payments-reconcile/` | Appelée par pg_cron uniquement (jeton Vault) |
| `src/pages/admin/SasPayOperations.tsx` | Admin : remboursement, attestation, surveillance, anomalies |
| `supabase/functions/_shared/saspay/*.ts` | Montants exacts, client SasPay, signature, service de paiement, accès base, HTTP |
| `supabase/functions/vyora-payments/` | Appelée par le navigateur (JWT exigé) : `options`, `create`, `status`, `balances` |
| `supabase/functions/vyora-saspay-webhook/` | Appelée par SasPay (signature exigée) |
| `src/lib/payments.ts`, `src/components/PaymentDialog.tsx` | Fenêtre de paiement commune |
| `src/pages/PaymentReturn.tsx` | `/app/paiement/retour` — suivi après la page hébergée |
| `src/pages/admin/SasPayPanel.tsx` | Admin : soldes (lecture seule) et paiements |
| `supabase/tests/saspay/` | Banc PostgreSQL local (voir son `README.md`) |
| `tests/saspay-*.test.ts(x)` | Tests unitaires et d'interface |

## 5. Mise en service (à faire par un humain, dans cet ordre)

Rien de ce qui suit n'a été fait.

1. **Créer la clé SasPay de VYORA.** Les secrets `SASPAY_SECRET_KEY` et
   `SASPAY_WEBHOOK_SECRET` existants appartiennent au produit immobilier et ne
   sont **jamais lus** par VYORA. Installer `VYORA_SASPAY_SECRET_KEY` (VYORA
   n'a besoin d'aucun droit de décaissement : un scope `PAYIN` devrait suffire —
   à confirmer en recette pour la lecture des transactions et des soldes). Sans ce
   secret, tout paiement répond « service non configuré ».
2. **Appliquer les deux migrations, dans l'ordre** :
   `20261113100000_vyora_saspay_payments.sql` puis
   `20261113110000_vyora_saspay_refunds_reconcile.sql`. La seconde crée le jeton
   dans Vault et la tâche pg_cron ; tant qu'aucune commande SasPay n'existe, la
   tâche ne fait aucun appel sortant.
3. **Déployer les trois Edge Functions.** Elles importent `../_shared/saspay/*.ts` :
   le déploiement doit envoyer ces fichiers avec chaque fonction (CLI Supabase, ou
   bundle). `vyora-payments` : `verify_jwt = true` ; `vyora-saspay-webhook` et
   `vyora-payments-reconcile` : `verify_jwt = false`. L'adresse de
   `vyora-payments-reconcile` est écrite dans la migration (projet
   `xbuuhfwobrafcbgtdgjx`) : à adapter pour un autre projet.
4. **Créer le webhook dans le tableau de bord SasPay**, vers
   `https://<projet>.supabase.co/functions/v1/vyora-saspay-webhook`, événements
   `transaction.success`, `transaction.failed`, `transaction.cancelled`. Copier le
   secret de signature dans le secret Supabase **`VYORA_SASPAY_WEBHOOK_SECRET`**
   (jamais `SASPAY_WEBHOOK_SECRET`, réservé à l'autre produit).
5. **Essayer en mode test** (clé `sk_test_…`, `mode: "test"`) — voir la recette
   ci-dessous — puis activer :

   ```sql
   update saas_ugc.ugc_app_settings
      set setting_value = setting_value || '{"enabled": true}'
    where setting_key = 'saspay_payment_config';
   ```

6. **Passer en production** : installer la clé `sk_live_…` et passer `mode` à
   `"live"`. Tant que la clé et le mode ne concordent pas, tout paiement est refusé.
7. **Business Grow** (facultatif, indépendant) : fixer un prix et un quota sur une
   formule, l'activer, puis :

   ```sql
   update saas_business.commercial_config
      set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}'
    where config_key = 'pricing';
   ```

   Aucune formule n'a de prix aujourd'hui : la souscription reste indisponible.

### Recette en mode test (clé `sk_test_…`)

À dérouler une fois avant toute activation en production. Chaque ligne vérifie
une hypothèse que les tests locaux n'ont pu que simuler.

| # | Geste | Attendu | Hypothèse vérifiée |
| --- | --- | --- | --- |
| 1 | Acheter le pack Creator en Mobile Money, valider sur le téléphone | Crédits ajoutés en moins d'une minute ; commande « Confirmé » | Forme des réponses `softpay` et `verify` ; webhook signé reçu |
| 2 | Dans le tableau de bord SasPay, ouvrir la transaction | Le libellé contient `VYS-…` | Le libellé est conservé (condition du balayage) |
| 3 | Désactiver le webhook chez SasPay, refaire un achat, ne pas rouvrir la page | Crédits ajoutés sous ~5 min ; une exécution « Réussie » dans Admin → SasPay | Tâche planifiée, jeton Vault, Edge Function de réconciliation |
| 4 | Payer par la page hébergée, fermer l'onglet avant le retour | Idem | État de session → transaction |
| 5 | Refuser le paiement sur le téléphone | Commande « Échoué », aucun crédit | Statut `FAILED` |
| 6 | Dans le tableau de bord SasPay, « renvoyer » la livraison du webhook de l'achat n° 1 | Aucun second crédit | Idempotence face à un rejeu réel |
| 7 | Admin → SasPay → « Rembourser » l'achat n° 1 (crédits intacts) | Crédits retirés ; « Remboursement en cours » côté client | Reprise des crédits |
| 8 | « Attester le versement » avec une référence | « Remboursé » | Attestation |
| 9 | `select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'vyora-payments-reconcile') order by start_time desc limit 5;` | Statut `succeeded` toutes les 5 min | pg_cron tourne |

Si la ligne 2 échoue (libellé absent ou tronqué), le balayage ne retrouvera pas
les paiements dont la réponse de création s'est perdue ; la revérification
ciblée (ligne 3) reste, elle, indépendante du libellé.

Origine supplémentaire (domaine personnalisé) : secret
`VYORA_PAYMENTS_ALLOWED_ORIGINS`, origines exactes séparées par des virgules.

Pour couper : remettre `enabled` à `false`. Les commandes en cours restent
réglables par webhook, vérification ou réconciliation ; aucune nouvelle commande
n'est créée. Pour suspendre la tâche planifiée :
`select cron.unschedule('vyora-payments-reconcile');` (la migration, rejouée, la
recrée).

## 6. Limites connues

- **Aucun essai avec SasPay réel.** Les tests utilisent un faux SasPay construit
  d'après la documentation publique (OpenAPI). Les formes exactes des réponses,
  le domaine des pages de paiement et le comportement des réseaux exigeant un
  code préalable restent à confirmer avec une clé de test.
- **Sessions hébergées sans idempotence côté SasPay.** Deux créations simultanées
  peuvent ouvrir deux sessions ; une seule est rattachée et remise au client.
- **Remboursements : l'argent n'est pas déplacé par VYORA.** SasPay n'offre ni
  route ni webhook de remboursement. Un versement fait directement chez SasPay
  sans passer par l'administration VYORA ne retire donc aucun crédit ; à
  l'inverse, VYORA ne peut pas vérifier qu'un versement attesté a bien eu lieu.
- **Remboursement Business Grow** : calculé sur la *dernière* période payée de
  l'abonnement, au prorata des jours. Les unités déjà consommées pendant la
  période ne sont pas décomptées du montant.
- **Balayage** : repose sur la présence de la référence interne dans le libellé
  renvoyé par `GET /transactions/` — décrit par la documentation SasPay, jamais
  observé en réel. Il lit au plus 300 transactions par passage (signalé dans le
  journal si la limite est atteinte).
- **Renouvellement Business Grow** : manuel. À l'échéance, l'abonnement expire
  (tâche planifiée, une heure de tolérance) et le quota revient à la valeur par
  défaut. Le changement de formule en cours de période est refusé.
- **Commandes abandonnées** : closes par la tâche planifiée (jamais parvenues à
  SasPay : après expiration ; inconnues de SasPay : après 24 h). Une commande
  réellement en attente chez SasPay reste ouverte et revérifiée 30 jours.
- **Tâche planifiée** : dépend de `pg_cron`, `pg_net` et Vault (présents en
  production). Si la tâche est absente ou désactivée, l'administration l'affiche
  en rouge ; le rattrapage ne se fait alors plus qu'à la consultation.
- **Unités** : `ugc_recharge_orders.amount_minor` est en centimes alors que
  d'autres fonctions Studio manipulent des FCFA entiers. La migration convertit
  explicitement (`amount_minor = prix × 100`) sans corriger l'existant.
- **Banc local** : repose sur une copie partielle du schéma de production
  (`prod_subset.sql`), à rafraîchir si la production évolue.
