# Livraison 1 — Hero 3D + Studio plein écran

Branche : `feat/landing-immersive-3d` (depuis `164c83d2a8166a8f50b83559d6bc410e70c16a28`, non commité).
Route : `/` (`src/pages/LandingImmersive.tsx` → `ExperienceImmersion`).

## Ce qui a été livré

Une **seule scène WebGL réelle** (pas un décor simulé) couvre le hero et le Studio :

- un seul `<Canvas>` React Three Fiber, une seule caméra amortie, un seul épinglage
  ScrollTrigger (`+=460 %`) ;
- téléphone construit en géométrie réelle (corps extrudé à congés, écran
  `ShapeGeometry` arrondi, îlot à trois optiques, boutons, vitre, reflet mobile,
  ombre portée) ;
- Studio : couloir d'affiches produit, écran géant 6,4 × 3,6 (texture dessinée en
  canvas), sol grillagé, halos additifs, quatre états de récit
  (Brief → Script → Storyboard → Vidéo) ;
- caméra pilotée par une fonction pure `etatCamera(progres, portrait)` — donc
  testable sans navigateur ;
- fond nébuleuse rendu **dans** la scène (`scene.background`), ce qui supprime
  toute fuite du fond DOM à travers la dalle ;
- textes limités à ceux autorisés, CTA unique, réassurance, slogan
  « Create. Evolve. Grow. ».

## Tableau par scène

Progression lue dans `#experience[data-progres]` après un défilement réel
(molette). Caméra calculée par `etatCamera` ; les valeurs ci-dessous sont celles
de la fonction, vérifiées par `tests/experience-3d.test.ts`.

| # | Scène | Progrès observé | Caméra (position → cible) | Visible | Hors champ / non visible |
|---|-------|-----------------|---------------------------|---------|--------------------------|
| 0 | Hero — téléphone + titre | 0,000 | `[0, 0.32, 7.00]` → `[0, 0, 0]` | téléphone (62 % de la hauteur en 360 px), écran animé, étiquettes Studio/Grow (paysage) | Studio (décor masqué sous 10 %), sol, affiches |
| 1 | Transition | 0,19 → 0,30 | `[0.55, 0.20, 2.4]` → `[1.2, 0.12, −5.2]` | couloir qui s'ouvre, nébuleuse | téléphone masqué au-delà de 30 % (sinon il traversait le cadre en gros plan) |
| 2 | Studio — Brief | 0,46 → 0,56 | `[1.55, 0.16, −9.4]` | affiches, écran géant « Brief », halo | téléphone, panneau script (retiré) |
| 3 | Studio — Script | 0,56 → 0,71 | `[1.45, 0.14, −11.0]` | écran géant état Script, rail d'étapes | — |
| 4 | Studio — Storyboard | 0,71 → 0,85 | `[1.1, 0.10, −12.2]` | quatre plans, barre de génération | — |
| 5 | Studio — Vidéo prête | 0,85 → 1,00 | `[0.5, 0.05, −13.4]` → `[−1.75, 0.20, −24]` | vidéo finale + bouton lecture, « Votre publicité est prête. » | — |

Captures (dossier `preuves/`) :

- desktop 1440 × 900, build de production : `100-hero-desktop-final.png`,
  `81-studio-desktop-brief.png`, `82-studio-desktop-script.png`,
  `83-studio-desktop-storyboard.png`, `84-studio-desktop-video.png` ;
- mobile 360 × 740 : `93-hero-360.png`, `98-studio-360-brief.png`,
  `96-studio-360-video.png` ;
- état antérieur (CSS seul, pour comparaison) : `00-avant-desktop.png`.

## WebGL vérifié avant capture

Sur le build de production, dans le navigateur de la VM :

```
version  : WebGL 2.0 (OpenGL ES 3.0 Chromium)
renderer : ANGLE (Intel, Intel(R) UHD Graphics (0x000046B3) Direct3D11 vs_5_0 ps_5_0, D3D11)
```

`prefers-reduced-motion` est activé par défaut dans cet environnement : les
captures ont été prises avec `emulateMedia({ reducedMotion: 'no-preference' })`.

## Défauts corrigés pendant la livraison

| Défaut observé | Cause | Correction |
|----------------|-------|------------|
| Nébuleuse visible **à travers** l'écran du téléphone | `globalAlpha` resté < 1 après une image interrompue entre `save()`/`restore()` ; le fond de la dalle était translucide | remise à zéro de l'état 2D à chaque image (`globalAlpha`, `globalCompositeOperation`, `filter`, `setTransform`) |
| Écran du téléphone qui « nuageait » | upload de texture animée + mipmaps | mipmaps désactivés, `alpha: false` sur le contexte 2D, alpha de fragment forcé à 1 |
| Téléphone géant au milieu du Studio | la caméra le dépassait alors qu'il restait visible | masqué au-delà de 30 % de progression |
| Panneau de script coupé à droite | positionné hors cadre à x = 3,5 | retiré (l'écran géant porte déjà le récit) |
| Barre de génération détachée en bas à gauche | objet 3D isolé hors du champ utile | retirée |
| Textes illisibles sur les affiches | voile latéral trop faible | dégradé renforcé (0,975 → 0,66 → 0) |
| Section suivante épinglée **par-dessus** le Studio | déclencheurs des scènes classiques calculés avant l'espace réservé par l'épinglage long | `ScrollTrigger.refresh()` après la pose du pin |
| Étiquettes 3D coupées en 360 px | décoration hors cadre | masquées en portrait |
| Écran géant coupé des deux côtés en 360 px | dalle de 6,68 unités pour un cadre de 360 px | mise à l'échelle 0,54 en portrait |

## Vérifications

| Vérification | Résultat |
|--------------|----------|
| `npx tsc -b` | 0 erreur |
| `npm run build` | OK (23 s), `dist` 7,0 Mo dont 606 Ko pour le bundle d'entrée |
| `npx vitest run` | **4090 tests passés**, 6 échecs **préexistants** dans `tests/edge-pin-reachable.test.ts` (épingles Edge Functions comparées à `main` — hors périmètre, aucune modification Edge autorisée) |
| `tests/experience-3d.test.ts` (nouveau) | 12 tests : la caméra avance de façon monotone, dépasse le téléphone, arrive à 10,6 unités de l'écran ; téléphone ≥ 60 % en 360 px ; quatre étapes dans l'ordre |
| Vérification par mutation | caméra figée (`z = constante`) → 3 tests tombent ; restauré → 12/12 |
| `tests/landing-immersion-2.test.tsx` | adapté à l'architecture (un seul épinglage `+=460 %`, h1 sur le hero) : 10/10 |
| LCP (build de production, 1440 × 900) | **1,80 s** (< 2,5 s) |
| Débordement horizontal 360 px | aucun (`scrollWidth === innerWidth`) |
| CTA au-dessus du pli en 360 × 740 | oui : 683 → 721 px |

### Performance : non conforme, et non mesurable ici

Mesure sur le build de production, 1440 × 900, DPR 1,5, scène au repos :

```
3 fps — médiane 287 ms, p95 327 ms
```

Contrôle effectué : sur la **même** page `about:blank`, le même navigateur rend
à **59 fps** (médiane 17 ms). Ce n'est donc pas un bridage d'onglet : la scène
coûte réellement ~290 ms par image sur le GPU de cette VM
(Intel UHD en ANGLE/D3D11, souvent logiciel en virtualisation). La même page a
d'ailleurs été rendue plus tôt dans la session par un GPU NVIDIA, ce qui montre
que le matériel change d'une session à l'autre.

Réductions de travail appliquées sans mesure de gain disponible :
`ContactShadows frames={1}`, DPR plafonné à 1,5, écran du téléphone redessiné à
12 Hz au lieu de 24.

**Conclusion honnête : l'exigence « 60 fps desktop » n'est pas vérifiée.** Elle
doit être mesurée sur le matériel cible, et la scène devra probablement être
allégée (nombre de lumières, halos plein écran, matières physiques).

## Points ouverts

- **60 fps** : non vérifié (voir ci-dessus) ; c'est le point bloquant de la
  livraison.
- L'image Open Graph pointe encore sur `/sorahnex-og.svg`.
- Aucun commit, aucune fusion, aucun déploiement : le travail est sur la branche
  `feat/landing-immersive-3d`, en attente de validation.
