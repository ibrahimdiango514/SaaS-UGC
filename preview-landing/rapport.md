# VYORA — Refonte de la page d’accueil

Rapport final · 13 novembre 2026 · branche `arena/ada94e4c-saas-ugc` (base `5b6bc24`)

## 1. Fichiers modifiés et créés

**Modifiés**
- `src/pages/Landing.tsx` — page d’accueil reconstruite (962 lignes) : header, hero, deux univers, Studio, Business Growth, douleurs, écosystème, démarrage, tarifs, FAQ, CTA final, footer.
- `src/index.css` — +202 lignes : classes `.landing-*` / `.vyora-*`, keyframes `vyoraLineIn`, `vyoraRotateIn`, `vyoraWordIn`, respect de `prefers-reduced-motion`, cibles tactiles.
- `tests/ui.test.tsx` — mise à jour des assertions de la page d’accueil.

**Créés**
- `src/components/landing/motion.tsx` (187 l.) — `usePrefersReducedMotion`, `Reveal`, `WordReveal`, `RotatingText`, `useInView`, sans dépendance externe.
- `src/components/landing/visuals.tsx` (703 l.) — `HeroConsole`, `HeroConsoleCompact`, panneaux Studio / Business, `StudioShowcase`, `GrowthShowcase`, `EcosystemFlow`, `TrustStrip`.
- `tests/landing.test.tsx` (6 tests) et `tests/landing-assets.test.ts` (3 tests).
- `public/brand/studio-creator.jpg`, `studio-product.jpg`, `business-visual.jpg`, `vyora-cta.jpg` — quatre visuels générés (941×1672, 941×1672, 1536×1024, 1672×941).
- `preview-landing/` — 27 captures, `verification.json`, `gallery.html`, ce rapport.

Aucune route, aucun fichier d’API, aucun secret, aucun réglage SasPay n’a été modifié.

## 2. Sections créées

1. Header fixe (5 ancres, Connexion, Créer mon compte, menu mobile).
2. Hero : « VYORA — L’intelligence artificielle qui fait grandir vos ambitions. », texte, rotation d’expressions, deux CTA, double console Studio / Business Growth.
3. Deux univers : « Un compte. Deux espaces spécialisés. ».
4. VYORA Studio : visuel de création + 6 capacités + CTA `Découvrir VYORA Studio` / `Créer mon compte` / formules.
5. VYORA Business Growth : dashboard illustratif + 6 capacités + CTA `Découvrir Business Growth` / `Voir les formules`.
6. Douleurs résolues : six cartes (prospect, dossier, client, commande, visibilité, tâches) + « Ce que VYORA apporte ».
7. Écosystème : « Studio crée. Business Growth prépare. Vous décidez. », hub central, cinq étapes, note de périmètre.
8. Démarrage : quatre étapes.
9. Tarifs Studio : formules lues via `listPlans()` depuis le serveur, limites réelles, `Gratuit` pour Découverte, `Le plus choisi` aligné, encart Business Growth séparé.
10. FAQ : sept questions, accordéon accessible.
11. Conversion finale : « Votre prochaine étape commence avec VYORA. » + 3 CTA.
12. Footer : logo, deux espaces (liens vers #studio / #business), navigation Studio, Business Growth, informations légales, espace propriétaire.

## 3. Visuels

- Quatre visuels générés pour la page, intégrés avec `width`/`height`, `alt` descriptif, `loading="lazy"` sauf le portrait du hero (`eager`) : 163 Ko + 213 Ko + 145 Ko + 102 Ko.
- Reprise des visuels existants `vyora-hero.jpg`, `vyora-growth.jpg` et `studio-examples/*` pour la bande « Inspirations » (aucune image de secteur inventée comme résultat client).
- Aucune illustration ne recouvre un titre ou un bouton. Les anciennes chips décoratives en `absolute` qui chevauchaient les libellés des panneaux ont été supprimées.
- Toutes les images ont un conteneur avec ratio stable : 0 image cassée, 0 décalage de mise en page observé.

## 4. Animations

- Reveal à l’entrée (`IntersectionObserver`), titre mot à mot, rotation d’expressions, parallaxe CSS légère sur les halos, cartes 3D au survol, graphiques animés, micro-interactions de boutons.
- Uniquement `opacity` et `transform` ; aucun calcul de layout en boucle.
- `prefers-reduced-motion` : styles d’animation neutralisés, rotation figée sur la première expression, contenu immédiatement visible (opacités mesurées à 1 sur h1, ligne dégradée, CTA et lead).
- Filet de sécurité JS (1,4 s) : le contenu ne peut pas rester invisible si `IntersectionObserver` manque ou si le thread est ralenti.

## 5. Responsive

- Desktop ≥ 1024 px : hero en deux colonnes, sections alternées, grilles 3 colonnes.
- Tablette 820 px : une colonne, console pleine largeur, visuels plafonnés à 600/640 px.
- Mobile 390 et 360 px : CTA pleine largeur, console remplacée par une double carte compacte de 328 px de haut, visuel Studio en une colonne puis cartes produit / prompt côte à côte, tarifs et footer empilés.
- Menu mobile : backdrop, fermeture au clic extérieur et à Échap, `aria-expanded` / `aria-controls`.
- Vérifié : `scrollWidth = clientWidth` à 1440, 820, 390 et 360 px ; 0 texte hors viewport ; 0 bouton interactif < 44 px.

## 6. Routes, auth, données et intégrations préservées

- Routes conservées et testées en HTTP 200 : `/`, `/connexion`, `/inscription`, `/app/studio`, `/app/business`, `/app/business/abonnement`, `/app/projets`, `/app/bibliotheque`, `/app/parametres`, `/confidentialite`, `/conditions`, `/proprietaire`.
- Les routes `/app/*` restent protégées : sans session, l’écran d’accès s’affiche ; aucun contournement ajouté.
- Aucune redirection automatique des utilisateurs Business Growth vers un abonnement.
- Studio et Business Growth restent séparés : crédits `saas_ugc`, quotas `saas_business.ai_quota_*`, bibliothèque Studio, mémoire Business Growth. Le pont `handoff_ugc_brief` ne débite aucun crédit.
- Aucun email, lien externe, chiffre client ou résultat garanti inventé. Aucun connecteur `planned` présenté comme actif.
- Aucun appel SasPay, aucun paiement, aucune écriture Supabase, aucun secret modifié.

## 7. Tests et résultats

- `npx vitest run` : **65 fichiers / 982 tests, 0 échec** (dont 9 tests dédiés à la landing, 6 tests UI existants).
- `npx tsc -b` : **0 erreur**.
- `npm run build` : **OK** — `index-*.js` 583,25 Ko (162,31 Ko gzip), chunks par page conservés.
- `git diff --check` : propre.
- Tests manuels navigateur : 27 captures, 4 viewports, 0 erreur page, 0 erreur console, 0 image cassée, 0 débordement horizontal.
- Routes : 12/12 en HTTP 200 ; 19/19 ancres résolues.
- Inscription / connexion : formulaires atteints par navigation réelle ; aucun compte créé (pas d’écriture Supabase dans le sandbox).
- Le seul échec réseau observé est `fonts.googleapis.com` (`ERR_CONNECTION_CLOSED`), lié au réseau du sandbox.

## 8. Vérification visuelle desktop / mobile / tablette

- Desktop 1440×1000 : hero, deux univers, Studio, Business, douleurs, écosystème, tarifs, FAQ, CTA, footer inspectés en pleine résolution.
- Mobile 390×844 : hero, menu, Studio, Business, douleurs, écosystème, tarifs, FAQ inspectés ; console mobile compacte et lisible.
- Mobile 360×800 : titre sur quatre lignes, boutons pleine largeur, aucun débordement.
- Tablette 820×1100 : une colonne, visuel Studio plafonné, features en deux colonnes.
- `prefers-reduced-motion` : capture dédiée, contenu visible.
- Galerie : `preview-landing/gallery.html` (27 captures, résultats et limites).
- Métriques : `preview-landing/verification.json`.

## 9. Corrections issues de l’audit visuel

1. **H1 invisible sur la 2ᵉ ligne** : `background-clip: text` appliqué à des `inline-block` animés → couleur transparente sans dégradé peint. Remplacé par `.vyora-line-reveal` avec le dégradé sur un enfant direct, keyframes dédiées ; espace accessible conservé entre les deux blocs.
2. **Chips absolues** (`Crédits Studio`, `Coût vérifié côté serveur`, `Plan 30/60/90`) supprimées : elles recouvraient les libellés des panneaux.
3. **Panneaux du hero déséquilibrés** : passage en `flex h-full flex-col`, aperçus en `absolute inset-0`, bloc Pipeline et actions ajoutés, footers en `mt-auto`.
4. **Console mobile de 807 px illisible** : remplacée par `HeroConsoleCompact` (328 px, deux cartes, liens réels vers #studio / #business).
5. **Visuel Studio trop dense sur mobile** : une colonne, image pleine largeur, cartes produit / prompt côte à côte, tailles de texte relevées.
6. **Trust strip sur deux lignes** : libellés raccourcis, grille 2/3/6 colonnes.
7. **Tarifs désalignés** : badge `Le plus choisi` en position absolue, prix `Gratuit` sans « / mois » pour la formule à 0.
8. **Menu mobile sans fond** : backdrop et fermeture extérieure / Échap ajoutés.
9. **Cibles tactiles** : `min-height: 44px` sur `.btn`, 48 px sur `.btn-lg`, `touch-action: manipulation`.
10. **Vues complètes** : capture pleine page du Chromium headless buguée au-delà de ~8 000 px → vues d’ensemble à l’échelle 0,5 ; captures de section en pleine résolution.

## 10. Problèmes restants et état Git

**Restants / non couverts**
- Google Fonts inaccessible dans le sandbox : rendu validé avec la pile système ; contrôle à refaire sur un réseau autorisant `fonts.googleapis.com` pour Space Grotesk / DM Sans.
- Les formules sont mockées côté navigateur pour l’audit ; le catalogue Supabase réel et l’auth n’ont pas été exercés (aucune écriture, aucun secret utilisé).
- La facturation Business Growth n’est pas activée : aucun prix Business Growth affiché et le bouton mène à `/app/business/abonnement`, route existante.
- Les vues complètes sont volontairement réduites (0,5) ; les captures de section font foi pour la lisibilité.
- Poids du bundle principal 583 Ko / 162 Ko gzip (hérité de l’application) ; les routes restent découpées par page.

**État Git**
- Branche `arena/ada94e4c-saas-ugc`, base `5b6bc24`.
- Modifications présentes dans le working tree, **non commitées et non poussées**.
- Aucun merge dans `main`, aucun déploiement Netlify, aucun build de production déclenché à distance.
