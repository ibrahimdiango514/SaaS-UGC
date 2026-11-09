# Reelora · Video Generation Studio + AI Video Editor

Cette évolution concerne **uniquement le Système 1 — UGC Studio avec crédits**. Le Système 2 — Business Growth Workspace, ses abonnements et ses écrans ne sont pas modifiés. Elle s’appuie sur l’intégration MuAPI, les RPC, le ledger, le Storage privé, les RLS et le suivi asynchrone déjà existants : aucune seconde intégration fournisseur, aucune nouvelle table, colonne, politique RLS, RPC ni migration.

## Routes

| Route | Contenu |
| --- | --- |
| `/app/studio` | Nouveau **Video Generation Studio** : barre supérieure, état vide, barre de prompt, plan de production, devis serveur, confirmation explicite, suivi et actions post-génération. |
| `/app/studio/classique` | Ancien parcours détaillé `VideoStudio`, conservé. |
| `/app/studio/avance` | Ancien parcours 5 étapes, conservé. |
| `/app/studio/montage` | **AI Video Editor** : lecteur, timeline, pistes, assistant, sauvegarde et rendu navigateur. |
| `/app/historique` | Historique enrichi : mode, qualité, projet, résultat réel, actions vers l’éditeur. |

## Ce qui est réellement opérationnel

- **Interface mobile-first** : barre horizontale défilante, solde « crédits UGC », historique, tarifs, compte ; Image / Audio / Lip Sync affichés « À venir » car aucun moteur correspondant n’est intégré. Vidéo, Avatar existant, Montage et Mes créations pointent vers des routes réelles.
- **État vide** : 5 secteurs avec de vrais JPEG intégrés dans `public/studio-examples/`, explicitement étiquetés « Démo / inspiration », jamais présentés comme des vidéos générées.
- **Une seule instruction → plan structuré** : objectif, produit, secteur, structure narrative, 1 à 6 scènes, instructions visuelles, ratio, avertissements. Le planificateur local est déterministe ; aucune réponse IA n’est simulée. `validateProductionPlan` rejette toute sortie non conforme avant usage.
- **Qualité Rapide / Standard / Premium** : abstraction Reelora sur les services actifs `ugc_clip_8s`, `ugc_clip_15s`, `ugc_ad_4clips`. Le modèle est choisi dans le catalogue MuAPI vérifié, trié par `cost_usd` réel, et filtré par `required_fields` que Reelora sait réellement fournir (`prompt`, `image_url`). Les modèles exigeant `audio_url` ou une entrée non intégrée ne sont pas proposés comme fonctionnels.
- **Devis et crédits** : le coût affiché vient uniquement de `reelora-video { action: "estimate" }`. Aucun coût n’est calculé dans le frontend. La génération conserve `reelora_start_generation` avec idempotence, réservation avant soumission, `videoStart`/`videoStatus`, capture uniquement après succès et restitution sur échec / annulation / expiration.
- **Confirmations** : le bouton de génération ouvre `CostConfirm` ; le devis, les paramètres réellement compatibles (`param_schema ∩ input_fields`), le coût fournisseur et la case de confirmation explicite sont obligatoires. Aucun lancement payant n’a été effectué.
- **AI Video Editor** : projet de démonstration explicitement sans média réel, prévisualisation uniquement avec une vraie source, timeline interactive (réordonnancement, durée, point d’entrée, transition, suppression, remplacement, sous-titres, voix off, instruction visuelle), pistes vidéo / audio / sous-titres, bibliothèque des créations réelles, import dans le bucket Storage privé existant.
- **Assistant de montage** : suggestions déterministes locales (média, accroche, CTA, rythme, sous-titres, cohérence, transitions, audio, coupes, synchronisation, cohérence visuelle), acceptables, refusables et modifiables pour les réglages concernés. Aucune réponse Groq n’est fabriquée.
- **Rendu navigateur réel** : `src/studio/editor/render.ts` compose chaque image avec Canvas 2D, mixe l’audio via Web Audio et encode avec `MediaRecorder`. Le fichier produit est un Blob téléchargeable. L’export est refusé tant qu’un plan n’a pas de média réel.
- **Sauvegarde** : l’état du montage est stocké dans `ugc_video_projects.settings[reelora_editor_v1]` via `getProject` / `updateProject` / `createProject` existants. Les URL signées et `blob:` ne sont pas persistées ; les chemins Storage privés sont re-signés à l’ouverture.
- **Historique** : date, service, statut, coût, modèle, paramètres, mode, qualité, projet, résultat réel, événements, mouvements de crédits et actions « Régénérer / variante », « Modifier le montage », « Reprendre l’éditeur », « Résultat / bibliothèque ».

## Partiel / préparé / non déployé

- `supabase/functions/reelora-ai/planner-prompt.ts` contient le **system prompt interne versionné** `reelora-ugc-plan-v1`, le contrat de sortie et les règles de non-invention. Il est côté source Edge, n’est jamais importé par le frontend et n’est **pas déployé** : redéployer les Edge Functions partagées nécessite une autorisation explicite.
- Le bouton « Proposer un plan avec Groq » utilise l’action existante `generate_script`, puis `mapAiScriptToPlan` + `validateProductionPlan`. `GROQ_API_KEY` est absent côté serveur : le bouton est désactivé, un état explicite est affiché et aucune réponse n’est simulée.
- Les fonctions Voix, Langue audio, Lip Sync, génération d’images et rendu serveur restent « à venir ». Aucun moteur TTS, lipsync ou transcodage serveur n’est connecté.
- Le rendu est **navigateur**, pas serveur : temps réel, onglet ouvert, CORS requis sur les médias distants, conteneur WebM/MP4 selon `MediaRecorder`, pas de file de rendu ni de transcodage MP4 garanti. « Reprendre » relance depuis le projet sauvegardé.
- Les 5 visuels de secteur sont des images de démonstration intégrées au projet ; le projet d’éditeur de démonstration est signalé et ne contient aucun média. Aucune fixture n’est présentée comme un appel MuAPI réel.

## Limites de sécurité et de crédits

- Aucun secret n’est exposé ; `MUAPI_API_KEY` reste côté serveur, `GROQ_API_KEY` reste absent, aucune valeur n’est recopiée.
- Crédits UGC distincts des abonnements du Business Growth Workspace.
- Aucune table, RLS, donnée partagée, fonction SQL ou Edge Function live n’a été modifiée pour cette évolution.
- Aucune génération payante, aucun appel MuAPI/Groq réel, aucun crédit dépensé et aucun job créé pendant le développement et les captures.

## Validation

- `npm test` : **10 fichiers / 124 tests** réussis, dont `tests/studio-v2.test.ts` (18 tests : plan, validation stricte, catalogue, timeline, assistant, rendu, persistance, system prompt, routes, ressources Démo).
- `npm run typecheck` : réussi.
- `npm run build` : réussi, 1683 modules, CSS 62,63 kB, JS 807,10 kB (221,51 kB gzip).
- Captures headless : `preview-v2/gallery.html`, `preview-v2/verification.json` et 14 JPEG. **10/10 interactions**, 0 erreur console, 0 erreur page, 56 appels backend interceptés, aucun `action:"start"`, aucun `reelora_start_generation`, aucun appel MuAPI, `realGenerationLaunched:false`, `jobsCreated:0`.
- Les captures utilisent un serveur Vite Preview local et des fixtures de navigateur ; la Preview Netlify de la PR reste privée et l’URL E2B externe nécessite un jeton de trafic. Aucun déploiement de production.
