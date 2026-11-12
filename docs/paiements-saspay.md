# Paiements SasPay — VYORA Studio et Business Grow

État : **livré dans le dépôt, non déployé, désactivé par défaut.** Aucun appel
réel à SasPay n'a été effectué et rien n'a été appliqué à la base de production.

## 1. Ce que fait l'intégration

- **Encaissement uniquement.** Le code n'appelle que six routes SasPay : tarifs
  du compte, paiement Mobile Money (`softpay`), session de paiement hébergée,
  état d'une session, vérification d'un paiement, soldes marchands (lecture).
  Aucun décaissement, transfert ni recharge de portefeuille n'existe dans le code.
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

## 4. Fichiers

| Fichier | Rôle |
| --- | --- |
| `supabase/migrations/20261113100000_vyora_saspay_payments.sql` | Migration additive et idempotente |
| `supabase/functions/_shared/saspay/*.ts` | Montants exacts, client SasPay, signature, service de paiement, accès base, HTTP |
| `supabase/functions/vyora-payments/` | Appelée par le navigateur (JWT exigé) : `options`, `create`, `status`, `balances` |
| `supabase/functions/vyora-saspay-webhook/` | Appelée par SasPay (signature exigée) |
| `src/lib/payments.ts`, `src/components/PaymentDialog.tsx` | Fenêtre de paiement commune |
| `src/pages/PaymentReturn.tsx` | `/app/paiement/retour` — suivi après la page hébergée |
| `src/pages/admin/SasPayPanel.tsx` | Admin : soldes et paiements, lecture seule |
| `supabase/tests/saspay/` | Banc PostgreSQL local (voir son `README.md`) |
| `tests/saspay-*.test.ts(x)` | Tests unitaires et d'interface |

## 5. Mise en service (à faire par un humain, dans cet ordre)

Rien de ce qui suit n'a été fait.

1. **Décider du compte SasPay.** Les secrets `SASPAY_SECRET_KEY` et
   `SASPAY_WEBHOOK_SECRET` existants appartiennent au produit immobilier. Le code
   lit `VYORA_SASPAY_SECRET_KEY`, puis à défaut `SASPAY_SECRET_KEY`. Pour un
   compte ou une clé dédiés à VYORA, créer `VYORA_SASPAY_SECRET_KEY`.
2. **Appliquer la migration** `20261113100000_vyora_saspay_payments.sql`.
3. **Déployer les deux Edge Functions.** Elles importent `../_shared/saspay/*.ts` :
   le déploiement doit envoyer ces fichiers avec chaque fonction (CLI Supabase, ou
   bundle). `vyora-payments` : `verify_jwt = true` ; `vyora-saspay-webhook` :
   `verify_jwt = false`.
4. **Créer le webhook dans le tableau de bord SasPay**, vers
   `https://<projet>.supabase.co/functions/v1/vyora-saspay-webhook`, événements
   `transaction.success`, `transaction.failed`, `transaction.cancelled`. Copier le
   secret de signature dans le secret Supabase **`VYORA_SASPAY_WEBHOOK_SECRET`**
   (jamais `SASPAY_WEBHOOK_SECRET`, réservé à l'autre produit).
5. **Essayer en mode test** (clé `sk_test_…`, `mode: "test"`) puis activer :

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

Origine supplémentaire (domaine personnalisé) : secret
`VYORA_PAYMENTS_ALLOWED_ORIGINS`, origines exactes séparées par des virgules.

Pour couper : remettre `enabled` à `false`. Les commandes en cours restent
réglables par webhook ou vérification ; aucune nouvelle commande n'est créée.

## 6. Limites connues

- **Aucun essai avec SasPay réel.** Les tests utilisent un faux SasPay construit
  d'après la documentation publique (OpenAPI). Les formes exactes des réponses,
  le domaine des pages de paiement et le comportement des réseaux exigeant un
  code préalable restent à confirmer avec une clé de test.
- **Sessions hébergées sans idempotence côté SasPay.** Deux créations simultanées
  peuvent ouvrir deux sessions ; une seule est rattachée et remise au client.
- **Remboursements** : non gérés. Un remboursement fait chez SasPay ne retire pas
  les crédits.
- **Renouvellement Business Grow** : manuel. Le changement de formule en cours de
  période est refusé.
- **Commandes abandonnées** : elles restent « à effectuer » ou « en attente » ;
  aucune tâche planifiée ne les clôt ni ne rattrape un webhook perdu. Le rattrapage
  se fait à la consultation (client ou bouton « Revérifier » de l'administration).
  Elles ne bloquent pas l'utilisateur : le plafond de 3 commandes ouvertes ne
  compte que les 30 dernières minutes.
- **Unités** : `ugc_recharge_orders.amount_minor` est en centimes alors que
  d'autres fonctions Studio manipulent des FCFA entiers. La migration convertit
  explicitement (`amount_minor = prix × 100`) sans corriger l'existant.
- **Banc local** : repose sur une copie partielle du schéma de production
  (`prod_subset.sql`), à rafraîchir si la production évolue.
