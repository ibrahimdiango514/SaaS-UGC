# Correction architecturale — SORAHNEX AI intégré dans Grow

**Branche** : `arena/bfcedd89-saas-ugc` · **Base** : `6f0decd` (`develop`)

---

## 1. Le défaut corrigé

La Livraison 1 avait produit `/app/ai` : un **espace assistant autonome**, avec sa
propre route, sa propre sidebar et sa propre navigation d'application. Le
catalogue d'intégrations vivait sur `/app/connect`, également à part.

C'était la mauvaise direction. Grow est l'espace métier de SORAHNEX ; il
avait déjà une section « Assistant ». La demande était de **remplacer cette
section**, pas d'ouvrir un second espace à côté.

## 2. Ancienne interface remplacée

`AssistantView` dans `src/business/BusinessGrowWorkspace.tsx` — **440 lignes
supprimées** (fichier passé de 2876 à 2315 lignes avant réintroduction des
blocs conservés).

Ce qu'elle faisait, et qui n'a **pas** été perdu :

| Fonction | Sort |
|---|---|
| Fil de messages brut | → `MessageList` (bulles, Markdown, copie, écoute) |
| Liste latérale ad hoc | → `Sidebar` (recherche, regroupement par période, renommage, suppression confirmée, repli) |
| Composeur minimal | → `Composer` (pièces jointes, mode analyse, envoi) |
| Renommage / suppression | conservé, avec confirmation |
| Sélecteur rôle / routage / service / modèle | conservé dans une barre AI Director |
| Quota, statut IA, données privées | conservés dans un panneau droit |
| Propositions d'outils + transfert Studio UGC | conservés à l'identique |
| Rapports d'agent + pré-remplissage | conservés |
| Suggestions métier (6, triées par couverture) | conservées |
| Bandeau de contexte importé (projet/marque/produit) | conservé |

## 3. Nouvelle architecture obtenue

```
/app/business                       ← un seul espace métier
└── BusinessGrowWorkspace
    ├── en-tête « SORAHNEX · Grow »
    ├── 4 indicateurs + accès aux 13 modules métier
    ├── nav métier (7 rubriques)  ← inchangée
    └── section « Assistant »
        └── AssistantView
            ├── barre AI Director (rôle, routage, service, modèle, quota)
            ├── suggestions métier
            └── BusinessAssistant  ← interface SORAHNEX AI
                ├── Sidebar (mode `embedded`)
                ├── MessageList
                └── Composer
```

`BusinessAssistant` est un **composant de rendu**, pas un espace. Il ne possède
ni route, ni navigation d'application, ni connexion propre : il reçoit son état
par le paramètre `host` et déclenche les rappels de Grow.

### Le mode `embedded` de la sidebar

Sans lui, embarquer la sidebar de la Livraison 1 aurait réintroduit des liens
« Espace Business », « Explorer », « Images », « Bibliothèque » **à côté** de la
navigation métier — soit exactement le second espace qu'on refuse. En mode
`embedded`, elle ne propose que :

- les conversations (recherche, regroupement, actions)
- un raccourci vers la rubrique **Intégrations** de Grow

Vérifié dans le bundle : la chaîne « Espace Business » est **absente** du chunk
`BusinessGrow-*.js`.

### Isolation des données

`useAssistant` et les fonctions de `src/ai/api.ts` acceptent désormais un
`workspaceId`. Les conversations sont rattachées à l'entreprise active, et les
dépendances `useCallback` ont été corrigées : changer d'entreprise recharge la
liste au lieu de conserver celle de la précédente.

En mode piloté (`host`), Grow garde la main sur ses révisions et ses
séquences de chargement — la logique d'isolation existante n'est pas dupliquée.

## 4. Catalogue d'intégrations

Accessible depuis Grow, à deux endroits :

1. la rubrique **Intégrations** de la navigation métier (existante, conservée) ;
2. le raccourci de la sidebar de l'assistant, qui bascule sur cette rubrique.

Rien n'est dupliqué : le raccourci change de section, il n'ouvre pas une page.

> **Point à trancher.** Le catalogue de 26 fournisseurs (Livraison 2) vit sur
> `/app/connect`. La rubrique Intégrations de Grow affiche le contrat
> préexistant `src/integrations/contracts.ts` (6 fournisseurs, demandes
> d'activation). Fusionner les deux demande de réconcilier deux modèles de
> statut : `deriveStatus` (comptes OAuth réels) et les demandes d'activation
> persistées. Les mélanger maintenant produirait un état incohérent — je
> propose de le faire en Livraison 3, quand l'Integration Engine existera. En
> attendant, **aucune connexion n'est simulée** dans l'un ou l'autre écran.

## 5. Défauts trouvés et corrigés en cours de route

- **Bouton imbriqué dans un bouton** (sidebar) : HTML invalide et deux nœuds
  accessibles portant le même nom. Actions remontées en frères.
- **Nom accessible ambigu** : « Options pour Campagne B » rendait la
  conversation « Campagne B » introuvable sans ambiguïté. Les actions ont
  maintenant leurs propres libellés.
- **Compteur de conversations faux** : `normalizeProvider` fusionnait
  `gmail`/`google_drive`/`google_calendar` alors que le socle les distingue.
- **Boutons morts évités** : un premier ajout du bouton « Envoyer » en
  `type="submit"` n'aurait rien déclenché (aucun `<form>`) ; corrigé avant test.
- **Statuts de traitement** : `MessageList` ne les affichait pas. Un message
  « en attente » aurait pu passer pour une réponse, et un échec pour un succès.
- **Statut IA non chargé ≠ aucun fournisseur** : distinction restaurée dans
  l'en-tête de l'assistant.

## 6. Vérifications

| Contrôle | Résultat |
|---|---|
| `npx tsc -b` | 0 erreur |
| `npm run build` | OK — `BusinessGrow-DNe7jcFc.js` (175,8 kB) |
| Tests Grow existants | **42 / 42** — aucune régression |
| Tests interface AI | **32 / 32** |
| Tests routage AI | **4 / 4** |
| Nouveaux tests d'intégration | **11 / 11** |
| Preuve de rendu | **1 / 1** |
| Suite complète | **1385 passent**, 1 échec préexistant (`tests/business-modules.test.tsx:84`, vérifié en `git stash`) |

## 7. Preuve de rendu

`tests/business-grow-rendu.test.tsx` monte le **vrai** `BusinessGrow` sur
`/app/business`, avec un socle mocké, et écrit le DOM produit dans :

- `artifacts/business-grow-assistant.html` — CSS Tailwind compilé inliné,
  s'ouvre dans un navigateur avec la vraie mise en page (187 Ko) ;
- `artifacts/business-grow-assistant.png` — version texte lisible.

Le test vérifie sur le rendu, pas sur le code :

1. `business-assistant` et la sidebar SORAHNEX sont présents ;
2. « Espace Business » et « Explorer » sont **absents** ;
3. les 7 rubriques métier sont présentes ;
4. l'AI Director et le quota (840 unités) sont là ;
5. les conversations et le message persisté s'affichent ;
6. le composeur porte le vocabulaire métier (« Votre demande », « Envoyer ») ;
7. le fournisseur (`groq`) n'est jamais exposé.

**Limite honnête** : ce n'est pas une capture d'écran. Aucun binaire Chrome
n'est disponible (cache Puppeteer vide, téléchargement hors réseau autorisé).

## 8. Netlify

Aucun changement : toujours **0 statut, 0 check-run** Netlify. Voir
`docs/ai/previews-netlify.md`. Aucune URL n'est inventée.
