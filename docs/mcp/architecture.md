# VYORA MCP — architecture et décisions

> **État : Phase 1 implémentée et testée localement. Phase 2 implémentée. Phase 3 = squelette de connecteurs (aucune activation).**
>
> Aucun déploiement en production. Aucun appel payant. Aucune intégration simulée.

---

## 1. Le problème à résoudre

Chaque utilisateur VYORA doit pouvoir brancher son compte à des outils compatibles MCP
(Claude Desktop, Cursor, VS Code…) et retrouver **ses** projets, **ses** générations,
**son** historique.

Cela impose une contrainte qui domine toute l'architecture :

> **Un serveur MCP distant est un endpoint public, unique, partagé par tous les
> utilisateurs.** L'isolation ne peut donc pas reposer sur l'URL. Elle doit reposer
> entièrement sur le jeton présenté — et être vérifiée **à chaque appel**, côté serveur,
> avant toute lecture.

Un serveur MCP mal isolé n'est pas un bug d'affichage : c'est une fuite de données entre
comptes. C'est le risque central de cette phase, et celui que les tests visent en premier.

---

## 2. Décisions structurantes

### 2.1 Transport : Streamable HTTP, pas SSE

Le protocole MCP définit trois transports. Le transport **Streamable HTTP** est le seul
compatible avec une Edge Function :

| Transport | Verdict |
|---|---|
| **Streamable HTTP** | **retenu** — requête/réponse HTTP classique, POST JSON-RPC sur un endpoint unique |
| SSE (ancien) | écarté — impose une connexion longue durée, impossible en Edge Function |
| stdio | écarté — réservé aux serveurs locaux |

Conséquence : pas de notifications serveur poussées. Le serveur répond à chaque requête
et termine. C'est conforme au protocole et suffisant pour des tools en lecture.

### 2.2 Authentification : jeton personnel haché, jamais stocké en clair

L'utilisateur ne présente pas son JWT Supabase à un client MCP tiers — un JWT court et
largement scopé n'a rien à faire dans un fichier de configuration d'outil externe. On
introduit donc un **jeton personnel dédié** :

```
vyora_mcp_<32 octets base64url>     (43 caractères utiles)
```

- **Seul le SHA-256 est stocké.** La valeur en clair n'est affichée **qu'une fois**, à la
  création. Ni la base, ni les logs, ni le frontend ne la conservent.
- **Préfixe de recherche** (`vyora_mcp_` + 8 caractères) stocké en clair : permet de
  retrouver la ligne sans hacher toute la table, et de révoquer sans jamais manipuler
  le secret complet.
- **Comparaison en temps constant** côté Edge pour éviter une attaque temporelle.
- **Portée explicite** (`scopes`) : `read` par défaut. Un jeton `read` ne peut pas
  appeler un outil d'écriture, même si l'outil existe.
- **Rotation** : nouveau secret, l'ancien est révoqué dans la même transaction.
- **Révocation** : immédiate, l'empreinte est invalidée.

### 2.3 Isolation : double barrière

1. **Barrière applicative** — chaque outil reçoit un contexte `{ userId, scopes }`
   construit à partir du jeton, jamais d'un paramètre fourni par le client MCP. Aucun
   outil n'accepte d'identifiant utilisateur en argument.
2. **Barrière base** — les requêtes passent par des RPC `security definer` qui prennent
   l'identité en paramètre explicite et filtrent dessus. RLS activée sur toutes les
   tables MCP, avec refus par défaut pour `anon` et `authenticated`.

Les tests d'isolation créent **deux utilisateurs réels** et vérifient qu'un jeton de A
ne voit jamais une ligne de B — c'est le test qui compte le plus.

### 2.4 Le client MCP ne dicte pas les permissions

Point de protocole important, souvent mal compris : dans MCP, **c'est le client qui
déclare quels tools il veut appeler**. Le serveur ne peut pas faire confiance à cette
déclaration. Toute autorisation d'écriture est donc re-vérifiée côté serveur, et les
actions sensibles exigent une **confirmation explicite** (jeton de confirmation à usage
unique), pas seulement la présence de l'outil dans la liste.

---

## 3. Composants

```
┌──────────────────────┐   Jeton personnel (Bearer)   ┌─────────────────────────────┐
│  Client MCP distant  │ ───────────────────────────► │  Edge Function `vyora-mcp`  │
│  (Claude, Cursor…)   │ ◄─────────────────────────── │  POST /  (JSON-RPC 2.0)     │
└──────────────────────┘    Resultat JSON-RPC         └──────────────┬──────────────┘
                                                                     │
                                        ┌────────────────────────────┼────────────────────────────┐
                                        │                            │                            │
                                 ┌──────▼──────┐            ┌────────▼────────┐          ┌────────▼────────┐
                                 │  Auth/jeton │            │  Registre tools │          │  Journal d'appels│
                                 │  haché+scopes│           │  (lecture/écrit)│          │  (audit, sans   │
                                 └──────────────┘            └────────┬────────┘          │   secret)       │
                                                                      │                   └─────────────────┘
                                                              ┌───────▼────────┐
                                                              │ RPC security   │
                                                              │ definer, filtré│
                                                              │ par user_id    │
                                                              └───────┬────────┘
                                                                      │
                                              ┌───────────────────────▼──────────────────────┐
                                              │  Données existantes (saas_ugc)               │
                                              │  ugc_video_projects, ugc_generation_jobs,     │
                                              │  ugc_usage_events, integration_connections    │
                                              └───────────────────────────────────────────────┘
```

### Méthodes MCP implémentées

| Méthode | Rôle |
|---|---|
| `initialize` | négociation de version, capacités `tools` |
| `notifications/initialized` | acquittement (notification, pas de réponse) |
| `ping` | vivacité |
| `tools/list` | catalogue filtré par les portées du jeton |
| `tools/call` | exécution, avec contrôle de portée et validation |
| `resources/list`, `prompts/list` | listes vides explicites (aucune ressource fantôme) |

### Tools de la phase 1 (lecture seule)

| Tool | Portée | Source réelle |
|---|---|---|
| `vyora_account_info` | `read` | `ugc_customer_accounts` + abonnement |
| `vyora_projects_list` | `read` | `ugc_video_projects` |
| `vyora_generations_list` | `read` | `ugc_generation_jobs` |
| `vyora_history_list` | `read` | `ugc_usage_events` |
| `vyora_integrations_list` | `read` | `integration_connections` |

### Tools d'écriture (préparés, désactivés par défaut)

`vyora_project_create` existe dans le registre mais :
- exige la portée `write` ;
- exige une **confirmation** (`confirm: true`) ;
- est **refusé** si la variable d'environnement `VYORA_MCP_WRITE_ENABLED` n'est pas à
  `true`. Le chemin d'écriture est donc présent et testé, mais **inopérant en
  production** tant qu'il n'est pas activé explicitement.

---

## 4. Ce qui est volontairement hors périmètre

- **Pas de connecteurs OAuth actifs.** La phase 3 livre l'architecture (table
  `mcp_oauth_providers`, fabrique de connecteurs, contrat), pas des connexions réelles :
  sans identifiants d'application approuvés par Google/Meta/TikTok, toute connexion
  serait une simulation — ce que les consignes interdisent.
- **Pas de déploiement.** Le code est prêt et testé; la mise en ligne attend votre accord.
- **Pas de tools d'écriture actifs.** Voir plus haut.

---

## 5. Risques identifiés

| Risque | Traitement |
|---|---|
| Jeton volé | Haché en base, révocable, rotation, journal d'usage daté |
| Fuite entre utilisateurs | Double barrière + tests d'isolation à deux comptes réels |
| Client MCP malveillant | Le serveur ne fait jamais confiance à la liste de tools déclarée par le client |
| Jeton en clair dans un log | Le secret n'est jamais journalisé ; seule l'empreinte de préfixe l'est |
| Écriture accidentelle | Écriture désactivée par défaut, confirmation obligatoire, portée `write` |
| Énumération de jetons | Réponse uniforme `401` quel que soit le motif d'échec |

---

## État d'avancement (2026-11-16)

| Élément | État |
| --- | --- |
| Document d'architecture | **fait** |
| Migration `20261116000118_vyora_mcp_core` | **appliquée en base** |
| Migration `20261116000130_vyora_mcp_functions` | **appliquée en base** |
| Migration `20261116001121_vyora_mcp_user_api` (interface) | **appliquée en base** |
| Edge Function `vyora-mcp` | **déployée, v1, ACTIVE** |
| Outils de lecture (5) | **opérationnels, preuves enregistrées** |
| Outil d'écriture | **préparé, non exposé** |
| Interface dashboard `/app/mcp` | **fait** |
| Connecteurs OAuth (8 fournisseurs) | **architecture seulement, aucun connecté** |

Preuves d'exécution : `docs/mcp/preuves-execution-reelle.md`.
Connecteurs : `docs/mcp/connecteurs-oauth.md`.
Écart source de référence / source déployée : `supabase/functions/vyora-mcp/DEPLOYED.md`.

### Limites connues

1. **Aucun client MCP tiers n'a été connecté.** Les preuves portent sur le
   protocole (JSON-RPC sur HTTP), pas sur Claude Desktop, Cursor ou VS Code.
2. **La source déployée est un monofichier** issu de la source de référence :
   toute correction doit être appliquée aux deux tant que le mécanisme
   d'artefact n'est pas branché sur `vyora-mcp`.
3. **Les jetons de vérification** créés pendant la campagne de preuves
   (`verif-A`, `verif-B`) doivent être révoqués avant toute mise en service.
