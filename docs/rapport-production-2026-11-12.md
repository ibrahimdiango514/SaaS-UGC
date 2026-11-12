# VYORA Studio — rapport d'état de production

> Établi le **12 novembre 2026**. Branche `arena/323bad30-saas-ugc`, HEAD `055cf24`.
> Projet Supabase : `xbuuhfwobrafcbgtdgjx`.

Ce rapport distingue systématiquement trois niveaux de preuve :

| Niveau | Signification |
| --- | --- |
| **PROD VÉRIFIÉ** | Opération réellement exécutée sur la production, résultat observé |
| **PROD CONFIGURÉ** | Objet déployé en production, contenu contrôlé, mais non exercé de bout en bout |
| **LOCAL** | Vérifié dans le dépôt (tests, typecheck, build) — aucune preuve de production |

---

## 1. `reelora-video` — état réellement déployé

**Version en production : `v15`, statut `ACTIVE`, `verify_jwt = true`.**

Le code métier n'a **pas** été remplacé ni simplifié. Le canal de déploiement
disponible tronque les charges longues (~5 Ko) : la version 43 Ko est stockée en
base (`public._edge_deploy_artifact`, 4 tranches gzip+base64) et la fonction
déployée est un **chargeur court** (`supabase/functions/reelora-video/bootstrap.ts`,
4 487 caractères) qui, à chaque démarrage à froid :

1. relit les 4 tranches ;
2. décompresse (`DecompressionStream("gzip")`) ;
3. vérifie la longueur (**43 519 caractères**) et le **SHA-256**
   (`4d00f46c84719c51eb6d67cc02fb3e74e3ead31b8e44bbd5fd63799a95a40e61`) ;
4. retire l'auto-serve inliné puis importe le module via une URL `data:`
   (aucun `eval`, aucun `new Function`) ;
5. délègue au `handler` **d'origine**.

**Preuves de production :**

| Contrôle | Résultat |
| --- | --- |
| `get_edge_function` | corps complet stocké, `verify_jwt: true`, v15 |
| `net.http_post` sans jeton (id 5021) | `401 UNAUTHENTICATED` « Authentification requise. » — **émis par le handler de l'artefact** |
| `net.http_post` avec jeton `service_role` (id 5022) | `401 UNAUTHENTICATED` « Jeton utilisateur invalide. » — le code est allé jusqu'à la vérification du porteur |
| Intégrité des tranches en base | 4 tranches, 19 040 caractères, SHA-256 base64 `32c47717…0382f5` = empreinte d'origine |

Le premier rejet (503 `ARTIFACT_LOAD_FAILED`) n'apparaît plus : le runtime
déploie, relit, décompresse, valide et exécute le vrai code métier.

**Contrôle fonctionnel authentifié : BLOQUÉ (externe).** L'action `catalog`
exige un **JWT utilisateur réel** (`authUserId(userJwt)` → `/auth/v1/user`). Ce
n'est pas contournable et n'a pas été contourné : aucun outil disponible ne
permet d'émettre un jeton utilisateur sans mot de passe réel. Le handler est donc
prouvé « chargé et exécuté » (401 métier), pas « réponse 200 ».

## 2. Autres Edge Functions

| Fonction | Version | `verify_jwt` | Preuve |
| --- | --- | --- | --- |
| `reelora-video` | **15** | true | PROD VÉRIFIÉ (boot + handler) |
| `video-quote` | 5 | true | PROD CONFIGURÉ (corps complet, calcul serveur, aucun crédit) |
| `vyora-ai` | 4 | true | PROD CONFIGURÉ |
| `business-grow` | 14 | true | PROD CONFIGURÉ |
| `reelora-video-worker` | 8 | false | PROD CONFIGURÉ |
| `reelora-health`, `reelora-ai`, `vyora-provider-health`, `saspay-*`, agences | — | — | inchangées |

`vyora-deploy-probe` (sonde temporaire) a été **supprimée**.

## 3. Migrations réellement appliquées

Nouvelles migrations appliquées en production le 12 novembre 2026 :

| Version | Nom | Effet |
| --- | --- | --- |
| `20261112062028` | `vyora_edge_artifact_store` | Table de tranches du chargeur (restaurée après suppression accidentelle, contenu vérifié) |
| `20261112062614` | `vyora_provider_spend_caps_alerts` | Table d'alertes, politique de budget, acquittement |
| `20261112062625` | `vyora_provider_spend_reserve_per_provider` | Réservation avec verrou global **et** par fournisseur |
| `20261112062634` | `vyora_provider_spend_summary_v2` | Résumé admin : plafonds par fournisseur, état d'alerte, journal |
| `20261112062818` | `vyora_provider_spend_reason_alias` | Motif de refus aligné sur le message client |
| `20261112063245` | `vyora_ledger_account_erasure` | Correctif d'effacement de compte (voir §5) |

Toutes ces migrations sont répliquées dans `supabase/migrations/`.

## 4. Plafond fournisseur — état réel

**Configuration actuelle en production : `{"enabled": false, "max_usd": 0}`.**
Conservée telle quelle : **aucune génération payante n'est possible**, et le
plafond n'a jamais été remplacé par une valeur illimitée.

Ce qui existe et fonctionne (vérifié par exécution SQL transactionnelle annulée) :

- **plafond global** en USD, lu `for update` (deux réservations concurrentes ne
  peuvent pas le franchir ensemble) ;
- **plafond par fournisseur** (`provider_caps_usd`, ex. `{"muapi": 1}`), second
  verrou indépendant, jamais supérieur au plafond global ;
- **refus sans appel payant** : la tentative est journalisée `blocked` avec le
  motif précis (`provider_spend_disabled`, `provider_spend_cap_exceeded`,
  `provider_spend_provider_cap_exceeded`), dépense fournisseur = 0 ;
- **alertes de consommation** : seuil (`alert_percent`), plafond global atteint
  (alerte critique), tentative bloquée — dédupliquées par clé, notifiées aux
  administrateurs via le canal de notifications existant ;
- **arrêt automatique** : dès que le budget engagé atteint le plafond, toute
  nouvelle réservation est refusée ;
- **suivi des dépenses** : estimé / réservé / réel distincts, historiques par
  fournisseur et par génération dans la console admin ;
- **protection double facturation** : `generation_job_id` unique, clés
  d'idempotence du portefeuille, statut `unknown` conservé engagé par prudence.

Exercices réalisés en production (transaction annulée, aucune ligne conservée) :

| Cas | Résultat observé |
| --- | --- |
| Plafond 10 USD + plafond muapi 0,30, coût 0,10 puis 0,50 | 1re réservée, 2e **bloquée** `provider_spend_provider_cap_exceeded`, alerte `blocked_attempt` |
| Plafond global 0,10, coût 0,10 ×2 | 1re réservée, 2e **bloquée**, alerte `cap_reached` critique |
| Seuil 1 % franchi | alerte `threshold` (une seule fois) |
| Configuration réelle (0 USD, désarmée) | refus `provider_spend_disabled`, 0 écriture persistante |

### Budget à confirmer par vous

Aucun montant n'a été inventé. Le plafond restera à **0 USD** (donc toutes les
générations payantes refusées) jusqu'à votre autorisation explicite.

Pour activer, il faut **deux valeurs** :

1. **le plafond global en USD** (ex. un montant que vous acceptez de perdre) ;
2. **le plafond MuAPI en USD**, ≤ au plafond global (ou vide = plafond global seul).

Et une valeur de confort : le **seuil d'alerte en %** (défaut 80).

Repère de coût : les tarifs catalogue relevés vont d'environ 0,10 USD à quelques
dollars par génération selon le modèle et la durée. Un plafond global de test
typique se situe donc entre **1 et 5 USD**. **Je n'active rien avant votre
confirmation écrite du montant.**

## 5. Débit de crédits — état réel

Vérifié en base par transactions annulées (`ugc_private.apply_wallet_delta`) :

| Étape | Solde disponible / réservé |
| --- | --- |
| départ | 5 / 0 |
| réserve 3 | 2 / 3 |
| même clé rejouée | **2 / 3** (aucun second débit) |
| capture 3 | 2 / 0 |
| réserve 2 | 0 / 2 |
| restitution | 2 / 0 |

| Cas adverse | Résultat |
| --- | --- |
| réserver 50 sur 1 crédit | refusé « Insufficient or inconsistent credit balance » |
| delta négatif de 500 | refusé, solde inchangé |
| écriture directe du solde | impossible : tous les appelants passent par la primitive |
| mise à jour arbitraire du journal | refusée « UGC credit ledger is append-only » |

État courant de la production : 4 portefeuilles, **5 crédits disponibles, 0
réservé, 0 solde négatif, 0 job**. Aucune transaction artificielle n'a été
conservée dans un portefeuille réel.

**Défaut réel corrigé** : la suppression d'un compte possédant un historique de
crédits **échouait** (la clé étrangère `ON DELETE SET NULL` déclenchait le
trigger append-only). L'effacement RGPD était donc cassé. Le trigger autorise
désormais cette seule mutation (anonymisation), et rien d'autre. Vérifié en
base : mise à jour arbitraire toujours refusée, suppression de compte acceptée,
journal conservé et anonymisé, portefeuille supprimé.

## 6. V2V et Lip Sync

`Video→Video` et `Lip Sync` sont `status: 'live'` dans
`src/studio/sections.ts` avec de vraies routes (`?mode=video-source`,
`?mode=audio-source`). Le socle est en place : import vidéo/audio, stockage
privé, URL signées, construction du corps fournisseur, devis serveur,
réservation de crédits puis de budget, suivi, récupération du résultat.

**Aucun rendu V2V ou Lip Sync n'a été exécuté en production** : cela exige une
génération payante, donc votre autorisation de budget. Tant que le plafond est à
0 USD, ces parcours s'arrêtent proprement sur un refus explicite (message
« budget fournisseur disponible insuffisant, aucun crédit débité »), ce qui est
le comportement attendu et non un mensonge de disponibilité.

Un modèle sans support vidéo/audio n'est pas présenté comme compatible : la
compatibilité est dérivée du catalogue réel (83/83 modèles Video→Video,
6 modèles Audio→Video actifs).

## 7. Parcours Studio

| Élément | État |
| --- | --- |
| Text→Video, Image→Video, Video→Video, Lip Sync | routés, devis serveur, suivi |
| Projets, historique, créations enregistrées | live (routes réelles) |
| Imports, timeline, scènes, audio/voix, sous-titres | présents (montage) |
| Image Studio, Avatar, Audio, Clipping, Workflows, Storyboarding… | `prepared` — **aucun** bouton de génération, message explicite |
| Prélèvement du montant | **jamais** décidé par le frontend (le devis vient du serveur) |

Réserve honnête : les fonctions `prepared` sont explicitement annoncées comme
non disponibles, sans cadenas inutile ni message de disponibilité trompeur.

## 8. Séparation BG / Studio

`saas_ugc.*` (Studio, marge 60 %) et `saas_business.*` (Business Grow, marge
95 %) restent des schémas distincts, avec portefeuilles et catalogues séparés.
Aucune dépense Studio ne touche la marge BG. Aucun tarif non validé n'a été
publié : `video_pricing_config` est inchangé.

## 9. Tests et vérifications

| Vérification | Résultat |
| --- | --- |
| `npx vitest run` | **50 fichiers / 526 tests ✅** (dont 20 nouveaux) |
| `npx tsc -b` | 0 erreur |
| `npm run build` | ✅ build de production |
| Parité artefact ↔ source | 8 tests ✅ |
| Chargeur Edge | 4 tests ✅ (handler appelable, crédits identiques, OPTIONS identiques) |
| Imports Edge | conformes |

**LOCAL :** tous les tests ci-dessus. **PROD VÉRIFIÉ :** boot `reelora-video`,
refus de budget, intégrité des tranches, invariants de crédits en SQL.

## 10. Déploiement du frontend

**Aucun déploiement Netlify n'a été déclenché.** Le dépôt ne contient **aucun
workflow GitHub Actions** ; le seul mécanisme identifié est le build Netlify des
**Deploy Previews de pull request** (`netlify.toml`). Pousser la branche
déclencherait donc une preview Netlify non maîtrisée. Conformément à votre
consigne, rien n'a été poussé.

Pour publier le frontend, il faut soit merger la PR #6 (déploiement de
production), soit autoriser explicitement un Deploy Preview.

## 11. Blocages externes restants

1. **Contrôle fonctionnel authentifié de `reelora-video`** : exige un mot de
   passe utilisateur réel pour obtenir un JWT (aucune émission de jeton possible
   depuis cet environnement).
2. **Aucune génération payante** : plafond à 0 USD, en attente de votre montant.
3. **Déploiement frontend** : dépend de votre décision sur la PR #6 / Netlify.
4. **Accès réseau** : `*.supabase.co` et `api.supabase.com` sont injoignables
   depuis cet environnement ; toutes les opérations de production passent par le
   connecteur Supabase (SQL + gestion des Edge Functions).

## 12. Liens, branche et commits

- Branche : `arena/323bad30-saas-ugc` — HEAD **`055cf24`**, 16 commits d'avance
  sur `main` (`1a572be`), aucun commit de `main` manquant.
- PR #6 ouverte, **non mergée** (aucune fusion dans `main`).
- Preview locale : `http://127.0.0.1:4180` (serveur de développement uniquement).
- Studio en production : dépend du déploiement frontend (§10), donc **pas encore
  publié**.

### Commits de cette session

```
055cf24 Budget fournisseur: plafond par fournisseur, alertes et arret auto; effacement de compte repare
a3b66fa Edge: chargeur runtime verifie, artefact 43 Ko servi en production
58a02f0 Edge: artefact minifie .edge.js avec empreinte SHA-256 verifiable
e1445f4 Edge: bundle autonome deployable pour reelora-video (import _shared inline)
```
