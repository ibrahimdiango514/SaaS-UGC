# VYORA MCP — compatibilité avec les clients MCP

## Résultat du test

**11 contrôles sur 11 réussis** avec le **SDK MCP officiel**
(`@modelcontextprotocol/sdk` v1.32.2) et son transport
`StreamableHTTPClientTransport` — le même code que celui employé par les clients
Node de l'écosystème MCP.

| # | Contrôle | Résultat |
| --- | --- | --- |
| 1 | Connexion sans jeton refusée | 401 explicite |
| 2 | Connexion avec jeton inventé refusée | 401 explicite |
| 3 | `initialize` + handshake | protocole négocié, `serverInfo` reçu |
| 4 | `tools/list` | 5 outils découverts |
| 5 | Annotations de lecture | tous `readOnlyHint: true` |
| 6 | `tools/call vyora_account_info` | `user_id` du propriétaire du jeton |
| 7 | Absence de `isError` | réponse saine |
| 8 | `tools/call vyora_projects_list` | pagination acceptée |
| 9 | Argument `user_id` fourni par le client | refusé `-32602` |
| 10 | Isolation — deux jetons | identités distinctes |
| 11 | Isolation — croisement de projets | **aucune fuite** |

Reproductible : `node scripts/mcp-client-check.mjs --url … --token … --token-b …`

## Portée exacte de cette preuve (à ne pas surestimer)

Le sandbox de développement **n'a pas d'accès réseau vers `*.supabase.co`**
(seuls GitHub et les registres de paquets sont joignables : `curl` vers le
projet renvoie `000`). Le serveur déployé ne peut donc pas être joint d'ici.

Le test a été exécuté ainsi :

- la **source du dépôt** (`supabase/functions/vyora-mcp/index.ts`) est chargée
  **telle quelle**, sans copie ni modification, par
  `scripts/mcp-local-server.mjs` ;
- les appels PostgREST de cette fonction sont servis par
  `scripts/mcp-bridge-memory.mjs`, qui réimplémente **les contrats SQL** sur deux
  utilisateurs (`mcp_resolve_token` par SHA-256, `mcp_projects_list` filtrée par
  `p_user_id`, `mcp_tool_permissions`, `mcp_touch_token`, `mcp_log_activity`) ;
- le client est le **SDK officiel**, non un client écrit à la main.

**Ce qui est prouvé** : la fonction du dépôt parle correctement le protocole MCP
à un client de référence — handshake, découverte, appels, erreurs, isolation.

**Ce qui n'est pas prouvé par ce test** :
1. l'accessibilité réseau publique de la fonction déployée — prouvée séparément
   par `pg_net` (voir `preuves-execution-reelle.md`) ;
2. le comportement de Postgres sur ces RPC — prouvé séparément sur la base
   réelle (isolation A/B, jetons révoqués, privilèges) ;
3. le rendu dans l'**interface graphique** de Cursor ou Claude Desktop : ce sont
   des applications de bureau, hors de portée d'un sandbox sans réseau. Leur
   configuration est fournie ci-dessous, mais **elle n'a pas été essayée par moi
   dans ces applications** — ce serait une affirmation sans preuve.

## Configuration à utiliser dans un vrai client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "vyora": {
      "type": "http",
      "url": "https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp",
      "headers": { "Authorization": "Bearer vyora_mcp_VOTRE_JETON" }
    }
  }
}
```

### Cursor (`.cursor/mcp.json` ou réglages MCP)

```json
{
  "mcpServers": {
    "vyora": {
      "type": "http",
      "url": "https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp",
      "headers": { "Authorization": "Bearer vyora_mcp_VOTRE_JETON" }
    }
  }
}
```

### VS Code (`settings.json` → `mcp.servers`)

```json
{
  "servers": {
    "vyora": {
      "type": "http",
      "url": "https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-mcp",
      "headers": { "Authorization": "Bearer vyora_mcp_VOTRE_JETON" }
    }
  }
}
```

La même configuration est générée et copiable depuis la page `/app/mcp`
(onglet « Connexion »), à partir du jeton réellement créé.

## Contrôle de sécurité notable

Le contrôle n°9 est celui qui compte le plus : le client a tenté de forcer
`{"user_id": "…"}` dans les arguments. Le serveur a répondu
`-32602 Argument non supporté : user_id`, **sans appeler la moindre RPC**. Un
agent ne peut donc pas choisir l'identité qu'il interroge.

## Ce qu'il reste à faire pour conclure la compatibilité

- [ ] Essayer la configuration ci-dessus dans **Claude Desktop** et confirmer
      l'apparition des 5 outils dans l'interface (nécessite un poste avec accès
      réseau au projet).
- [ ] Idem dans **Cursor**.
- [ ] Vérifier le rafraîchissement de la liste après ajout d'outils (le serveur
      annonce `tools.listChanged: false` : un redémarrage du client est requis).
