# Contrats des intégrations externes Reelora

Ce contrat prépare les futurs connecteurs sociaux et e-commerce du SaaS Reelora. Il ne représente ni une connexion existante, ni un jeton, ni une synchronisation active. Les définitions locales restent à l’état `planned` jusqu’à l’implémentation et la vérification d’un connecteur officiel.

## Contrats TypeScript

Les types partagés sont définis dans `src/integrations/contracts.ts` :

- `IntegrationDefinition` décrit l’identifiant, la catégorie, le mécanisme d’autorisation et les capacités proposées.
- `IntegrationAccount` ne contient que les métadonnées d’un compte autorisé. Les jetons et secrets ne font pas partie du contrat navigateur.
- `IntegrationAdapter` décrit les opérations serveur attendues : début et callback d’autorisation, actualisation, révocation, puis synchronisation avec curseur.
- `IntegrationSyncResult` expose des compteurs et un curseur de synchronisation permettant une reprise idempotente.

Les connecteurs prévus sont Facebook, Instagram, YouTube, TikTok, Shopify et WooCommerce. Les capacités du registre sont indicatives : une capacité ne doit être affichée comme active qu’après obtention des scopes officiels et un test réel.

## Flux d’autorisation attendu

1. Le client Reelora appelle une Edge Function authentifiée avec l’identifiant du workspace autorisé.
2. Le serveur génère un `state` imprévisible, lié à l’utilisateur, au workspace, au connecteur et à une expiration; il stocke ce state côté serveur.
3. Le serveur retourne uniquement une URL d’autorisation officielle et son expiration. Aucun secret fournisseur ni jeton d’accès n’est retourné.
4. Le callback vérifie et consomme le state, échange le code côté serveur, chiffre le jeton avec un mécanisme de coffre serveur et enregistre uniquement une référence de secret dans les métadonnées de connexion.
5. Chaque lecture ou mutation contrôle à nouveau le workspace et son appartenance. Les appels plateforme et la synchronisation sont effectués côté serveur.
6. La synchronisation est paginée, idempotente et reprend depuis un curseur. Les erreurs de quota et les révocations mettent à jour l’état sans exposer de détails sensibles.

## Persistance

La connexion d’un fournisseur doit être liée à l’identifiant de workspace Reelora, non à une nouvelle identité ni à un compte SaaS indépendant. Avant d’activer un connecteur, définir et valider les tables, contraintes d’unicité, index, règles RLS, stockage sécurisé des références de secrets et politiques de conservation.

Le registre actuel ne crée aucune connexion et n’enregistre aucune donnée. Il n’y a pas de migration ni d’intégration active incluse dans cette préparation.
