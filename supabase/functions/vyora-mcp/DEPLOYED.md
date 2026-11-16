# `vyora-mcp` — écart entre la source de référence et la source déployée

**Déploiement vérifié le 2026-11-16** : slug `vyora-mcp`, version **1**,
`status: ACTIVE`, `verify_jwt: false`.

## Pourquoi deux sources

Le canal de déploiement du connecteur Supabase altère les sources longues
(constat déjà documenté dans `scripts/build-edge-loader.mjs`). La fonction
déployée a donc été publiée en **monofichier**, sans import relatif
(≈ 13 Ko), tandis que le dépôt conserve une source de référence découpée en
modules :

| Fichier du dépôt | Rôle | Statut |
| --- | --- | --- |
| `protocol.ts` | cœur JSON-RPC pur, HTTP, authentification | référence testée |
| `tools.ts` | registre des outils, schémas, validation | référence testée |
| `supabase-store.ts` | adaptateur PostgREST | référence testée |
| `index.ts` | fonction Edge (importe les trois ci-dessus) | référence |
| *fonction déployée v1* | monofichier équivalent | **actif en production** |

## Couverture de tests

Les **45 tests** de `tests/vyora-mcp.test.ts` s'exécutent contre la source de
référence. Les preuves d'exécution réelles (voir
`docs/mcp/preuves-execution-reelle.md`) portent sur la fonction déployée.

## Ce qu'il reste à faire

1. **Aligner la source déployée sur la référence** : soit en publiant le bundle
   minifié via la table d'artefacts (`scripts/build-edge-loader.mjs`), soit en
   rattachant `vyora-mcp` à `LOADER_TARGETS` et en publiant les tranches. Tant
   que ce n'est pas fait, toute correction doit être appliquée **aux deux**
   sources — c'est le principal risque de divergence.
2. Ajouter une entrée `LOADER_TARGETS['vyora-mcp']` et un test de parité
   d'artefact, sur le modèle de `tests/edge-loader-parity.test.ts`.

Aucun écart fonctionnel connu à ce jour : les deux sources exposent les mêmes
5 outils de lecture, les mêmes codes d'erreur, la même double barrière
d'isolation et la même désactivation par défaut de l'écriture.
