# ÉTAPE 4 — Serveur MCP : audit et parcours

Statut : **serveur réel, exécution couverte par 367 tests ; parcours Paramètres →
Intégrations → MCP ajouté**. Aucun test contre un client MCP externe réel n'a été
exécuté dans cet environnement.

## 1. Ce qui existe déjà (audité, pas recréé)

| Élément | Emplacement | Constat |
| --- | --- | --- |
| Serveur MCP entrant | `supabase/functions/vyora-mcp/` (`index.ts`, `handler.ts`, `core.ts`, `oauth.ts`) | **Réel** : JSON-RPC, résolution de jeton par RPC (`mcp_resolve_token`), journalisation (`mcp_log_activity`), mise à jour d'usage (`mcp_touch_token`) |
| Outils exposés | `core.ts` | **13 outils** : `vyora_account_info`, `vyora_stores_list`, `vyora_products_list`, `vyora_product_get`, `vyora_imports_list`, `vyora_import_previews_list`, `vyora_integrations_status`, `vyora_integrations_list`, `vyora_projects_list`, `vyora_generations_list`, `vyora_history_list`, `vyora_product_create`, `vyora_project_create` |
| Isolation par entreprise | paramètre `workspace_id` sur les outils de lecture/écriture | le `userId` vient du jeton GoTrue, jamais du corps ; `workspace_id` restreint la lecture et est validé côté SQL |
| Écritures | `vyora_product_create`, `vyora_project_create` | conditionnées, jamais implicites ; l'activation des écritures est un réglage serveur (`VYORA_MCP_WRITE_ENABLED`, conservé) |
| OAuth | `oauth.ts`, `consentement.ts` | consentement explicite, `resource_name` affiché en SORAHNEX (métadonnée, pas un identifiant) |
| Client MCP sortant | `supabase/functions/mcp-client/`, `MesServeursMcpPage.tsx` | parcours réel `/gestion/...`, permissions outil par outil, aucun secret réaffiché |
| Pages | `ConnexionsMcpPage`, `McpConnectionsPage`, `MesServeursMcpPage` | routes `/app/connexions-mcp`, `/app/connexions-ia`, `/app/mes-serveurs-mcp` |

## 2. Défaut corrigé : parcours introuvable depuis les Paramètres

Les trois écrans MCP n'étaient atteignables que depuis la barre latérale de
l'assistant (`src/ai/Sidebar.tsx`). Le parcours demandé
**Paramètres → Intégrations → Connexion MCP** n'existait pas : l'onglet
« Intégrations » ne listait que les futurs connecteurs sociaux/e-commerce.

Ajout dans `src/pages/Settings.tsx`, onglet « Intégrations », d'une carte
**« Connexion MCP »** avec trois accès nommés (Connexions MCP, Serveur MCP
SORAHNEX, Mes serveurs MCP) et un bandeau qui rappelle les deux limites : aucune
connexion affichée sans réponse réelle du serveur, révocation possible à tout
moment, appels isolés sur l'entreprise qui a autorisé.

## 3. Vérification

| Contrôle | Résultat |
| --- | --- |
| `npm run typecheck` | **succès** |
| `npm run build` | **succès** |
| 16 fichiers de tests MCP (`mcp-core`, `mcp-handler`, `mcp-http`, `mcp-execution`, `mcp-gestion*`, `mcp-oauth*`, `mcp-route`, `mcp-tools-parity`, `mcp-url-backend`, `mcp-accueil`, `mcp-account-info`, pages) | **367/367 succès** |
| `tests/settings-catalog.test.tsx` + pages MCP après ajout de la carte | **80/80 succès** |

## 4. Non vérifié / reste à faire

- **Exécution depuis un vrai client MCP** (ChatGPT, Claude Code) : nécessite un
  jeton émis pour un compte réel et l'URL publique du serveur.
- **Révocation de bout en bout** : les RPC existent et sont testées en unité,
  mais aucune révocation n'a été observée sur un déploiement.
- **Isolation stricte entre deux entreprises réelles** : couverte par des tests
  de handler, pas par un test à deux comptes sur la base de production.
- Les permissions affichées côté client doivent rester relues depuis la base
  après chaque action (comportement déjà implémenté dans `MesServeursMcpPage`,
  à confirmer visuellement).
