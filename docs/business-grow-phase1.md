# Business Grow — socle intégré à VYORA

Business Grow est le deuxième système fonctionnel de l’application VYORA, aux côtés du Studio UGC. Il utilise le même frontend React, la même session Supabase, le même compte et le même profil. Le schéma `saas_business` sépare les données métier sans créer un second SaaS ni une authentification indépendante.

## Parcours applicatif

- Route protégée `/app/business` dans la navigation VYORA existante (accessible directement ou via un `BusinessGrowEntryIntent` typé depuis Dashboard, Projets ou Studio).
- Conversations, messages et mémoire sont accessibles à travers la session utilisateur existante.
- Le navigateur appelle l’Edge Function `business-grow` (`verify_jwt = true`) ; l’identité provient du JWT validé par Supabase Auth, jamais d’un `user_id` fourni par le client.
- L’Edge Function utilise un rôle PostgreSQL serveur restreint (`bg_edge`) et des fonctions `SECURITY DEFINER` dédiées. Elle ne renvoie aucun secret fournisseur et n’expose pas les tables `saas_business` à PostgREST.
- Le partage éventuel d’un workspace est validé côté SQL avant association à une conversation.
- Les données de mémoire ne sont enregistrées qu’après consentement ; sa révocation purge le profil et les éléments mémoire.
- Aucun outil métier (`propose_memory_save`, `propose_action_plan`, `propose_campaign_brief`, `handoff_ugc_brief`, `request_connector_read`) ne s’exécute sans approbation humaine explicite.

## État des fournisseurs, modèles et quotas

- **Fournisseurs actifs et vérifiés sur `xbuuhfwobrafcbgtdgjx`** :
  - **Groq** (`openai/gpt-oss-120b` priorité 1, `qwen/qwen3.8-27b` priorité 2, `openai/gpt-oss-20b` priorité 3 ; les anciens modèles non supportés sur ce compte ont été désactivés).
  - **Gemini** (`gemini-2.5-flash` priorité 10, `gemini-3.5-flash` priorité 11, `gemini-3-flash-preview` priorité 12, `gemini-2.5-flash-lite` priorité 13 ; `gemini-2.5-pro` et `gemini-pro-latest` désactivés suite aux sondes live).
- **Adaptateurs extensibles préparés** : `openai`, `anthropic`, `deepseek`, `mistral` (enregistrés côté serveur et catalogue sans secret ni exécution distante active tant qu’ils ne sont pas configurés).
- **MuAPI** reste exclusivement dans le Studio UGC (`saas_ugc`), hors du routage conversationnel Business Grow.
- **Isolation financière** : Business Grow gère ses propres quotas (`saas_business.ai_quota_*`) et ne lit ni ne débite jamais `saas_ugc.ugc_wallets` ou `saas_ugc.ugc_credit_ledger` (`consumesStudioCredits: false`, `studio_ugc_untouched: true`).

## État de la base et du déploiement (`xbuuhfwobrafcbgtdgjx`)

- **Migrations appliquées** : `20261110172827_business_grow_saas_business.sql` à `20261110180955_business_grow_gemini_priority.sql`.
- **Edge Function déployée** : `business-grow` (`verify_jwt: true`, statut `ACTIVE`).
- **Vérification bout-en-bout réalisée** : authentification JWT requise (`401` sans session), vérification live `providers.verify` (`groq`, `gemini`), exécution de tous les rôles métier, secours automatique `gemini -> groq`, mode manuel strict `allowFallback: false` (`503` sans débit), idempotence `messages.send`, quota isolé (`402 BG_INSUFFICIENT_QUOTA`), propositions d’outils (`action_plan`, `handoff_ugc_brief`), mémoire consentie / révocation (`409`) et effacement RGPD (`bg_prepare_account_erasure`).
- Les connecteurs externes (`facebook`, `instagram`, `youtube`, `tiktok`, `shopify`, `woocommerce`) demeurent à l’état `planned` tant que leurs flux OAuth et secrets serveur dédiés ne sont pas activés.

## Fichiers principaux & contrats anti-conflit

- `src/contracts/business-grow.ts` : contrats publics partagés (`BusinessGrowUgcHandoffBrief`, `BusinessGrowEntryIntent`, `BusinessGrowStatusPort`, `BusinessAiEnginePort`, `BusinessConnectorReadBridge`).
- `src/business/bridge.ts` et `src/business/index.ts` : pont officiel exposé aux autres modules VYORA.
- `docs/reelora-ai-platform-contracts.md` : guide de séparation des zones d’ownership entre le moteur IA (Arena) et la plateforme générale (VS Code).
- `src/business/BusinessGrowWorkspace.tsx` : interface de chat, routage auto/manuel par rôle métier, contrôle `allowFallback`, approbation d’actions assistées, transfert typé sans débit vers `/app/studio`, statut/vérification des fournisseurs, mémoire consentie et intégrations planifiées.
- `src/business/api.ts` et `src/business/ai/registry.ts` : client authentifié vers l’Edge Function `business-grow`, registre des fournisseurs, adaptateurs extensibles et descripteurs de capacités.
- `supabase/functions/business-grow/` : validation d’identité, adaptateurs serveur (`providers.ts`), contexte, normalisation d’outils (`intelligence.ts`), orchestration centrale (`handler.ts`) et pont PostgreSQL `saas_business` (`index.ts`).
- `supabase/migrations/20261110000001` à `000005` : schéma privé `saas_business`, extensions IA/outils/quotas, synchronisation catalogue Groq/Gemini et correctif d’effacement RGPD.
- `supabase/config.toml` : fonction configurée avec validation JWT (`[functions.business-grow]`).
- `tests/business-grow*.test.{ts,tsx}` et `tests/reelora-contracts.test.ts` : tests UI, contrats, pont plateforme, API client, frontières Studio/Business, adaptateurs fournisseurs et handler Edge.
