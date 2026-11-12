# Preview Studio VYORA — captures reproductibles

Ce dossier contient des captures de l'interface **réelle** (application Vite
lancée par `npm run dev`), prises dans Chromium par
[`scripts/studio-preview.mjs`](../scripts/studio-preview.mjs).

```
node scripts/studio-preview.mjs --base http://127.0.0.1:4180 --out preview-studio
```

## Ce que les captures prouvent — et ce qu'elles ne prouvent pas

Le script intercepte **le réseau du navigateur** : session, RPC Supabase et Edge
Functions sont simulées côté client. Par conséquent :

- ✅ elles prouvent le rendu, la mise en page desktop/mobile et les interactions
  de l'interface (canvas immersif, barre de prompt dockée, panneau de modèles,
  grille de crédits, états de blocage) ;
- ❌ elles ne prouvent **aucune** valeur réelle en base : ni solde, ni devis
  fournisseur, ni catalogue MuAPI, ni crédits débités ;
- ❌ aucun paiement, aucune réservation, aucune génération IA n'est déclenchée :
  les requêtes d'écriture (`POST`, `PATCH`, `DELETE`) vers Supabase sont
  annulées par le harnais.

Le code applicatif n'est pas modifié pour la preview : aucune variable de
démonstration n'est lue par l'application, aucun *mock* n'est livré dans `src/`.

## Prérequis d'exécution

Le bac à sable n'a pas de navigateur système et le CDN de Playwright n'est pas
joignable. La capture a donc utilisé un Chromium distribué via npm
(`@sparticuz/chromium`, binaire Lambda + bibliothèques glibc extraites) et
`puppeteer-core`, installés **hors** des dépendances du projet :

```bash
npm i --no-save @sparticuz/chromium puppeteer-core
node -e "require('@sparticuz/chromium').executablePath().then(console.log)"  # → /tmp/chromium
CHROMIUM_PATH=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023/lib \
  node scripts/studio-preview.mjs --base http://127.0.0.1:4180 --out preview-studio
```

Sur une machine disposant de Chrome/Chromium, seul `puppeteer-core` et
`CHROMIUM_PATH` sont nécessaires.

## Captures

| Fichier | Contenu |
| --- | --- |
| `01-studio-desktop.png` | Canvas immersif : navigation par catégories, hero + carrousel, une seule barre de prompt dockée |
| `02-studio-devis-desktop.png` | Prompt saisi, devis serveur (crédits) affiché avant génération |
| `03-studio-modeles-desktop.png` | Panneau « Explorer les capacités vidéo » : catalogue, filtres, paramètres réels, coût |
| `04-credits-desktop.png` | Page `/app/credits` : 3 packs, prix au crédit, avantage progressif, recharge libre, historique, périmètre Studio |
| `05-studio-mobile.png` | Studio mobile 390×844 (barre de prompt et bouton Générer visibles) |
| `06-credits-mobile-haut.png` | Crédits mobile — packs et prix |
| `07-credits-mobile-bas.png` | Crédits mobile — recharge libre, historique, périmètre de facturation |

`verification.json` liste les interactions vérifiées, les erreurs console et les
erreurs de page. Les erreurs console attendues sont uniquement les polices
Google Fonts, non joignables depuis le bac à sable.

## Limites connues de l'environnement

- Supabase, MuAPI et les polices Google ne sont pas joignables depuis le bac à
  sable : sans interception, l'application affiche son écran d'erreur
  d'initialisation (« Connexion impossible »). C'est une limite réseau, pas un
  défaut de l'interface.
- Pour tester avec une vraie session, renseigner `.env.local`
  (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) et se connecter : le
  harnais n'est alors pas nécessaire.
