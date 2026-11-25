# SORAHNEX — validation visuelle et correctifs ergonomiques

Campagne du 25 novembre 2026, sur la branche `feat/sorahnex-espaces-v2`.
**Aucune production n'a été touchée** : la validation s'exécute dans un
navigateur réel, toutes les requêtes Supabase étant interceptées.

---

## 1. Méthode

| Élément | Choix |
| --- | --- |
| Navigateur | Navigateur cloud du projet (Chromium), piloté par Playwright |
| Backend | **Aucun appel réseau distant** : `/auth/v1`, `/rest/v1`, `/functions/v1` sont interceptés et répondent depuis des fixtures locales |
| Session | Session de démonstration injectée dans `localStorage` (`reelora.auth.v1`), jamais valide côté serveur |
| Écritures | Toute requête non-GET hors authentification est refusée par l'interception ; aucune écriture n'est rejouée |
| Mesures | Débordement horizontal, éléments dépassant la fenêtre, cibles tactiles < 40 px, erreurs console, contenu réellement rendu |
| Captures | `preview-espaces/screenshots/` |

Le service métier (`business-grow`) est **volontairement indisponible** dans le
harnais : les écrans affichent donc leur état d'erreur réel, qui est justement
celui qu'un utilisateur voit quand le service tombe. Les écrans ne prouvent pas
la vérité des données ; ils prouvent la mise en page, la navigation et les
interactions.

## 2. Formats testés

| Format | Taille | Ce qui était vérifié |
| --- | --- | --- |
| Android petit | 360 × 740 | Lisibilité, cibles tactiles, barre basse, tiroir |
| Android grand | 412 × 915 | Hiérarchie, densité |
| Android paysage | 740 × 360 | Contenu court, barres collantes |
| Tablette | 768 × 1024 | Apparition de la barre latérale |
| Tablette paysage | 1024 × 768 | Deux colonnes, tableaux |
| PC | 1440 × 900 | Espace disponible, colonnes |

Écrans parcourus : sélecteur d'espaces, Studio (tableau de bord, création,
projets), Grow (vue générale, CRM, catalogue de modules, module métier,
assistant), paramètres.

## 3. Constats et correctifs

| Constat réel | Preuve | Correctif |
| --- | --- | --- |
| **Double navigation sur tablette** : à 768 px, la barre latérale du Growth OS apparaît mais la barre basse reste affichée | capture `grow-vue-tablette.png` | La barre basse est masquée dès `md` **uniquement** sur les routes du Growth OS (`Layout.tsx`) ; le Studio et les pages catalogue gardent la leur |
| **Bandeau d'actions redondant sur téléphone** : Prospect · Vente · Encaissement · Assistant répétait exactement la barre basse, avant le contenu | `grow-vue-android-petit.png` | Bandeau réservé à partir de `md` ; sur téléphone, la barre basse suffit. Hauteur portée à 48 px sur ordinateur |
| **Action principale en second sur mobile** dans les 21 modules métier | `grow-module-workspace-android-petit.png` | Colonne inversée sur téléphone : « Nouvel enregistrement » avant « Demander à l'agent » |
| **Fiche module trop haute** : deux garanties détaillées poussaient les enregistrements sous la ligne de flottaison | même capture | Garanties repliées dans un `<details>` de 44 px sur téléphone, conservées en clair sur grand écran |
| **Titre dupliqué** : fil d'Ariane terminé par « Lead Rescue » puis titre identique | même capture | Dernier maillon du fil masqué sur téléphone |
| **Cibles tactiles de 16 à 32 px** : lien « Gérer les services IA », sélecteurs de l'assistant, barre supérieure du Studio | mesures `smallTargets` | Lien et sélecteurs portés à 44 px ; `.studio-bar-tab`, `.studio-bar-icon`, pastilles crédits/compte : 44 px sur téléphone, densité d'origine dès 640 px |
| **Débordement horizontal** | mesure `overflowX` | Aucun débordement détecté sur les 6 formats (0 px), y compris après correctifs |

Captures « après » : `apres-grow-vue-360.png`, `apres-grow-module-workspace-360.png`,
`final-module-360.png`, `apres-grow-vue-768.png`.

## 4. Ce qui n'a pas pu être validé

- **Données métier réelles** : le service étant indisponible dans le harnais,
  les tableaux remplis, les filtres et les formulaires pré-remplis ne sont pas
  exercés. Un passage sur un projet Supabase de développement reste nécessaire.
- **Écrans CRM, Finance, Ventes, Trésorerie avec données** : leurs listes
  utilisent déjà des colonnes masquées par palier (`sm`/`md`/`lg`) et des
  enveloppes de défilement ; le rendu avec 20 lignes réelles n'a pas été vu.
- **Interactions** : ouverture du tiroir, fermeture par Échap, passage
  Studio → Grow ont été vérifiés à l'écran dans les captures ; les parcours
  d'écriture (création, modification, suppression) n'ont pas été rejoués.
- **Paysage 740 × 360** : la barre basse occupe une part importante de la
  hauteur. Non corrigé : cela demande une décision produit (masquer la barre en
  paysage court), reportée.

## 5. Reproductibilité

```bash
# 1. serveur de développement sur le port réservé de la conversation
npx vite --host 0.0.0.0 --port 3000

# 2. captures + mesures (Chromium requis : npx puppeteer browsers install chrome)
node scripts/spaces-preview.mjs --base http://127.0.0.1:3000 --out preview-espaces
```

Le script `scripts/spaces-preview.mjs` est versionné : il ne contacte jamais
Supabase et refuse toute requête non interceptée.
