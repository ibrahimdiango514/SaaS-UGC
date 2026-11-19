# Premier test réel — Facebook Page puis WhatsApp Business

> Procédure opérationnelle. Chaque étape a un **critère de réussite observable** et un
> **critère d'échec** avec sa cause la plus probable. Aucune étape n'est déclarée réussie sans
> preuve visible.
>
> **Ce que je ne fais pas** : je ne déploie rien et je ne configure rien chez Meta à votre place.
> Les commandes sont prêtes ; leur exécution attend votre autorisation.

---

## Partie 0 — Déploiement contrôlé des Edge Functions

### 0.1 Ce qui sera modifié, exactement

| Action | Effet | Réversible ? |
| --- | --- | --- |
| Création de la fonction `meta-connect` | Nouvelle URL `…/functions/v1/meta-connect` | Oui (suppression) |
| Création de la fonction `meta-webhook` | Nouvelle URL `…/functions/v1/meta-webhook` | Oui (suppression) |
| Fixation de `verify_jwt = false` sur `meta-connect` | La passerelle laisse passer le GET `/callback` ; le handler authentifie lui-même les POST | Oui |
| Fixation de `verify_jwt = false` sur `meta-webhook` | La passerelle laisse passer Meta ; la signature HMAC protège | Oui |
| Huit secrets `META_*` + `VYORA_APP_URL` | Variables d'environnement des fonctions | Oui (suppression) |

**Ce qui ne sera PAS modifié** : aucune autre fonction Edge (les 31 existantes restent
intactes), aucune migration (la base Meta est déjà en place), aucune table existante, aucun
réglage Netlify, aucune tarification, aucun code e-commerce, aucun secret existant.

**Point de vigilance** : le projet Supabase est **partagé** — il n'y a pas d'environnement de
préproduction isolé. Déployer `meta-*` ajoute deux fonctions ; cela ne touche aucune fonction
existante, mais ces deux fonctions seront immédiatement joignables en production. Elles refusent
toute requête sans JWT valide (sauf le retour OAuth protégé par `state`) et tout webhook sans
signature valide.

### 0.2 Prérequis

```bash
# CLI Supabase installée
npm install -g supabase        # ou : brew install supabase/tap/supabase
supabase --version

# Connecté et lié au projet
supabase login
supabase link --project-ref xbuuhfwobrafcbgtdgjx
```

### 0.3 Ordre d'exécution

**Étape 1 — secrets d'abord.** Les fonctions lisent leur configuration au démarrage : les créer
avant les secrets les ferait démarrer en `configured: false` jusqu'au prochain redémarrage.

```bash
supabase secrets set \
  META_APP_ID="<App ID>" \
  META_APP_SECRET="<App Secret>" \
  META_WEBHOOK_VERIFY_TOKEN="<votre jeton aléatoire>" \
  META_WHATSAPP_CONFIG_ID="<config_id WhatsApp>" \
  META_FACEBOOK_CONFIG_ID="<config_id Pages>" \
  --project-ref xbuuhfwobrafcbgtdgjx
```

Ne saisissez pas ces valeurs dans un terminal partagé ni dans un historique synchronisé. Vous
pouvez aussi tout saisir dans **Supabase → Project Settings → Edge Functions → Secrets**, ce qui
évite l'historique shell.

`META_MESSENGER_CONFIG_ID` et `META_INSTAGRAM_CONFIG_ID` peuvent être ajoutés plus tard : les
fiches concernées resteront en « configuration manquante », ce qui est l'état honnête.

**Étape 2 — déployer les deux fonctions.**

Un script dédié existe : `scripts/deploy-meta-functions.sh`. Il ne peut déployer **que**
`meta-connect` et `meta-webhook` — les autres fonctions n'y figurent pas, donc une faute de frappe ne
peut pas redéployer Reelora ou Business Grow.

```bash
# 1. Contrôles à blanc : parité des chargeurs, commit épinglé joignable sur GitHub,
#    présence des secrets (par NOM seulement). N'écrit RIEN.
bash scripts/deploy-meta-functions.sh

# 2. Déploiement réel, après autorisation explicite.
bash scripts/deploy-meta-functions.sh --apply
```

Sans `--apply`, le script s'arrête après les contrôles et affiche :

```
Contrôles passés. Rien n'a été déployé.
```

Le script déploie le **chargeur** (`--entrypoint loader.ts`), jamais `index.ts` : voir §0.4.

Si vous préférez la main, les commandes équivalentes sont :

```bash
node scripts/build-edge-artifact.mjs meta-connect --check
node scripts/build-edge-artifact.mjs meta-webhook --check
supabase functions deploy meta-connect \
  --project-ref xbuuhfwobrafcbgtdgjx --no-verify-jwt --entrypoint loader.ts
supabase functions deploy meta-webhook \
  --project-ref xbuuhfwobrafcbgtdgjx --no-verify-jwt --entrypoint loader.ts
```

`--entrypoint loader.ts` n'est pas décoratif : sans lui, la CLI envoie `index.ts`, dont les
imports vers `src/business/meta/*` n'existent pas sur la plateforme.

### 0.4 Ce qui est réellement déployé : un chargeur, pas `index.ts`

**Correction d'une erreur de ma part.** J'avais écrit plus haut que ces deux fonctions pouvaient
être déployées en source directe « parce que le bundle est petit ». **C'est faux**, et la mesure
le montre :

`meta-connect` et `meta-webhook` importent `../../../src/business/meta/*.ts` et
`../../../src/lib/origin-allowlist.ts`, qui vivent **hors de `supabase/functions/`**. Un
déploiement de la fonction seule ne transmet pas ces fichiers → `BOOT_ERROR` au démarrage.

Les quatre fonctions de ce dépôt qui ont le même besoin — `business-grow`, `store-import`,
`store-connect`, `mcp-client` — passent toutes par un **chargeur épinglé**. C'est le seul
mécanisme dont ce dépôt ait la preuve qu'il fonctionne.

**Donc, pour `meta-*` aussi :**

| Fichier | Rôle | Taille |
| --- | --- | --- |
| `supabase/functions/_artifacts/meta-connect.js` | bundle autonome, commité | 42 055 car. |
| `supabase/functions/_artifacts/meta-webhook.js` | bundle autonome, commité | 10 748 car. |
| `supabase/functions/meta-connect/loader.ts` | **la seule source déployée** | 3 412 car. |
| `supabase/functions/meta-webhook/loader.ts` | **la seule source déployée** | 3 412 car. |

`index.ts` reste la source lisible, typée et testée. Le bundle est construit depuis le même
`index.ts`, et `tests/store-import-artifact.test.ts` vérifie que ce qui est déployé est exactement
ce que le dépôt produit.

### 0.4 bis Fabrication : deux commits, dans cet ordre

Le chargeur désigne le commit qui **contient** l'artefact. Générer le chargeur depuis un commit qui
ne contient pas encore l'artefact produit une épingle cohérente en apparence et fausse en
production — la fonction répond alors 503. D'où deux temps :

```bash
# 1. produire les artefacts, les committer, pousser
EDGE_PIN_COMMIT=0000000000000000000000000000000000000000 \
  node scripts/build-edge-artifact.mjs meta-connect
EDGE_PIN_COMMIT=0000000000000000000000000000000000000000 \
  node scripts/build-edge-artifact.mjs meta-webhook
git add supabase/functions/_artifacts/meta-connect.js \
        supabase/functions/_artifacts/meta-webhook.js
git commit -m "build(meta): artefacts des Edge Functions Meta"
git push
# 2. relever le SHA du commit qui vient d'être poussé
git rev-parse HEAD
```

Puis, avec ce SHA :

```bash
EDGE_PIN_COMMIT=<sha du commit 1> node scripts/build-edge-artifact.mjs meta-connect
EDGE_PIN_COMMIT=<sha du commit 1> node scripts/build-edge-artifact.mjs meta-webhook
node scripts/build-edge-artifact.mjs meta-connect --check
node scripts/build-edge-artifact.mjs meta-webhook --check
git add supabase/functions/meta-connect/loader.ts supabase/functions/meta-webhook/loader.ts
git commit -m "feat(meta): chargeurs épinglés des Edge Functions Meta"
git push
```

**Ces quatre commandes ne sont pas exécutées.** Elles le seront après votre autorisation, sur ce
dépôt, et le test de parité vérifiera l'artefact au commit épinglé — pas sur le disque.

### 0.4 ter Ce qui est déployé, concrètement

| Fonction | Corps envoyé | `verify_jwt` |
| --- | --- | --- |
| `meta-connect` | contenu de `supabase/functions/meta-connect/loader.ts` (3 412 car.) | `false` |
| `meta-webhook` | contenu de `supabase/functions/meta-webhook/loader.ts` (3 412 car.) | `false` |

Jamais `index.ts`, jamais le bundle : le chargeur seul, qui vérifie taille et SHA-256 avant
d'exécuter quoi que ce soit.

### 0.4 quater Pourquoi `verify_jwt = false` sur les deux

- `meta-webhook` : Meta ne peut présenter aucun JWT Supabase. La protection est le HMAC
  `X-Hub-Signature-256` sur l'App Secret (+ résolution en base : un identifiant inconnu ne crée
  aucune ligne).
- `meta-connect` : le retour OAuth est un GET de redirection du navigateur, sans JWT. Les actions
  POST de la fonction vérifient elles-mêmes le JWT auprès de GoTrue (`getUserId`), ce qui est
  strictement plus strict que la passerelle.

### 0.5 Vérification immédiate après déploiement

```bash
npm run meta:readiness
```

Critères :

| Sonde | Succès attendu |
| --- | --- |
| `POST /meta-connect` sans JWT | `401` + `UNAUTHENTICATED` — la fonction existe et exige un JWT |
| `GET /meta-connect/callback` avec state invalide | `303` vers `…/app/business?meta=error&code=STATE_INVALID` |
| `GET /meta-webhook` avec faux jeton | `403` + `TOKEN_MISMATCH` (ou `503 TOKEN_NOT_CONFIGURED` si le secret manque) |

Un `404` signifie « fonction non déployée ». Un échec réseau signifie « impossible de conclure »
et **non** « c'est cassé ».

### 0.6 Journal à tenir

| Étape | Date | Par | Résultat |
| --- | --- | --- | --- |
| Secrets posés (8) | | | |
| `meta-connect` déployée | | | |
| `meta-webhook` déployée | | | |
| `npm run meta:readiness` | | | 3/3 |
| Webhook abonné chez Meta | | | |

---

## Partie A — Connexion d'une Facebook Page

### A.0 Prérequis

- Une **Page Facebook** dont vous êtes administrateur.
- `META_FACEBOOK_CONFIG_ID` posé.
- URL de redirection déclarée (§2.1 du document de configuration).
- Application en mode **Développement** — vous pouvez tester avec votre propre Page sans App
  Review.

### A.1 Le parcours exact

1. Ouvrir `https://vyora-saas-ugc.netlify.app/app/connect`.
2. Ouvrir la fiche **Facebook**.
3. État attendu : « Aucun compte Facebook n'est connecté » et bouton **Connecter Facebook** actif
   (si le bouton est grisé, un secret manque : la fiche le nomme).
4. Cliquer **Connecter Facebook** → redirection vers `facebook.com/dialog/oauth` avec
   `config_id`, `state` et `redirect_uri`.
5. Écran Meta : choisir la Page, accepter les permissions.
6. Retour automatique sur `/functions/v1/meta-connect/callback` puis sur
   `/app/business?section=integrations&meta=connected&product=facebook`.
7. La fiche Facebook doit afficher **« Connecté · <votre nom> »** et l'identifiant du compte Meta.
8. Cliquer **Choisir les pages** → cocher votre Page → **Enregistrer la sélection**.
9. La Page apparaît avec son identifiant, et la mention « webhooks actifs » si l'abonnement a
   réussi.

### A.2 Preuves attendues en base

```sql
-- Connexion : 1 ligne, product = 'facebook'
select product, status, external_account_id, display_name, token_expires_at
  from saas_business.meta_connections
 where product = 'facebook';

-- Page sélectionnée : 1 ligne, avec un jeton de page en Vault
select page_id, name, webhook_subscribed, token_ref is not null as a_jeton
  from saas_business.meta_pages
 where product = 'facebook';

-- Le jeton est dans Vault, jamais dans la table
select count(*) from vault.secrets where name like 'vyora_meta_%';
```

### A.3 Si ça échoue

| Symptôme | Cause la plus probable | Correction |
| --- | --- | --- |
| `URL Blocked: redirect URI is not whitelisted` | URI déclarée différente à l'octet près | Recopier exactement §2.1, sans slash final |
| `Impossible de charger l'URL` | Domaine absent des *Domaines autorisés* | Ajouter `vyora-saas-ugc.netlify.app` et `xqh….supabase.co` |
| Retour avec `meta=error&code=META_NOT_CONFIGURED` | `META_APP_ID`/`META_APP_SECRET` absents | Poser les secrets, redéployer |
| Retour avec `code=META_CONFIG_ID_MISSING` | `META_FACEBOOK_CONFIG_ID` absent | Poser le secret, redéployer |
| Retour avec `code=STATE_INVALID` | `state` expiré (> 10 min) ou déjà consommé | Recommencer le parcours |
| « Connecté » mais 0 page | Aucune page sélectionnée à l'étape 8 | Cliquer **Choisir les pages** |
| `permission_denied` à la sélection | Vous n'êtes pas admin de la Page, ou permission non approuvée | Vérifier le rôle sur la Page ; en mode Développement, être admin de l'app |

---

## Partie B — Publication réelle sur la Page

### B.1 Le parcours exact

1. Fiche Facebook, connexion **Connecté**, Page sélectionnée.
2. Section **Publier sur la page** : saisir un texte court et unique
   (par exemple `Test VYORA 2026-11-14 10:32`).
3. Cliquer **Publier**.
4. Message attendu : « Publication créée sur la page (identifiant rendu par Meta) ».
5. La publication apparaît dans la liste **Publications de la page** (relue chez Meta, pas depuis
   un cache local).
6. Ouvrir `facebook.com/<votre-page>` dans un navigateur : **la publication doit y être visible**.
   C'est la seule preuve qui compte — un identifiant rendu ne prouve pas la publication publique.

### B.2 Preuve en base

```sql
select id, page_id, item, verb, post_id, occurred_at
  from saas_business.meta_page_events
 order by occurred_at desc limit 5;
```

Note : la publication **sortante** n'écrit pas dans `meta_page_events` (cette table ne reçoit que
les événements entrants par webhook). La preuve de la publication est l'identifiant rendu par Meta
**et** la présence visible sur la Page.

### B.3 Si ça échoue

| Symptôme | Cause | Correction |
| --- | --- | --- |
| Bouton **Publier** grisé | Texte et lien vides | Saisir un texte |
| `Permissions manquantes : pages_manage_posts` | Permission non accordée à l'autorisation | Reconnecter, cocher toutes les permissions |
| `Meta refuse l'opération : permission manquante` | Accès Standard + page d'un autre utilisateur | Tester avec **votre** Page, en tant qu'admin de l'app |
| `Cette page n'est pas rattachée à l'entreprise` | Page non sélectionnée, ou sélection d'une autre entreprise | Rouvrir **Choisir les pages** |
| Publication créée mais invisible sur Facebook | Page non publiée, ou publication en attente de revue | Vérifier l'état de la Page |

---

## Partie C — Connexion WhatsApp Business

### C.0 Deux chemins, choisissez consciemment

| Chemin | Ce qu'il faut | Délai | Recommandation |
| --- | --- | --- | --- |
| **C1 — Numéro de test Meta** | Rien de plus que l'application en Développement | Immédiat | **Pour le premier test** |
| **C2 — Embedded Signup avec votre numéro** | Statut Tech Provider + accès avancé | Semaines | Après C1 |

**Ce qu'il faut savoir avant de choisir C2.** Embedded Signup n'est pas qu'un bouton : Meta impose
que l'application soit **Tech Provider** (ou Solution Partner) avec **accès avancé** aux deux
permissions WhatsApp. Un parcours Embedded Signup lancé sans ce statut échoue côté Meta, souvent
avec un message peu explicite.

C1 permet de prouver **aujourd'hui** la chaîne complète : webhook vérifié, message reçu, message
envoyé, statut de remise. C2 ajoute l'onboarding de numéros clients réels.

### C.1 Chemin C1 — numéro de test Meta

1. App Dashboard → **WhatsApp** → **Premiers pas**.
2. Meta fournit un **numéro de test** et un **identifiant de numéro de téléphone**.
3. Ajouter **votre** numéro personnel dans *Destinataires de test* (obligatoire : un numéro non
   autorisé ne recevra rien).
4. Relever : **identifiant du compte WhatsApp Business (WABA ID)** et **identifiant du numéro de
   téléphone**.
5. Dans la console Meta, **Webhooks → WhatsApp Business Account** : URL de webhook
   (`…/functions/v1/meta-webhook`), Verify Token (le même que `META_WEBHOOK_VERIFY_TOKEN`),
   puis **s'abonner au champ `messages`** (indispensable : sans cet abonnement, Meta n'envoie
   rien).

### C.2 Chemin C2 — Embedded Signup réel

1. Obtenir le statut **Tech Provider** (vérification d'entreprise + accès avancé aux deux
   permissions WhatsApp).
2. Créer la configuration `VYORA WhatsApp Embedded Signup` (variation WhatsApp Embedded Signup,
   produit Cloud API).
3. Poser `META_WHATSAPP_CONFIG_ID`.
4. Fiche WhatsApp dans VYORA → **Connecter WhatsApp Business** → fenêtre Meta → sélectionner ou
   créer le WABA et le numéro → terminer.
5. Le serveur vérifie ensuite que le WABA et le numéro **vus par le jeton** correspondent à ce qui
   a été transmis, abonne le WABA aux webhooks, enregistre le numéro (PIN conservé dans Vault) et
   écrit la connexion.

### C.3 Preuve de connexion

```sql
select status, external_account_id as waba_id, display_name,
       metadata->>'phone_number_id' as phone_number_id,
       metadata->>'registered' as enregistre,
       metadata->>'webhook_subscribed' as webhook_abonne,
       metadata->>'register_error' as erreur_enregistrement
  from saas_business.meta_connections
 where product = 'whatsapp';
```

Attendu : `status = connected`, `webhook_abonne = true`, `enregistre = true` (ou `false` avec un
motif lisible si Meta a refusé le PIN).

---

## Partie D — Premier message WhatsApp (envoi ET réception)

### D.1 Réception (le plus important : elle prouve le webhook)

1. Depuis **votre téléphone**, envoyer un message WhatsApp au numéro de test Meta.
2. Ouvrir la fiche WhatsApp dans VYORA → **Boîte de réception**.
3. Le message doit apparaître en moins de quelques secondes.

**Si le message n'apparaît pas**, la cause est dans cet ordre :

| Vérification | Commande / action |
| --- | --- |
| Le WABA est-il abonné à l'app ? | Le champ `webhook_subscribed` doit être `true` |
| Le champ `messages` est-il abonné ? | Console Meta → Webhooks → WhatsApp Business Account → champs |
| Le Verify Token correspond-il ? | `META_WEBHOOK_VERIFY_TOKEN` = valeur saisie dans Meta |
| La signature est-elle acceptée ? | Logs de `meta-webhook` : `signature invalide` = `META_APP_SECRET` faux |
| L'événement a-t-il été résolu ? | `select * from saas_business.meta_webhook_events order by received_at desc limit 5` |
| Le message est-il en base ? | `select * from saas_business.meta_messages where channel = 'whatsapp' order by sent_at desc limit 5` |

Si `meta_webhook_events` contient l'événement mais pas `meta_messages`, la résolution a échoué :
l'identifiant du numéro n'est rattaché à aucune connexion. C'est le comportement attendu d'un
événement non résolvable — mais ici il indique que `metadata->>'phone_number_id'` ne correspond
pas à l'identifiant envoyé par Meta.

### D.2 Envoi

1. Boîte de réception → ouvrir la conversation → saisir une réponse → **Envoyer**.
2. Le message doit arriver sur le téléphone.
3. Hors de la **fenêtre de 24 h** (aucun message du contact depuis 24 h), un texte libre est refusé
   par Meta : utiliser un **modèle approuvé** (section « Modèles approuvés » de la fiche). En mode
   test, le modèle `hello_world` fourni par Meta fonctionne.

### D.3 Preuves finales

```sql
-- Messages entrants ET sortants
select direction, status, left(body, 40) as extrait, sent_at, error_message
  from saas_business.meta_messages
 where channel = 'whatsapp'
 order by sent_at desc limit 10;
```

Attendu : au moins une ligne `in` et une ligne `out`, sans `error_message`.

---

## État final à cocher

| Preuve | Critère | État |
| --- | --- | --- |
| Déploiement | `npm run meta:readiness` → 3/3 | ☐ |
| A1 Page connectée | `meta_connections` : 1 ligne `facebook` / `connected` | ☐ |
| A2 Publication réelle | Visible sur `facebook.com/<page>` | ☐ |
| C1 WhatsApp connecté | `meta_connections` : 1 ligne `whatsapp` / `connected` | ☐ |
| D1 Message reçu | Ligne `direction = 'in'` dans `meta_messages` | ☐ |
| D2 Message envoyé | Ligne `direction = 'out'`, statut `sent` ou `delivered` | ☐ |

**Tant que ces six cases ne sont pas cochées, aucune intégration ne doit être annoncée comme
opérationnelle** — ni dans l'interface, ni dans une démonstration, ni dans une réponse.
