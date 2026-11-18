# P5 — permissions par outil : le refus côté serveur, avant le réseau

Date : 2026-11-21 · Branche : `arena/0188834f-saas-ugc`

## Le problème que ce lot résout

Jusqu'ici, la classification d'un outil (lecture / écriture / destructif /
inconnu) et la décision d'appel vivaient dans le client. Un appel direct à une
Edge Function aurait contourné l'interface, et une permission venue du corps de
la requête aurait été crue sur parole.

P5 déplace la décision **derrière** la frontière HTTP : la base fait autorité,
et le client ne peut que demander.

## L'ordre des contrôles (aucun appel réseau avant le dernier)

`executerOutilExterne` (`supabase/functions/mcp-client/execution.ts`) :

1. la connexion existe **et appartient à cet utilisateur** ;
2. elle n'est pas révoquée, et son état est `connected` ;
3. le secret Vault est lisible (sinon refus, jamais un 401 trompeur) ;
4. l'outil figure dans la découverte **persistée** ;
5. la permission persistée vaut exactement `allowed` ;
6. si l'outil n'est pas classé lecture : autorisation d'écriture en base
   **et** confirmation pour cet appel.

Les points 4 à 6 passent par `deciderAppel`, déjà couverte par
`mcp-external.test.ts` : une seule implémentation de la règle, donc aucune
divergence possible entre la porte et sa documentation.

## Ce que le client ne peut pas faire

| Tentative | Résultat |
|---|---|
| Envoyer `permission: "allowed"` | ignoré — la base est relue |
| Envoyer `toolPermissions` | ignoré |
| Envoyer `userId` | ignoré — identité résolue par GoTrue |
| Confirmer une écriture non autorisée en base | refusée (`ecriture_non_confirmee`) |
| Appeler un outil jamais découvert | refusé (`outil_inconnu`) |
| Réutiliser la connexion d'un autre utilisateur | `server_not_found` (404) |

Le corps normalisé ne contient que `serverId`, `outil`, `arguments` et une
confirmation booléenne : il est structurellement impossible d'y glisser une
propriété que la couche de décision lirait par erreur.

## Preuves

`tests/mcp-execution.test.ts` (22) et `tests/mcp-route.test.ts` (14) lancent un
**vrai serveur MCP local** et comptent chaque `tools/call` reçu. Ce compteur est
la preuve : sur un refus, il reste vide.

| Cas | Statut | Appels reçus côté serveur |
|---|---|---|
| Lecture autorisée | 200 | 1 |
| Écriture autorisée mais non confirmée | refus | **0** |
| Écriture confirmée mais non autorisée en base | 403 | **0** |
| Écriture autorisée + confirmée | 200 | 1 |
| Permission absente / `pending` / `denied` / `ALLOWED` / `1` / `null` | 403 | **0** |
| Outil jamais découvert | 404 | **0** |
| Connexion révoquée | 409 | **0** |
| Connexion `unknown` ou `error` | 409 | **0** |
| Autre utilisateur | 404 | **0** |
| Secret introuvable | 409 | **0** |

Un test vérifie aussi qu'aucun jeton n'apparaît dans une réponse de refus, et
que l'entrée de journal ne contient ni arguments, ni jeton, ni URL.

## Validations

- `vitest run` : **166 fichiers / 2 875 tests, 0 échec**
- `tsc -b` : 0 erreur
- `tsc -p tsconfig.edge.json --noEmit` : 0 erreur

## Ce qui n'est pas encore branché

Ces deux modules sont **la couche de décision**, pas encore une Edge Function
déployée :

- il n'existe pas de fonction `mcp-external` (nom à choisir) dont l'`index.ts`
  appellerait `traiterAppelOutil` ;
- `AccesBase.lireConnexion` / `lireSecret` ne sont pas encore implémentés
  contre `postgres` + Vault ;
- **la migration P2 n'est pas appliquée** : `to_regclass('public.mcp_servers')`
  renvoie `null` en production. La valeur a été vérifiée le 2026-11-21.

Tant que la migration n'est pas exécutée, aucun appel réel ne peut aboutir :
c'est un fail-closed, pas une régression.
