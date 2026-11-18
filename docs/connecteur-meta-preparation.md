# Connecteur Meta (Facebook Pages / Instagram) — préparation

> **Document historique (2026-11-14, avant l'application Meta).** Le connecteur est désormais
> construit : la référence à jour est **`docs/meta-integrations-config.md`** (valeurs exactes à
> déclarer, secrets, actions, webhooks, réserves). Ce qui suit reste utile pour le contexte des
> règles de manipulation des secrets, mais les chemins de code cités ont changé : les fiches Meta
> passent par `meta-connect` / `meta-webhook`, pas par `business-grow`.

> État au 2026-11-14 : **aucune application Meta n'existe encore**. Ce document fixe ce qui est
> prêt côté VYORA, ce qu'il reste à faire côté Meta for Developers, et les règles de manipulation
> des secrets. Rien de ce qui suit n'active le connecteur : `facebook` et `instagram` restent
> `implemented = false` dans `saas_business.integration_providers` et `engine: null` dans
> `src/integrations/catalog.ts` tant que l'App Review n'est pas obtenue.

## 1. Ce qui est déjà en place dans VYORA

| Élément | Où | État |
| --- | --- | --- |
| Fiches catalogue `facebook` et `instagram` (mode `oauth2`, clé serveur `META_APP_ID`, approbation externe annoncée) | `src/integrations/catalog.ts` | En place, affichées « Validation externe requise » |
| Lignes fournisseur `facebook`, `instagram` (`auth_mode = oauth2`, `implemented = false`) | `saas_business.integration_providers` (prod) | En place |
| Demande d'activation par le client (`integrations.request` → ligne `pending`, journalisée) | `supabase/functions/business-grow/handler.ts` | En place ; **hors garde d'abonnement** (connecteurs sociaux), conformément au périmètre Import & Connect |
| Aucune URL ni identifiant Meta codé en dur | `src/`, `supabase/functions/` | Vérifié (`grep META_APP` → seule la clé de configuration nommée dans le catalogue) |

## 2. Secrets à créer — noms exacts, jamais de valeur dans le dépôt

| Secret | Où le poser | Usage |
| --- | --- | --- |
| `META_APP_ID` | Supabase → Edge Functions → Secrets | Identifiant public de l'application Meta : construit l'URL d'autorisation OAuth. Peut figurer dans une URL, **pas** dans le code source. |
| `META_APP_SECRET` | Supabase → Edge Functions → Secrets **uniquement** | Échange du `code` OAuth contre un jeton, vérification des signatures de webhook (`X-Hub-Signature-256`). **Ne jamais** le coller dans un chat, un ticket, un commit, une variable `VITE_*`, ni une variable Netlify. |
| `META_OAUTH_REDIRECT_URI` (recommandé) | Secrets Edge | URL de retour exacte, identique à celle déclarée chez Meta : `https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/<fonction-oauth>/callback`. Une seule source de vérité évite les écarts de « redirect_uri mismatch ». |
| `META_WEBHOOK_VERIFY_TOKEN` (si webhooks) | Secrets Edge | Jeton aléatoire long, choisi par nous, répété dans la console Meta lors de l'abonnement aux webhooks. |

Règles :
- Si un secret a été exposé (capture d'écran, message, log), **régénérer** immédiatement depuis la
  console Meta (*App settings → Basic → App Secret → Reset*) puis mettre à jour le secret Edge.
- Les secrets Edge ne sont lisibles par aucune fonction qui ne les demande pas : seule la future
  fonction OAuth y accède. Le frontend ne reçoit que l'URL d'autorisation déjà construite.

## 3. Étapes Meta for Developers (à réaliser par le titulaire du compte Meta)

1. **Compte développeur** : <https://developers.facebook.com> → s'inscrire avec le compte Facebook
   qui administre la Page VYORA (vérification téléphone/e-mail exigée).
2. **Portefeuille Business** : <https://business.facebook.com> → créer (ou réutiliser) le
   portefeuille « VYORA » ; y rattacher la Page Facebook et le compte Instagram professionnel qui
   serviront aux tests. Lancer la **vérification d'entreprise** (documents officiels) : elle est
   exigée avant l'accès avancé aux permissions.
3. **Créer l'application** : *My Apps → Create App* → type **Business** → nom « VYORA » →
   rattacher au portefeuille Business. Noter l'**App ID** (public). L'**App Secret** s'affiche dans
   *App settings → Basic* : le copier **directement** dans le secret Edge `META_APP_SECRET`, sans
   passage par un intermédiaire.
4. **Paramètres de base** : renseigner *Privacy Policy URL*, *Terms of Service URL*,
   *Data Deletion Instructions URL* (pages publiques du site `https://vyora-ugc.netlify.app`),
   catégorie, icône 1024×1024, e-mail de contact. Sans ces quatre éléments l'application ne peut
   pas passer en mode **Live**.
5. **Produits à ajouter** : *Facebook Login for Business* (OAuth), *Instagram Graph API*
   (publication/lecture Instagram), *Webhooks* (facultatif, pour les statistiques en continu).
6. **Facebook Login → Settings** : *Valid OAuth Redirect URIs* = exactement la valeur de
   `META_OAUTH_REDIRECT_URI` ; *Client OAuth Login* = oui ; *Web OAuth Login* = oui ;
   *Enforce HTTPS* = oui ; *Use Strict Mode for Redirect URIs* = oui.
7. **Permissions à demander (App Review)** — minimum pour le périmètre annoncé dans le catalogue :
   - Pages : `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content`
   - Instagram : `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`
   - Business : `business_management` (si la sélection de Page passe par le portefeuille)
   Pour chaque permission : vidéo de démonstration du parcours réel dans VYORA, justification
   d'usage, compte de test. L'accès **Standard** suffit pour nos propres Pages pendant le
   développement ; l'accès **Avancé** (App Review + vérification d'entreprise) est obligatoire
   pour des Pages de clients.
8. **Testeurs** : *App Roles → Roles* → ajouter les comptes qui testeront avant le passage en Live
   (ils doivent accepter l'invitation dans leur propre compte Facebook).
9. **Passage en Live** : *App Mode → Live* uniquement après : politique de confidentialité en
   ligne, vérification d'entreprise validée, App Review accordé pour les permissions ci-dessus.
10. **Après obtention** : nous activons côté VYORA (dans cet ordre) : secrets Edge → fonction OAuth
    déployée → `integration_providers.implemented = true` pour `facebook`/`instagram` par
    migration → fiche catalogue `engine` renseigné → tests de bout en bout sur un compte test →
    annonce aux clients ayant une demande `pending`.

## 4. Ce que VYORA fera au moment de l'activation (pour information)

- Flux OAuth « Authorization Code » côté serveur, `state` signé et lié à l'entreprise VYORA
  (`workspace_id`) pour empêcher toute association croisée entre comptes.
- Jeton utilisateur court → jeton long (60 j) → **jetons de Page** (sans expiration tant que le
  jeton long est valide), chiffrés en base ; jamais renvoyés au navigateur.
- Déconnexion = suppression locale **et** révocation `DELETE /me/permissions` chez Meta ; le
  libellé « Association locale retirée » actuel sera alors remplacé par une révocation réelle.
- Webhook de désautorisation et de suppression de données (exigés par Meta) traités par la même
  fonction, signature vérifiée avec `META_APP_SECRET`.

## 5. Ce qu'il ne faut pas faire

- Ne pas créer l'application avec un compte Facebook personnel sans portefeuille Business : la
  migration ultérieure est pénible et l'App Review la refuse souvent.
- Ne pas mettre `META_APP_SECRET` dans une variable `VITE_*`, dans Netlify, ni dans ce dépôt.
- Ne pas marquer `facebook`/`instagram` `implemented = true` avant que le flux OAuth soit déployé
  et testé : le catalogue afficherait un bouton « Connecter » qui ne mène nulle part.
