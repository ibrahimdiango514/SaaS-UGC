# VYORA Growth OS — architecture et fonctionnement

Growth OS est le cerveau métier de VYORA Business. Il ne s’agit pas d’un chatbot : chaque analyse est
ancrée sur des enregistrements réels, modifiables par l’utilisateur, stockés dans la mémoire métier
de l’espace de travail.

## 1. Stockage (aucune nouvelle table)

Growth OS réutilise la mémoire métier existante (`business_grow_memory_items` / API `business-grow`).
Catégories ajoutées :

| Catégorie | Contenu |
| --- | --- |
| `growth_goal` | Objectif commercial : titre, métrique, cible, valeur actuelle, unité, échéance, priorité, statut |
| `growth_prospect` | Prospect/client : nom, société, email, téléphone, étape, montant, devise, prochaine action, date |
| `growth_competitor` | Concurrent : nom, site, positionnement, forces/faiblesses, prix, notes |
| `growth_signal` | Signal de marché : type, titre, source, métrique observée, valeur, date, lien |
| `growth_strategy` | Plan généré ou écrit : titre, horizon, résumé, actions, source (`ia` ou `utilisateur`) |

Le profil entreprise (activité, offre, audience, marché, ton, objectifs) reste dans `memory.profile`.

Étapes de pipeline : `prospect → contacte → qualifie → proposition → gagne / perdu`.

Aucune migration de schéma n’est nécessaire : la mémoire accepte des catégories libres, et
`src/business/growth/model.ts` valide et normalise chaque enregistrement à la lecture. Les données
corrompues ou incomplètes sont ignorées sans casser l’interface.

## 2. Calculs réels (côté client, à partir des données)

`model.ts` fournit : progression d’objectif, objectif en retard, synthèse du pipeline (ouvert, gagné,
perdu, par étape), relances triées par date, formatage de montant, import de catalogue JSON/CSV.
Aucune valeur n’est simulée : sans données, l’interface affiche un état vide explicite.

## 3. Intelligence

`buildGrowthPrompt(task, snapshot)` construit chaque requête avec :

- le profil entreprise et le nom de l’espace ;
- les objectifs, le pipeline, les concurrents, les signaux, les produits et les stratégies existantes ;
- une consigne stricte : ne pas inventer de chiffres, citer les données absentes comme manquantes,
  ne pas prétendre avoir consulté le web, proposer des actions datées (30/60/90 jours) et mesurables.

Tâches disponibles : `strategy` (plan de croissance), `acquisition` (plan d’acquisition),
`competition` (analyse concurrentielle à partir des fiches saisies), `content` (angle de contenu /
script UGC). L’appel passe par l’Edge Function `business-grow` (mémoire, quota métier, fournisseurs IA
vérifiés côté serveur). Les clés API ne quittent jamais le serveur.

Les plans produits par l’IA ne sont jamais enregistrés automatiquement : l’utilisateur les relit puis
les sauvegarde (bouton « Enregistrer ce plan »), ce qui crée un `growth_strategy`.

## 4. Import du catalogue

`parseCatalogImport` accepte un JSON (nom, prix, devise, description, bénéfices, URL) ou un CSV
(`name,price,currency,description,url,benefits`). Les lignes invalides sont signalées avec leur numéro,
les valides sont créées via `createProduct` (données réelles, espace de l’utilisateur). Aucun produit
de démonstration n’est inséré.

## 5. Interfaces

`GrowthWorkspace` ajoute la section **Croissance** à VYORA Business, avec les onglets :
Vue d’ensemble, Entreprise, Objectifs, Catalogue, Marché, Prospects, Stratégie.
Chaque action écrit ou relit la mémoire via l’API ; chaque échec affiche le message réel renvoyé par le
serveur. Le consentement mémoire est obligatoire : sans lui, l’interface propose de l’activer.

## 6. Limites assumées

- Aucun scraping ni accès silencieux aux réseaux sociaux. Les connexions officielles (Facebook,
  Instagram, WhatsApp, YouTube, TikTok, Shopify…) passent par `integration_connections` et ne sont
  actives qu’après autorisation explicite (voir `docs/integration-contracts.md`).
- Les tendances et performances concurrentielles sont saisies par l’utilisateur ou issues d’une
  connexion autorisée ; l’IA ne fabrique jamais de statistiques.
- Les recommandations restent des propositions à valider, pas des ordres d’exécution.

## 7. Tests

- `tests/business-growth-model.test.ts` : lecture défensive, pipeline, objectifs, import JSON/CSV,
  contenu du prompt anti-hallucination.
- `tests/growth-workspace.test.tsx` : rendu des vrais indicateurs, navigation, consentement, états vides,
  validation du formulaire entreprise.
