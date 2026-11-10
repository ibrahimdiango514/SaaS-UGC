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

## État de la base

Le dossier SQL de [conception Business Grow](./business-grow-sql-design.md) n’a pas été exécuté. La vérification précédente du projet `xbuuhfwobrafcbgtdgjx` indiquait que `saas_business` et ses objets n’y étaient pas présents. Aucune migration n’a été appliquée. La migration additive et ses objets exacts doivent être présentés pour approbation avant toute écriture dans le projet de production.

L’Edge Function, la configuration locale, le client frontend et les contrats de lecture/écriture SQL sont préparés dans le dépôt, mais le parcours persistant reste indisponible tant que le schéma et les secrets serveur requis ne sont pas installés. Aucun fournisseur, compte de paiement ou intégration externe n’est déclaré opérationnel.

## Fichiers principaux

- `src/business/BusinessGrowWorkspace.tsx` : interface de chat, historique, statut des fournisseurs et gestion de la mémoire.
- `src/business/api.ts` : client authentifié vers l’Edge Function.
- `src/business/ai/registry.ts` : catalogue initial et capacités proposées.
- `supabase/functions/business-grow/` : validation d’identité, contrat d’API et accès serveur privé.
- `supabase/config.toml` : fonction configurée avec validation JWT.
- `tests/business-grow.test.tsx` et `tests/business-grow-edge.test.ts` : tests UI et du handler Edge sans connexion à une base ni appel fournisseur.
