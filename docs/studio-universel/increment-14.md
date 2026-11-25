# Incrément 14 — des modèles préparés aux générateurs configurables

Mesure du 2026-11-20, sur le code du dossier de travail. Aucun déploiement,
aucune écriture Supabase, aucune génération payante, aucun crédit consommé.

## 1. Ce qui a changé dans cet incrément

Jusqu'ici, un modèle « préparé » ne pouvait pas devenir un générateur : deux
données **officielles** nécessaires au devis étaient jetées à l'ingestion
(le prix déclaré et l'endpoint d'estimation), et aucune fonction serveur ne
savait remplir une configuration runtime. C'est corrigé.

| Fichier | Rôle |
|---|---|
| `supabase/functions/universal-catalog/details.ts` | Conserve le prix déclaré (`cost`, USD uniquement) et l'endpoint d'estimation **de ce modèle**, avec provenance. Un prix nul, non-USD ou un endpoint visant un autre modèle ne sont jamais convertis : ils restent absents. |
| `supabase/migrations/20261120210000_studio_runtime_prepare.sql` | Colonne validée `provider_pricing`, conversion USD → crédits depuis la grille serveur, `studio_prepare_runtime`, `studio_prepare_runtime_batch`, `studio_runtime_readiness`. |
| `supabase/functions/studio-runtime/handler.ts` | Tâche worker `prepare_runtime` : prépare en lot après déploiement. |
| `scripts/evaluate-runtime-readiness.mjs` | Rejoue la même décision hors-ligne sur les 867 références : combien de configurations sont persistables, et pourquoi les autres ne le sont pas. |

### Pourquoi les prix sont désormais persistés

Le runtime ne peut pas devisier sans deux choses : un coût fournisseur estimé
et un plafond (`max_cost_usd`). Le commentaire historique de `catalog.ts`
(« ne jamais persister les prix fournisseur ») visait le snapshot public : il
reste vrai. La fiche détaillée conserve maintenant le prix **déclaré**, dans une
colonne dédiée, validée par contrainte (`cost_usd` > 0, ≤ 1000, devise `USD`,
endpoint d'estimation conforme), avec sa source et son horodatage. Aucun prix
n'est déduit d'un nom de modèle : un prix absent reste absent.

### Conversion USD → crédits (aucun tarif inventé)

La seule grille existante, `ugc_app_settings.studio_pricing_config`
(`usd_to_xof = 620`, `credit_value_xof = 100`, `target_margin_percent = 60`,
`processing_cost_usd = 0.01`), est relue en base à chaque calcul :

```
retail_xof = cost_usd × usd_to_xof × (1 + marge/100) + processing_cost_usd × usd_to_xof
crédits    = plafond(retail_xof / credit_value_xof)
```

Si la grille manque, la préparation **refuse** (`studio_pricing_not_configured`)
au lieu de calculer un prix par défaut. Exemples réels : 0,025 USD → 1 crédit,
0,10 USD → 2, 0,50 USD → 6, 2,00 USD → 21. Sur les 683 modèles configurables,
la médiane est de 1 crédit et le maximum de 93.

## 2. Ce que fait exactement `studio_prepare_runtime`

Elle écrit, pour un modèle donné : `credits`, `max_cost_usd` (= le coût déclaré,
sans marge inventée), `quota_kind`, `output_kind`, `estimate_path`, et
l'adaptateur (`muapi_prediction_v1`, déjà constant). Elle **ne fait jamais** :

- `enabled = true` (testé : la fonction échoue si une ligne se retrouve activée) ;
- `verified_at` / `verified_hash` (un test fournisseur payant est requis) ;
- un prix, un quota ou un endpoint qu'elle n'a pas prouvés.

Elle **invalide** une validation antérieure dès qu'un prix, un endpoint ou un
output change : `enabled=false`, `verified_*` remis à zéro, `revision+1`. Une
configuration ne peut donc pas être « vérifiée » puis modifiée en silence.

Refus explicites et testés : `integration_not_prepared`, `provider_pricing_missing`,
`estimate_endpoint_missing` (y compris un endpoint visant un autre modèle),
`quota_policy_missing`, `studio_pricing_not_configured`, `cost_out_of_range`.

## 3. Résultat mesuré sur les 723 modèles préparés

| | Nombre |
|---|---:|
| Préparés (incrément 13) | 723 |
| **Configurations runtime persistables automatiquement** | **683** |
| Non configurables | 40 |
| Opérationnels aujourd'hui | **0** |
| Disponibles dans le Studio aujourd'hui | **0** |

Motifs des 40 refus (mesurés, pas estimés) :

| Motif | Modèles | Détail |
|---|---:|---|
| `QUOTA_POLICY_MISSING` | 37 | 26 audio (`Text to Audio`), 6 LoRA d'inférence, 3 texte→3D, 2 cas isolés |
| `PROVIDER_PRICING_NOT_DECLARED` | 3 | `add-image-watermark`, `add-video-watermark`, `gemini-omni-character` : prix absent de la fiche officielle |

Répartition par famille (préparés / configurables / crédits médians) :

| Famille | Préparés | Configurables | Crédits médians |
|---|---:|---:|---:|
| Image → vidéo | 148 | **148** | 6 |
| Édition vidéo | 135 | 134 | 11 |
| Texte → vidéo | 112 | **112** | 7 |
| Texte → image | 83 | 82 | 1 |
| Multimodal / texte | 91 | **91** | 1 |
| Édition image | 66 | 65 | 1 |
| Audio et musique | 27 | 1 | 1 |
| Amélioration image | 26 | 25 | 1 |
| Voix / lip-sync | 9 | **9** | 3 |
| Avatar | 8 | **8** | 4 |
| LoRA (inférence) | 6 | 0 | — |
| Image → 3D | 5 | **5** | 6 |
| Texte → 3D | 3 | 0 | — |
| Vidéo → vidéo | 3 | **3** | 3 |
| Image → image | 1 | 0 | — |

Familles **techniquement terminées** (toutes les fiches préparées sont
configurables) : image→vidéo, texte→vidéo, multimodal/texte, lip-sync, avatar,
image→3D, vidéo→vidéo.

## 4. Pourquoi 0 générateur opérationnel, et ce qu'il faut décider

`assessment()` exige, pour être opérationnel : endpoint prouvé, schéma
supporté, prix + plafond, quota cohérent, endpoint d'estimation vérifié,
adaptateur constant, **`verified_at` + `verified_hash` = hash de la spec**,
`enabled`, accès fournisseur confirmé, et un plan autorisé. La préparation
remplit les quatre premiers ; les quatre derniers ne peuvent pas l'être sans
toi :

| Porte | Ce qu'il faut |
|---|---|
| `ACCESS_UNCONFIRMED` | Une clé `MUAPI_API_KEY` dans l'environnement du worker (le probe de catalogue authentifié confirme l'accès). Absente ici : aucun modèle ne peut être déclaré accessible. |
| `PLAN_UNAVAILABLE` | Quels plans ont droit à quoi (`allowed_plans`). Décision commerciale, laissée vide par défaut. |
| `PAID_VALIDATION_PENDING` | Un test fournisseur réel, payant, par modèle — puis `studio_runtime_attest` avec la référence. Aucun test n'a été lancé. |
| `ADMIN_DISABLED` | L'activation explicite, après le test. Jamais automatique. |

**Décision n°1 — quotas audio / 3D / LoRA.** Le système de quotas de plans ne
connaît que `script`, `video`, `image` (et `export`/`prompt` côté produit).
`Text to Audio` n'obtient donc aucun quota : 26 modèles audio restent bloqués,
et l'audio consommerait sinon un quota vidéo par décret technique, ce qui est
une décision produit, pas une correction de code. Même question pour les 3 LoRA
d'inférence et les 3 modèles texte→3D. À noter aussi : `Image to 3D` est
aujourd'hui rattaché au quota **image** (la catégorie contient « Image ») — à
confirmer ou corriger.

**Décision n°2 — plans autorisés.** Par défaut `allowed_plans = '{}'` : personne
ne peut l'utiliser. Il faut la politique (par exemple : les 683 sur Creator et
au-dessus, ou seulement une sélection).

## 5. Isolation des 89 références hors périmètre

Elles ne sont pas « bloquées par un adaptateur manquant » : ce ne sont pas des
générateurs. Publication sociale (`*-publish`, `youtube-*`), bac à sable,
modération, transcription, agents JSON. La vue d'administration les distingue
désormais explicitement (`scope = 'tool'` quand `group_of` vaut `utility` ou
`moderation`) au lieu de les compter comme des générateurs à venir.

## 6. Tests

| Contrôle | Résultat |
|---|---|
| `npx vitest run` | **205 fichiers, 3271 réussis, 0 échec**, 2 skipped |
| `npx tsc -b` | 0 erreur |
| `npx tsc -p tsconfig.edge.json --noEmit` | 0 erreur |
| `npm run check:edge-imports` | conforme |
| `npm run build` | OK |
| Artefacts Edge | régénérés, `--check` conformes (`studio-runtime ae1468de…`, `universal-catalog 96137380…`) |

Nouveaux tests (`tests/studio-runtime-prepare-migration.test.ts`, 12 cas, PGlite) :
configuration complète écrite sans activation ; idempotence (révision et valeurs
inchangées) ; refus sans prix / sans estimation / non préparé **sans laisser de
ligne partielle** ; refus audio faute de politique de quota ; invalidation d'une
validation payée quand le prix change ; lot avec motifs exacts ; lecture
service-only ; contraintes de forme sur la preuve tarifaire ; endpoint
d'estimation visant un autre modèle refusé ; effacement d'un prix qui n'est plus
déclaré.

Les deux tests `store-import-artifact` restent **skipped** avec leur raison
(commit épinglé absent de ce clone), comme convenu.

Crédits et remboursements : les suites existantes (`studio-wallet-invariants`,
`provider-spend-caps`, `studio-runtime-database`, `studio-text-runtime`) passent
sans modification.

## 7. Lot de publication (rien n'a été appliqué)

1. `20261120190000_studio_endpoint_resolution.sql`
2. `20261120210000_studio_runtime_prepare.sql`
3. `universal-catalog` (`96137380…`) puis `studio-runtime` (`ae1468de…`)
4. `worker task=catalog` → `worker task=details` (persiste prix + estimation)
   → `worker task=integrations` (867 évaluations) → `worker task=prepare_runtime`
5. Renseigner `allowed_plans` et lancer les tests fournisseur réels autorisés,
   puis activer modèle par modèle.

Coût : 0 crédit fournisseur, 0 débit client, frontend inchangé donc 0 crédit
Netlify. Le seul coût à venir est le test fournisseur réel, à autoriser.

## 8. Risques résiduels

- Les 683 configurations sont mesurées sur les fiches publiques du 2026-11-20 ;
  le worker re-mesurera sur la base réelle, et c'est lui qui fera foi.
- Un modèle dont le prix déclaré change verra sa vérification invalidée : c'est
  voulu, mais cela peut désactiver un générateur en production — à surveiller.
- `provider_pricing` introduit une donnée tarifaire en base : elle est validée,
  sourcée et utilisée uniquement pour le plafond et le calcul de crédits.
- Aucun test fournisseur réel n'a eu lieu : la chaîne devis → soumission →
  résultat des 683 modèles reste **non prouvée en production**.
