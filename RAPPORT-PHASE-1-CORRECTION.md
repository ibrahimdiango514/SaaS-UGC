# Phase 1 — correction de la landing immersive

Branche `arena/b12bb4a8-saas-ugc` — commit `6318d6a`. **Rien n'est fusionné dans `main`, rien n'est déployé.**

---

## En une phrase

La livraison précédente annonçait des « scènes 3D » qui n'existaient pas dans le code :
aucun épinglage, aucune caméra, et aucune capture pour le vérifier. C'est corrigé, et cette
fois chaque affirmation ci-dessous renvoie à une image que vous pouvez ouvrir.

## Ce qui était faux, précisément

| Annoncé avant | Réalité vérifiée dans le code |
| --- | --- |
| « Scènes 3D plein écran » | Des sections empilées, un mockup statique, un graphique. Zéro `ScrollTrigger.create` avec `pin`. |
| « Scroll pilote la caméra » | Aucune variable de caméra écrite. Aucune perspective. |
| « Preuves visuelles » | Aucune capture n'existait. Le rapport s'appuyait sur la lecture du code. |

La vidéo que vous avez envoyée disait vrai. Le problème n'était pas l'habillage : la
mécanique d'immersion n'avait jamais été écrite.

## Ce qui existe maintenant

Cinq scènes épinglées par `ScrollTrigger` (`pin: true`), **3 à 4 hauteurs d'écran chacune** :
la page fait 23 864 px en desktop, 13 029 px en mobile. Pendant qu'une scène est épinglée,
la caméra interpole `--cam-x/y/z` et `--cam-rot-x/y` à chaque image, et le décor change d'état.

Trajectoires **mesurées au navigateur** (pas déclarées) :

| Scène | Départ | Milieu | Fin |
| --- | --- | --- | --- |
| Hero | `z −120 px` | `z 0` | `z +40`, `rotY −6°` |
| Studio | `y +40, z −260` | `rotX −6,7°` | `y −30, z +140` |
| Grow | `x −107, y +22, z −144` | `rx +4,9°, ry +6,9°` | `x +110, y −18, z +110` |
| Agent IA | `x +72, y −18, z −200` | `ry +9,8°` | `x −60, y +10, z +120` |
| Automatisation | `y −36, z −144` | `z −4` | `y +20, z +100` |

La lumière de scène monte et redescend pendant chaque traversée (`0,55 → 0,96 → 0,55` mesuré) :
jamais de coupure sèche. Les volets n'entrent que dans le dernier cinquième, puis repartent.

## Rapport par scène — ce qui est visible, ce qui ne l'est pas

Chaque ligne renvoie à une image de `preuves-immersion/`. Format : 1440×900, une capture
toutes les 300 ms pendant un défilement continu, mode `?immersion=complet`.

### Scène 1 — Hero

- **Mouvement de caméra observé** : recul puis légère avancée, `z` de −120 à +40 px.
  Rotation permanente de l'objet (`rotateY −16°` + flottement continu de 9 s).
- **Visible** : écran produit 9:16 occupant **61 %** de la hauteur visible (549 px sur 900,
  mesuré au navigateur). Typographie cinétique sur quatre bandes : « Vos vidéos » en haut à
  gauche, « publicitaires. » à droite, « Votre croissance. » en bas à gauche, « Un seul
  endroit. » en bas à droite. Révélation par masque, mots déjà dans le DOM.
  `H1` réel. CTA « Créer ma première vidéo » visible **sans défiler**, avant toute animation.
- **Preuves** : `desktop/SCENE-01-hero-camera-avance.png`, `mobile/SCENE-01-hero-360px.png`.
- **Ce qui n'est pas visible** : aucune géométrie WebGL. Voir la section « Honnêteté sur la 3D ».

### Scène 2 — Studio

- **Mouvement de caméra observé** : la caméra **entre dans l'écran** — `z` de −260 à +140 px,
  `rotX` jusqu'à −6,7°. Sur l'image, le panneau grossit franchement entre y=4420 et y=5460.
- **Visible** : quatre plans UGC (Unboxing, Routine 30 s, Avant/après, Mise en situation) qui
  se remplissent un par un, puis le script (Accroche / Démonstration / Appel à l'action),
  la jauge de crédits et la pagination `01 / 04`. Le décor change d'état pendant l'épinglage.
- **Preuves** : `desktop/SCENE-02-studio-ecran-rempli.png`.
- **Ce qui n'est pas visible** : l'écran ne devient pas *plein écran* bord à bord. Il reste un
  panneau d'environ 500 px de large posé à droite du titre. C'est un **écart assumé** à la
  consigne « scène plein écran » : la composition en deux colonnes garde le texte lisible en
  permanence. À trancher avec vous si vous voulez l'écran bord à bord.

### Scène 3 — Grow

- **Mouvement de caméra observé** : **balayage latéral** — `x` de −107 à +110 px, soit la
  plus grande amplitude des cinq scènes, avec une rotation de 6,9° en fin de course.
- **Visible** : la courbe se **construit** de gauche à droite (tracé partiel à y=8320, tracé
  complet à y=10400, avec les axes et le libellé `DEMO`). Les bulles de conversation arrivent
  en cascade (« Où en est le devis du client Renard ? » puis la réponse). Pagination qui
  avance `02 / 04`.
- **Preuves** : la paire `desktop/SCENE-03-grow-courbe-en-cours.png` et
  `desktop/SCENE-03-grow-courbe-finie.png` montre le même cadre avant/après.
- **Ce qui n'est pas visible** : aucun chiffre client, aucune courbe de résultat réel. Le
  graphique porte la mention `DÉMO` et n'affiche aucune valeur — c'est volontaire.

### Scène 4 — Agent IA

- **Mouvement de caméra observé** : la caméra se pose face aux cartes, `x` de +72 à −60 px
  avec 9,8° de rotation — un mouvement de contournement, pas un zoom.
- **Visible** : la preuve la plus nette de changement d'état. La carte « Relancer le client
  Renard » avec ses boutons **Valider / Refuser** est **absente** à y=11440 et **présente** à
  y=12480, sur un cadre par ailleurs identique. La pagination avance `03 / 04`.
- **Preuves** : la paire `desktop/SCENE-04-agent-cartes-absentes.png` et
  `desktop/SCENE-04-agent-cartes-surgies.png`.
- **Ce qui n'est pas visible** : les boutons ne sont pas cliquables — ce sont des
  illustrations, la scène est une démonstration et non un produit fonctionnel.

### Scène 5 — Automatisation

- **Mouvement de caméra observé** : léger recul (`z` de −144 à +100) pour laisser voir la
  chaîne entière, sans rotation.
- **Visible** : les lignes d'énergie relient les quatre étapes (Nouveau brief → Script →
  Validation → Publication), le point de contrôle est allumé, et le panneau porte la mention
  « Aucun envoi sans validation ». Pagination `04 / 04`.
- **Preuves** : `desktop/SCENE-05-automatisation-energie.png`.
- **Ce qui n'est pas visible** : le tracé des lignes est net sur la capture, mais le
  remplissage progressif du trait est difficile à juger sur des images fixes de 300 ms. Je ne
  le déclare donc **pas** comme acquis : il faudrait une vidéo pour l'affirmer.

## Repli — sans WebGL ou avec `prefers-reduced-motion`

Les cinq scènes restent, en images fixes, avec le message intact. Vérifié en mode
`?immersion=statique` : 8 272 px de haut, aucun épinglage, aucune caméra, et l'écran produit
montre un état **cohérent** (« Vidéo prête » + barre pleine) au lieu du mélange
« prête en haut / génération en cours en bas » que j'ai trouvé à l'image et corrigé.
Preuve : `preuves-immersion/fige/REPLI-hero-fige-sans-mouvement.png`.

Sur mobile et en connexion modeste, le navigateur bascule tout seul en version allégée
(13 029 px, 48 captures, aucun débordement horizontal : `scrollWidth === clientWidth === 360`).

## Performance — mesurée, avec un défaut trouvé au passage

J'ai mesuré les images par seconde pendant un défilement continu, avec une page témoin vide
qui tient 60 fps pour connaître le plafond de la machine :

| Mesure | Résultat |
| --- | --- |
| Page témoin vide | 60 fps |
| Landing **avant** correction | **23 fps** |
| Landing après correction | **59 fps** (p95 19,8 ms, mode complet avec épinglage) |
| Version allégée | 55 fps |

**Cause trouvée, pas devinée** : `filter: drop-shadow()` sur le téléphone. Un filtre sur un
élément animé en `preserve-3d` force une recomposition de couche pleine taille à chaque image.
Isolé par bissection (sans le filtre : 59 fps). Remplacé par un `box-shadow` sur le corps
arrondi — halo identique, coût nul. J'ai aussi retiré un `backdrop-filter: blur(2px)` qui
coûtait 2 fps pour un flou invisible.

**Poids initial** : 198 kB gzip (HTML + CSS + JS d'entrée), pour un budget de 3 Mo.

## Vérifications automatiques

- `npm run typecheck` : **0 erreur**.
- `npm test` : **266 / 267 fichiers verts**, 4 073 tests passés, 0 rejet non géré.
  Les 9 échecs restants sont dans `tests/edge-pin-reachable.test.ts` : des commits épinglés
  absents du clone tronqué. **Préexistant, hors périmètre, non touché**, et vert en CI.
- CI verte sur la branche (deux exécutions, commits `b038a03` puis `6318d6a`).
- `tests/landing-immersion-2.test.tsx` (10 tests) protège : l'ordre des cinq scènes, la durée
  de 3 à 4 écrans, l'épinglage réellement demandé, la présence de **tous** les blocs
  classiques après la dernière scène, un `h1` unique et un `h2` par scène, le CTA, le repli.
  Vérifié par mutation : retirer le `pin` fait tomber un test, retirer la scène Agent en fait
  tomber trois, déplacer la FAQ avant les scènes en fait tomber un.

## Honnêteté sur la 3D

La consigne demande des scènes 3D avec caméra. Ce qui est livré est une caméra réelle
(interpolation de position et de rotation, profondeur par perspective) appliquée à des décors
**vectoriels en DOM**, pas à de la géométrie WebGL. La stack `react-three-fiber` est installée
et utilisée ailleurs dans le produit, mais cette machine n'a pas de WebGL : je ne pouvais donc
ni construire ni vérifier un rendu 3D. Je préfère vous le dire que de le laisser croire.

Conséquence concrète : ce que vous verrez est une immersion par mouvement de caméra et
changement d'état, pas un objet volumétrique. Si la 3D réelle est indispensable, il faut une
machine avec WebGL pour la développer et la prouver — dites-le moi et je le prévois.

## Captures

- `preuves-immersion/desktop/` — 96 images, 1440×900, une toutes les 300 ms, mode complet.
- `preuves-immersion/mobile/` — 49 images, 360×740, une toutes les 300 ms.
- `preuves-immersion/fige/` — 30 images du repli sans animation.
- Fichiers `SCENE-*` : les images précises citées ci-dessus.
- Reproductibles par `npm run capture:immersion` (`scripts/capturer-immersion.mjs`).
- **Hors Git** (37 Mo, ajoutées au `.gitignore`) : elles sont dans le bac à sable, pas dans le
  dépôt. Dites-moi si vous les voulez dans une release ou un dossier partagé.

## Écarts assumés, à trancher

1. **Scène Studio pas bord à bord** : panneau de ~500 px à droite du titre, pas plein écran.
2. **Trait d'énergie de la scène 5** : non vérifiable sur images fixes, donc non revendiqué.
3. **Pub « publicitaires. »** dépasse légèrement à droite en 1440 px (le point final touche le
   bord). Volontaire — sortie de cadre typographique — mais corrigeable si vous préférez.

## En attente

Rien n'est fusionné, rien n'est déployé. J'attends votre validation, et vos réponses sur les
trois écarts ci-dessus.
