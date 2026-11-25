# Incrément 15 — Quotas extensibles, plans et parcours Studio

Statut : **implémenté et mesuré hors ligne**. Aucun déploiement, aucune génération
payante, aucun débit client, aucune migration appliquée en base.

Les acquis des incréments 12 à 14 sont conservés : 46 conflits d'endpoints
résolus, adaptateurs de réponse, sorties 3D `.glb`, preuve OpenAPI, chaîne de
préparation runtime et refus explicites.

---

## 1. Quotas : une architecture de données, plus de conditions par modèle

Avant ce lot, `studio_prepare_runtime`, `assessment` et `reelora_consume_quota`
répétaient tous la même condition `video / image / text to text`. Toute famille
absente (audio, musique, voix, 3D, LoRA) était bloquée par construction.

La migration `20261120230000_studio_quota_plan_policy.sql` remplace ce codage :

| Table | Rôle |
| --- | --- |
| `saas_ugc.studio_quota_families` | familles consommables (`script`, `prompt`, `video`, `image`, `audio`, `music`, `voice`, `model_3d`, `lora`, `tool`, `export`) |
| `saas_ugc.studio_family_rules` | règles ordonnées catégorie/famille d'intégration → famille de quota (données modifiables, pas de `case` par modèle) |
| `saas_ugc.studio_plan_quotas` | limite mensuelle par offre et par famille, avec `approved` |
| `saas_ugc.studio_plan_families` | droit offre → famille, avec `approved` |

`studio_runtime_configs.quota_kind` devient une **clé étrangère** vers les
familles : ajouter une famille est une insertion, pas un redéploiement.
`reelora_consume_quota` garde sa signature mais lit désormais la politique en
base ; les quotas historiques sont repris **à l'identique** :

- `script` → `max_scripts_per_month` ;
- `prompt` → `max_prompts_per_month` ;
- `video` → `max_videos_per_month` ;
- `image` → `greatest(max_videos_per_month × 2, 1)` ;
- `export` → 100.

Aucune valeur existante n'a été modifiée, aucun quota n'a été détourné.

### Ce qui attend un arbitrage produit (non appliqué)

Les familles nouvelles sont seulement **proposées** (`approved = false`) :

| Offre | Audio | Musique | Voix | 3D | LoRA | Outil |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Découverte | 2 | 1 | 2 | 1 | 1 | 5 |
| Studio | 30 | 15 | 30 | 10 | 10 | 100 |
| Pro | 120 | 60 | 120 | 40 | 40 | 500 |
| Entreprise | 1000 | 500 | 1000 | 300 | 300 | 5000 |

Tant qu'elles ne sont pas approuvées, la consommation échoue avec
`quota_policy_missing:<famille>` — jamais avec un quota emprunté à une autre
famille.

## 2. Plans et accès

Le droit d'abonnement est désormais distinct de la préparation technique :

- `assessment` expose `planAllowed` et `technicalBlockers` (le blocage d'offre
  n'est plus confondu avec une panne ou une validation manquante) ;
- `customerModel` expose `plan_allowed` et `quota_family` ;
- la préparation n'accorde un plan que si le droit `offre → famille` est
  **approuvé** ; un réglage manuel (`plans_source = 'manual'`) n'est jamais
  écrasé par la politique automatique ;
- `studio_runtime_start` vérifie déjà le plan, le quota, le budget quotidien,
  la concurrence et le solde avant de réserver.

Répartition **proposée** (non approuvée, à valider) :

| Offre | Familles incluses |
| --- | --- |
| Découverte | script, image, vidéo, audio, voix, 3D |
| Studio | + (mêmes familles, volumes supérieurs) |
| Pro | + musique, LoRA |
| Entreprise | + outils fournisseur |

La grille tarifaire (prix des offres, crédits mensuels) n'est pas touchée.

## 3. Parcours Studio

Le parcours vérifié est : **sélection → formulaire → validation → droits →
crédits → devis serveur → soumission → polling → résultat → historique**.

- Les formulaires utilisent le schéma officiel filtré côté serveur
  (`customerSchema`) ; les descriptions et métadonnées fournisseur ne fuient
  pas.
- Le devis vient de l'endpoint d'estimation déclaré ; un prix absent ou hors
  plafond refuse le devis.
- La réservation est idempotente par `request_key` : une double soumission ne
  produit ni second débit ni seconde requête fournisseur.
- Échec, expiration ou annulation restituent les crédits et suppriment
  l'événement de quota correspondant.
- Le Studio affiche désormais les résultats **selon leur type réel** : image,
  vidéo, audio, modèle 3D (`.glb`), texte, et non plus un lien générique.
- Les modèles prêts mais hors offre sont affichés séparément, avec un lien vers
  les offres ; ils ne sont jamais proposés à la génération.
- Un panneau de quotas montre, par famille, la limite, l'usage et l'état de la
  politique (`active`, `pending_approval`, `disabled`, `missing`).

## 4. Administration

Nouvel écran `StudioPlanMatrix` : compteurs cohérents (mêmes définitions que le
runtime) et matrice offre × famille éditable (droit, approbation, limite,
activation, approbation du quota). Les compteurs incluent préparés,
configurables, opérationnels, activés, disponibles Studio, quotas à arbitrer,
plans à arbitrer, prix manquants et tests réels manquants.

## 5. Mesure hors ligne (867 références officielles)

Rejeu du code de préparation sur le listing public, les 867 fiches et
`openapi.json` :

| Indicateur | Incrément 14 | Incrément 15 |
| --- | ---: | ---: |
| Préparés | 723 | 723 |
| Configurations persistables | 683 | **720** |
| Bloqués faute de prix déclaré | 3 | 3 |
| En attente de politique de quota | 37 | **60** (familles nouvelles) |

Répartition des 720 configurations : vidéo 407, image 165, script 91, audio 44,
3D 8, LoRA 8. Les 60 configurations audio/3D/LoRA sont **persistables** mais
leur consommation reste refusée jusqu'à approbation des limites.

Rappel : **0 modèle opérationnel, 0 disponible dans le Studio**. Il manque
toujours la clé fournisseur (`ACCESS_UNCONFIRMED`), l'approbation des plans et
quotas, et le test fournisseur payant (`PAID_VALIDATION_PENDING`).

## 6. Validation non payante

- Migration testée sur PGlite (8 cas) : résolution des familles, reprise exacte
  des quotas historiques, refus d'une politique non approuvée, application
  d'une limite approuvée, quota incomplet refusé, persistance audio/3D/LoRA/
  outil sans activation, attribution de plan conditionnée, compteurs et quotas
  client.
- Chaîne runtime réelle testée sur PGlite : réservation, rejeu idempotent,
  capture, restitution, expiration, isolation.
- Parcours simulé de bout en bout : devis, soumission unique, polling,
  résultat, historique signé, refus d'offre sans appel fournisseur.
- Ces mocks prouvent le câblage et les protections ; **ils ne démontrent pas**
  le comportement réel d'un fournisseur.

## 7. Décisions nécessaires avant activation

1. Approuver (ou corriger) les limites audio / musique / voix / 3D / LoRA /
   outil du tableau ci-dessus.
2. Approuver l'attribution des familles aux offres.
3. Fournir `MUAPI_API_KEY` dans l'environnement serveur.
4. Autoriser explicitement les tests fournisseur payants, modèle par modèle,
   puis les attestations.

Sans ces quatre décisions, les compteurs resteront à 0 opérationnel — ce qui est
l'état honnête du produit, pas un défaut de configuration.
