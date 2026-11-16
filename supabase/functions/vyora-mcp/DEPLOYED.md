# `vyora-mcp` — source déployée et pipeline d'artefacts

**État au 2026-11-16** : slug `vyora-mcp`, version **2**, `status: ACTIVE`,
`verify_jwt: false`, **publié par chargeur** (la divergence est close).

## Résolution de l'écart (version 2)

La version 1 était un monofichier publié à la main : dépôt et production
pouvaient diverger. C'est corrigé :

1. `vyora-mcp` a rejoint `LOADER_TARGETS` dans `scripts/build-edge-loader.mjs` ;
2. le bundle est généré de façon déterministe (gzip MTIME=0, SHA-256) ;
3. les 4 tranches ont été publiées dans `_edge_function_artifact_slices`
   (6 728 caractères base64, **MD5 vérifié `09f486e1d13dd83297ec6afaa6a7651a`**) ;
4. la fonction déployée n'est plus le code métier mais le **chargeur** de
   3 523 octets, qui recompose les tranches et **vérifie le SHA-256 avant
   exécution** (`artifact_digest_mismatch` sinon).

Conséquence : une divergence entre le dépôt et la production est désormais
**détectée à l'exécution**. Pour modifier le serveur, il faut régénérer le
bundle (`node scripts/build-edge-loader.mjs vyora-mcp`), republier les tranches
et redéployer le chargeur — jamais éditer la production à la main.

Vérifié après bascule : `tools/list` → **HTTP 200, 5 outils** sur la version 2.

## Historique : pourquoi deux sources au départ

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
