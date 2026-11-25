# Incrément 16 — Quotas dérivés, gratuit prouvé et administration de la matrice

Statut : **implémenté, mesuré hors ligne et vérifié dans un navigateur**. Aucun
déploiement, aucune génération payante, aucun débit client, aucune migration
appliquée en base, aucun achat de crédits fournisseur.

Les acquis des incréments 12 à 15 sont conservés : conflits d'endpoints résolus,
adaptateurs de réponse, sorties 3D `.glb`, preuve OpenAPI, chaîne de préparation
runtime, politique de quota en données et refus explicites.

---

## 1. Mesures

Mesure API publique (cache local, aucune clé requise), puis évaluation et audit
hors ligne :

| Étape | Compteur | Valeur |
| --- | --- | ---: |
| Catalogué | `models` | 867 |
| Préparé (schéma + endpoint + famille + prix exploitables) | `prepared` | 737 |
| Configurable (configuration persistée, quota résolu) | `configurable` | 737 |
| Runtime configuré | `runtime_configured` | 737 |
| Test technique réussi | `technical_test_passed` | 0 |
| Opérationnel / activé / visible dans le Studio | — | 0 / 0 / 0 |
| Bloqué | `models − prepared` | 130 |
| Gratuit déclaré (prix officiel 0 $) | — | 3 |
| Configurable, quota en attente | `configurable_quota_pending` | 67 |
| Configurable, offre en attente | `configurable_plan_pending` | 737 |

L'audit `scripts/audit-runtime-configs.mjs` rejoue les 737 configurations
persistables : **737 cohérentes, 0 anomalie**, 3 avertissements
`SCHEMA_NO_REQUIRED_FIELD` (`heygen-avatar-6`, `heygen-avatar-6-turbo`,
`depth-anything`) — schéma sans champ obligatoire, accepté sans invention.

« Configurable » n'est **pas** « opérationnel » : rien n'a été généré chez un
fournisseur, `ACCESS_UNCONFIRMED` reste vrai sans `MUAPI_API_KEY`.

## 2. Quotas : propositions dérivées, jamais inventées

Les 60 modèles bloqués par un quota manquant ne reçoivent pas un tarif ou une
limite choisis par le code. La migration
`20261121000000_studio_family_policy_lot16.sql` ajoute une **table de règles de
dérivation** `studio_family_policy_rules` : chaque famille nouvelle hérite d'un
multiple d'un quota **déjà approuvé** (le quota vidéo de l'offre), avec un
plancher.

| Famille | Règle | Plancher |
| --- | --- | ---: |
| `audio` | 2 × vidéo | 1 |
| `voice` | 2 × vidéo | 1 |
| `music` | 1 × vidéo | 1 |
| `model_3d` | 1 × vidéo | 1 |
| `lora` | 1 × vidéo | 1 |
| `tool` | 5 × vidéo | 5 |

`studio_propose_family_policy(famille)` écrit des lignes `approved = false` et
`studio_approve_family_policy(famille, approuver, motif)` exige un **motif
écrit** pour les activer. Aucune fonction n'approuve automatiquement : la
décision reste un acte d'administration motivé, visible dans la console.

`studio_runtime_model` expose désormais `quota_resolved`, `quota_policy_ready` et
`quota_status` ; le runtime ne code plus aucune famille en dur (`core.ts`).

## 3. Prix fournisseur officiellement nul

Trois modèles publient un prix `$0.00` avec une preuve explicite (watermark,
Gemini Omni character). Ils sont traités comme **gratuits déclarés**, pas comme
des prix manquants :

- `studio_provider_pricing_valid` accepte un prix nul **uniquement** avec la
  preuve (`billing = 'free'`, stratégie et source présentes, ≤ 9 clés) ;
- un zéro sans stratégie ni source est refusé par la contrainte de base ;
- le devis vaut 0 crédit, aucun mouvement de portefeuille n'est écrit, mais le
  quota est **toujours consommé** ;
- l'interface affiche « gratuit (0 crédit) » et le motif reste explicite.

## 4. Liaison des sorties (extension bornée par la preuve)

`families.ts` accepte un champ de sortie supplémentaire lorsque la preuve est
sans ambiguïté : format `uri`, ou titre/description terminant par « URL/URLs »,
ou exemples tous HTTPS. Une ambiguïté est refusée, et le résultat est toujours
validé HTTPS. Les conteneurs `output`, `output_data` et la racine sont explorés.

## 5. Administration

- `studio_catalog_admin_summary` expose l'**échelle de statuts** mesurée par le
  runtime : catalogué → préparé → configurable → runtime configuré → test
  technique → opérationnel → activé → disponible Studio, plus les compteurs
  d'attente (`quota_policy_pending`, `configurable_quota_pending`,
  `configurable_plan_pending`, `plan_policy_pending`, `pricing_missing`,
  `real_tests_missing`) et les champs de diagnostic (`details_ok`,
  `detail_errors`, `last_sync`, `categories`, `measured_at`).
- La console n'affiche plus « Intégrés et validés = 737 » : chaque étape a son
  compteur, une configuration persistée n'est jamais présentée comme testée.
- Panneau **Propositions dérivées** : montant proposé, règle et source, motif
  obligatoire, bouton d'approbation désactivé tant que le motif est vide.
- Actions Edge `admin_plan_proposals / admin_plan_propose / admin_plan_approve`.

## 6. Parcours et interface

Studio universel (`src/studio/UniversalStudio.tsx`) :

- **tous** les modèles sont sélectionnables ; un modèle non opérationnel affiche
  son motif exact (quota proposé non approuvé, hors offre, accès non confirmé,
  test réel manquant) et un formulaire inactif ;
- le panneau de quotas distingue quota approuvé et « Proposition : N / mois —
  en attente d'arbitrage produit » ;
- l'historique rend image, vidéo, audio, modèle 3D glTF, texte, échec et
  « incertain — vérification administrative requise » (jamais relancé
  automatiquement).

États vérifiés dans le navigateur : catalogue chargé, recherche sans résultat,
erreur Edge (503) avec bouton de reprise, récupération après erreur, modèle
bloqué, modèle gratuit, devis 4 crédits, confirmation, mobile 390 × 844 sans
débordement horizontal.

## 7. Défauts trouvés par la vérification visuelle et corrigés

1. `adminVideoCatalog()` renvoyait un corps partiel sans validation : la section
   Catalogue MuAPI plantait (`Cannot read properties of undefined (reading
   'detected_video')`) et l'écran entier basculait sur l'erreur d'affichage. La
   réponse est désormais validée (`CATALOG_INVALID_RESPONSE`) et la section
   tolère un champ absent.
2. Compteur « Intégrés et validés » trompeur à 737 : remplacé par des compteurs
   d'étapes distincts (`configurable`, `technical_test_passed`).

## 8. Causes de blocage restantes (documentées, non contournées)

| Cause | Modèles |
| --- | ---: |
| Aucun champ de sortie exploitable (multimodal texte/JSON) | 61 + 14 |
| Outils de publication/modération (famille `other`, sortie non fichier) | 10 |
| LoRA trainers (entrée ZIP non supportée) | 8 |
| Endpoint déclaré absent de l'OpenAPI (flux-3, seedance-2.x, veo-4, wan3.0) | 11 |
| `topaz` : enum numérique sur un champ `string` | plusieurs |
| `kling` : `pattern` regex non validable en toute sécurité | 2 |
| `face-expression-change`, `any-llm`, `suno-*` : schéma non adapté | — |

Aucune de ces causes n'est corrigeable sans inventer une sémantique
fournisseur ; elles restent des refus explicites.

## 9. Validation

- `npx vitest run` : 209 fichiers, 3305 réussis, 2 ignorés
  (`tests/store-import-artifact.test.ts`, commit épinglé absent du clone),
  0 échec.
- Nouveaux tests : `studio-quota-plan-migration` (11, PGlite),
  `studio-journey-families` (14 : image, vidéo, audio, 3D, paramètres invalides,
  hors offre, quota insuffisant, devis expiré, échec fournisseur, résultat
  manquant, fichier incompatible, devis gratuit 0, estimation facturée),
  `studio-output-declarations` (6).
- `npm run typecheck`, `npm run typecheck:edge`, `npm run check:edge-imports`,
  `npm run build` verts.
- `node scripts/build-studio-runtime.mjs --check` et
  `node scripts/build-universal-validation.mjs --check` à jour.

## 10. Ce qui reste bloqué, et pourquoi

| Code | Cause | Décision attendue |
| --- | --- | --- |
| `ACCESS_UNCONFIRMED` | aucune `MUAPI_API_KEY` dans cet environnement | clé fournisseur |
| `QUOTA_POLICY_MISSING` | propositions audio/voix/musique/3D/LoRA/outil non approuvées | arbitrage produit motivé |
| `PLAN_UNAVAILABLE` | matrice offre → famille non approuvée | arbitrage produit |
| `PAID_VALIDATION_PENDING` | aucun test fournisseur payant lancé | autorisation explicite |

Rien n'a été commité, poussé ni déployé.
