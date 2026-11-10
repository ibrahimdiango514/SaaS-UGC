# Business Grow — socle intégré à Reelora

Business Grow est le deuxième système fonctionnel de l’application Reelora, aux côtés du Studio UGC. Il utilise le même frontend React, la même session Supabase, le même compte et le même profil. Le schéma `saas_business` sépare les données métier sans créer un second SaaS ni une authentification indépendante.

## Parcours applicatif

- Route protégée `/app/business` dans la navigation Reelora existante.
- Conversations, messages et mémoire sont accessibles à travers la session utilisateur existante.
- Le navigateur appelle l’Edge Function `business-grow`; l’identité provient du JWT validé par Supabase Auth, jamais d’un `user_id` fourni par le client.
- L’Edge Function est conçue pour utiliser un rôle PostgreSQL serveur restreint (`bg_edge`) et des fonctions dédiées. Elle ne renvoie pas de secret fournisseur et n’expose pas les tables Business Grow à PostgREST.
- Le partage éventuel d’un workspace est validé côté SQL avant association à une conversation.
- Les données de mémoire ne sont enregistrées qu’après consentement; sa révocation purge le profil et les éléments mémoire.

## État des fournisseurs et coûts

Gemini, Groq, Gonka, Kilo, OpenRouter et LLM7 sont listés comme fournisseurs candidats, mais aucun n’est réputé connecté ou disponible sans configuration et vérifications serveur. MuAPI reste exclusivement dans le Studio UGC.

L’adaptateur Business Grow ne déclenche pas d’appel fournisseur ni de débit payant à ce stade. En l’absence de route vérifiée, une demande est historisée et son statut IA échoue explicitement; aucune réponse n’est simulée. Les usages et coûts Business Grow restent distincts des crédits et quotas Studio.

## État de la base et du déploiement

Les migrations SQL additives locales (`supabase/migrations/20261110000001_business_grow_saas_business.sql` et `supabase/migrations/20261110000002_business_grow_ai_extensions.sql`) préparent le schéma privé `saas_business`, les rôles (`bg_owner`, `bg_edge`, `bg_billing_worker`, `bg_erasure`), le routage par tâche (`auto`/`manual`), les propositions d’outils soumises à approbation utilisateur et le portefeuille/quota isolé Business Grow.

Elles restent **non appliquées** sur le projet Supabase `xbuuhfwobrafcbgtdgjx`, où ni `saas_business` ni la fonction Edge `business-grow` ni les secrets serveur (`BUSINESS_GROW_GROQ_API_KEY`, `BUSINESS_GROW_GEMINI_API_KEY`, etc.) ne sont encore déployés. Aucun fournisseur ni aucune intégration externe (`facebook`, `instagram`, `youtube`, `tiktok`, `shopify`, `woocommerce`) n’est déclaré disponible tant que les secrets serveur et les vérifications réelles (`providers.verify`) n’ont pas réussi.

## Fichiers principaux

- `src/business/BusinessGrowWorkspace.tsx` : interface de chat, routage auto/manuel par rôle métier, approbation d’actions assistées, transfert sans débit vers `/app/studio`, statut/vérification des fournisseurs, mémoire consentie et intégrations planifiées.
- `src/business/api.ts` : client authentifié vers l’Edge Function `business-grow`.
- `src/business/ai/registry.ts` : catalogue initial, adaptateurs extensibles préparés (`openai`, `anthropic`, `deepseek`, `mistral`) et rôles Business Grow.
- `supabase/functions/business-grow/` : validation d’identité, adaptateurs serveur (`providers.ts`), contexte et outils (`intelligence.ts`), orchestration centrale (`handler.ts`) et pont PostgreSQL `saas_business` (`index.ts`).
- `supabase/migrations/20261110000001_business_grow_saas_business.sql` et `20261110000002_business_grow_ai_extensions.sql` : migrations additives isolées prêtes pour application après validation.
- `supabase/config.toml` : fonction configurée avec validation JWT (`[functions.business-grow]`).
- `tests/business-grow*.test.{ts,tsx}` : tests UI, API client, frontières Studio/Business, adaptateurs fournisseurs et handler Edge.
