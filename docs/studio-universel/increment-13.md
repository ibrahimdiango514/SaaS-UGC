# Incrément 13 — réconciliation réelle des 867 références MuAPI

Mesure du 2026-11-20, sur le code du dossier de travail (aucun déploiement,
aucune écriture Supabase, aucun appel de génération, aucun crédit consommé).

## 1. Ce qui a été mesuré, et avec quelles données

La mesure ne peut pas passer par la production (le worker n'écrit qu'en base
réelle, et le déploiement n'est pas autorisé à ce stade). Elle rejoue donc
**le même code** (`integrationProgress`) sur **les mêmes données officielles**
que celles dont le worker se sert :

| Source | Usage | Coût |
|---|---|---|
| `GET https://api.muapi.ai/api/v1/models` | périmètre : 867 références | gratuit, public |
| `GET https://api.muapi.ai/api/v1/models/{name}` | fiche de chaque modèle (schémas entrée/sortie, catégorie, preuve d'endpoint) | 867 GET publics, gratuits |
| `GET https://api.muapi.ai/openapi.json` | preuve des opérations POST documentées | gratuit, public |

`scripts/evaluate-muapi-catalog.mjs` exécute ce rejeu (cache disque des fiches,
deux passes par modèle). Commande :

```
node scripts/evaluate-muapi-catalog.mjs --cached --out /tmp/eval.json
```

**Contrôle de fidélité** : le même jeu de 867 lignes, évalué avec l'ancien code
(`git show HEAD:…/families.ts`), reproduit **exactement** le snapshot de
production `muapi-live-20261120T1831Z` : 616 préparés / 251 bloqués, et les
mêmes compteurs par cause. La mesure locale décrit donc bien la production, et
les écarts qui suivent viennent du code, pas du jeu de données.

## 2. Résultat mesuré

| | Avant (ancien code, mêmes données) | Après (code du dossier) |
|---|---:|---:|
| Références évaluées | 867 | **867** |
| Préparées (`integration_prepared`) | 616 | **723** |
| Bloquées | 251 | **144** |
| Opérationnelles (config runtime validée) | 0 | **0** |
| Activées / accessibles dans le Studio | 0 | **0** |
| Déterminisme (2 passes identiques) | — | **867/867** |
| Deux exécutions consécutives identiques | — | **oui** |

Transitions exactes, calculées modèle par modèle (aucune estimation) :

| Transition | Nombre |
|---|---:|
| bloqué → préparé | **107** |
| préparé → bloqué (régression) | **0** |
| préparé → préparé | 616 |
| bloqué → bloqué | 144 |

Causes effectivement levées chez les 107 modèles nouvellement préparés :

| Cause levée | Modèles |
|---|---:|
| `ENDPOINT_CONFLICT` (preuve OpenAPI) | 43 |
| `RESPONSE_CONTRACT_UNSUPPORTED` (sortie média déclarée sans enveloppe) | 77 |
| `OUTPUT_FORMAT_UNSUPPORTED` (familles 3D) | 14 |
| `UPLOAD_FORMAT_UNSUPPORTED` (URL texte prise pour un upload) | 6 |

## 3. Les 46 conflits d'endpoints, re-vérifiés

`node scripts/reconcile-muapi-endpoints.mjs` sur les 46 déclarations réelles :

| | Nombre |
|---|---:|
| Résolus par un **seul** POST documenté (`openapi_single`) | **33** |
| Résolus par **deux** POST à contrat fonctionnel identique (`openapi_equivalent_contracts`) | **13** |
| Non résolus | **0** |
| Passent en préparé (l'endpoint était la seule cause) | 21 |
| Restent bloqués par une autre cause | 25 |

Deux exécutions consécutives produisent des transitions **identiques**
(comparaison octet pour octet hors horodatage). 33 des 46 chemins retenus
diffèrent du nom du modèle : la preuve porte donc bien sur le document, pas sur
une convention de nommage.

## 4. Blocages restants : 144, tous justifiés

| Cause | Modèles | Pourquoi ce n'est pas débloquable sans inventer |
|---|---:|---|
| Hors périmètre Studio (JSON/agent/social/sandbox) | 89 | Sorties `{flagged}`, `{publish_id}`, `{result}`, agents JSON : aucun média ni texte déclaré. Ce ne sont pas des générations. |
| Contrat de réponse non déclaré | 33 | La fiche ne déclare **aucun** champ média typé (`ltx-2.5-*` : `video` sans `format`, `wan2.7-*`, `suno-*`, `krea-*`). Deviner par le nom ou la description est exactement ce que le runtime s'interdit : un mauvais champ = génération payée puis échec. |
| Endpoint non documenté | 11 | Le modèle est au catalogue mais **absent** de `openapi.json` (`flux-3-*`, `wan3.0-*`, `seedance-2.1-*`, `veo-4-*`). Aucune preuve d'exécution. |
| Upload ZIP (entraînement) | 8 | Entraînements LoRA réels : archive `.zip` + artefact `.safetensors`. Pas de runtime d'entraînement. |
| Schéma non supporté | 3 | `topaz-image-upscale` (enum numérique sur un type `string`), `kling-4.0-*` (tableau d'objets imbriqués). |

Les deux portes `CONSTRAINT_REVIEW_REQUIRED` et `REAL_TEST_PENDING` restent sur
**les 867** : aucun modèle ne peut être déclaré opérationnel sans configuration
runtime validée et test fournisseur réel.

## 5. Corrections apportées dans cet incrément

| Fichier | Correction | Effet mesuré |
|---|---|---|
| `supabase/functions/studio-runtime/families.ts` | Un champ `format: uri|url` **sans** `field` est un lien HTTPS saisi par le client, pas un emplacement de fichier : il n'exige plus d'adaptateur d'upload. | 24 fiches ne sont plus bloquées à tort ; 6 deviennent préparées. |
| `supabase/functions/studio-runtime/families.ts` | `image-to-3d` et `text-to-3d` déclarent une sortie média (`model_url`, `format: uri`) : familles ajoutées au runtime de sortie. | +8 préparés (5 image→3D, 3 texte→3D). |
| `supabase/functions/studio-runtime/core.ts` | Signature `glTF` → `model/gltf-binary` (`.glb`). Sans elle, une génération 3D **payée** était jetée en `RESULT_FILE_UNSUPPORTED` à l'enregistrement du résultat. | Résultats 3D réellement conservés. |
| `scripts/evaluate-muapi-catalog.mjs` | Rejeu hors-ligne du worker sur le catalogue public, avec double passe de déterminisme. | Mesure reproductible sans production. |

Aucun statut n'est forcé : `integration_prepared` reste calculé par les mêmes
conditions (`endpoint_confirmed && schema && protocol && uploads && output &&
adapterSelfTest`), et le validateur SQL refuse tout rapport incohérent.

## 6. Compatibilité, persistance, invalidation

- Preuve persistée sur `studio_ai_models.endpoint_evidence.resolution` ; les
  déclarations d'origine (`endpoint`, `endpoint_url`) sont conservées telles
  quelles.
- Rejeu : le libellé de résolution d'origine est réutilisé, donc un deuxième
  passage du worker produit un rapport **identique** (pas d'invalidation
  horaire). Vérifié par test et par deux exécutions consécutives.
- Invalidation : l'attestation (`enabled`, `verified_hash`, `verified_at`) est
  retirée dès que le chemin, l'empreinte de contrat, le protocole ou la version
  d'adaptateur change — testé sur PGlite.
- Bascule : `studio_save_integration` accepte les rapports `muapi-families-2`
  à `5` (un worker encore en v4 peut écrire pendant le déploiement) et refuse
  `muapi-families-6`. Testé.
- Jobs déjà en file : `protocol_key` + `result_field` sont relus tels quels ; le
  décodage des cinq protocoles est inchangé par le passage en v5. Testé.

## 7. Tests

| Contrôle | Résultat |
|---|---|
| `npx vitest run` | **204 fichiers, 0 échec** |
| `npx tsc -b` (application) | 0 erreur |
| `npx tsc -p tsconfig.edge.json --noEmit` (Edge) | 0 erreur |
| `npm run check:edge-imports` | conforme |
| `npm run build` | OK (Vite) |
| Artefacts `universal-catalog` / `studio-runtime` | régénérés, `--check` conformes |
| Tests de sécurité et d'isolation présents dans la suite | comptes, fichiers, plafonds de dépense, permissions Studio : verts |

Les deux anciens échecs `store-import-artifact` ne sont **plus** des échecs : le
contrôle « artefact au commit épinglé » est désormais **annoncé en skipped**
avec sa raison quand l'objet de commit est absent de ce clone (historique
reconstruit). Il n'est jamais compté comme réussi. L'échec `localStorage`
provenait de Node 26 sans `--localstorage-file` : un `Storage` mémoire partagé
est installé dans le test, l'assertion « aucun jeton stocké » garde son sens.

## 8. Migrations et déploiement nécessaires

1. `supabase/migrations/20261120190000_studio_endpoint_resolution.sql`
   (preuve d'endpoint, hash de spec, invalidation d'attestation, validateur).
2. `universal-catalog` (artefact `df066d8f…`), puis `studio-runtime`
   (`8445e7ce…`) — l'ordre est sûr, la migration accepte encore `v4`.
3. `worker task=catalog` puis `worker task=details` (fiches à jour), puis
   `worker task=integrations` pour écrire les 867 évaluations réelles.

## 9. Risques résiduels

- **Écart de source** : la mesure locale porte sur le catalogue public au
  2026-11-20 ; une fiche modifiée entre-temps changerait son statut. Le worker
  re-mesurera sur la base réelle — c'est lui qui fait foi.
- **3D** : `.glb` est conservé et téléchargeable, mais n'est pas prévisualisé
  dans le Studio (lien de téléchargement). Aucun rendu 3D n'est promis.
- **144 blocages** : aucun ne se lève sans une preuve fournisseur
  supplémentaire (contrat de réponse documenté, endpoint publié, runtime ZIP)
  ou sans sortir du périmètre Studio.
- **Activation** : 0 modèle opérationnel. Elle exige, par modèle, une
  configuration runtime (crédits, coût plafond, plans autorisés) et un test
  fournisseur réel — donc une autorisation de dépense.

## 10. Coût de publication

- Migration + Edge Functions Supabase : **0 crédit** fournisseur, aucun débit
  client. Les 867 GET de fiches et l'OpenAPI sont publics et gratuits.
- Frontend inchangé : **0 crédit Netlify** consommé par cet incrément.
- Le seul coût à venir est le test fournisseur réel, modèle par modèle, à
  autoriser explicitement (aucun n'a été lancé).
