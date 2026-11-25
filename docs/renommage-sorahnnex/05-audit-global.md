# ÉTAPE 5 — Audit global (6 états)

Grille honnête : un élément n'est **opérationnel testé** que si une commande a
réellement été exécutée et a réussi dans cette session. Tout le reste est nommé
pour ce qu'il est.

| Domaine | État | Preuve / limite |
| --- | --- | --- |
| Renommage de marque visible | **opérationnel testé** | `typecheck`, `build`, garde `tests/brand-visible-sorahnnex.test.ts` (3/3), 323 fichiers en SORAHNEX ; identifiants techniques conservés et catalogués |
| Navigation mobile Grow (5 entrées, tiroir, verrou de défilement) | **corrigé, non testé sur appareil** | 87/87 tests ciblés ; aucun rendu 360/390/412 px ni clavier virtuel vérifié |
| Intégration Chariow (connecteur) | **opérationnel testé hors réseau réel** | 64/64 tests ; conformité vérifiée ligne à ligne avec `chariow.dev/api-reference` ; **aucun appel authentifié** (pas de clé) |
| Déploiement Edge (bundles + chargeurs) | **corrigé, en attente de déploiement** | 4 chargeurs à tranches régénérés, 4 chargeurs GitHub réépinglés ; 171/171 tests de parité. La production exécute encore l'ancien bundle jusqu'au redéploiement |
| Serveur MCP entrant | **opérationnel testé en unité** | 367/367 tests MCP ; 13 outils ; exécution depuis un client externe non testée |
| Parcours Paramètres → Intégrations → MCP | **opérationnel testé (compilation + tests)** | carte ajoutée dans `Settings.tsx`, 80/80 tests ; parcours non cliqué dans un navigateur |
| MCP sortant (`mcp-client`) | **présent, non testé en réel** | tests `mcp-http`, `mcp-external` (hors ligne) ; aucun serveur distant réel appelé |
| Studio universel | **incomplet — configuration externe requise** | catalogue préparé, aucune génération réelle : clés fournisseurs absentes, quotas non arbitrés |
| Studio classique / montage vidéo | **présent, non testé** | non revalidé dans cette mission |
| Paiements SasPay | **configuration externe requise** | code et tests présents ; secrets `VYORA_SASPAY_*` et webhook réels nécessaires |
| Shopify / WooCommerce | **incomplet** | lecture publique du catalogue seulement, aucun parcours de connexion authentifié |
| Autres fournisseurs d'intégration | **simulé / déclaré** | listés dans le catalogue, non fonctionnels ; l'interface doit les présenter « configuration requise », jamais « connecté » |
| Netlify / GitHub / Supabase (identité de compte) | **action propriétaire requise** | `SITE_NAME`, dépôt et nom d'affichage inchangés ; `SITE_ID` et `project_id` immuables |
| Landing page, 3D, refonte visuelle | **hors périmètre, non touchés** | aucune modification |

## Commandes exécutées dans cette session

```
npm ci
npm run typecheck                        → succès
npm run build                            → succès (12,9 s)
npx vitest run tests/brand-visible-sorahnnex.test.ts        → 3/3
npx vitest run (nav Grow + layout + business + modules)     → 87/87
npx vitest run (chargement/parité Edge, 13 fichiers)        → 171/171
npx vitest run (MCP, 16 fichiers)                            → 367/367
npx vitest run (settings + pages MCP)                        → 80/80
node scripts/build-edge-loader.mjs --all                     → 4 chargeurs régénérés
node scripts/build-edge-artifact.mjs store-import|store-connect|mcp-client
node scripts/build-business-grow-artifact.mjs                → réépinglage sur cf92ca3
```

## Ce que la suite complète n'a pas couvert

La suite entière (~3 380 tests) n'a pas été relancée d'un bloc : la VM (2 vCPU,
3,9 Go) dépasse la mémoire en parallèle et chaque commande est limitée à
5 minutes. Les 708 tests exécutés ici couvrent les zones modifiées (marque,
navigation, artefacts Edge, MCP, boutiques) ; les zones non touchées n'ont pas
été rejouées.

## Priorités suivantes

1. **Pousser la branche et redéployer** `store-connect`, `store-import`,
   `mcp-client`, `business-grow` avec les nouveaux bundles réépinglés — sans cela
   les corrections de cette session ne sont pas actives en production.
2. Tester Chariow avec une clé réelle (`store.read` + `products.read`).
3. Valider le mobile Grow sur appareil (360/390/412 px, paysage, clavier).
4. Exécuter la suite complète par lots sur une machine disposant de plus de
   mémoire.
5. Décider du domaine final SORAHNEX avant toute bascule Netlify/OAuth.
