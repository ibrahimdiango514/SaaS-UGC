# Phase 4 — Moteur d’export vidéo professionnel (`Reelora`)

> **Date :** 2026-11-09  
> **Branche de session :** `arena/147ca0c8-saas-ugc` (appuyée sur Phase 1, Phase 2 `a30ee86` et Phase 3 `db4b373` ; `main` intact ; PR #3 laissée ouverte et non fusionnée)  
> **Portée :** remplacement du moteur d’export basique par un pipeline de rendu vidéo professionnel multi-moteurs produisant de vrais fichiers vidéo vérifiés (`MP4` H.264/AAC et `WebM` VP9/Opus), avec sonde matérielle par résolution, mixage audio haute précision, interface complète d’export et spécification locale d’architecture de rendu serveur non déployée.

---

## 1. Architecture technique du moteur d’export (`src/studio/editor/`)

### 1.1 Moteur principal : WebCodecs + Multiplexeurs binaires + `OfflineAudioContext`
Implémenté dans `src/studio/editor/render.ts`, `src/studio/editor/exportConfig.ts` et `src/studio/editor/audioMixer.ts` :

- **Vidéo (`VideoEncoder` + `mp4-muxer@5.2.2` / `webm-muxer@5.1.4`) :**
  - Rendu image par image déterministe (`renderCompositeFrame` à cadence fixe `24`, `30` ou `60 ips`) avec seek exact (`seekVideoExact`) sur les clips source.
  - Respect strict de l’ordre des scènes, des trims (`trimStart`), des transitions (`cut`, `fade`, `dissolve`, `slide` avec `transitionDuration`), du mode d’adaptation (`cover` / `contain`), des sous-titres synchronisés (`subtitleStart` / `subtitleEnd`, style `pill` / `box` / `outline`, position et casse) et de la durée totale.
  - Encodage matériel/logiciel via `VideoEncoder` (`avc1.640028` / `avc1.4D002A` / `avc1.42001E` pour MP4 ; `vp09.00.41.08` / `vp8` pour WebM), puis multiplexage binaire en mémoire (`fastStart: 'in-memory'` sur `mp4-muxer` pour un fichier MP4 immédiatement lisible et seekable).
  - Libération systématique de chaque `VideoFrame` et `AudioData` juste après encodage (`try ... finally { frame.close() }`).

- **Audio (`OfflineAudioContext` + `AudioEncoder`) :**
  - Planification pure et testable (`planAudioTimeline` dans `src/studio/editor/audioMixer.ts`) des pistes de clips, de la voix off (`startAt`, `trimStart`, `volume`) et de la musique (`startAt`, `trimStart`, `volume`).
  - Mixage offline haute précision (`mixProjectAudioOffline`) générant des rampes progressives d’atténuation (`ducking`) à `DUCKING_FACTOR = 0.30` sur la musique et les clips durant les plages actives de voix off.
  - Encodage AAC (`mp4a.40.2`) ou Opus (`opus`) synchronisé avec la piste vidéo.

### 1.2 Moteur de repli automatique : `MediaRecorder` + Web Audio API
- Utilisé uniquement lorsque `WebCodecs` (`VideoEncoder`) n’est pas disponible dans le navigateur, mais que `MediaRecorder` et `HTMLCanvasElement.prototype.captureStream` sont présents et qu’un codec conteneur (`video/webm;codecs=vp9,opus`, `video/webm;codecs=vp8,opus`, `video/mp4`) est réellement supporté.
- Synchronise les clips, transitions, sous-titres, voix off, musique et ducking dynamique en temps réel sur un `MediaStream` unifié.
- Rétablit de manière stricte les garde-fous de durée, d’audio absent (`!project.audio`) et d’annulation (`AbortSignal`).

### 1.3 Sonde matérielle honnête & vérification des fichiers produits
- **`probeExportCapabilities(aspect, fps)` (`exportConfig.ts`) :**
  - Interroge `VideoEncoder.isConfigSupported(...)` pour les dimensions **exactes** de chaque résolution (`720p`, `1080p`, `4k`) selon le ratio (`9:16`, `16:9`, `1:1`).
  - **Règle absolue :** une résolution (notamment `4k` : `2160×3840`, `3840×2160`, `2160×2160`) ou un conteneur (`MP4` / `WebM`) n’est **jamais** proposé comme actif si `isConfigSupported` ou `MediaRecorder.isTypeSupported` échoue.
- **`verifyVideoBlob(blob, expectedContainer)` (`exportConfig.ts`) :**
  - Vérifie avant toute déclaration de succès que le `Blob` n’est ni vide ni factice (taille ≥ 128 octets et signatures d’en-tête ISO BMFF `ftyp` pour MP4 ou EBML `0x1A 0x45 0xDF 0xA3` pour WebM).
  - En cas de fichier corrompu, vide ou d’erreur d’encodage, lève une erreur typée `RenderError` (`EMPTY_OUTPUT`, `CODEC_UNSUPPORTED`, `MEDIA_LOAD_ERROR`, `DECODE_ERROR`, `ENCODER_ERROR`, `ABORTED`, `INVALID_PROJECT`).

---

## 2. Expérience utilisateur, sécurité & sauvegarde (`ExportPanel.tsx` & `VideoEditor.tsx`)

- **Nouveau panneau dédié (`src/studio/editor/components/ExportPanel.tsx`) :**
  - Choix du ratio (`9:16`, `16:9`, `1:1`), résolution (`720p`, `1080p`, `4k`) avec désactivation individuelle et justification technique par résolution, qualité (`standard`, `high`, `ultra`), cadence (`24`, `30`, `60 ips`) et conteneur (`MP4`, `WebM`).
  - Estimation transparente avant lancement (`estimateExportMetrics`) : dimensions exactes en pixels, débit cible, durée, estimation de taille (Mo) et durée approximative du rendu.
  - Machine à états explicite (`ExportPhase`) : `idle` → `preparing` → `rendering` → `finalizing` → `succeeded` / `failed` / `cancelled`.
  - Barre de progression réelle, bouton **Annuler** opérationnel à tout instant, bouton **Réessayer** en cas d’erreur ou d’annulation.
  - **Double sécurité :** verrou `renderLockRef` partagé entre **Lancer le rendu** et **Enregistrer et exporter** (atomique même pendant la sauvegarde asynchrone) empêchant tout double lancement.
  - **Aperçu post-rendu intégré (`<video controls>`)** avec nettoyage automatique des URLs `blob:` (`URL.revokeObjectURL`) + téléchargement réel du fichier vidéo et des sous-titres `.srt`.
  - **Préservation des données & zéro coût :** sauvegarde avant export via **Enregistrer et exporter**, montage conservé intact en cas d’échec ou d’annulation, protection `beforeunload` si un rendu est en cours ou non enregistré, **0 crédit débité** pour tout export local.

---

## 3. Architecture étudiée pour le rendu serveur (`src/studio/editor/serverRenderSpec.ts`)

Un module déclaratif local (`assessServerRenderNeed`, `buildServerRenderManifest`) évalue quand un rendu serveur devient souhaitable (navigateur dépourvu d’encodeurs, export `4K` ou montage long `> 60 s` sur appareil modeste) et génère un manifeste de job déterministe prêt pour un futur worker FFmpeg.

**État actuel transparent :**
- `serverEngineDeployed: false` — **aucun worker serveur n’est déployé** et aucun service payant ni aucune Edge Function supplémentaire n’a été mis en ligne.
- **Prérequis d’infrastructure à valider explicitement avant un éventuel déploiement ultérieur :**
  1. Conteneur/worker dédié doté de **FFmpeg** (`libx264` / `aac`) — hors limite mémoire/CPU des Supabase Edge Functions classiques (ex. Fly.io, Cloud Run ou VPS dédié) ;
  2. Stockage privé Supabase (`ugc-assets` ou bucket `ugc-exports` dédié avec politiques RLS strictes par `workspace_id`) pour recevoir les rendus terminés et délivrer des URLs signées ;
  3. Table de file de jobs asynchrone + secret d’authentification inter-services (`RENDER_WORKER_SECRET`) ;
  4. Règle de facturation éventuelle validée séparément (l’export local reste à **0 crédit**).

---

## 4. Vérifications et tests effectués (`tests/export-phase4.test.tsx`)

Conformément aux exigences de transparence, voici la séparation stricte des vérifications exécutées :

1. **Logique pure & génération binaire réelle (`vitest`) :**
   - Calcul exact des 9 combinaisons `(ratio × résolution)` : `9:16`, `16:9`, `1:1` × `720p`, `1080p`, `4k`.
   - Planification audio multi-pistes, trims, décalage `startAt`, et fenêtres de ducking (`DUCKING_FACTOR = 0.30`) + montages longs (`72 s`).
   - Multiplexage binaire réel via `mp4-muxer` et `webm-muxer` validé par `verifyVideoBlob()` (octets `ftyp` MP4 et EBML WebM), et rejet strict des blobs vides ou HTML.
   - Évaluation du besoin serveur (`serverRenderSpec.ts`) avec `creditsChargedForLocalExport = 0`.
2. **Moteur de rendu & UI sous `jsdom` (APIs navigateur simulées) :**
   - Sonde de capacités refusant `4K` et `WebM` lorsqu’ils ne sont pas supportés par `VideoEncoder.isConfigSupported`.
   - Exécution complète `renderVideo` sur `9:16`, `16:9` (transition `fade` + sous-titres `pill`) et `1:1` (transition `slide` + sous-titres `outline`) avec mocks explicites de `VideoEncoder`, `AudioEncoder`, `VideoFrame`, `AudioData`, `OfflineAudioContext` (vérifiant les rampes de ducking), annulation `AbortController` et nettoyage des éléments `<video>`.
   - Repli `MediaRecorder` (avec et sans pistes audio) + rejet `CODEC_UNSUPPORTED` sans faux fichier lorsque tout encodeur est absent + rejet des erreurs média/CORS.
   - UI `ExportPanel` et `VideoEditor` sur desktop et mobile (`390 px`) : protection atomique anti-double-clic, sauvegarde avant export, aperçu `<video controls>` et téléchargement.
3. **Limites de l’environnement sandbox :**
   - Aucun navigateur Chromium/Playwright ni binaire `ffmpeg` n’étant installé dans cette sandbox Linux, **aucun encodage vidéo matériel réel dans Chrome/Safari ni aucune lecture réelle d’un MP4 généré par un navigateur n’a été exécutée dans ce bac à sable**. Le build de production complet (`dist/`) reste servi et vérifié sur `0.0.0.0:4173`.
