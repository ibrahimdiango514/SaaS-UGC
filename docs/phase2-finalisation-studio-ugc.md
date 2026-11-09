# REELORA — Phase 2 : finalisation du Studio UGC

**Branche** : `arena/e22e624f-saas-ugc` (active). **Main** : inchangée. **PR** : ouverte uniquement après la fin des tests, non fusionnée. **Aucune génération vidéo n’a été exécutée ni validée pendant cette phase.**

Ce rapport distingue strictement :

1. les **vérifications live antérieures** (phase de validation MuAPI, déjà livrée) ;
2. l’**audit DB en lecture seule** effectué au début de la Phase 2 ;
3. les **tests et captures simulés** de la Phase 2, qui ne prouvent aucune exécution MuAPI live.

---

## 1. Vérifications live antérieures — rappel, non répétées

Ces résultats appartiennent à la phase précédente (`3b99f98`, `27b2ab9`) et n’ont **pas** été refaits en Phase 2 :

- catalogue authentifié : **415** modèles retournés, **236** actifs Reelora, **179** indisponibles (`176` entrées requises non connectées + `3` `coming_soon`) ;
- **4** fiches `model-detail` consultées ; **3** devis `estimate_cost` exacts, sans génération ;
- Rapide `wan2.2-5b-fast-t2v` : **9 crédits UGC / 0,020 USD** ;
- Standard `seedance-2.5-spicy-text-to-video` : **16 crédits UGC / 1,870 USD** ;
- Premium `seedance-2.5-spicy-text-to-video-4k` : **36 crédits UGC / 9,350 USD** ;
- **142 tests**, `ugc_generation_jobs=0`, `ugc_generated_assets=0`, `probe_ledger=0`, aucune génération ni dépense.

Ils servent de **références factuelles** aux fixtures Phase 2. Les captures Phase 2 ne sont pas des sondes live.

---

## 2. Audit Phase 2 — lecture seule, aucune mutation

Requêtes `SELECT` sur `saas_ugc.ugc_video_models` via le connecteur Supabase, sans création de compte, sans POST MuAPI, sans déploiement :

| Mesure | Résultat | Interprétation |
|---|---:|---|
| `total` | 415 | références du catalogue synchronisé |
| `active_compatible` | 412 | lignes `active && is_enabled && !is_coming_soon` |
| `coming_soon` | 3 | non sélectionnables |
| `unsupported_required` | 176 | `required_fields` non connectés par Reelora |
| **actifs Reelora** | **236 = 412 − 176** | sélectionnables dans le parcours actuel |
| `dynamic_pricing` | 412 | devis `estimate-cost` déclaré |
| `estimate_endpoint` | 412 | endpoint de devis déclaré |
| `input_fields.aspect_ratio` | 251 | capacité déclarée |
| `input_fields.resolution` | 208 | capacité déclarée |
| `input_fields.duration` | 333 | capacité déclarée |
| `param_schema` typés `select` | 3 / 3 / 4 | ratio / résolution / durée |
| `min_cost` / `max_cost` | 0,0000 / 9,3500 USD | le `0,0000` réel concerne `add-video-watermark`, non sélectionnable (`video_url`, `watermark_image_url`) |
| `missing_cost` | 0 | aucun coût catalogue manquant |
| catégories des 412 lignes | 8 | dont 5 catégories parmi les 236 actifs Reelora |

Répartition des **236 actifs Reelora** : `Image to Video` 118, `Text to Video` 109, `Video to Video` 4, `Lora Support` 3, `Training` 2.

Point corrigé : `selectOptions()` exigeait `type === 'select'` alors que la plupart des schémas synchronisés déclarent `aspect_ratio` / `resolution` / `duration` en `string` ou `number` avec ou sans `options`. La Phase 2 accepte désormais toute **option réellement déclarée**, quel que soit son type, et n’invente jamais `9:16`, `720p` ou une durée lorsque le schéma synchronisé ne publie ni option ni borne. Les valeurs exactes restent chargées via `model-detail` côté serveur.

Contrôle final lecture seule : `catalog_rows=415`, `jobs=0`, `assets=0`, `ledger_rows=2` (deux bonus d’inscription préexistants), `phase2_ledger_rows=0`, `signup_bonus={"credits":9,"enabled":true}`. Edge `reelora-video` toujours **v6 ACTIVE**, `verify_jwt=true`, correctif local non déployé.

---

## 3. Modifications livrées

### 3.1 Sélection, catégories, formats, durées, résolutions

- Nouveau module pur `src/studio/catalog.ts` : filtres, recherche multi-token, 8 catégories réelles, statuts, capacités, tarification, tri, compteurs, résumé USD/crédits, garde de confirmation.
- `CatalogBrowser` réécrit sans supprimer les fonctions existantes :
  - recherche nom / famille / identifiant / catégorie / capacité ;
  - filtres **statut**, **capacité** (ratio, résolution, durée, audio, image), **tarification** (dynamique / catalogue), **tri** (catalogue, coût croissant/décroissant, nom) ;
  - compteurs par catégorie recalculés selon les autres filtres, bouton de réinitialisation, pagination `+36` ;
  - badges de capacités construits **uniquement** depuis `input_fields` et les options déclarées ;
  - états explicites : chargement (`catalog-loading`), catalogue vide (`catalog-empty`), aucun résultat (`catalog-no-results`), erreur fournisseur (`catalog-provider-error`), schéma en cours (`catalog-detail-loading`), erreur de devis (`catalog-quote-error`) ;
  - cartes incompatibles visibles mais **non sélectionnables**, avec motif verrouillé ;
  - mise en page mobile `grid-cols-2` pour les filtres, desktop `lg:grid-cols-[minmax(0,1fr)_340px]`.
- `quality.ts` : `catalogByCost` n’utilise plus `NaN → 0` comme coût ; un prix inconnu n’est jamais classé « plus économique ». `qualityTierSummary()` expose la correspondance exacte **Rapide / Standard / Premium → service + crédits + modèle réel**.
- `model.ts` / `DynamicParams.tsx` : options déclarées sur `string`/`number` respectées ; bornes `min`/`max` réelles uniquement ; champs structurés affichés comme **non connectés** ; aucune valeur de substitution.

### 3.2 Devis USD, crédits Reelora et confirmation

- `usableCostUsd`, `hasUsableProviderCost`, `providerQuoteCostLabel` : `null`, chaîne vide, `NaN`, `source='unavailable'` et `provider_quote_error` donnent **« devis fournisseur à confirmer »** ; jamais `0.000 USD` factice.
- `creditSummary()` : les crédits viennent du serveur, le coût USD du fournisseur est affiché séparément, **aucune conversion USD → crédits**. Un modèle dynamique exige `provider_quote_source='estimate_cost'` ; un tarif catalogue est factuel mais explicitement « devis exact non disponible » et ne déclenche pas de génération pour un modèle dynamique.
- `CostConfirm` et `canConfirmGeneration()` : checkbox explicite, `service_active`, `model_available`, solde suffisant, devis confirmé, absence de `blockedReason` ; aucun `?? 0` sur les crédits.
- `GenerationStudio` : panneau **Rapide / Standard / Premium**, note « aucune conversion », avertissement de devis à confirmer, blocage de `onConfirm` si `summary.canReserve` est faux ; `providerQuoteOriginLabel` conservé.
- `PromptBar` : résumé USD + crédits, avertissement mobile, bouton de génération désactivé tant que le devis n’est pas confirmé, note de non-conversion.
- Parcours historiques `src/pages/Studio.tsx` et `src/studio/VideoStudio.tsx` : `estimateVideo` reçoit désormais les **mêmes paramètres et prompt** que la génération, utilise `creditSummary`, affiche « devis en cours » au lieu de `0`, et bloque le lancement sans devis confirmé. L’éditeur / montage (`VideoEditor`, `editor/*`, `planToEditorProject`) est **préservé**.

### 3.3 Sécurité et facturation

- Aucune modification RLS, aucun rôle, aucun secret frontend, aucun déploiement Edge ou production, aucune migration.
- `verify_jwt=true` conservé dans `supabase/config.toml` et confirmé côté Edge live.
- Réservation / capture / remboursement / idempotence existantes conservées ; les nouveaux tests les **simulent** en mémoire et vérifient aussi les garde-fous SQL (`on conflict ... do nothing`, `capture-job`, `release-job`, RPC `service_role`).

---

## 4. Tests obligatoires et tests simulés ajoutés

Commandes exécutées après toutes les modifications :

```text
npm run typecheck  ✅
npm test           ✅ 11 fichiers / 157 tests
npm run build      ✅ Vite 6.4.5, dist/assets/index-BNJht0P-.js 855,72 kB
```

`tests/studio-phase2.test.tsx` ajoute **15 tests** couvrant les 4 familles demandées, sans appel réseau ni génération :

1. **Devis indisponibles** : `null`, `0` sur `unavailable`, chaîne vide, `NaN`, erreur fournisseur, absence d’estimate → libellé « devis fournisseur à confirmer », `canReserve=false`, `canConfirmGeneration=false`, aucune chaîne `0.000 USD` fallacieuse.
2. **Erreurs fournisseur / états** : HTTP 503 simulé, `model_available=false`, 415 références / 236 actifs / 176 non connectés / 3 `coming_soon` en fixtures, chargement, catalogue vide, aucun résultat, filtres, tri avec prix inconnu en dernier.
3. **Paramètres incompatibles** : schéma synchronisé sans options → aucun `9:16`/`720p`/durée deviné ; options `string`/`number` respectées ; bornes réelles ; champs structurés non envoyés ; modèle `audio_url` exclu.
4. **Calculs de crédits** : 9 / 16 / 36 crédits avec devis USD 0,020 / 1,870 / 9,350 sans conversion ; portefeuille simulé avec réservation unique, capture uniquement sur succès, remboursement unique sur échec / annulation / expiration, absence de double débit et de découvert.

Tests existants mis à jour pour vérifier les nouveaux helpers (`creditSummary`, `providerQuoteOriginLabel`) au lieu de motifs de source devenus obsolètes.

---

## 5. Captures Phase 2 — **SIMULÉES / FIXTURES**

Dossier : `preview-phase2/`. Harnais Chromium avec session, catalogue, devis, erreurs et quota **entièrement interceptés**. Chaque image porte le filigrane :

> « SIMULÉ · FIXTURES PHASE 2 · aucune génération / aucun débit »

| # | Capture | Scénario |
|---:|---|---|
| 01 | `screenshots/01-studio-desktop-devis-exact.jpg` | Desktop 1440×1000 : devis exact 1,870 USD, 16 crédits UGC, trois niveaux réels |
| 02 | `screenshots/02-confirmation-desktop.jpg` | Modale de confirmation, checkbox cochée, aucun `start` |
| 03 | `screenshots/03-catalogue-filtres-desktop.jpg` | Recherche `seedance`, capacité ratio, devis dynamique, badges de capacités |
| 04 | `screenshots/04-studio-mobile-devis-exact.jpg` | Mobile 390×844 : USD + crédits, aucun chevauchement |
| 05 | `screenshots/05-studio-desktop-devis-indisponible.jpg` | HTTP 503 simulé : « devis fournisseur à confirmer », génération bloquée |
| 06 | `screenshots/06-studio-mobile-devis-indisponible.jpg` | Même état sur mobile |
| 07 | `screenshots/07-catalogue-fournisseur-indisponible.jpg` | Fournisseur indisponible + catalogue vide, aucun modèle fictif |
| 08 | `screenshots/08-catalogue-aucun-resultat.jpg` | Recherche sans résultat + réinitialisation des filtres |

`preview-phase2/verification.json` : **8/8** scénarios, **101** appels backend interceptés, `edgeActions=['catalog','estimate','health','model-detail']`, `startActions=0`, `muapiCalls=[]`, `consoleErrors=[]`, `pageErrors=[]`, `failedRequests=[]`, `jobsCreated=0`, `creditsSpent=0`, `realGenerationLaunched=false`. Galerie : `preview-phase2/gallery.html`.

---

## 6. Limites et non-faits

- **Aucune génération vidéo live n’a été lancée ni validée** en Phase 2 ; aucun `action=start`, aucun `reelora_start_generation`, aucun débit.
- Aucune nouvelle sonde MuAPI `catalog` / `model-detail` / `estimate` n’a été exécutée ; les valeurs live sont celles de la phase précédente.
- Le correctif local `provider_cost_usd=null` de `supabase/functions/reelora-video/index.ts` reste **non déployé** ; l’Edge live reste v6. Le frontend bloque désormais tout devis non confirmé, mais le déploiement Edge nécessiterait une nouvelle autorisation explicite.
- Les captures sont des fixtures navigateur, pas une preuve de droits d’exécution par modèle, ni une validation sur appareil mobile réel.
- Aucun déploiement production, aucune modification de `main`, aucune fusion, aucune modification RLS / rôle / secret / schéma destructif.
- `GROQ_API_KEY` absent → assistance IA non simulée ; aucun secret MuAPI côté frontend.
- Aucune migration Phase 2 ; seul le `GRANT SELECT` additif de la phase précédente reste en place.

---

## 7. Fichiers modifiés / ajoutés

**Source** : `src/studio/catalog.ts` (nouveau), `src/studio/model.ts`, `src/studio/quality.ts`, `src/studio/GenerationStudio.tsx`, `src/studio/VideoStudio.tsx`, `src/pages/Studio.tsx`, `src/studio/components/CatalogBrowser.tsx`, `CostConfirm.tsx`, `DynamicParams.tsx`, `PromptBar.tsx`.

**Tests** : `tests/studio-phase2.test.tsx` (nouveau), `tests/muapi.test.ts`, `tests/studio-v2.test.ts`.

**Livrables Phase 2** : `docs/phase2-finalisation-studio-ugc.md`, `preview-phase2/{gallery.html,verification.json,README.md,screenshots/01…08*.jpg}`.

**Non modifiés / préservés** : `src/studio/VideoEditor.tsx`, `src/studio/editor/*`, `src/studio/plan.ts`, `src/studio/components/AfterGeneration.tsx`, `PreviewStage.tsx`, `ModelCatalog.tsx`, routes, CSS, exemples, `supabase/config.toml`, migrations, RLS, secrets.

---

## 8. Git et PR

- Travail uniquement sur `arena/e22e624f-saas-ugc`.
- `main` / `origin/main` restent à `cee9e5aebf2b7cee3ea552b17b4a4deafea112ef`.
- Commit final de la branche : identifiant communiqué dans la réponse finale (aucun hash auto-référent dans ce fichier).
- PR ouverte depuis la branche active après `typecheck`, `test`, `build`, captures et vérification no-spend ; **PR non fusionnée** conformément à la consigne.
