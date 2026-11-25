# Increment 12 — résolution des conflits d'endpoints et déblocage générique

Date : 2026-11-20 (UTC). Branche de travail : `freebuff/muapi-reprise`, créée sur `main`
`318adca` (PR #44). **Aucun déploiement, aucune migration distante, aucun débit.**

## 1. État réel constaté avant ce lot

Le travail de l'agent précédent est bien présent, mais sur `main` : `develop` était
13 commits en retard et ne contenait ni `studio_ai_models`, ni `studio-runtime`, ni
les PR #32 → #44. Le lot a donc été repris depuis `main`, pas depuis zéro.

`studio_model_integrations` (mesure atomique en lecture seule, identifiant
`muapi-live-20261120T1831Z`, source : connecteur Supabase officiel en lecture seule) :

| Indicateur | Valeur |
|---|---:|
| Références catalogue | **867** (861 au relevé de 18:03, +6 synchronisées à 18:17) |
| `integration_prepared` | **616** |
| `blocked` | **251** |
| Configurations runtime | **0** |
| Modèles `studio_enabled` | **0** |
| Opérationnels / activés | **0** |

Répartition des blocages (un modèle peut en cumuler) : `RESPONSE_CONTRACT_UNSUPPORTED`
207 · `OUTPUT_FORMAT_UNSUPPORTED` 112 · `ENDPOINT_CONFLICT` 46 ·
`UPLOAD_FORMAT_UNSUPPORTED` 24 · `SCHEMA_UNSUPPORTED` 13 ·
`OPENAPI_OPERATION_UNCONFIRMED` 11, plus les deux portes universelles
`CONSTRAINT_REVIEW_REQUIRED` et `REAL_TEST_PENDING` (867 chacune).

## 2. Incident 403 — voie autorisée retenue

L'export global des fiches via la passerelle du sandbox reste refusé (403) et n'a pas
été contourné. La réconciliation utilise désormais **le connecteur Supabase officiel en
lecture seule** (même projet `xbuuhfwobrafcbgtdgjx`) : agrégats et sous-ensembles
strictement nécessaires, aucune écriture, aucun transfert de masse inutile. Le résolveur
est ensuite exécuté localement sur ces déclarations + l'OpenAPI public officiel
(`GET https://api.muapi.ai/openapi.json`, gratuit).

## 3. Conflits d'endpoints — mécanisme implémenté

`supabase/functions/universal-catalog/endpoint.ts`

- Le résolveur reçoit désormais le document OpenAPI officiel (4e argument).
- Règles de résolution, dans cet ordre :
  1. une seule déclaration ⇒ inchangé ;
  2. preuve déjà enregistrée et déclarations identiques ⇒ rejeu à l'identique ;
  3. **exactement un chemin POST documenté** ⇒ `openapi_single` ;
  4. **exactement deux chemins POST documentés et contrats fonctionnels identiques**
     (`requestBody`, `responses`, `tags` — seuls `operationId`/`summary`/`description`
     peuvent différer) ⇒ `openapi_equivalent_contracts`, chemin canonique = celui qui
     porte le nom du modèle, sinon ordre lexical ;
  5. sinon ⇒ `conflict` (aucune supposition).
- Les déclarations d'origine sont conservées (`declared_paths`), les chemins documentés
  aussi (`documented_paths`), avec `operation_id`, empreinte de contrat et SHA-256 du
  document.
- Une preuve enregistrée n'est honorée que si **les déclarations courantes sont
  exactement celles de la preuve** ; sinon elle est ignorée et tout est re-résolu.

`supabase/functions/studio-runtime/families.ts` : version de protocole `muapi-families-5`,
`endpoint_resolution` exposé dans `openapi_evidence` (objet **déterministe**, sans
horodatage : un document inchangé n'invalide rien).

`supabase/migrations/20261120190000_studio_endpoint_resolution.sql`

- `studio_save_integration` persiste la preuve sur `studio_ai_models.endpoint_evidence`,
  recalcule le hash **après** persistance (la ligne d'intégration ne retarde jamais sur
  la preuve), et **invalide** `studio_runtime_configs` (`enabled=false`,
  `verified_hash/verified_at=null`, `revision+1`) dès que le chemin, l'empreinte de
  contrat, le protocole ou l'adaptateur change.
- `ugc_private.studio_spec_hash` intègre désormais `resolution.path` et
  `contract_fingerprint` : une attestation liée à une ancienne preuve devient
  automatiquement invalide.
- Validation stricte de la preuve (chemin sûr, statut, libellé, SHA-256, tableaux bornés) :
  toute preuve anormale lève `invalid_report` au lieu d'être devinée.
- Aucune activation : `studio_enabled`, configurations et crédits inchangés.

### Mesure réelle de la réconciliation (46 conflits)

Script reproductible : `node scripts/reconcile-muapi-endpoints.mjs`
(fixture `tests/fixtures/muapi-endpoint-conflicts-20261120.json`, OpenAPI officiel).

| Résultat | Nombre |
|---|---:|
| Conflits traités | 46 |
| Résolus — un seul POST documenté | **33** |
| Résolus — deux POST à contrats identiques (Seedance VIP) | **13** |
| Non résolus | **0** |
| Passent à `integration_prepared` | **21** |
| Restent bloqués par une autre cause | **25** (22 contrat de réponse, 2 entraînement/upload, 1 texte) |

Les 33 et 13 confirment exactement l'analyse de l'agent précédent, cette fois
**revérifiée sur l'OpenAPI officiel**.

## 4. Déblocage générique des sorties média (63 modèles)

Constat mesuré : de nombreux schémas déclarent explicitement **un seul champ URL**
(`output.video_url` titré « Video URL », etc.) mais ne répètent pas l'enveloppe générique
`id`/`status`. L'ancienne règle bloquait ces modèles pour une omission de fiche, pas pour
une ambiguïté de contrat.

- `protocolBinding` lie désormais `muapi_output_media_v1` / `_media_list_v1` /
  `_urls_v1` sur le champ de sortie réellement déclaré (format URI ou titre « … URL »),
  sans exiger la répétition de l'enveloppe.
- **Le parseur reste strict** : `familyResult` refuse tout résultat sans `id` conforme,
  sans `status` reconnu, ou hors `https`. Une enveloppe absente produit donc un échec
  explicite et un remboursement, jamais un faux succès.
- Aucun protocole n'est déduit d'un nom de champ : un champ non typé, deux champs URL
  concurrents ou un wrapper `output_data` non déclaré restent bloqués.

Effet attendu, calculé sur les formes de schémas réellement mesurées (modèles
actuellement bloqués avec `protocol = null`) : **50 modèles remplissent la condition**
(12 image→vidéo, 10 texte→vidéo, 9 édition vidéo, 6 texte→image, 6 audio, 4 édition
image, 2 LoRA, 1 lip-sync). Ce chiffre est un **décompte de schémas éligibles**, pas
encore un statut réévalué : il sera confirmé par le worker après déploiement.

## 5. LoRA d'inférence ≠ entraînement

`classifyFamily` : `Lora Support` ⇒ `lora-inference` (inférence). `Training` reste
`training` et reste bloqué (ZIP non pris en charge). Les modèles d'inférence LoRA dont
le contrat de sortie est déclaré redeviennent éligibles ; ceux qui exigent un champ
d'upload non connecté (`lora`, `zip`, `dataset`) restent bloqués par
`UPLOAD_FORMAT_UNSUPPORTED`.

## 6. Tests exécutés

| Contrôle | Résultat |
|---|---|
| `npx tsc -b` | ✅ 0 erreur |
| `npx tsc -p tsconfig.edge.json --noEmit` | ✅ 0 erreur |
| Artefacts Edge (`--check`) | ✅ régénérés et conformes |
| Suite complète `npx vitest run` | **3249 réussis / 3252**, 202 fichiers verts sur 204 |
| Nouveaux tests | `universal-endpoint-resolution` (14), `studio-generic-adapters` (8), `studio-endpoint-resolution-migration` (4, PGlite) |

3 échecs **préexistants**, reproduits à l'identique sur l'arbre `main` non modifié
(`/tmp/base-check`) : `mcp-connexions-page` (`window.localStorage` absent sous
Node 26) et deux contrôles `store-import-artifact` (artefact absent du commit épinglé).
Ils ne touchent pas ce lot et ne sont pas masqués.

## 7. Projection (à re-mesurer, ne pas confondre avec un statut)

Si l'on applique la migration puis redéploie `studio-runtime` + `universal-catalog` et
relance `worker task=integrations` : 616 + 21 (endpoints) + 50 (sorties média) ≈ **687
préparés** au maximum, sur 867. Les 180 restants exigent des contrats non pris en charge
(multimodal 60, texte 15, 3D, entraînement ZIP, wrappers ambigus). **Aucun modèle ne
devient opérationnel ou activé par ce lot** : tarification, plafonds, droits d'exécution
et attestation réelle restent requis.

## 8. Aucune dépense, aucun déploiement

Aucun appel de génération payant, aucun crédit client, aucun achat, aucune migration
distante, aucun déploiement Edge ou Netlify. Le frontend est inchangé : **aucun crédit
Netlify n'est consommé par ce lot**. Les deux fonctions Edge et la migration sont prêtes
à être déployées après autorisation.

## 9. Actions nécessaires (hors code)

1. Appliquer `20261120190000_studio_endpoint_resolution.sql` sur le projet principal.
2. Déployer `universal-catalog` (artefact `f10b12a4…`) puis `studio-runtime`
   (artefact `056d187c…`) — dans cet ordre, la fonction de sauvegarde acceptant encore
   `muapi-families-4` pendant la bascule.
3. Relancer le worker `task=integrations`, puis relever un nouveau snapshot atomique.
4. Pour toute activation réelle : prix en crédits, coût plafond USD, plans autorisés et
   autorisation financière pour le test fournisseur payant.
