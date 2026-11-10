# Reelora AI Engine & Business Grow — Architecture et Contrats d’Intégration VS Code

> **Date :** 2026-11-09  
> **Branche :** `arena/147ca0c8-saas-ugc`  
> **Statut déploiement :** Code, migrations SQL et tests préparés localement. **Aucune migration DB et aucune Edge Function n’ont été publiées en production** (en attente de votre validation et de vos clés API `GROQ_API_KEY` / `GEMINI_API_KEY`).

---

## 1. Architecture générale & séparation Studio UGC ↔ Business Grow

Le moteur IA central alimente **Business Grow** tout en pouvant être étendu à d’autres fonctions intelligentes de Reelora sans couplage ni partage de crédits :

```text
┌───────────────────────────────┐        ┌──────────────────────────────────┐
│ Studio UGC (/app/studio...)   │        │ Business Grow (UI VS Code)       │
│ Crédits : saas_ugc.ugc_wallets│        │ Crédits : saas_ugc.bg_wallets    │
│ Quota   : ugc_usage_events    │        │ Ledger  : bg_credit_ledger       │
└──────────────┬────────────────┘        └────────────────┬─────────────────┘
               │ (brief optionnel sans débit Studio)      │
               │                                          ▼
               │                         ┌──────────────────────────────────┐
               │                         │ SDK Frontend : src/ai/*          │
               │                         │ - contracts.ts / client.ts       │
               │                         │ - useBusinessGrow.ts             │
               │                         │ - routing/planner.ts             │
               │                         │ - tools/registry.ts              │
               │                         │ - connectors/interfaces.ts       │
               │                         └────────────────┬─────────────────┘
               │                                          │ HTTPS (JWT vérifié)
               ▼                                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Supabase Edge Function : supabase/functions/reelora-ai-engine/             │
│  ├── index.ts        (auth JWT, actions health/verify/execute/business_chat)│
│  ├── router.ts       (chaîne candidats auto/manuel, fallback, coûts/tokens)│
│  ├── businessGrow.ts (hydratation profil, mémoire consentie, outils, etc.) │
│  └── providers/                                                            │
│       ├── groq.ts         (Groq Cloud REST réel : llama-3.3-70b, 8b, qwen3)│
│       ├── gemini.ts       (Google Gemini REST réel : 2.5 Flash / Pro, 2.0) │
│       ├── placeholders.ts (adaptateurs prêts : OpenAI, Claude, DeepSeek,   │
│       │                    Mistral)                                        │
│       └── registry.ts     (registre extensible centralisé)                 │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL (saas_ugc + vues public security_invoker = true + RLS stricte)  │
│ - ai_providers, ai_models, ai_routing_rules                                │
│ - ai_requests, ai_request_attempts                                         │
│ - bg_wallets, bg_credit_ledger                                             │
│ - bg_business_profiles, bg_business_memories                               │
│ - bg_conversations, bg_messages, bg_tool_executions                        │
│ - bg_external_connectors, bg_connector_snapshots                           │
└────────────────────────────────────────────────────────────────────────────┘
```

### Garantie d’isolation des crédits
- Business Grow utilise **exclusivement** `saas_ugc.bg_wallets` et `saas_ugc.bg_credit_ledger` via `reelora_bg_reserve_credits`, `reelora_bg_capture_credits` et `reelora_bg_release_credits`.
- Business Grow n’appelle **jamais** `reelora_consume_quota`, `ugc_reserve_credits`, `saas_ugc.ugc_wallets` ou `saas_ugc.ugc_usage_events`.
- Tout handoff d’idée de campagne depuis Business Grow vers Studio UGC (`buildUgcBriefHandoff`) produit uniquement un brouillon de projet (`consumesStudioCreditsOnDraft: false`) et ne débite aucun crédit vidéo Studio UGC.

---

## 2. Points d’entrée TypeScript pour VS Code (`src/ai/index.ts`)

VS Code importe directement depuis `../ai` (ou `@/ai`) :

### 2.1 SDK principal `reeloraAI` (`src/ai/client.ts`)
| Méthode | Signature / Rôle | Retour |
| --- | --- | --- |
| `reeloraAI.getHealth()` | Sonde réelle des fournisseurs configurés vs vérifiés | `Promise<AIHealthResponse>` |
| `reeloraAI.verifyProvider(providerKey, modelId?)` | Exécute un appel réel de vérification serveur | `Promise<AIProviderVerificationResponse>` |
| `reeloraAI.listModels({ providerKey?, includeRemote? })` | Catalogue + modèles distants si clé active | `Promise<{ models, remoteModels }>` |
| `reeloraAI.execute(req)` | Exécution IA générique avec routage & fallback | `Promise<AIExecuteResponse>` |
| `reeloraAI.sendBusinessMessage(req)` | Tour complet Business Grow (profil + mémoire + outils + sauvegarde) | `Promise<AIExecuteResponse>` |
| `reeloraAI.getBGQuota(workspaceId?)` | Solde isolé Business Grow (`credit_domain: 'business_grow'`) | `Promise<BGQuotaStatus>` |
| `reeloraAI.listRoutingRules(space?)` / `saveWorkspaceRoutingRule(...)` | Règles auto/manuel par workspace/tâche | `Promise<AIRoutingRuleRecord[]>` |
| `reeloraAI.listRequests(limit?)` | Historique des requêtes, modèles utilisés, tokens, coûts | `Promise<AIRequestLog[]>` |
| `reeloraAI.listBusinessProfiles()` / `upsertBusinessProfile(...)` | Profils entreprise structurés | `Promise<BusinessProfile[]>` |
| `reeloraAI.listBusinessMemories(profileId)` / `saveBusinessMemory(...)` / `deleteBusinessMemory(id)` | Mémoire métier persistante isolée | `Promise<BusinessMemoryItem[]>` |
| `reeloraAI.listBusinessConversations()` / `createBusinessConversation(...)` / `listBusinessMessages(convId)` | Conversations Business Grow | `Promise<...>` |
| `reeloraAI.listToolExecutions(convId?)` / `resolveToolExecution(id, 'approved' \| 'rejected')` | Validation humaine des actions/outils | `Promise<...>` |
| `reeloraAI.listExternalConnectors(profileId?)` / `registerPreparedConnector(...)` | État des connecteurs sociaux/e-commerce | `Promise<ExternalConnectorState[]>` |

### 2.2 Hook React clé en main `useBusinessGrow` (`src/ai/useBusinessGrow.ts`)
```tsx
import { useBusinessGrow, previewRoutingPlan, buildUgcBriefHandoff } from '../ai';
import { useAuth } from '../context/AuthContext';

export function BusinessGrowWorkspace() {
  const { user, workspaceId } = useAuth();
  const bg = useBusinessGrow({ workspaceId, userId: user?.id });
  // bg.bgQuota (crédits BG isolés), bg.health (fournisseurs réels),
  // bg.activeProfile, bg.memories, bg.conversations, bg.messages,
  // bg.pendingTools, bg.connectors, bg.sendMessage(...), bg.resolveTool(...)
}
```

---

## 3. Contrat HTTP de l’Edge Function (`reelora-ai-engine`)

- **URL :** `POST ${SUPABASE_URL}/functions/v1/reelora-ai-engine`
- **Authentification :** `Authorization: Bearer <user_jwt>` (JWT vérifié obligatoirement via GoTrue + `verify_jwt = true` dans `supabase/config.toml`)

### Actions supportées

1. **`{ "action": "health" }`**  
   Retourne `{ engine, status, creditDomainIsolation: true, providers: AIProviderStatus[], models: AIModelDefinition[] }`.  
   Un fournisseur n’a `connected: true` que si `configured: true` **et** `verification_status === 'connected'` en base après un appel API réel réussi.

2. **`{ "action": "verify_provider", "providerKey": "groq" | "gemini", "modelId"?: string }`**  
   Exécute un appel minimal réel côté serveur (`max_tokens: 12..16`), met à jour `ai_providers.verification_status`, et retourne `AIProviderVerificationResponse` (`200` si vérifié, `503` si secret absent, `502` si échec API).

3. **`{ "action": "list_models", "providerKey"?: AIProviderKey, "includeRemote"?: boolean }`**  
   Retourne le catalogue local et, si `includeRemote: true` et le fournisseur est configuré, les modèles retournés en direct par `/v1/models` ou `/v1beta/models`.

4. **`{ "action": "business_chat", ... }`** (et **`"action": "execute"`**)  
   **Corps attendu :**
   ```json
   {
     "action": "business_chat",
     "workspaceId": "uuid-optionnel",
     "businessProfileId": "uuid-optionnel",
     "conversationId": "uuid-optionnel",
     "taskType": "chat | strategy | action_plan | marketing_campaign | sales_analysis | content_ideas | memory_extraction | tool_planning",
     "prompt": "Message utilisateur",
     "messages": [{ "role": "user | assistant", "content": "..." }],
     "temperature": 0.45,
     "maxTokens": 2400,
     "jsonMode": false,
     "enableTools": true,
     "routing": {
       "selectionMode": "auto | manual",
       "preferredProviderKey": "groq | gemini",
       "preferredModelId": "llama-3.3-70b-versatile",
       "maxCostTier": "economy | balanced | premium",
       "allowFallback": true
     }
   }
   ```
   **Réponse `200 OK` :**
   ```json
   {
     "requestId": "uuid",
     "space": "business_grow",
     "taskType": "strategy",
     "provider": "gemini",
     "model": "gemini-2.5-pro",
     "fallbackUsed": false,
     "attempts": [
       { "attemptNumber": 1, "providerKey": "gemini", "modelId": "gemini-2.5-pro", "status": "succeeded", "latencyMs": 920, "inputTokens": 480, "outputTokens": 310, "estimatedCostUsd": 0.0037 }
     ],
     "text": "...",
     "toolProposals": [
       { "toolName": "propose_action_plan", "arguments": { ... }, "riskLevel": "write_requires_approval" }
     ],
     "usage": {
       "inputTokens": 480,
       "outputTokens": 310,
       "estimatedCostUsd": 0.0037,
       "bgCreditsCharged": 3,
       "studioUgcCreditsCharged": 0
     },
     "latencyMs": 920,
     "messageId": "uuid",
     "businessProfileId": "uuid"
   }
   ```

### Erreurs normalisées (`error.code`)
| Code | Statut HTTP | Signification |
| --- | --- | --- |
| `UNAUTHENTICATED` | `401` | JWT manquant ou invalide |
| `FORBIDDEN` | `403` | Espace ou profil non autorisé par RLS |
| `BG_INSUFFICIENT_CREDITS` | `402` | Crédits Business Grow insuffisants (Studio UGC jamais touché) |
| `AI_PROVIDERS_NOT_CONFIGURED` / `NOT_CONFIGURED` | `503` | Aucune clé API serveur (`GROQ_API_KEY` / `GEMINI_API_KEY`) configurée |
| `RATE_LIMITED` | `429` | Tous les fournisseurs disponibles ont atteint leur limite |
| `AUTH_ERROR` / `PROVIDER_UNAVAILABLE` / `EMPTY_RESPONSE` / `SAFETY_BLOCKED` | `502` | Échec amont complet (les crédits réservés sont remboursés à 100 %) |
| `CONNECTOR_NOT_CONNECTED` | `400` | Lecture connecteur impossible sans OAuth autorisé |

---

## 4. Variables d’environnement / Secrets serveur requis

**Strictement côté Supabase Edge Functions Secrets (`create_secrets`) — JAMAIS dans Vite (`VITE_*`) ni dans Git :**
- `GROQ_API_KEY` : clé API Groq Cloud (obligatoire pour activer Groq).
- `GEMINI_API_KEY` (ou alias `GOOGLE_AI_API_KEY`) : clé API Google AI Studio / Gemini (obligatoire pour activer Google Gemini).
- Déjà présents dans Supabase : `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Secrets préparés pour extensions futures (non actifs tant que l’adaptateur correspondant n’est pas branché) : `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`.

---

## 5. Modifications sur fichiers partagés & guide d’intégration VS Code

Conformément à la coordination avec VS Code, aucun écran existant de Studio UGC ni le routage principal n’a été remodelé :

### Fichiers partagés légèrement modifiés dans cette mission
1. `supabase/config.toml` : ajout de `[functions.reelora-ai-engine]\nverify_jwt = true`.
2. `src/lib/errors.ts` : ajout des traductions françaises pour `AI_PROVIDERS_NOT_CONFIGURED`, `BG_INSUFFICIENT_CREDITS`, `business_memory_consent_required`.
3. `tests/integration-parity.test.ts` : mise à jour de l’inventaire des Edge Functions déclarées (`5` au lieu de `4` avec `reelora-ai-engine`).

### Modifications suggérées côté VS Code (à réaliser dans l’UI Business Grow)
- **`src/App.tsx`** : ajouter une route protégée sous `/app/business-grow` (ex. `<Route path="business-grow" element={<BusinessGrow />} />`).
- **`src/components/Layout.tsx`** : ajouter l’entrée de navigation `Business Grow` dans `NAV` avec distinction visuelle des crédits Business Grow (`useBusinessGrow` / `reeloraAI.getBGQuota()`) séparés de `quota.credits` (Studio UGC).
- **Écran Business Grow** : consommer `useBusinessGrow({ workspaceId, userId })`, afficher le badge fournisseur/modèle utilisé (`lastResponse.provider`, `lastResponse.model`, `lastResponse.fallbackUsed`), les boutons Approuver / Refuser pour `pendingTools`, la fiche entreprise & souvenirs épinglés, et le panneau des connecteurs préparés (`EXTERNAL_CONNECTOR_CATALOG`).
