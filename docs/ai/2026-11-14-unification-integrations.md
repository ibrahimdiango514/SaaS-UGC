# Unification des intégrations — correspondance des deux modèles

**Date** : 2026-11-14 · **Branche** : `arena/bfcedd89-saas-ugc`
**Préalable exigé** : examiner les deux modèles et documenter leur correspondance
**avant** toute migration.

---

## 1. Ce qui existait réellement

Le projet contenait **trois sources distinctes**, pas deux. Les confondre aurait
produit un catalogue qui ment.

### A. Catalogue déclaratif — `src/integrations/catalog.ts` (26 fournisseurs)

Aucune donnée persistée. Décrit chaque fournisseur : catégorie, description,
capacités, modes d'authentification, prérequis, `engine` (connecteur écrit ou
`null`). C'est la **fiche d'identité**.

### B. Demandes d'activation — `saas_business.integration_connections`

Table réelle, déployée. Colonnes :

```
id uuid PK · user_id uuid NOT NULL · workspace_id uuid NULL
connector_key text NOT NULL · external_account_ref text NULL
credential_ref text NULL · status text NOT NULL · created_at · updated_at
```

Contraintes réellement lues en base :

- `CHECK status IN ('unconfigured','pending','connected','disconnected','error')`
- index unique partiel `(user_id, connector_key) WHERE status='pending' AND external_account_ref IS NULL`
- RLS : politique `owner_integrations`, `ALL`, rôle `bg_owner`

RPC (SECURITY DEFINER, scopées par entreprise) :

| Fonction | Effet |
|---|---|
| `bg_list_scoped_integration_connections(user, workspace)` | lecture |
| `bg_request_scoped_integration_connection(user, workspace, key)` | insère/réactive `pending` |
| `bg_cancel_scoped_integration_request` | supprime la demande `pending` sans compte |
| `bg_disconnect_scoped_integration_connection` | `disconnected`, efface `credential_ref` / `external_account_ref` |
| `bg_validate_connector_key` | **refuse toute clé hors `facebook, instagram, youtube, tiktok, shopify, woocommerce`** |

### C. Comptes OAuth réels — `public.oauth_accounts`

Table réelle, déployée, vide à ce jour. Colonnes : `provider`, `external_account_id`,
`display_name`, `email`, `capabilities` (bornées à `read|draft|send|modify`),
`status` (`pending|connected|expired|revoked|error`), jetons chiffrés.

`CHECK provider IN ('gmail','google_drive','google_calendar')` — **un identifiant
par service Google**, jamais fusionnés.

Lecture : `oauth_list_accounts()` (SECURITY DEFINER, filtrée sur `auth.uid()`),
`oauth_audit_list(p_limit)`, `oauth_revoke_account(p_account_id)`.

## 2. Correspondance retenue

Le statut affiché est **dérivé**, jamais stocké. Une seule fonction décide, et
elle lit les sources dans cet ordre de priorité :

| Priorité | Source | Condition | Statut affiché |
|---|---|---|---|
| 1 | `oauth_accounts` | `status = connected` | **Connecté** |
| 2 | `oauth_accounts` | `status = expired` | **Erreur de connexion** (motif : expiré) |
| 3 | `oauth_accounts` | `status = revoked` | **Non connecté** (accès révoqué côté fournisseur) |
| 4 | `oauth_accounts` | `status = error` | **Erreur de connexion** |
| 5 | `integration_connections` | `status = pending`, `external_account_ref IS NULL` | **Activation demandée** |
| 6 | `integration_connections` | `status = connected`, **sans** compte OAuth vérifié | **Autorisation manquante** |
| 7 | `integration_connections` | `status = error` | **Erreur de connexion** |
| 8 | catalogue | `engine === null` + approbation externe connue | **Validation externe requise** |
| 9 | catalogue | `engine === null`, sinon | **Configuration requise** |
| 10 | catalogue | `engine !== null` | **Disponible** (non connecté) |

Deux règles portent tout le reste :

1. **Le cas 6 est le cœur de la demande.** Une ligne `connected` dans
   `integration_connections` peut exister sans qu'aucune autorisation n'ait été
   obtenue : le backend actuel écrit cette valeur sur demande de l'utilisateur,
   pas après un handshake OAuth. Afficher « Connecté » sur cette seule base
   serait exactement le faux état interdit. Sans compte dans `oauth_accounts`,
   on affiche **« Autorisation manquante »**, pas « Connecté ».
2. **Aucun statut inventé.** Si la lecture échoue, on rend « État inconnu » et
   on bloque les actions (comportement déjà verrouillé par les tests existants).

### Correspondance des identifiants

Les identifiants sont identiques dans les trois sources (`facebook`, `instagram`,
`youtube`, `tiktok`, `shopify`, `woocommerce`) : aucune table de correspondance
n'est nécessaire.

Point de vigilance explicite : `gmail`, `google_drive`, `google_calendar` sont
**trois fournisseurs distincts** dans `oauth_accounts`. Aucune normalisation ne
les fusionne — un compte Drive n'accorde rien sur Gmail. C'est verrouillé par
test (`ne fusionne pas les services Google entre eux`).

### Le blocage à traiter en Livraison 3

`bg_validate_connector_key` n'accepte que **6 clés**. Les 20 autres fournisseurs
du catalogue ne peuvent pas recevoir de demande d'activation : le serveur
lèverait `invalid connector key`.

Conséquence assumée : pour ces 20 fournisseurs, l'interface affiche leur statut
réel et **n'expose pas** de bouton « Demander l'activation » qui échouerait. La
migration qui élargit cette liste accompagne le Integration Engine (Livraison 3),
car elle n'a de sens qu'avec des connecteurs réellement implémentés derrière.

**Aucune migration n'est appliquée dans ce lot.** Aucune donnée n'est supprimée :
`oauth_accounts`, `oauth_audit_log`, `integration_connections` et les RPC restent
intacts.

## 3. Interface unifiée

Un seul composant, `src/integrations/IntegrationsCenter.tsx`, rendu à deux endroits :

- **Business Grow → Intégrations** (section `integrations`) ;
- **`/app/connect`** — qui n'est plus un catalogue parallèle mais la même page.

La page expose : les 26 fournisseurs, la recherche, le filtre par catégorie,
les capacités et permissions, le statut réel, la demande d'activation
(6 fournisseurs éligibles), la révocation OAuth réelle quand un compte existe.

`/app/connect` conserve son propre en-tête de page (retour à l'assistant) ;
le composant reste identique.

## 4. Ce qui n'est pas touché

- `src/integrations/contracts.ts` est conservé : `Settings.tsx` l'utilise pour un
  aperçu en lecture seule, et `tests/settings-catalog.test.tsx` le verrouille.
  Le nouveau centre ne s'en sert pas comme source de statut.
- Les RPC et la RLS ne changent pas.
- Aucun secret n'est lu ni stocké côté navigateur : `credential_ref` n'est jamais
  retourné par `bg_list_scoped_integration_connections`.
