# Configurer les identifiants Google pour VYORA Connect

Ce document décrit **exactement** ce qu'il faut fournir pour que les
intégrations Google passent de « Configuration requise » à un bouton de
connexion réel. Aucune étape ici n'est optionnelle.

Tant que ces trois secrets sont absents, le comportement est volontaire :
l'interface affiche « Configuration requise », `start` renvoie
`503 google_not_configured`, et **aucun** faux compte n'apparaît. Ce n'est pas
un défaut à contourner, c'est la garantie qu'aucun état n'est simulé.

---

## 1. Les trois secrets attendus

| Secret | Rôle | Où le trouver |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Identifie l'application auprès de Google | Console Google Cloud → « ID client » |
| `GOOGLE_CLIENT_SECRET` | Prouve l'identité de l'application lors de l'échange de code | Console Google Cloud → « Code secret du client » |
| `VYORA_OAUTH_REDIRECT_URI` | URI vers laquelle Google renvoie l'utilisateur | Doit correspondre **au caractère près** à celle déclarée côté Google |

`VYORA_OAUTH_REDIRECT_URI` est en réalité **facultative** : si elle est absente,
le code retombe sur la valeur construite à partir de `SUPABASE_URL` :

```
https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth?action=callback
```

La déclarer explicitement reste préférable : c'est la seule façon de garantir
que la valeur enregistrée dans Google Cloud et celle utilisée au runtime ne
divergent pas silencieusement.

Un quatrième secret, `VYORA_OAUTH_ENCRYPTION_KEY`, est **déjà en place** et ne
doit pas être régénéré : il chiffre les jetons déjà stockés. Le changer rendrait
illisibles tous les comptes existants.

---

## 2. Créer le client OAuth dans Google Cloud

1. **Créer ou choisir un projet** dans la [console Google Cloud](https://console.cloud.google.com/).
2. **Activer les trois API** — sans elles, l'échange de jeton réussit mais chaque
   appel métier échoue en `403` :
   - Gmail API
   - Google Drive API
   - Google Calendar API
3. **Configurer l'écran de consentement OAuth** (OAuth consent screen) :
   - Type : *Externe*
   - Nom de l'application, e-mail d'assistance, domaine autorisé
   - Renseigner les scopes listés en section 4
4. **Créer les identifiants** → « ID client OAuth » → type **Application Web**.
5. **Déclarer l'URI de redirection autorisée** — exactement :
   ```
   https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth?action=callback
   ```
   Une différence d'un seul caractère (slash final, `http` au lieu de `https`,
   casse) provoque `redirect_uri_mismatch` au retour de Google.

---

## 3. Renseigner les secrets dans Supabase

Les secrets se créent dans **Edge Functions → Secrets**, jamais dans le
frontend, jamais dans un fichier du dépôt.

```bash
supabase secrets set \
  GOOGLE_CLIENT_ID="…apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="…" \
  VYORA_OAUTH_REDIRECT_URI="https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth?action=callback"
```

Puis **redéployer** `vyora-oauth` : les variables d'environnement sont lues au
démarrage de l'instance. Un secret ajouté sans redéploiement reste invisible
pour la fonction.

Vérification ensuite — l'action `status` est la source de vérité :

```bash
curl -s "https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-oauth?action=status" \
  -H "Authorization: Bearer <cle_publishable_ou_JWT>"
```

La fonction exige un en-tête `Authorization` non vide (`401 unauthorized` sans
lui), mais `status` **ne lit pas la base** : il évalue seulement la présence des
secrets. Une clé publishable suffit donc pour cette vérification, sans monter un
compte utilisateur.

Attendu :

```json
{
  "google": true,
  "encryption_configured": true,
  "providers": { "gmail": true, "google_drive": true, "google_calendar": true }
}
```

`google` ne vaut `true` que si **les trois** — `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` et `VYORA_OAUTH_ENCRYPTION_KEY` — sont présents. Si la
réponse indique encore `false`, un secret manque ou la fonction n'a pas été
redéployée après son ajout.

---

## 4. Scopes réellement demandés

Chaque capacité demande **ses propres scopes, et rien de plus** — c'est ce qui
rend le picker de permissions honnête. Les scopes ne sont jamais cumulés
d'office : un utilisateur qui ne demande que `read` obtient un jeton qui ne peut
techniquement pas écrire.

| Fournisseur | Capacité | Scope |
|---|---|---|
| Gmail | `read` | `gmail.readonly` |
| Gmail | `draft` | `gmail.compose` |
| Gmail | `send` | `gmail.send` |
| Gmail | `modify` | `gmail.modify` |
| Drive | `read` | `drive.readonly` |
| Drive | `modify` | `drive.file` |
| Calendar | `read` | `calendar.readonly` |
| Calendar | `modify` | `calendar.events` |

À quoi s'ajoutent, pour les trois, les scopes d'identité `openid`, `email`,
`profile` — nécessaires pour vérifier à qui appartient le compte connecté.

Deux choix délibérés méritent d'être signalés à quiconque relit ce fichier :

- **`draft` et `send` sont séparés.** `gmail.compose` crée des brouillons sans
  pouvoir envoyer. Fusionner les deux aurait donné à un utilisateur qui veut
  « préparer un brouillon » le pouvoir d'envoyer en son nom. L'outil
  `vyora_gmail_draft` renvoie donc toujours `sent: false`.
- **Drive utilise `drive.file`, pas `drive`.** L'application ne voit que les
  fichiers qu'elle a elle-même créés — jamais le reste du Drive.

> **Point de Vigilance — vérification Google**
>
> Les scopes Gmail (`gmail.readonly`, `gmail.compose`, `gmail.send`,
> `gmail.modify`) sont classés **restreints** par Google. Une application les
> utilisant est plafonnée tant qu'elle n'a pas passé la procédure de
> vérification Google, qui peut inclure un audit de sécurité.
>
> Conséquence pratique : en mode *Test*, seuls les comptes ajoutés comme
> « utilisateurs de test » peuvent autoriser l'application, et les jetons de
> rafraîchissement expirent au bout de 7 jours. C'est utilisable pour valider le
> flux de bout en bout, pas pour ouvrir le service à des utilisateurs réels.
>
> Le plan de retrait doit donc être prévu **avant** la mise en production, et
> non découvert au premier utilisateur qui échoue.

---

## 5. Ce qu'il faut vérifier après configuration

Dans l'ordre — chaque étape prouve quelque chose de différent :

1. `status` renvoie `google: true` → les secrets sont lus par la fonction.
2. Un bouton « Connecter » apparaît sur Gmail dans `/app/connect` → l'interface
   a bien reçu cet état, elle ne l'a pas inventé.
3. Le flux d'autorisation revient sur `?action=callback` sans
   `redirect_uri_mismatch` → l'URI est correctement déclarée des deux côtés.
4. Le compte apparaît avec ses **permissions réellement accordées**, relues
   depuis Google — et non celles demandées.
5. `oauth_accounts` contient une ligne pour cet utilisateur, et les colonnes de
   jeton sont des cryptogrammes, **jamais** un `ya29.…` en clair.
6. Un appel `tools_call` sur `vyora_gmail_search` renvoie des messages, et la
   réponse ne contient nulle part le jeton.

Les étapes 4 à 6 sont celles qui distinguent une intégration réelle d'une
démonstration. Elles se vérifient, elles ne se supposent pas.

---

## 6. En cas de problème

| Symptôme | Cause la plus fréquente |
|---|---|
| `503 oauth_not_configured` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` ou `VYORA_OAUTH_ENCRYPTION_KEY` absent — bloque **toutes** les actions |
| `503 google_not_configured` sur `start` | `GOOGLE_CLIENT_ID` absent, ou fonction non redéployée après ajout |
| `redirect_uri_mismatch` | URI déclarée dans Google ≠ `VYORA_OAUTH_REDIRECT_URI` |
| `invalid_grant` au rafraîchissement | jeton révoqué côté Google, ou expiration des 7 jours du mode Test |
| `403` sur un appel métier | API Gmail/Drive/Calendar non activée dans le projet |
| `insufficientPermissions` | scope non accordé : la capacité demandée dépasse ce que l'utilisateur a consenti |
| Le compte reste « Configuration requise » | l'interface interroge `status` ; vérifier d'abord cette action, pas `provider_status()` |

`provider_status()` en SQL renvoie toujours `google: null`. C'est volontaire :
Postgres ne peut pas lire l'environnement des Edge Functions. La source de
vérité est l'action `status`.
