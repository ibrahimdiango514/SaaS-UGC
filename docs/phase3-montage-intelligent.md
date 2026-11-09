# Phase 3 — Montage vidéo intelligent (`Reelora` / `AI Video Editor`)

> **Date :** 2026-11-09  
> **Branche de session :** `arena/147ca0c8-saas-ugc` (contenant les commits Phase 1 & Phase 2 jusqu’à `a30ee86` ; `main` intact ; PR #3 laissée ouverte et non fusionnée)  
> **Portée :** évolution directe de l’éditeur existant (`/app/studio/montage`) et de ses composants sans duplication ni régression sur le Studio V2 et le Studio classique.

---

## 1. Fonctionnalités implémentées

### 1.1 Médias réels du projet & hydratation (`src/studio/editor/projectMedia.ts`)
- Ouverture directe d’un projet depuis `/app/projets`, `/app/projets/:id` ou `/app/studio/montage?projet=<id>`.
- Hydratation prioritaire depuis `settings.reelora_editor_v1` avec re-signature des URLs privées (`ugc-assets`), et **hydratation automatique depuis les vraies données du projet** (`getProject`, `listScripts`, `listScenes`, `listAssets`, `listJobs`) si aucun montage éditeur n’a encore été sauvegardé — l’éditeur ne bascule plus sur un projet de démonstration lorsqu’un projet réel existe.
- Assemblage déterministe `assembleFromProjectMedia()` :
  - répartit plusieurs vidéos réelles ou découpe automatiquement un clip unique long sur plusieurs scènes (`hook` → `demo` → `proof` → `cta`) via `trimStart` distincts ;
  - n’invente jamais de média fictif si aucun asset réel n’est disponible.

### 1.2 Timeline interactive multi-pistes (`src/studio/editor/components/Timeline.tsx`, `src/studio/editor/types.ts`)
- Règle temporelle interactive avec lecture/pause, curseur temps réel (scrubbing), zoom (`1×`, `1.5×`, `2×`), raccourcis clavier (`Espace`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+S`) et pile Annuler / Rétablir (40 états).
- **4 pistes synchronisées :**
  - **Vidéo** : glisser-déposer pour réordonner, poignées de trim latérales avec bornage strict sur la durée source réelle du clip (`sourceDuration`), scission au curseur (`splitScene`), ajout (`addScene`), duplication (`duplicateScene`), suppression, recadrage (`cover` / `contain`), transitions (`cut`, `fade`, `dissolve`, `slide`) et durée de transition (`transitionDuration`).
  - **Sous-titres** : visualisation des spans actifs par scène et accès rapide à l’édition.
  - **Voix off** : piste dédiée (`voiceover`), import audio privé, capture micro navigateur réelle (`MediaRecorder`), volume, décalage `startAt`, `trimStart`, activation du ducking automatique.
  - **Musique / Ambiance** : piste musicale avec contrôle de volume, mute et ducking pendant la voix off.

### 1.3 Assistant de montage UGC intelligent (`src/studio/editor/assist.ts`, `src/studio/editor/components/AssistPanel.tsx`)
- **Séparation stricte entre analyse locale et IA serveur :**
  - Chaque règle locale porte `origin: 'local-deterministic'` et repose uniquement sur les données réelles du montage et des médias (`sourceDuration`, `mediaWidth`/`mediaHeight`, WPM du texte parlé, presets UGC).
  - Les presets de rythme UGC (`tiktok-fast` ~15 s, `ugc-balanced` ~24 s, `storytelling` ~35 s) ajustent dynamiquement les recommandations de découpage, durée de l’accroche, transitions et resserrage temporel.
  - Règles incluses : assemblage des médias du projet, ordre narratif UGC (`hook → demo → proof → cta`), rythme d’accroche, scission des plans longs, bornage de trim selon la durée réelle du média, synchronisation débit de parole (WPM) vs durée de scène, adaptation de cadrage (`aspect-fit`), ducking audio voix off / musique, sous-titres et rythme des transitions.
  - **Décision individuelle persistée sur chaque suggestion (`suggestionDecisions`)** :
    - **Accepter** : applique la transformation sur la timeline et enregistre la décision ;
    - **Modifier** : ouvre les paramètres personnalisables (`modifySpec` — durée, plan cible, format, ordre, etc.) et applique la version choisie ;
    - **Refuser** : masque la suggestion avec possibilité de la rétablir à tout moment.
  - **Proposition IA Groq (`reelora-ai`) :** strictement désactivée et annoncée comme indisponible lorsque `GROQ_API_KEY` est absent côté serveur (`reelora-health`), et toujours soumise à validation explicite avant application.

### 1.4 Sous-titres & Voix off (`src/studio/editor/components/SubtitlesVoiceoverPanel.tsx`)
- Personnalisation du style des sous-titres (`bottom` / `center` / `top`, fond `pill` / `box` / `outline`, taille `sm` / `md` / `lg`, majuscules), timing `subtitleStart` / `subtitleEnd` par scène, copie en lot depuis le texte parlé et export `.srt` réel (`buildSrt`).
- Téléprompteur voix off (comptage mots, durée estimée ~150 mots/min), enregistrement micro réel via `MediaRecorder` lorsqu’il est pris en charge par le navigateur, import de fichier audio réel, et mention explicite qu’aucune synthèse vocale IA (TTS) n’est connectée.

### 1.5 Prévisualisation fluide & Export honnête (`PreviewPlayer.tsx`, `render.ts`, `persistence.ts`)
- Double couche `<video>` préchargée dans `PreviewPlayer.tsx` pour des transitions fluides (`fade`, `dissolve`, `slide`) sans coupure visuelle, synchronisation audio voix off + musique avec ducking, et remontée des métadonnées réelles (`sourceDuration`, `mediaWidth`, `mediaHeight`).
- Sauvegarde sans perte dans `ugc_video_projects.settings.reelora_editor_v1` tout en préservant les `blob:` locaux dans l’onglet actif et les brouillons locaux par projet (`localStorage`), plus avertissement `beforeunload` si des modifications sont non enregistrées.
- **Refus strict de tout faux export :** `exportCapabilities()` vérifie concrètement `MediaRecorder`, `HTMLCanvasElement.prototype.captureStream` et un codec vidéo supporté ; si indisponible ou si un plan manque de média réel, `renderProject()` rejette explicitement l’opération et le bouton d’export reste désactivé.

---

## 2. Périmètre de vérification & honnêteté technique

### Vérifié réellement en local (sans simulation)
- `npm run typecheck` (`tsc -b --pretty false`) : **succès (0 erreur)**.
- `npm test` (`vitest run`) : **12 fichiers / 171 tests réussis**, incluant `tests/editor-phase3.test.tsx` (logique pure : scission, ajout, duplication, réordonnancement, bornage trim, hydratation projet réel, assemblage médias, règles UGC locales, génération SRT, persistance sans perte et refus strict d’export).
- `npm run build` (`vite build`) : **succès** (`dist/assets/index-*.js`, CSS et HTML générés).
- Sécurité & invariants préservés : routes historiques conservées, `verify_jwt=true` maintenu dans `supabase/config.toml`, aucune clé secrète côté frontend, aucun déploiement Supabase, aucune génération vidéo payante ni débit de crédit.

### Vérifié avec mocks/fixtures jsdom (explicitement simulé)
- Les tests composants React de `tests/editor-phase3.test.tsx` (`VideoEditor`, `AssistPanel`, `Timeline`, `SubtitlesVoiceoverPanel`) utilisent des mocks contrôlés de `src/lib/api` et `AuthContext` dans `jsdom` (vues desktop et mobile) sans appel réseau vers Supabase, MuAPI ou Groq.

### Non exécutable dans cette sandbox
- **Capture de screenshots Chromium & test navigateur réel `MediaRecorder.captureStream()`** : ce conteneur ne dispose ni d’un binaire Chromium/Playwright ni des bibliothèques système GUI/NSS requises (`libnss3`, `libgbm`, `libgtk`, `libasound` absentes), et l’accès réseau sortant est restreint aux registres Git/npm/PyPI. Aucune capture artificielle n’a été fabriquée.
