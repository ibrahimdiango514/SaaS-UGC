# Intégrations Business Grow — verrou d'accès et compte de test

_Mis à jour le 2026-11-18._

## Comportement livré (parcours)

| Abonnement (réponse serveur `business-grow` / `listIntegrations`) | Écran Intégrations | Requêtes `store-connect status` |
| --- | --- | --- |
| Refusé (`NO_SUBSCRIPTION`, `SUBSCRIPTION_EXPIRED`, …) | Bandeau « Connexions verrouillées … » + lien **Voir l'abonnement Business Grow** (`/app/business/abonnement`) ; « Mes boutiques connectées » affiche le même verrou. | **Aucune** (une seule requête au total : la lecture des intégrations). Comptes OAuth et journal ne sont pas lus non plus. |
| Accepté | État réel de chaque boutique (PrestaShop, Chariow, Shopify, WooCommerce). | 4 lectures, après la réponse d'acceptation. |
| Indisponible (panne réseau) | « Lecture des intégrations en échec : … », bouton **Revérifier**. | Aucune. |

Le serveur n'a pas changé : `store-connect` et `store-import` vérifient
toujours l'abonnement (`bg_import_access`) avant toute action, `status` compris.

## Origines autorisées (CORS)

Le domaine publié `https://vyora-saas-ugc.netlify.app` n'était pas dans la liste
par défaut (`src/lib/origin-allowlist.ts`) ; `store-connect` répondait
`access-control-allow-origin: null` et `store-import` 403 `ORIGIN_NOT_ALLOWED`.
Correction appliquée sans redéploiement, via les secrets Edge qui **s'ajoutent**
à la liste par défaut :

- `VYORA_ALLOWED_ORIGINS` (store-connect)
- `STORE_IMPORT_ALLOWED_ORIGINS` (store-import)

Valeur : `https://vyora-saas-ugc.netlify.app,https://deploy-preview-*--vyora-saas-ugc.netlify.app,https://vyora-ugc.netlify.app,https://deploy-preview-*--vyora-ugc.netlify.app,https://vyora.pages.dev,https://*.vyora.pages.dev`.

À développer : inscrire le domaine dans `DEFAULT_ALLOWED_ORIGINS` et dans les
listes figées de `business-grow/index.ts` et `_shared/saspay/http.ts`, puis
régénérer les artefacts épinglés (`tests/*-artifact.test.ts`) — nécessite un
redéploiement Edge, donc une autorisation explicite.

## Compte de test (attribution manuelle, mécanisme admin existant)

Aucune protection n'a été désactivée : l'abonnement a été posé par la RPC
`public.vyora_admin_set_business_subscription`, exécutée dans le contexte de
l'administrateur VYORA (`reelora_assert_admin()`), journalisée dans
`saas_ugc.ugc_audit_logs` (`business_grow_subscription_set`).

- Compte : `ibagang009@gmail.com` (`373436db-0f06-4888-a489-e9c60d7fbd8b`)
- Formule : `essentiel`, `billing_provider = manual`, du 2026-11-18 au 2026-12-18
- Abonnement : `92141f52-cb82-4c89-a288-679c807ff86c`, référence `manual:ed38622a-…`
- Note : « Compte de test intégrations (Shopify/WooCommerce/PrestaShop/Chariow) »

Révocation : `select public.vyora_admin_revoke_business_subscription('373436db-0f06-4888-a489-e9c60d7fbd8b', 'fin de test');`
(même contexte admin), ou Admin → Abonnements Business Grow.

Tarifs, facturation automatique et formules n'ont pas été modifiés
(`billing_enabled = false` sur les trois formules).
