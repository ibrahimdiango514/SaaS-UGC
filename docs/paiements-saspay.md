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

**Webhooks rejoués.** Un événement déjà traité est acquitté sans effet
(`duplicate`). Un événement n'est marqué « traité » que si la vérification a
abouti à une issue : si le webhook devance l'état de SasPay (vérification encore
`PENDING`), il reste **rejouable** — sa relance, ou un renvoi manuel depuis le
tableau de bord SasPay, revérifie au lieu d'être écartée. Si SasPay est
injoignable pendant la vérification, le webhook répond 503 pour être retenté.

### Business Grow : une formule à la fois

Un utilisateur n'a qu'un abonnement courant. Les règles sont tenues en base, sous
un verrou par utilisateur partagé par la création de commande et le règlement :

- **Même formule** payée de nouveau : la période est prolongée de 30 jours
  (30 × 24 h exactes, indépendamment du fuseau et des changements d'heure).
- **Autre formule pendant une période en cours** : refusée à la création (409).
- **Autre formule alors qu'un paiement est déjà en cours** (deux onglets) :
  refusée à la création (`BUSINESS_OTHER_PLAN_PAYMENT_IN_PROGRESS`) tant que la
  première commande n'est ni aboutie, ni échouée, ni expirée.
- **Encaissement devenu inapplicable** (paiement tardif d'une ancienne commande
  alors qu'une autre formule a été activée entre-temps, ou abonnement repris par
  un autre prestataire) : **rien n'est livré**, la formule en cours n'est ni
  remplacée ni raccourcie. La commande passe à l'état « Reçu, non appliqué »
  (définitif), le client lit que son paiement a été reçu et sera remboursé, et
  une anomalie `subscription_conflict` alerte l'administrateur. Seule issue : le
  remboursement intégral (voir « Remboursements »).

### Réconciliation planifiée (filet de sécurité)

Un webhook peut se perdre, un client peut fermer sa page. Une tâche pg_cron
(`vyora-payments-reconcile`, toutes les 5 minutes) appelle
`public.vyora_payments_reconcile_dispatch()` :

1. **Entretien SQL, sans réseau** : clôt les commandes pour lesquelles **aucune
   demande n'est jamais partie** vers SasPay (expirées depuis 15 min) ; fait
   passer en rapprochement manuel les demandes Mobile Money restées sans
   réponse (voir § 2 ter — elles ne sont **jamais** closes d'office) ; fait expirer les abonnements Business Grow échus
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
     72 dernières heures (`GET /transactions/`, 5 pages de 200 au plus) et
     retrouve la commande par sa référence interne (`VYS-…`/`VYB-…`), que VYORA
     place dans le libellé de chaque paiement. C'est l'un des moyens de rattraper
     une réponse de création perdue (§ 2 ter). **Ce filet dépend d'un champ que la spécification SasPay
     ne garantit pas** (`description` n'apparaît que dans un exemple de réponse) :
     si la liste arrive sans libellé, ou si elle dépasse 1 000 lignes, le passage
     est marqué « partiel », une anomalie `sweep_unreliable` est levée et
     l'administration l'affiche — le filet ne se déclare jamais sain à tort ;
   - pour chaque demande Mobile Money restée sans réponse, **cherche chez SasPay
     par le numéro du payeur** (`GET /transactions/?search=…`, lecture seule) —
     voir § 2 ter.

Une seule exécution peut être « en cours » à la fois (index unique en base).

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
| `subscription_conflict` | Paiement Business Grow encaissé mais inapplicable à l'abonnement en cours | Ne livre rien ; à rembourser intégralement (l'anomalie se classe à l'attestation du versement) |
| `sweep_unreliable` | Liste SasPay sans libellé, ou tronquée | Passage « partiel » ; les commandes rattachées restent revérifiées une à une |
| `initiation_unconfirmed` | Demande Mobile Money partie, jamais de réponse, fenêtre de rejeu dépassée | Ne livre rien, ne clôt rien, bloque tout autre paiement du client ; **ne se classe pas** : à trancher (§ 2 ter) |

## 2 ter. Demande Mobile Money restée sans réponse

**Le cas.** VYORA envoie `POST /payments/softpay/` ; SasPay crée peut-être le
paiement et sollicite le téléphone du client, mais la réponse n'arrive jamais
(délai dépassé, coupure, 5xx, 409, réponse illisible, identifiant impossible à
enregistrer). VYORA n'a alors **aucun identifiant de transaction**, et le client
a peut-être été débité.

**Ce que SasPay permet, d'après sa documentation** (relue en novembre 2026 ;
aucun essai réel) :

- le **seul** moyen garanti de retrouver ce paiement est de **renvoyer la même
  requête avec la même `Idempotency-Key`** : SasPay renvoie alors le paiement
  déjà créé. La durée de conservation de la clé n'est pas documentée ; un corps
  différent sous la même clé est refusé (409) ; et si la première requête n'a
  jamais atteint SasPay, ce rejeu **crée** le paiement ;
- il n'existe **aucune recherche par référence marchande** : ni `search`, ni les
  filtres de `GET /transactions/` ne portent sur le libellé ou les métadonnées ;
- le webhook `transaction.success` porte l'identifiant, le montant et le numéro,
  pas notre référence ; `GET /payments/{id}/verify/` *peut* restituer le libellé
  ou les métadonnées (présents dans un exemple, dans aucun schéma).

**Ce que fait VYORA.**

| Moment | Comportement |
| --- | --- |
| Avant l'envoi | La tentative est enregistrée en base **avec le corps exact** de la requête (`vyora_payment_initiations`). La clé d'idempotence SasPay est la référence interne de la commande. |
| Pas de réponse | **Un** rejeu immédiat (2 s plus tard), à l'identique. S'il reste sans réponse : la commande passe « **en vérification** » — ni payée, ni échouée. Réponse HTTP 200, `next: "review"`, message « Ne payez pas une seconde fois ». |
| Refus certain (400, 404, 422, 429 ; 401/403 s'il n'y a pas eu de tentative incertaine avant) | Aucun paiement n'existe : commande « échouée », le client peut recommencer. |
| Tant que l'issue est inconnue | **Tout nouveau paiement du même utilisateur est refusé** (409 `PAYMENT_UNDER_REVIEW`), Studio et Business Grow confondus, Mobile Money comme page hébergée. Tenu par la base (trigger), pas seulement par le service. |
| Le client relance | La **même** demande repart (même clé, corps d'origine — même s'il a changé de numéro à l'écran), au plus **4 envois** sur **10 minutes**. Deux clics simultanés n'envoient qu'une requête. |
| Fenêtre dépassée | Plus aucun envoi. La commande passe en **rapprochement manuel** : alerte `initiation_unconfirmed`, notification aux administrateurs, message au client. Elle n'expire pas. |
| Le client ne revient jamais | Trois voies, toutes sans son concours : (1) le **webhook** de la transaction inconnue — VYORA la relit chez SasPay et ne la rattache que si SasPay restitue **notre** référence ; (2) le **balayage** des encaissements (même condition) ; (3) la **recherche par numéro** — qui ne fait que proposer. |
| Transaction qui ressemble (même montant, même devise, bonne période) sans référence restituée | **Jamais rattachée automatiquement.** Consignée comme « candidate » (origine, « même numéro » ou non) pour l'administrateur. Rien n'est livré. |

**Décision de l'administrateur** (Admin → SasPay → « Paiements sans réponse ») :

- **Rattacher un paiement** : il saisit l'identifiant de la transaction SasPay
  (ou choisit une candidate) et une note. Le serveur relit la transaction chez
  SasPay et refuse tout écart (montant, devise, sens, transaction antérieure à
  la commande ou créée plus d'une heure après notre dernier envoi, référence
  d'une autre commande,
  transaction déjà rattachée). L'achat n'est livré que si SasPay la déclare
  `SUCCESS`, par le règlement idempotent habituel.
- **Aucun encaissement** : possible seulement en rapprochement manuel, avec une
  attestation cochée et une note. La commande est annulée et le client peut
  repayer. Si SasPay confirme plus tard un encaissement pour cette commande, elle
  est **rouverte et livrée**.

Les deux décisions sont tracées dans le journal d'audit. L'alerte ne peut pas
être « classée » à la main tant que la commande n'est pas tranchée.

**Côté navigateur.** Si c'est la réponse de *notre* serveur qui se perd (coupure
côté client), la fenêtre de paiement n'affiche pas « paiement non lancé » et ne
rend pas le formulaire : elle propose seulement de relancer la même demande,
avec la même clé. Fermer puis rouvrir la fenêtre ne l'oublie pas (tant que la
page n'est pas rechargée ; après rechargement, c'est le blocage serveur qui
protège).

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
     comptée au client ; une journée = 24 h exactes, sans effet du fuseau). Si
     l'abonnement est depuis passé à une autre formule, la période payée par
     cette commande est terminée : il n'y a plus rien à reprendre.
   - *Business Grow, paiement « reçu, non appliqué »* : rien n'a été livré, donc
     rien n'est repris. Le remboursement est **intégral et seulement intégral**
     (le montant encaissé), l'abonnement en cours et son quota ne sont pas
     touchés, aucun événement de facturation n'est créé.
2. **Rendre l'argent hors de VYORA** (transfert Mobile Money, décaissement depuis
   le tableau de bord SasPay), puis **attester le versement** avec sa référence.
   VYORA ne vérifie pas ce versement : la référence saisie fait foi.

Entre les deux, la commande apparaît « Remboursement en cours » (client comme
administrateur) et un rappel « remboursement(s) à verser » reste affiché. Un
client Studio reçoit une notification au versement ; un client Business Grow
(qui n'a pas de centre de notifications) le lit dans son historique de
paiements. Le
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
| Une seule réconciliation à la fois | Base (verrou consultatif + index unique sur l'exécution « en cours ») |
| Business Grow : jamais deux formules, jamais une formule en cours écrasée par un paiement tardif | Base (verrou par utilisateur à la création et au règlement ; contrôle refait au règlement) |
| Encaissement non applicable : jamais livré plus tard, jamais clos en silence, remboursable une seule fois et intégralement | Base (trigger `subscription_conflict_is_final`, `vyora_admin_refund_business`) + anomalie |
| Deux règlements simultanés du même utilisateur n'échouent jamais sur une date d'événement | Base (événement daté après les verrous, jamais avant le dernier état de l'abonnement) |
| Le filet de réconciliation ne se déclare pas sain s'il est aveugle ou tronqué | Edge (`sweep_unreliable`, exécution « partielle ») + administration |
| Un webhook arrivé trop tôt reste rejouable | Edge (événement non marqué « traité » tant que SasPay ne confirme pas) |
| La clé SasPay n'est jamais envoyée ailleurs qu'à SasPay | Edge (curseur de pagination restreint à l'API configurée) |
| Clé SasPay propre à VYORA | Edge (`VYORA_SASPAY_SECRET_KEY` seule ; aucun repli sur `SASPAY_SECRET_KEY`) |
| Demande sans réponse : jamais close « non payée » par un automate, jamais « payée » sans `verify` `SUCCESS` | Base (`housekeeping`, `vyora_payment_open_review`) + Edge (règlement inchangé) |
| Demande sans réponse : aucun second paiement du même client | Base (trigger `vyora_payment_block_unconfirmed`, `begin_initiation` sous verrou par utilisateur) |
| Rejeu à l'identique seulement (même clé, corps enregistré), borné dans le temps | Base (`vyora_payment_begin_initiation`) + Edge |
| Une transaction ressemblante n'est jamais rattachée sans preuve ou décision humaine | Edge (`matchUnconfirmed`, `searchUnconfirmed`, `resolveReview`) |

## 4. Fichiers

| Fichier | Rôle |
| --- | --- |
| `supabase/migrations/20261113100000_vyora_saspay_payments.sql` | Migration additive et idempotente |
| `supabase/migrations/20261113110000_vyora_saspay_refunds_reconcile.sql` | Remboursements, réconciliation, anomalies, tâche planifiée (additive, idempotente) |
| `supabase/functions/vyora-payments-reconcile/` | Appelée par pg_cron uniquement (jeton Vault) |
| `supabase/migrations/20261113120000_vyora_pricing_margin.sql` | Prix tout compris : politique de provision, barème des frais, devis figés, rapprochement, rapport financier (additive, idempotente) — voir § 9 |
| `supabase/functions/_shared/saspay/pricing.ts` | Moteur de calcul du prix (miroir exact de la base, qui fait foi) |
| `src/pages/admin/SasPayFinance.tsx` | Admin : politique de prix, barème, simulateur, chiffre d'affaires / frais / marge |
| `src/pages/admin/SasPayOperations.tsx` | Admin : remboursement, attestation, surveillance, anomalies |
| `supabase/functions/_shared/saspay/*.ts` | Montants exacts, client SasPay, signature, service de paiement, accès base, HTTP |
| `supabase/functions/vyora-payments/` | Appelée par le navigateur (JWT exigé) : `options`, `create`, `status`, `balances`, `resolve_review`, `sync_rates` (administrateur) |
| `supabase/functions/vyora-saspay-webhook/` | Appelée par SasPay (signature exigée) |
| `src/lib/payments.ts`, `src/components/PaymentDialog.tsx` | Fenêtre de paiement commune |
| `src/pages/PaymentReturn.tsx` | `/app/paiement/retour` — suivi après la page hébergée |
| `src/pages/admin/SasPayPanel.tsx` | Admin : soldes (lecture seule) et paiements |
| `supabase/tests/saspay/` | Banc PostgreSQL local (voir son `README.md`) ; `audit.mjs` = audit de concurrence avant mise en production ; `unconfirmed.mjs` = demandes sans réponse |
| `tests/saspay-unconfirmed.test.ts` | Demandes sans réponse : service, webhook, tâche planifiée, décision de l'administrateur |
| `tests/saspay-*.test.ts(x)` | Tests unitaires et d'interface |

## 5. Mise en service (à faire par un humain, dans cet ordre)

Rien de ce qui suit n'a été fait.

1. **Créer la clé SasPay de VYORA.** Les secrets `SASPAY_SECRET_KEY` et
   `SASPAY_WEBHOOK_SECRET` existants appartiennent au produit immobilier et ne
   sont **jamais lus** par VYORA. Installer `VYORA_SASPAY_SECRET_KEY` (VYORA
   n'a besoin d'aucun droit de décaissement : un scope `PAYIN` devrait suffire —
   à confirmer en recette pour la lecture des transactions et des soldes). Sans ce
   secret, tout paiement répond « service non configuré ».
2. **Appliquer les migrations, dans l'ordre** :
   `20261113100000_vyora_saspay_payments.sql`,
   `20261113110000_vyora_saspay_refunds_reconcile.sql`, puis
   `20261113120000_vyora_pricing_margin.sql` (prix tout compris, § 9). La seconde crée le jeton
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
| 10 | Après les achats précédents, attendre un quart d'heure puis ouvrir Admin → SasPay | Aucune alerte « Rattrapage des paiements incomplet », aucune anomalie `sweep_unreliable` ; aucune alerte « sans jeton » ni « Appel HTTP indisponible » | **`GET /transactions/` renvoie bien le libellé** ; scope de la clé suffisant pour lister ; Vault et pg_net en place |
| 11 | Business Grow (si activé) : ouvrir deux onglets, lancer le paiement de deux formules différentes | Le second est refusé avec un message clair ; un seul paiement créé chez SasPay | Verrou par utilisateur |
| 12 | Business Grow : payer deux fois la même formule | Fin de période repoussée de 60 jours au total | Prolongation |
| 13 | Ouvrir la transaction de l'achat n° 1 avec `GET /payments/{id}/verify/` (ou regarder le journal de la fonction) | La réponse contient `description` (`VYS-…`) ou `metadata.internal_reference` | **`verify` restitue notre référence** : condition du rattachement automatique par webhook (§ 2 ter) |
| 14 | Appeler deux fois `POST /payments/softpay/` avec la même `Idempotency-Key` et le même corps, à 5 min d'intervalle | Même `id` de transaction, une seule demande sur le téléphone | Idempotence réelle de SasPay et durée de conservation au moins égale à la fenêtre de rejeu (10 min) |
| 15 | `GET /transactions/?search=<numéro du payeur>` avec la clé de VYORA | La transaction de l'achat n° 1 est listée | Scope de la clé suffisant et recherche par numéro effective (sinon : aucune candidate par recherche, seules restent celles du webhook) |

**Si la ligne 10 affiche « Rattrapage des paiements incomplet », ou si la
ligne 13 échoue** : aucun rattachement automatique n'est possible pour un
paiement Mobile Money dont la réponse de création se perd et que le client
valide sans jamais relancer l'achat. Ce cas n'est plus sans filet — la commande
reste « en vérification », bloque tout autre paiement et attend la décision d'un
administrateur (§ 2 ter) — mais **chaque occurrence demandera une intervention
humaine**. À décider avant la production : accepter cette charge, ou n'ouvrir
que la page hébergée (qui n'a pas ce risque : sans réponse, le client ne reçoit
jamais le lien de paiement).

Si la ligne 2 échoue (libellé absent ou tronqué), même conséquence ; la
revérification ciblée (ligne 3) reste, elle, indépendante du libellé.

Si la ligne 14 échoue (deux transactions créées), **ne pas activer le Mobile
Money direct** : le rejeu à l'identique, sur lequel repose toute la reprise,
provoquerait lui-même un double débit.

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
  renvoyé par `GET /transactions/`. Ce champ figure dans l'exemple de la
  documentation SasPay mais **dans aucun schéma** ; la recherche (`search`) ne
  porte ni sur le libellé ni sur les métadonnées, et les webhooks ne portent ni
  l'un ni l'autre : il n'existe pas d'autre moyen documenté de retrouver un
  paiement sans son identifiant. Le balayage lit au plus 1 000 transactions par
  passage (5 × 200) sur 72 h, sans reprise au-delà. Dans les deux cas (libellé
  absent, limite atteinte) le passage est « partiel » et signalé — voir la
  ligne 10 de la recette.
- **Demande Mobile Money sans réponse** (§ 2 ter) : rien, dans la documentation
  SasPay, ne permet de retrouver *à coup sûr* un paiement sans son identifiant.
  Le rejeu à l'identique n'est garanti que tant que SasPay conserve la clé
  d'idempotence (durée non documentée) ; au-delà de 10 minutes VYORA n'en envoie
  plus, pour ne pas risquer de créer un paiement que le client n'attend plus.
  Le rattachement automatique dépend de champs que SasPay ne garantit pas
  (`description`, `metadata`). Quand ils manquent, la commande attend une
  décision humaine, et le client reste bloqué jusque-là : c'est voulu (un second
  paiement serait pire), mais cela suppose qu'un administrateur consulte les
  alertes. Aucun délai n'est imposé à cette décision.
- **Webhook d'une transaction inconnue** : il est comparé aux 200 tentatives non
  soldées les plus récentes (appel encore en vol compris). Au-delà — situation
  qui supposerait une panne SasPay prolongée — les plus anciennes ne seraient
  retrouvées que par le balayage, la recherche ou l'administrateur. Chaque
  webhook inconnu coûte alors une lecture `verify` chez SasPay, y compris ceux
  d'un autre produit partageant le compte marchand.
- **Rattachement par l'administrateur** : VYORA contrôle montant, devise, sens,
  période et absence d'autre référence, mais ne peut pas prouver que la
  transaction choisie est bien celle *de ce client* si SasPay ne restitue ni
  libellé ni numéro. Deux clients payant le même montant au même moment se
  distinguent par le numéro du payeur, à vérifier dans le tableau de bord SasPay.
- **Clôture « aucun encaissement »** : repose sur l'attestation de
  l'administrateur. S'il se trompe, le client peut payer une seconde fois ; le
  premier encaissement, s'il est confirmé plus tard, rouvre et livre la première
  commande (le client aurait alors deux achats, dont un à rembourser).
- **Réponse perdue entre notre serveur et le navigateur** : couverte tant que la
  page n'est pas rechargée. Si le paiement a bien été créé et rattaché côté
  serveur, il suit le parcours normal (webhook, tâche planifiée) ; le client qui
  recharge la page puis repaye un *autre* article n'est pas bloqué, comme pour
  tout paiement en attente ordinaire.
- **Page hébergée, webhook sans commande connue** : la transaction d'une session
  hébergée n'est connue qu'après paiement ; le webhook la cherche parmi les 10
  sessions ouvertes les plus récentes. Au-delà, il est ignoré et c'est la tâche
  planifiée qui livre (sous ~5 min) en interrogeant l'état de la session.
- **Quota d'appels SasPay** : 300 requêtes par minute **par compte marchand**. Si
  la clé de VYORA appartient au même compte que le produit immobilier, le quota
  est partagé. Un passage de réconciliation vérifie 20 commandes au plus (une
  ou deux lectures chacune) et lit 5 pages de liste : quelques dizaines d'appels,
  toutes les 5 minutes au plus, et aucun s'il n'y a rien à vérifier.
- **Studio : crédits fongibles.** Le portefeuille ne sait pas de quel achat
  vient un crédit. Rembourser un achat reprend des crédits *disponibles* à
  hauteur de cet achat, quels que soient les achats dont ils proviennent ; le
  plafond de remboursement suit ce qui est effectivement repris.
- **Montant différent encaissé** (`amount_mismatch`) : rien n'est livré et
  l'anomalie est levée, mais le montant à rendre n'étant pas celui de la
  commande, ce cas ne passe pas par l'écran de remboursement : il se traite chez
  SasPay puis se classe à la main, avec une note.
- **Renouvellement Business Grow** : manuel. À l'échéance, l'abonnement expire
  (tâche planifiée, une heure de tolérance) et le quota revient à la valeur par
  défaut. Le changement de formule en cours de période est refusé.
- **Commandes abandonnées** : closes par la tâche planifiée (aucune demande
  jamais envoyée à SasPay : après expiration ; inconnues de SasPay : après 24 h).
  Une demande envoyée et restée sans réponse n'est jamais close d'office. Une commande
  réellement en attente chez SasPay reste ouverte et revérifiée 30 jours.
- **Tâche planifiée** : dépend de `pg_cron`, `pg_net` et Vault (présents en
  production). Si la tâche est absente ou désactivée, l'administration l'affiche
  en rouge ; le rattrapage ne se fait alors plus qu'à la consultation.
- **Unités** : `ugc_recharge_orders.amount_minor` (Studio) est en centimes alors
  que `saas_business.payment_orders.amount_minor` (Business Grow) est en FCFA
  entiers, comme le catalogue de chaque produit. La migration convertit
  explicitement côté Studio (`amount_minor = prix × 100`) sans corriger
  l'existant ; les deux colonnes ne doivent jamais être additionnées.
- **Banc local** : repose sur une copie partielle du schéma de production
  (`prod_subset.sql`), à rafraîchir si la production évolue.

## 7. Audit avant mise en production (novembre 2026)

Audit mené sur PostgreSQL 17 réel avec des connexions réellement simultanées
(`supabase/tests/saspay/audit.mjs`), les vraies Edge Functions (`e2e.mjs`) et la
spécification publique de SasPay. **Aucun essai SasPay réel, rien de déployé.**

Défauts trouvés et corrigés :

| Défaut | Conséquence avant correction | Correction |
| --- | --- | --- |
| Business Grow : deux formules payées en même temps sans abonnement préalable | Le second règlement échouait sur une contrainte d'unicité brute : paiement encaissé, commande sans issue | Verrou par utilisateur au règlement ; refus de la seconde commande à la création |
| Business Grow : paiement tardif d'une autre formule | La formule en cours était remplacée et sa période écrasée | Contrôle refait au règlement ; état « reçu, non appliqué », anomalie, remboursement intégral |
| Business Grow : deux règlements simultanés de la même formule | Échec intermittent « stale or mismatched subscription event » | Événement daté après la prise des verrous |
| Encaissement non applicable sans issue | Commande « en cours » indéfiniment, re-signalée sans pouvoir être close | Remboursement intégral dédié ; anomalie classée à l'attestation |
| Webhook `transaction.success` arrivé avant la confirmation de SasPay | Marqué « traité » : ses relances étaient écartées comme doublons (livraison retardée jusqu'à la tâche planifiée) | L'événement reste rejouable tant que la vérification n'a pas abouti |
| Balayage muet si la liste SasPay n'a pas de libellé, ou tronquée à 300 lignes | Le filet pouvait ne rien rattraper tout en s'affichant « réussi » | Lecture portée à 1 000 lignes ; passage « partiel », anomalie et alerte dans l'administration |
| Deux réconciliations simultanées | Possibles en théorie (verrou consultatif seul) | Index unique sur l'exécution « en cours » |
| Durées d'abonnement en « jours » de calendrier | Sensibles au fuseau de la session lors d'un changement d'heure | Durées en secondes (30 × 86 400) |
| Prérequis de la tâche planifiée invisibles | Tâche « active » même sans jeton ni extension HTTP | Affichés dans la vue d'exploitation |

Points vérifiés sans défaut : crédit Studio unique sous rafales (webhooks rejoués
+ vérifications simultanées), remboursement Studio concurrent d'une dépense
(solde jamais négatif, grand livre équilibré), attestation unique, cloisonnement
Studio / Business Grow (même utilisateur, même clé d'intention), pannes réseau
(réponse de création perdue, SasPay injoignable pendant un webhook).

## 8. Demande de paiement dont la réponse se perd (novembre 2026)

Mission menée après l'audit, sur la question laissée ouverte par la ligne 10 de
la recette. **Aucun essai SasPay réel, rien de déployé, aucune écriture en
production.** Le fonctionnement est décrit au § 2 ter.

Défaut corrigé : une demande Mobile Money sans réponse laissait une commande
« à effectuer », sans trace de l'envoi. L'entretien la fermait « non payée » au
bout de 15 minutes après expiration ; entre-temps rien n'empêchait le client de
payer une seconde fois avec une autre intention. Le seul rattrapage était le
balayage par libellé, que SasPay ne garantit pas.

Preuves locales : `supabase/tests/saspay/unconfirmed.mjs` (base réelle, dont deux
connexions simultanées), section H de `e2e.mjs` (vraies Edge Functions : client
jamais revenu, SasPay sans libellé, requête jamais reçue, Business Grow),
`tests/saspay-unconfirmed.test.ts`, et les tests d'interface
(`tests/saspay-ui.test.tsx`).

Reste à vérifier avec une clé de test réelle : lignes 13, 14 et 15 de la recette.

## 9. Prix tout compris, frais SasPay et marge (novembre 2026)

**Aucun essai SasPay réel, rien de déployé, aucune écriture en production, aucun
tarif SasPay supposé.** Migration : `20261113120000_vyora_pricing_margin.sql`
(additive, idempotente, à appliquer après les deux précédentes).

### Règle de prix

Le client paie un **prix final unique**. Il ne voit ni prix de base, ni
provision, ni frais, ni net.

```
prix final = plus petit montant P, arrondi au pas de la devise (1 FCFA), tel que
             P ≥ prix de base + provision            (provision : 1 000 FCFA)
        et   P − frais SasPay(P) ≥ prix de base      (seulement si un tarif est confirmé)
```

- Sans tarif confirmé au barème : `P = base + provision` (5 000 → 6 000 FCFA).
- Avec un tarif confirmé qui dépasse la provision, le prix est relevé juste
  assez pour que VYORA reçoive au moins le prix de base (stratégie
  `cover_fees`). La stratégie `provision_only` ne relève jamais le prix.
- Un même prix pour tous les opérateurs d'un pays (le tarif le plus cher fait
  référence) : le prix affiché ne change pas quand le client change d'opérateur.
- Les **crédits Studio et la durée d'abonnement restent calculés sur le prix de
  base** : la provision n'achète rien.
- VYORA demande à SasPay le mode de frais **« déduits »** (`fee_charge_mode:
  "DEDUCTED"`) : le client est débité exactement du prix affiché, SasPay prélève
  ses frais sur ce montant.
- Unités internes : montants en centièmes entiers, taux en millièmes de pour cent
  (2,5 % = 2500). Aucun calcul en virgule flottante, ni en base ni en TypeScript.
- Le devis (base, provision, prix final, frais estimés, tarif utilisé) est
  **figé sur la commande** (`pricing_quote`, immuable). Changer la politique ou le
  barème ne modifie aucune commande existante.

Exemples vérifiés à l'identique en SQL et en TypeScript
(`supabase/tests/saspay/pricing-vectors.json`) :

| Prix de base | Tarif confirmé | Prix final | Frais estimés | Net attendu |
| ---: | --- | ---: | ---: | ---: |
| 5 000 | aucun | 6 000 | inconnus | inconnu |
| 39 000 | 2,5 % | 40 000 | 1 000 | 39 000 |
| 100 000 | 2,5 % | 102 565 | 2 564,13 | 100 000,87 |
| 100 000 | 2 % | 102 041 | 2 040,82 | 100 000,18 |
| 5 000 | 1 500 fixes | 6 500 | 1 500 | 5 000 |
| 100 000 | 2,5 %, `provision_only` | 101 000 | 2 525 | 98 475 (déficit) |

### Barème : rien n'est supposé

La table `saas_ugc.vyora_fee_schedule` est livrée **vide**. La documentation
publique de SasPay ne contient aucune grille tarifaire ; les tarifs réels sont
propres à chaque compte. Deux façons de la remplir, depuis l'administration
(SasPay → « Prix, frais et marge ») :

1. **Importer les tarifs du compte** : lit `GET /pricing/my-rates/` avec la clé
   installée côté serveur (lecture seule, aucun paiement). Rejouable : les lignes
   identiques sont conservées, les lignes disparues sont closes.
2. **Saisir une ligne** d'après un document de SasPay ou du propriétaire ;
   l'origine et sa référence sont obligatoires, un tarif nul doit être confirmé
   explicitement.

Une ligne ne se modifie ni ne se supprime : on la clôt et on en ajoute une. Tant
qu'aucun tarif n'est confirmé pour un pays et un opérateur, les frais estimés
sont « non confirmés » (jamais zéro) et l'administration le signale.

### Rapprochement après paiement

À chaque paiement confirmé, une ligne immuable est écrite dans
`saas_ugc.vyora_payment_reconciliations` : montant débité au client, frais réels
(`débité − net`), net reçu, marge (`net − prix de base`), écart avec les frais
estimés. Les montants viennent de la vérification SasPay
(`GET /payments/{id}/verify/`), jamais du navigateur ni du webhook.

Alertes (une par commande et par genre, visibles dans « Surveillance ») :

| Alerte | Signification | Le client est-il livré ? |
| --- | --- | --- |
| `fee_exceeds_provision` | Frais réels supérieurs à ce que le prix prévoyait pour les absorber (prix final − prix de base) | Oui |
| `net_below_base` | VYORA a reçu moins que le prix de base | Oui |
| `fee_mode_unexpected` | SasPay a ajouté les frais au client au lieu de les déduire : le client a payé plus que le prix affiché | Oui |
| `reconciliation_failed` | La ligne de rapprochement n'a pas pu être écrite | Oui (un échec comptable ne bloque jamais une livraison) |

Un prix relevé au devis pour couvrir un tarif connu n'est **pas** une alerte : les
frais dépassent alors 1 000 FCFA, mais le prix les couvre.

Le tableau « Chiffre d'affaires, frais et marge » agrège ces lignes par pays,
opérateur et produit, avec filtres de période. Les paiements dont SasPay n'a pas
restitué le net sont comptés à part : ils n'entrent ni dans les frais, ni dans le
net, ni dans la marge.

### Mise en service

1. Appliquer la migration `20261113120000_vyora_pricing_margin.sql`. **Dès cet
   instant, la provision de 1 000 FCFA s'applique aux nouvelles commandes** (la
   politique est créée active). Pour l'appliquer plus tard, la désactiver dans
   l'administration juste après la migration.
2. Redéployer `vyora-payments`, `vyora-saspay-webhook` et
   `vyora-payments-reconcile` (elles partagent `_shared/saspay/*.ts`).
3. Dans le tableau de bord SasPay, **Paramètres → Frais** : activer
   « Autoriser le choix du mode de frais par l'API », ou choisir le mode
   « Déduits » par défaut. Sans cela, SasPay ignore silencieusement le mode
   demandé et **ajoute** ses frais au client. VYORA le détecte après coup (alerte
   `fee_mode_unexpected`) mais ne peut pas l'empêcher.
4. Administration → SasPay → « Prix, frais et marge » → « Importer les tarifs du
   compte ».
5. « Reprendre l'historique » si des paiements ont été confirmés avant la
   migration.

### Corrections faites au passage

- **Frais réels en mode « déduits »** : ils étaient calculés « débité − demandé »,
  donc toujours 0 dans ce mode. Ils valent désormais « débité − net ».
- **Taux à trois décimales** : SasPay publie ses taux sous la forme « 2.500 ».
  L'estimation de frais de l'ancien parcours n'acceptait que deux décimales et
  renonçait à estimer. Corrigé (`parsePercentMilli`).

### Limites

- Les tarifs réels du compte ne sont pas connus : aucun appel SasPay n'a été
  fait. Tant que le barème est vide, la marge n'est connue qu'après chaque
  paiement.
- Avec la page de paiement hébergée, l'opérateur n'est connu qu'après le
  paiement : le prix est calculé sur le tarif le plus cher du pays.
- Décaissements (payouts) : seule une **estimation** de frais existe (simulateur),
  sans provision. VYORA n'exécute aucun décaissement.
- Les événements `settlement.*` de SasPay ne sont pas traités : leur contenu n'est
  pas documenté.
- Plusieurs devises : la politique accepte une provision par devise, mais seule
  la devise XOF est paramétrée et proposée dans l'écran.

### Preuves locales

`supabase/tests/saspay/pricing.mjs` (65 vérifications sur PostgreSQL réel),
section « prix tout compris » de `e2e.mjs` (vraies Edge Functions),
`tests/saspay-pricing.test.ts` (moteur de calcul, mêmes vecteurs que la base),
`tests/saspay-pricing-service.test.ts` (parcours de paiement),
`tests/saspay-pricing-ui.test.tsx` (écrans client et administrateur).
