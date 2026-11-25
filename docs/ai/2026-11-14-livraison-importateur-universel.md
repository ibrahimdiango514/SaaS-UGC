# Livraison — Universal Store Importer (partie E)

**Date** : 2026-11-14 · **Branche** : `arena/bfcedd89-saas-ugc` (PR #8, ouverte)

| Commit | Contenu |
|---|---|
| `237f596` | Garde SSRF, détection de plateforme, parseurs de fichiers |
| `f1715d4` | Sources réseau et pipeline d'import |
| `169b9f0` | Panneau d'import intégré à Grow + preuve de rendu |
| `a69b367` | Chaînes partagées XLSX (vrais classeurs Excel) |

---

## 1. Ce qui fonctionne réellement

### Import de fichiers — **opérationnel**

| Format | État | Preuve |
|---|---|---|
| CSV | ✅ | RFC 4180, guillemets, sauts de ligne, BOM |
| TSV | ✅ | séparateur déduit |
| XML | ✅ | flux `product`/`item`/`entry`/`offer` |
| XLSX | ✅ | ZIP lu par `DecompressionStream`, `sharedStrings` géré |

Formats testés de bout en bout avec des fichiers construits en mémoire, y
compris un classeur en mode stocké **et** en mode deflate.

### Normalisation — **opérationnelle**

- Prix en unité mineure entière, jamais en flottant.
- Devises sans subdivision (XOF, XAF, JPY…) : 12 000 reste 12 000.
- HTML nettoyé : `<script>` et `<style>` supprimés avant tout affichage.
- URL limitées à `https`, `javascript:`/`data:` rejetés.
- Empreinte de déduplication insensible aux accents, à la casse et à la
  ponctuation (`SERUM ECLAT` = `Sérum éclat`).

### Prévisualisation — **opérationnelle**

Nom, prix, catégories, nombre de variantes, lien fiche, image, avertissements
par produit, nature du doublon (dans le fichier / déjà au catalogue).
**Rien n'est écrit avant confirmation** — vérifié par test (`createProduct`
jamais appelé pendant l'aperçu).

### Intégration Grow — **opérationnelle**

Nouveau bouton « Importer un catalogue » dans Croissance → Catalogue, à côté de
l'import texte existant, conservé. Le panneau reçoit l'entreprise active et
rafraîchit la liste après écriture.

### Détection de plateforme — **opérationnelle, sans réseau**

9 plateformes, indices pondérés (domaine, en-têtes, assets, meta), seuil de
décision et marge. Testée de bout en bout avec des empreintes fabriquées.

---

## 2. Ce qui ne fonctionne pas encore, et pourquoi

### Import par URL — **bloqué sur une décision d'architecture**

Le code de la sonde, de la garde SSRF et du pipeline URL est **écrit et testé**
(51 tests). Il n'est **pas exposé dans l'interface**, parce que la sonde exige
un résolveur DNS : un navigateur ne peut pas résoudre un nom puis vérifier
l'adresse obtenue. Sans ce contrôle, l'import d'URL devient un proxy SSRF.

Ce qui est livré : un message explicite dans le panneau (« exige une
vérification DNS et une protection contre les accès internes, qui n'existent que
côté serveur »), et **aucun bouton** qui échouerait.

Ce qu'il reste à faire : une Edge Function `store-import` qui reçoit l'URL,
applique `guardUrl` avec `Deno.resolveDns` comme résolveur, et renvoie
l'empreinte normalisée. Tout le reste du code est prêt — c'est un branchement,
pas une réécriture.

### Import par API autorisée — **non commencé**

Dépend de l'Integration Engine (livré au commit `6450f3d`) : le contrat
`ConnectorAdapter` existe, le registre est vide. Aucun connecteur n'est
implémenté, donc aucune connexion de boutique par API n'est proposée.

---

## 3. Sécurité — les garanties vérifiées

### SSRF

Deux **failles réelles** ont été trouvées par les tests, avant toute mise en
production :

1. `parseStoreUrl` validait la forme de l'URL mais **pas l'hôte**. Un appelant
   pouvait n'utiliser que la première étape. Correction : le contrôle d'hôte est
   dans la fonction elle-même. Une garde qu'on peut oublier d'appeler n'est pas
   une garde.
2. `::ffff:7f00:1` — l'écriture hexadécimale de `127.0.0.1` en IPv6 — passait
   le filtre. Correction : l'adresse est développée en huit groupes avant
   décision, et NAT64 (`64:ff9b::/96`) est couvert.

Couvert par test : `127.0.0.1`, `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`,
`::1`, `fe80::`, `fd00::`, `::ffff:192.168.0.1`, `localhost`, `.internal`,
`.local`, `.arpa`, labels uniques, redirection 302 vers `169.254.169.254`,
résolution mixte publique+privée, `content-length` menteur, réponse sans
`content-length`.

Le `User-Agent` s'annonce comme SORAHNEX — aucun usurpation de navigateur pour
franchir une protection.

### Fichiers

| Attaque | Défense | Test |
|---|---|---|
| XXE (`DOCTYPE SYSTEM`) | refus avant lecture | ✅ |
| Billion laughs (`ENTITY`) | refus avant lecture | ✅ |
| Injection de formule CSV | `sanitizeFormula` | ✅ |
| Zip bomb | sortie décompressée plafonnée à 32 Mio | ✅ |
| Fichier trop gros | 8 Mio, vérifié avant lecture | ✅ |
| Type usurpé (`.csv` qui est un ZIP) | détection par signature | ✅ |
| Archive XLSX chiffrée | refus explicite | ✅ |

### Isolation

Le pipeline n'écrit **jamais** en base : un test vérifie qu'il n'exporte aucune
fonction d'écriture. L'écriture passe par `createProduct` avec l'entreprise
active, donc par la RLS existante. Aucun secret n'est lu ni stocké.

---

## 4. Mesures

| Contrôle | Résultat |
|---|---|
| `tsc -b` | **0 erreur** |
| `npx vitest run` | **1594 passent / 1 échec préexistant** |
| Nouveaux tests | **+133** |
| `npm run build` | **OK** — `BusinessGrow-DbXPZEXE.js`, 188.24 kB |

Détail des nouveaux tests : 35 garde SSRF · 32 fichiers · 29 sources ·
22 pipeline · 13 panneau · 1 rendu.

(1594 = 1461 de la livraison précédente + 133.)

L'échec restant est `tests/business-modules.test.tsx:84`, présent avant ce
chantier, sans rapport avec l'importateur.

---

## 5. Preuves fonctionnelles

- **`artifacts/import-universel.html`** (160 Ko, CSS inliné) : aperçu réel
  produit par le vrai pipeline sur un CSV de 4 lignes. Montre simultanément un
  doublon interne (`SERUM ECLAT` face à `Sérum éclat`), un doublon du catalogue
  (`Baume lèvres`), un prix à compléter, et le décompte « Importer 3
  produit(s) » sur 4 détectés.
- **`artifacts/integrations-unifiees.html`** : preuve de la livraison
  précédente, toujours valide.
- Servis sur `http://127.0.0.1:4300/preuves/` → 200.

---

## 6. Netlify — ce que j'ai réellement trouvé

Statut à `169b9f0` : `status: pending`, `0 check-run`.

**Nouveauté** : `check-suites` renvoie **3 suites** — `netlify`, `render`,
`cursor` — toutes en `status: queued`, `latest_check_runs_count: 0`. L'application
Netlify **est donc installée** sur le dépôt. Le blocage n'est pas une absence
d'installation (c'était mon hypothèse précédente, elle était partiellement
fausse), mais un déploiement qui ne démarre pas.

Les causes possibles, par ordre de probabilité, et ce qu'il faut vérifier côté
compte Netlify (inaccessible depuis ici) :

1. **Deploy previews désactivées** pour ce site — l'option « Deploy previews:
   Any pull request » n'est pas activée.
2. **Quota de build épuisé** — la suite reste en file sans jamais consommer.
3. **`ignore` du `netlify.toml`** — mais il ne cite ni cette branche ni `develop`
   (`ignore` limite à `arena/323bad30` et `arena/ada94e4c`), donc ce n'est pas
   la cause ici.

Ce que je ne fais pas : fabriquer une URL, ou déduire une URL de production.

---

## 7. Prochaine étape recommandée

Deux chantiers, dans cet ordre :

1. **Edge Function `store-import`** — branche la sonde serveur avec
   `Deno.resolveDns`. Débloque l'import par URL, dont le code est déjà écrit et
   testé. C'est le plus petit pas à plus fort effet.
2. **Connecteurs réels** (Notion, Google Drive, Shopify) — débloquent l'import
   par API autorisée et la synchronisation, en réutilisant le contrat de
   `src/integrations/engine/`.
