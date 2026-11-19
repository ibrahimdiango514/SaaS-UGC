# VYORA — configuration Meta de production

> Ce document ne décrit **que** ce qui est réellement implémenté dans le dépôt.
> Chaque URL ci-dessous est extraite du code (fonction + ligne indiquées), pas
> recopiée d'un exemple Meta.
>
> Application concernée : **VYORA**, App ID `1692282959171281`, type Business.

---

## 1. URLs à déclarer dans le tableau de bord Meta

### 1.1 Redirect URI OAuth (Facebook Login for Business)

| Champ Meta | Valeur exacte |
| --- | --- |
| Valid OAuth Redirect URIs | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback` |

**Source** : `src/business/meta/oauth.ts`, `callbackUri()`

```
`${supabaseUrl}/functions/v1/meta-connect/callback`
```

`supabaseUrl` est la variable d'environnement `SUPABASE_URL` de la fonction
(`supabase/functions/meta-connect/index.ts`, `const SUPABASE_URL = env('SUPABASE_URL')`).
Sur le projet de production `xbuuhfwobrafcbgtdgjx`, cela donne l'URL ci-dessus.

Il n'y a **qu'une seule** URI de redirection pour les trois produits Facebook
(facebook, messenger, instagram) : le produit est transporté par `state`, pas par
l'URI. C'est volontaire — moins d'URI déclarées, moins de surface d'erreur.

### 1.2 Webhook (messages, statuts, commentaires)

| Champ Meta | Valeur exacte |
| --- | --- |
| Callback URL | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-webhook` |
| Verify Token | la valeur du secret Supabase `META_WEBHOOK_VERIFY_TOKEN` |

**Source** : `supabase/config.toml` → `[functions.meta-webhook]`,
et `supabase/functions/meta-webhook/index.ts` (`verifyToken: env('META_WEBHOOK_VERIFY_TOKEN')`).

Champs d'abonnement souscrits par le code (`src/business/meta/products.ts`,
`META_PRODUCT_DEFINITIONS`) :

| Objet | Champs |
| --- | --- |
| `whatsapp_business_account` | `messages`, `message_template_status_update`, `account_update` |
| `page` | `feed` |
| `instagram` | `comments` |

> **Ne cochez pas d'autres champs** : `src/business/meta/webhook.ts` ignore tout
> champ non reconnu (il produit un événement `unknown` sans effet). En cocher
> davantage n'apporte rien et élargit l'exposition de données.

### 1.3 Rappels de cycle de vie (nouveau)

| Champ Meta | Valeur exacte |
| --- | --- |
| Deauthorize Callback URL | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-lifecycle/deauthorize` |
| Data Deletion Request URL | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-lifecycle/data-deletion` |
| Page de suivi des suppressions | `https://vyora-saas-ugc.netlify.app/confidentialite/suivi?code=…` |

La page de suivi est **publique** (aucune authentification) : c'est ce que Meta
exige. Elle ne reçoit qu'un état et des dates — jamais un identifiant Meta, un
nom, une adresse ou un jeton. Elle est alimentée par la route
`…/functions/v1/meta-lifecycle/deletion-status?code=…`, qui refuse tout code
mal formé avant d'interroger la base.

`data-deletion` renvoie exactement `{ url, confirmation_code }`. Le code qu'il
renvoie est celui **réellement enregistré en base**, dans la même transaction
que la suppression : l'URL de suivi ne peut donc pas pointer vers une demande
inexistante.

**Source** : `supabase/functions/meta-lifecycle/index.ts` — la route est le
dernier segment du chemin (`chemin.split('/').filter(Boolean).pop()`), comparée
dans `supabase/functions/meta-lifecycle/handler.ts`.

Ces deux points d'entrée sont **exigés par les Platform Terms** dès que
l'application traite des données d'utilisateurs Meta. Sans le second, Meta peut
désactiver le rappel puis suspendre l'application.

### 1.4 Domaines autorisés (SDK JavaScript)

| Champ Meta | Valeur exacte |
| --- | --- |
| App Domains | `vyora-saas-ugc.netlify.app` |
| Allowed domains for JavaScript SDK | `https://vyora-saas-ugc.netlify.app` |

**Source** : `src/integrations/meta/MetaConnectPanel.tsx` charge le SDK Meta
depuis cette origine ; `VYORA_APP_URL` (défaut dans
`supabase/functions/meta-connect/index.ts` : `https://vyora-saas-ugc.netlify.app`).

### 1.5 URL de retour dans VYORA (pour information)

`https://vyora-saas-ugc.netlify.app/app/business?section=integrations&meta=connected&product=whatsapp`

**Source** : `src/business/meta/oauth.ts`, `returnUrl()`. Ce n'est **pas** une URI
OAuth : c'est la page où la fonction renvoie le navigateur après l'échange de
code. Elle n'a pas à être déclarée dans Meta.

---

## 2. Identifiants de configuration (`config_id`)

Le parcours Facebook Login for Business n'utilise **pas** `scope` : il utilise un
`config_id` (identifiant de configuration de connexion), créé dans
**Facebook Login for Business → Configurations**.

Le code lit un `config_id` par produit
(`supabase/functions/meta-connect/index.ts`, `configIds`) :

### Permissions demandées par produit (valeurs exactes du code)

`src/business/meta/products.ts`, `META_PRODUCT_DEFINITIONS` :

| Produit | `scopes` (à cocher dans la configuration) |
| --- | --- |
| `whatsapp` | `whatsapp_business_management`, `whatsapp_business_messaging` |
| `facebook` | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_metadata`, `business_management` |
| `messenger` | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `business_management` |
| `instagram` | `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `business_management` |

### Correspondance secret ↔ configuration

| Produit | Secret Supabase | `config_id` à créer |
| --- | --- | --- |
| WhatsApp Embedded Signup | `META_WHATSAPP_CONFIG_ID` | configuration avec le produit **WhatsApp Embedded Signup** |
| Facebook Pages | `META_FACEBOOK_CONFIG_ID` | configuration avec les permissions `facebook` ci-dessus |
| Messenger | `META_MESSENGER_CONFIG_ID` | configuration avec les permissions `messenger` ci-dessus |
| Instagram | `META_INSTAGRAM_CONFIG_ID` | configuration avec les permissions `instagram` ci-dessus |

### ⚠️ Point à vérifier au premier branchement réel

`buildLoginForBusinessUrl()` (`src/business/meta/oauth.ts`) envoie **à la fois**
`config_id` et `scope`. C'est couvert par un test
(`tests/meta-oauth.test.ts`, « déclare les permissions du produit dans scope »),
donc c'est un choix assumé : `scope` sert de garde-fou côté VYORA pour vérifier
ensuite les permissions réellement accordées (`missingScopes`).

La documentation Meta indique toutefois que `config_id` **remplace** `scope`. Si
le premier parcours réel renvoie une erreur `Invalid Scopes`, la correction est de
retirer l'appel à `url.searchParams.set('scope', …)` — une ligne — et non de
changer les configurations. Je ne l'ai pas modifié ici faute de pouvoir tester
contre Meta : modifier un comportement testé sur une simple lecture de
documentation serait moins sûr que de le vérifier.

> Les trois derniers sont **facultatifs** : si le secret est absent,
> `MetaConnectPanel` n'affiche pas le bouton correspondant plutôt que d'ouvrir un
> parcours qui échouerait. Aucun repli silencieux.

---

## 3. Secrets Supabase à poser

Aucun n'est posé aujourd'hui sur le projet `xbuuhfwobrafcbgtdgjx` (vérifié : 27
secrets, aucun `META_*`). **Ne pas les poser sans accord explicite** — c'est une
écriture en production.

| Secret | Obligatoire | Rôle |
| --- | --- | --- |
| `META_APP_ID` | oui | `1692282959171281` |
| `META_APP_SECRET` | oui | échange de code, `debug_token`, signature des webhooks |
| `META_WEBHOOK_VERIFY_TOKEN` | oui | vérification d'abonnement `hub.verify_token` |
| `META_WHATSAPP_CONFIG_ID` | oui pour WhatsApp | `config_id` Embedded Signup |
| `META_FACEBOOK_CONFIG_ID` | pour Pages | `config_id` Login for Business |
| `VYORA_APP_URL` | recommandé | URL de retour (défaut codé en dur) |

Commande (à ne lancer qu'après accord) :

```bash
supabase secrets set --project-ref xbuuhfwobrafcbgtdgjx \
  META_APP_ID="1692282959171281" \
  META_APP_SECRET="…" \
  META_WEBHOOK_VERIFY_TOKEN="…" \
  META_WHATSAPP_CONFIG_ID="…"
```

L'App Secret ne doit **jamais** être transmis dans le chat ni committé : il se
saisit directement dans la commande ou le tableau de bord.

---

## 4. Ce qui reste à faire côté Meta (hors code)

Dans l'ordre, car chaque étape conditionne la suivante :

1. **Business Verification** du portefeuille Business.
2. **Tech Provider** (ou Solution Partner) — *obligatoire* pour l'Embedded
   Signup WhatsApp. Sans ce statut, le parcours ne s'ouvre pas.
3. **App Review** des permissions :
   - `whatsapp_business_management`, `whatsapp_business_messaging`
   - `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
     `pages_manage_metadata`, `pages_messaging`
   - `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`
   - `business_management`
4. **Access Verification** — conditionne le quota de 200 comptes WhatsApp
   embarqués (contre 10 / 7 jours sans).
5. **Passer l'application en mode Live** (aujourd'hui : Development).

> Tant que 2 et 3 ne sont pas faits, seuls les comptes ayant un rôle sur
> l'application peuvent réaliser le parcours. Ce n'est pas un défaut du code :
> c'est le fonctionnement de Meta.

---

## 5. Ce que ce dépôt ne fait pas (et pourquoi)

| Point | État | Raison |
| --- | --- | --- |
| Révocation du jeton système WhatsApp | **impossible** | Meta n'expose aucune API de révocation pour un jeton système. La déconnexion VYORA efface le secret de Vault : le jeton devient inutilisable. |
| Renouvellement du jeton système WhatsApp | inutile | Le jeton Embedded Signup est permanent par construction (`refresh` le reconnaît et ne tente rien). |
| Rafraîchissement du jeton utilisateur 60 j | **non implémenté** | Un jeton long Facebook ne se rafraîchit pas indéfiniment sans interaction : au-delà de `data_access_expires_at` (60 j), le client doit reconnecter. L'échéance est stockée et affichée ; la reconnexion est un clic. |
| Suivi public d'une demande de suppression | **implémenté** | Page `/confidentialite/suivi?code=…`, états `pending` / `completed` / `no_data`, réponse `{ url, confirmation_code }` conforme. |
| Publication de modèles de messages WhatsApp | non implémenté | Seul le webhook `message_template_status_update` est traité (statut des modèles existants). La création de modèles se fait pour l'instant dans WhatsApp Manager. |
| API de conversation Instagram | partiel | Lecture des commentaires par média (`listPostComments`). Envoi de réponses Instagram non implémenté : nécessiterait `instagram_manage_comments` et un parcours dédié. |

Ces lignes sont volontairement explicites : elles distinguent ce qui est
**terminé**, ce qui est **une limite de Meta**, et ce qui **reste à faire**.
