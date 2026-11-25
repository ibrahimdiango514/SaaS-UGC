# Incrément 17 — Capacité d'exécution : sorties déclarées, entraînements, liens publics

Statut : **implémenté, mesuré hors ligne et vérifié dans un navigateur**. Aucun
déploiement, aucune génération payante, aucun débit client, aucune migration
appliquée en base, aucun commit.

---

## 1. Contrôle du lot 16

| Point | Vérification |
| --- | --- |
| Migrations / RPC / front / tests | relus et rejoués ; la mesure lot 16 (737 préparés / 130 bloqués) se reproduit à l'octet près sur un cache neuf |
| Approbations d'écran | le harnais navigateur remplace `window.fetch` pour tout hôte `supabase.co` : les RPC d'administration (dont `studio_approve_family_policy`) reçoivent une réponse statique, aucune requête ne quitte le navigateur ; les tests SQL tournent sur PGlite en mémoire |
| Gratuité des 3 modèles | fiches officielles `https://api.muapi.ai/api/v1/models/{name}` (HTTP 200) : `cost = 0 USD`, `cost_strategy` = `watermark-free`, `watermark-free`, `gemini-omni-character-cost`. Un zéro sans stratégie reste refusé par la contrainte |
| Propositions non approuvées | test PGlite : `select count(*) … where approved` sur audio/music/voice/model_3d/lora/tool = **0** ; l'approbation exige toujours un motif écrit |

## 2. Mesures après ce lot

| Étape | Lot 16 | Lot 17 |
| --- | ---: | ---: |
| Catalogué | 867 | 867 |
| Préparé | 737 | **812** |
| Configurable (100 % des préparés) | 737 | **812** |
| Test technique réussi / opérationnel / activé | 0 / 0 / 0 | 0 / 0 / 0 |
| Bloqué | 130 | **55** |
| Prix manquants | 130 | **0** |
| Quota en attente (propositions) | 67 | **81** (audio 44, 3D 10, LoRA 27) |

`scripts/audit-runtime-configs.mjs` : 812 configurations auditées, **0 anomalie**,
3 avertissements `SCHEMA_NO_REQUIRED_FIELD` (heygen-avatar-6, heygen-avatar-6-turbo,
depth-anything).

## 3. Ce qui a été débloqué (75 modèles)

Aucune règle ne s'appuie sur un nom de modèle : chaque capacité est bornée par
une **déclaration officielle** de la fiche.

1. **Sortie déclarée dans la fiche d'entrée** (`input_schema.schemas.output_data`).
   La fiche officielle porte sa propre déclaration de sortie ; elle est lue après
   l'enveloppe de prédiction, jamais à sa place. → `face-expression-change`,
   `qwen-image-edit-lora`, `qwen-image-edit-2511-lora`, `flux-lora-trainer`, etc.
   Les exemples HTTPS restent une preuve même si `type` est omis ; une ambiguïté
   entre deux champs reste refusée.
2. **Donnée déclarée (`result`)** : nouveau protocole `muapi_output_json_v1`.
   Une enveloppe qui déclare `id`, `status` et `result` (objet/tableau/chaîne)
   restitue ce résultat en **JSON borné à 128 Kio**, stocké comme sortie texte.
   → 60 API de données (SEO, entreprises, recrutement, e-commerce, créateurs,
   marchés, actualités, e-mail, recherche web, réseaux sociaux).
   Un outil dont l'état s'appelle `state` (bac à sable) ou qui n'a pas de
   `result` déclaré reste refusé.
3. **Entraînements LoRA** : la famille `training` peut désormais lier un contrat
   de sortie déclaré (`lora_url`, `outputs` « … URLs ») et consomme la famille de
   quota `lora` (règle de données, priorité 82) — la limite reste **proposée**.
   → 12 entraînements (flux, qwen, z-image, wan2.1, sdxl, flux-dev).
4. **Champ « public URL »** : un champ que la fiche déclare comme lien
   (`Public URL …`, ou `URL to ZIP archive` pour un champ `zip`) n'exige plus
   d'import privé : le formulaire saisit un lien HTTPS, le serveur le valide,
   rien n'est signé ni téléversé. Les autres médias gardent l'import privé.
   → les 7 derniers entraîneurs à archive.

## 4. Blocages restants (55) et cause exacte

| Cause | Modèles | Pourquoi ce n'est pas corrigeable sans inventer |
| --- | ---: | --- |
| `OPENAPI_OPERATION_UNCONFIRMED` | 11 | la fiche déclare un chemin absent du document OpenAPI officiel (flux-3-*, seedance-2.x, veo-4-*, wan3.0-*) ; aucun autre chemin documenté ne partage le contrat |
| `SCHEMA_UNSUPPORTED` | 3 | `topaz-image-upscale` : `enum [1,2,4,8]` sur un champ déclaré `string` (le format filaire est ambigu) ; `kling-4.0-*` : contraintes de schéma non validables sans supposition |
| `RESPONSE_CONTRACT_UNSUPPORTED` | 12 | sortie déclarée sans champ exploitable : `wan2.7-video-edit` (`video: string` sans URL ni exemple), `suno-*` (flux multi-étapes / texte sans enveloppe), `ocr-recognize-text` (`items` sans format), `gemini-omni-audio` (identifiant de voix, pas un fichier) |
| `RESPONSE_CONTRACT_UNSUPPORTED` + `OUTPUT_FORMAT_UNSUPPORTED` | 19 | texte/JSON dont la fiche ne déclare ni `result` ni `output.text` (`gpt-5-*`, `any-llm`, `moderate-*`, `sandbox-*`, `youtube-download`, `openai-whisper`) |
| `SCHEMA_UNSUPPORTED` + contrat | 10 | outils de publication sociale : sortie `platform`/`media_id`, entrée non prise en charge ; ce sont des actions externes, pas des générateurs |
| `UPLOAD_FORMAT_UNSUPPORTED` | 0 | — |

## 5. Chaîne d'exécution vérifiée

Inspection et tests couvrent : sélection → formulaire (schéma validé côté
serveur) → devis (crédits, gratuit, expiration) → droits d'offre → réservation
(`studio_runtime_start` idempotent par `request_key` **ou** `quote_id`) → appel
fournisseur (clé requise) → suivi (`worker`/`poll`, contrôle d'identifiant) →
résultat (fichier téléversé dans Storage ou texte/JSON) → historique (URLs
signées) ; échec → libération de la réservation, suppression de l'événement de
quota ; expiration → restitution ; coût réel supérieur au plafond → modèle et
runtime désactivés. **Aucun modèle n'est déclaré opérationnel** : cela exige un
test fournisseur réel réussi, qui reste interdit dans cet environnement.

## 6. Quotas proposés (81 modèles en attente)

| Famille | Modèles | Proposition (règle) | État |
| --- | ---: | --- | --- |
| `audio` | 44 | 2 × quota vidéo approuvé | non approuvée |
| `model_3d` | 10 | 1 × quota vidéo approuvé | non approuvée |
| `lora` | 27 | 1 × quota vidéo approuvé (entraînements inclus) | non approuvée |

Les six familles restent `approved = false` ; aucune limite, aucun prix d'offre
et aucun abonnement n'a été modifié. L'écran d'administration expose les
propositions, le motif obligatoire et le recalcul explicite.

## 7. Correctifs d'interface

- Le formulaire de génération ne propose plus « Importer un fichier privé » pour
  un champ déclaré public ; il affiche « Lien HTTPS public déclaré par le
  fournisseur ».
- Le compteur « Intégrés et validés » (lot 16) reste remplacé par
  `Configurables` / `Test technique réussi` ; « Restant à rendre opérationnel »
  remplace « Références à résoudre ».
- Console admin : 867 / 812 / 812 / 0 test / 0 opérationnel, 81 quotas à
  arbitrer, 0 prix manquant, sans erreur console.

## 8. Validation

- `npx vitest run` : **211 fichiers, 3323 réussis, 2 ignorés**, 0 échec.
  Ignorés : `tests/store-import-artifact.test.ts` (commit épinglé absent du
  clone) — comptés comme ignorés, jamais comme réussis.
- Nouveaux tests : `studio-lot17-capabilities` (12), `studio-public-link-field`
  (3, rendu réel des deux formulaires), `studio-quota-plan-migration` (+2 :
  règle `training → lora`, protocole de donnée accepté et classé `text`).
- `npm run typecheck`, `npm run typecheck:edge`, `npm run check:edge-imports`,
  `npm run build`, `build-studio-runtime --check`, `build-universal-validation
  --check` verts après reconstruction.
- Navigateur : Studio universel (6 opérationnels, 3 motifs exacts, modèle
  gratuit 0 crédit, quota proposé 160/mois, historique image/vidéo/audio/3D/
  texte/échec/incertain) et console admin ; 0 erreur console.

## 9. Pour passer aux tests réels

1. `MUAPI_API_KEY` valide, configurée côté serveur (jamais dans le dépôt).
2. Autorisation écrite d'un test payant par famille, avec plafond de dépense.
3. Approbation motivée des quotas audio/3D/LoRA et de la matrice offre → famille.
4. Puis : `prepare_runtime`, activation modèle par modèle, un test réel réussi →
   `technical_test_passed`, et seulement ensuite `operational`.
