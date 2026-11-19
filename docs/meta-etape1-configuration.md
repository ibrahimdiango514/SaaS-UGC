# Étape 1 — Configuration Meta, guidée

> Pour le parcours **C1** (numéro de test WhatsApp), avant tout déploiement Supabase.
> Chaque valeur à coller est encadrée. Chaque fois, la source est indiquée : d'où elle vient,
> où la trouver.
>
> **Rien ici ne s'invente** : chaque URL est dérivée du code (`callbackUri()`), chaque
> permission est celle lue dans `src/business/meta/products.ts`.

---

## Avant de commencer : deux blocages à connaître

### Blocage 1 — corrigé : l'écouteur ne comprenait pas la forme v5

Le code demandait Embedded Signup **v5** (`extras.version: 'v5'`) mais l'écouteur du message de
session ne lisait que `data.waba_id`. Or **en v5, `waba_id` n'existe plus** : Meta envoie
`messaging_account_ids`, un tableau.

Conséquence : `wabaId` restait vide, et **toute connexion WhatsApp échouait** avec « Meta n'a pas
transmis le compte WhatsApp Business » — un message qui accuse l'utilisateur d'un défaut du code.

**Corrigé** dans `src/integrations/MetaConnectPanel.tsx` : les deux formes sont acceptées (v5
d'abord, v4 et antérieurs en repli). Deux tests verrouillent le comportement, et j'ai vérifié que
le test v5 **échoue** si l'on remet l'ancien code — un test qui passerait dans les deux cas ne
prouverait rien.

Le serveur, lui, revalide de toute façon que le jeton voit bien ce compte et ce numéro : accepter
deux écritures ne relâche aucun contrôle.

### Blocage 2 — non résolu : C1 suppose une connexion que le code n'a pas

**Il n'existe aucun parcours produit pour le numéro de test Meta.** Le seul chemin implémenté est
`start` → Embedded Signup → `finish-embedded`. Ce chemin exige :
- un identifiant de configuration Embedded Signup (`META_WHATSAPP_CONFIG_ID`) ;
- que le compte WhatsApp choisi soit un compte **réel** du portefeuille business.

Or le numéro de test Meta n'est **pas** dans un portefeuille business : il est fourni d'office à
l'application.

**Les deux moitiés ne se rejoignent pas.** Je peux vous guider pour récupérer les valeurs et
configurer les webhooks — c'est utile et réversible — mais **arriver à un échange réel par C1
demande du code qui n'existe pas encore** : une action serveur qui enregistre une connexion
WhatsApp à partir d'un WABA et d'un numéro de test fournis par vous.

Ce que cela impliquerait, en clair :
- une nouvelle action (`whatsapp.connect-test` ou équivalent) ;
- la décision de la rendre disponible en production, donc une possibilité qu'un utilisateur
  s'attache un compte qu'il ne possède pas — sauf à la restreindre à votre compte ;
- une écriture en base (`meta_connection_upsert`) hors du parcours OAuth.

**Je ne code pas cela sans votre accord**, parce que c'est une décision de sécurité, pas un détail
d'implémentation. Trois options, détaillées en fin de document.

---

## 1. WhatsApp Cloud API et numéro de test

**Chemin** : App Dashboard → votre application VYORA (`1692282959171281`) → menu de gauche →
**Ajouter un produit** → **WhatsApp** → **Configurer**.

Une fois ajouté : **WhatsApp → Premiers pas** (ou *API Setup*).

Vous y trouvez, dans cet ordre :

| Élément | Où exactement | À noter |
| --- | --- | --- |
| **Numéro de test** | Bloc *Envoyer des messages de test* → champ **De** | Un numéro au format international, fourni par Meta |
| **Identifiant du numéro de téléphone** | Même bloc, libellé *Identifiant de numéro de téléphone* | Une suite de chiffres — c'est le `phone_number_id` |
| **Identifiant du compte WhatsApp Business** | Même écran, libellé *Identifiant du compte WhatsApp Business* | C'est le `waba_id` |
| **Destinataires de test** | Bloc *À* → **Gérer les numéros de téléphone** | **Votre** numéro personnel doit y figurer, sinon rien n'arrive |
| **Jeton temporaire** | Bouton *Afficher* à côté du jeton | ⚠️ 24 h, ne le copiez pas dans le chat — il ne sert à rien à VYORA |

**Le jeton temporaire ne fait pas partie des secrets.** VYORA n'en a pas besoin : il échange un
code OAuth contre un jeton durable. Si quelqu'un vous dit de le coller dans une variable, c'est
faux.

### Étape concrète

1. Ajoutez le produit WhatsApp.
2. Notez le **numéro de test**, l'**identifiant du numéro** et l'**identifiant du compte**.
3. Cliquez **Gérer les numéros de téléphone** → ajoutez **votre** numéro → validez le code reçu.
   Sans cette étape, l'étape 4 échouera silencieusement (Meta répond 200, rien n'est délivré).

---

## 2. Webhooks WhatsApp

**Chemin** : menu de gauche → **WhatsApp → Configuration** → section **Webhooks** → **Modifier**.

| Champ | Valeur exacte à coller |
| --- | --- |
| **URL de rappel** | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-webhook` |
| **Jeton de vérification** | *le vôtre* — voir §3 |

Puis **Vérifier et enregistrer**. À ce moment précis, Meta envoie un `GET` à cette URL avec
`hub.mode=subscribe`, `hub.challenge` et `hub.verify_token`.

**Attendu aujourd'hui : l'échec.** La fonction `meta-webhook` **n'est pas déployée** et le secret
`META_WEBHOOK_VERIFY_TOKEN` n'existe pas. Meta affichera une erreur de vérification. C'est normal
et sans conséquence : rien n'est cassé, il manque simplement l'autre moitié.

**Pourquoi je vous le fais faire quand même** : le jour où vous autoriserez le déploiement, la
vérification se fera depuis ce même écran en un clic, avec les valeurs déjà en place. Le seul
travail restant sera **S'abonner** aux champs.

### Champs à abonner (après le déploiement)

Une fois la vérification réussie, dans **Webhooks → Gérer** pour l'objet *Compte WhatsApp
Business*, cochez :

```
messages
message_template_status_update
account_update
```

Ces trois champs sont ceux déclarés dans le code (`products.ts`, produit `whatsapp`). Seul
**`messages`** est indispensable au premier test : il porte les messages entrants **et** les
statuts de livraison.

> **Sans cet abonnement, Meta n'envoie rien du tout** — même si le WABA est abonné et l'URL
> vérifiée. C'est la cause n°1 d'un « webhook silencieux ».

---

## 3. Le Verify Token attendu par VYORA

**Il n'existe pas encore.** Ce n'est pas une valeur à retrouver dans Meta : c'est **vous qui la
choisissez**, et elle doit être **identique** aux deux endroits.

| Endroit | Rôle |
| --- | --- |
| Console Meta → Webhooks → **Jeton de vérification** | Ce que Meta renvoie dans `hub.verify_token` |
| Supabase → Edge Functions → Secrets → **`META_WEBHOOK_VERIFY_TOKEN`** | Ce que VYORA compare |

Comment le produire :

```bash
openssl rand -hex 24
```

Cela affiche 48 caractères hexadécimaux. Copiez la même valeur aux deux endroits. **Ne me la
transmettez pas** : elle n'a aucune raison de passer par le chat.

Le code compare en temps constant et **échoue fermé** : sans ce secret, `meta-webhook` répond
`503 TOKEN_NOT_CONFIGURED` plutôt que d'accepter n'importe quel jeton. C'est voulu.

---

## 4. Facebook Login for Business

**Chemin** : menu de gauche → **Facebook Login for Business** → **Paramètres** (ou *Configurations*
selon la version de l'interface).

### 4.1 Paramètres OAuth du client

Section **Paramètres OAuth du client** :

| Champ | Valeur exacte |
| --- | --- |
| **URI de redirection OAuth valides** | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback` |
| **URI de redirection pour la déconnexion** | laisser vide |
| **Domaines autorisés pour le SDK JavaScript** | `vyora-saas-ugc.netlify.app` |

Ces deux valeurs viennent du code, pas d'une convention :

- l'URI de redirection est produite par `callbackUri()` (`src/business/meta/oauth.ts`) :
  `` `${SUPABASE_URL}/functions/v1/meta-connect/callback` `` ;
- le domaine est celui de l'application Netlify, seul endroit d'où le SDK est chargé.

**À l'octet près** : pas de slash final, pas d'espace, pas de paramètre. Meta compare
littéralement et répond `URL Blocked: This redirect failed because the redirect URI is not
whitelisted` à la moindre différence.

Section **Client OAuth** — basculez sur **Oui** :

- Connexion OAuth client
- Connexion OAuth Web
- Appliquer HTTPS
- **Connexion OAuth du navigateur intégré**
- **Utiliser le mode strict pour les URI de redirection**
- **Connexion avec le SDK JavaScript**

Les trois en gras sont indispensables pour que la fenêtre Embedded Signup s'ouvre et rende le
code.

### 4.2 Vérification immédiate

Ouvrez ce lien dans un navigateur — vous devez voir **une erreur explicite de Meta, pas une page
blanche** :

```
https://www.facebook.com/v26.0/dialog/oauth?client_id=1692282959171281&redirect_uri=https%3A%2F%2Fxbuuhfwobrafcbgtdgjx.supabase.co%2Ffunctions%2Fv1%2Fmeta-connect%2Fcallback&state=test
```

`URL Blocked` = URI non déclarée. `Invalid Scopes` / `URL Blocked` sur le domaine = domaine non
autorisé. Une page qui demande de se connecter = les paramètres sont bons.

---

## 5. Les identifiants de configuration (config_id)

### 5.1 WhatsApp

**Chemin** : **Facebook Login for Business → Configurations → + Créer une configuration**.

Le plus fiable : **Créer à partir d'un modèle** → choisir
**« WhatsApp Embedded Signup Configuration »**.

| Réglage | Valeur |
| --- | --- |
| Nom | `VYORA WhatsApp Embedded Signup` |
| Type de jeton | **Jeton d'utilisateur de système d'intégration métier** |
| Variation | **WhatsApp Embedded Signup** |
| Produit | **Cloud API** |
| Actifs | **Comptes WhatsApp** uniquement |

Puis **Enregistrer** → l'écran affiche un **ID de configuration** : une longue suite de chiffres.
C'est votre `META_WHATSAPP_CONFIG_ID`.

> Ne cochez **que** *Comptes WhatsApp*. Ajouter *Catalogues*, *Pixels* ou *Comptes publicitaires*
> fait apparaître des écrans de sélection supplémentaires qui font abandonner le parcours.

### 5.2 Facebook Pages

Même écran, **+ Créer une configuration** :

| Réglage | Valeur |
| --- | --- |
| Nom | `VYORA Facebook Pages` |
| Type de jeton | **Jeton d'utilisateur** |
| Variation | *Facebook Login for Business* |
| Actifs | **Pages** uniquement |
| Permissions | voir §7 |

L'ID affiché est `META_FACEBOOK_CONFIG_ID`.

### 5.3 Les deux autres — à ne pas créer maintenant

`META_MESSENGER_CONFIG_ID` et `META_INSTAGRAM_CONFIG_ID` ne sont **pas** nécessaires au premier
test. Leurs fiches afficheront « configuration manquante », ce qui est l'état honnête. Créez-les
après les quatre preuves.

---

## 6. Les URL exactes, récapitulées

| Usage | Valeur exacte | Source dans le code |
| --- | --- | --- |
| Redirection OAuth | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback` | `callbackUri()` |
| Webhook | `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-webhook` | nom de la fonction Edge |
| Domaine autorisé SDK | `vyora-saas-ugc.netlify.app` | application Netlify |
| Retour après autorisation | `https://vyora-saas-ugc.netlify.app/app/business?section=integrations&meta=connected&product=<produit>` | `returnUrl()` |
| Suppression des données | `https://vyora-saas-ugc.netlify.app/confidentialite#suppression-des-donnees` | `Legal.tsx` |
| Version Graph | `v26.0` | `META_GRAPH_VERSION` |
| Version Embedded Signup | `v5` | `META_EMBEDDED_SIGNUP_VERSION` |

---

## 7. Permissions : nécessaires au test, et celles qui exigent une revue

### 7.1 WhatsApp

| Permission | Utile au test C1 ? | Mode Développement | Mode Live |
| --- | --- | --- | --- |
| `whatsapp_business_management` | oui (lire le WABA, abonner) | accordée aux rôles admin/dev/testeur de l'app | **App Review** |
| `whatsapp_business_messaging` | oui (envoyer, recevoir) | idem | **App Review** |

**Point capital** : tant que l'application est en **mode Développement**, ces permissions
apparaissent pour toute personne ayant un rôle **admin**, **développeur** ou **testeur** sur
l'application. En mode **Live**, seules les permissions validées en **accès avancé** restent.

Cela veut dire : **votre premier test ne nécessite aucune App Review**, à condition d'utiliser
votre propre compte, administrateur de l'application. La revue ne devient nécessaire que pour
servir **des tiers**.

### 7.2 Facebook Pages

| Permission | Test avec votre propre Page | Pour des clients |
| --- | --- | --- |
| `pages_show_list` | accordée | accès avancé |
| `pages_read_engagement` | accordée | accès avancé |
| `pages_manage_posts` | accordée | accès avancé |
| `pages_manage_metadata` | accordée | accès avancé |
| `business_management` | accordée | accès avancé |

Même logique : en mode Développement, avec **votre** Page et **votre** rôle admin, aucune revue
n'est requise.

### 7.3 Ce qui exige une App Review, et quand

| Élément | Requis pour | Quand le demander |
| --- | --- | --- |
| `whatsapp_business_management` + `_messaging` en **accès avancé** | servir d'autres entreprises | après les quatre preuves |
| `pages_*` en accès avancé | publier sur la Page d'un client | après les quatre preuves |
| **Vérification d'entreprise** | mode Live, limites de messages, Embedded Signup au-delà du test | parallèlement, sans bloquer |
| **Statut Tech Provider** | Embedded Signup pour **vos clients** (C2) | après les quatre preuves |

**Embedded Signup au-delà du portefeuille de test.** Meta documente que tant que l'application
n'est pas approuvée, Embedded Signup fonctionne pour **votre** portefeuille business uniquement.
Pour onboarder des clients, il faut l'App Review **puis** le passage en Live.

---

## 8. Ce que vous devez avoir noté à la fin de cette étape

Sans jamais me les transmettre :

- [ ] Numéro de test WhatsApp (format international)
- [ ] Identifiant du **numéro de téléphone** (chiffres)
- [ ] Identifiant du **compte WhatsApp Business** (chiffres)
- [ ] Votre numéro personnel ajouté aux destinataires de test
- [ ] URL de webhook enregistrée (même si la vérification échoue)
- [ ] Verify Token choisi (`openssl rand -hex 24`)
- [ ] URI de redirection déclarée
- [ ] Domaine autorisé déclaré
- [ ] Interrupteurs OAuth activés
- [ ] `META_WHATSAPP_CONFIG_ID` relevé
- [ ] `META_FACEBOOK_CONFIG_ID` relevé

---

## 9. Les trois options pour débloquer C1

Le blocage n'est pas la configuration Meta : c'est l'absence de parcours produit pour un numéro
de test.

### Option A — Je code un parcours de test, en attendant Embedded Signup

Une action serveur qui enregistre une connexion WhatsApp à partir du WABA et du numéro de test que
vous saisissez, **restreinte à votre compte** (l'administrateur de l'application, identifiant
`d54cb18f…`). Ensuite, tout le reste du code fonctionne tel qu'il est : envoi, réception,
statuts.

- Ce que ça prouve : la chaîne complète, aujourd'hui.
- Ce que ça coûte : une action serveur, des tests, une décision de sécurité assumée.
- Risque : faible, à condition que la restriction soit stricte et testée. Une fois Embedded
  Signup validé, ce parcours peut être retiré.

### Option B — On saute le test et on va directement à Embedded Signup

La connexion WhatsApp passera par le parcours normal. Mais ce parcours **exige un compte WhatsApp
réel d'un portefeuille business**, pas le numéro de test Meta. Vous avez donc besoin d'un numéro
que vous acceptez de consacrer à WhatsApp Business.

- Ce que ça prouve : le vrai parcours, celui des clients.
- Ce que ça coûte : un numéro réel, et l'Embedded Signup doit être approuvé pour votre portefeuille.
- Point positif : en mode Développement, cela fonctionne avec **votre** portefeuille sans App Review.

### Option C — On valide d'abord un récepteur minimal

Une fonction de test, distincte de `meta-webhook`, qui se contente de répondre au défi et de
journaliser les événements signés. Elle prouve la poignée de main et la réception, **sans rien
écrire en base**.

- Ce que ça prouve : votre Verify Token, votre URL, votre App Secret sont bons, et Meta vous
  joint. C'est la moitié la plus fragile de la chaîne.
- Ce que ça ne prouve pas : l'envoi, ni l'enregistrement en base.
- Ce que ça coûte : une fonction jetable de plus en production.

Mon avis : **Option A**, restreinte à votre compte, puis retirée une fois l'Embedded Signup
validé. C'est la seule qui atteigne votre objectif (message reçu, réponse envoyée, statut de
livraison) sans exiger de numéro réel ni de revue Meta.
