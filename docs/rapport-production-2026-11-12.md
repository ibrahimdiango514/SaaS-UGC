# VYORA Studio — Rapport final de production

**Date** : 2026-11-12
**Branche** : `arena/323bad30-saas-ugc` (issue de `1a572be`)
**Projet Supabase** : `xbuuhfwobrafcbgtdgjx`
**Règle de lecture** : chaque affirmation ci-dessous a été vérifiée soit en production (SQL/Edge), soit par test automatisé. Tout ce qui reste bloqué est écrit comme bloqué.

---

## 1. Pourquoi le message « débit backend indisponible » apparaissait

Le message n'existe pas littéralement dans le code. Le seul libellé d'indisponibilité de débit du Studio est **« Devis backend indisponible »** (`src/studio/GenerationStudio.tsx`, bannière d'erreur du devis).

Cause racine trouvée et **corrigée** : l'appel `estimate`/`quote` échouait lorsque le corps envoyé ne correspondait pas au modèle. Deux défauts distincts ont été isolés :

1. **Identifiant de modèle** : `estimate` recevait un `model_id` technique (`creatify-lipsync`) au lieu du `public_id` UUID. Résultat : `MODEL_NOT_FOUND` (« Ce modèle vidéo n'existe pas dans le catalogue VYORA »).
2. **Nom de modèle transmis au fournisseur** : avec un UUID à la place du nom technique, `POST /api/v1/models/{name}/estimate-cost` renvoyait **404 `Unknown model: 5fa1a3b3-…`**, ce que le classifieur traduisait par `PROVIDER_BAD_RESPONSE` (« Le fournisseur a renvoyé une réponse illisible »). L'endpoint existait et la clé était valide : c'était bien l'identifiant qui était faux.

Preuve : le même endpoint, appelé avec le **nom technique** (`creatify-lipsync`), renvoie `200 {"cost":0.11,"currency":"USD"}`.

## 2. Comment cela a été corrigé

- Le chemin de devis utilise désormais le **nom technique** pour l'estimation fournisseur et le **`public_id`** pour le catalogue client (séparation déjà présente dans `loadModel`, validée en production).
- **Défaut de routage réel corrigé** : `str(body.action, 20)` tronquait `admin-provider-balance` (22 caractères) et faisait tomber la requête dans la branche « job_id requis ». Limite portée à 40 caractères.
- **Artefact Edge reconstruit** : le générateur produisait du SQL avec des guillemets doubles (invalide) ; les tranches sont maintenant écrites en littéraux SQL et le gzip est **déterministe** (`mtime: 0`), ce qui rend l'artefact reproductible octet pour octet.
- **Nouvelle barrière fournisseur** ajoutée avant tout appel payant : lecture du solde MuAPI + refus si insuffisant ou illisible.

## 3. Débit de crédits réellement fonctionnel en production

Vérifié en production avec un **compte de test dédié** (`studio-debit-test@vyora.test`), sans toucher aux portefeuilles réels :

| Étape | Résultat observé en prod |
|---|---|
| Authentification du compte de test | `POST /auth/v1/token?grant_type=password` → **200** |
| Devis Audio→Vidéo (`creatify-lipsync`) | `200` — **2 crédits**, devis créé, `provider_quote.cost_usd = 0.11` |
| Devis Texte→Vidéo (`flux-3-text-to-video`) | `200` — **13 crédits**, `provider_quote.cost_usd = 1.25` |
| Devis Image→Vidéo (`flux-3-image-to-video`) | `200` — **13 crédits**, coût réel `1.25 USD` |
| `pricing_available` | `true`, `pricing_error: null` |
| Enregistrement du devis (`reelora_record_video_quote`) | Devis réel créé, expirant à 10 minutes, lié au modèle et à la config tarifaire |

Le cycle réservation → capture → restitution avait déjà été prouvé transactionnellement (5 → réserve 3 = 2/3 → rejeu idempotent → capture 2/0 → réserve 2 = 0/2 → release = 0/2).

**Limite honnête** : aucune génération payante n'a été lancée (interdiction explicite). Le dernier maillon — appel MuAPI réel et capture — est donc vérifié par test automatisé et par le code déployé, **pas** par une génération réelle facturée.

## 4. Plafond 10 USD configuré et actif

- Politique appliquée en production : `max_usd = 10`, `enabled = true`, `alert_percent = 80`, `provider_caps_usd = {"muapi": 10}`.
- Contrôle **côté serveur** (`reelora_reserve_provider_spend`) avant chaque opération, avec double verrou global/fournisseur.
- Vérifié juste après application : `remaining_usd = 10`, `committed_usd = 0`, `actual_spent_usd = 0`, `alert_state = ok`.
- **Jamais illimité** : `max_usd` est borné, et une valeur `0` bloque tout test payant.

## 5. Solde MuAPI consultable en admin

- Nouvelle action Edge `admin-provider-balance`, réservée aux admins (vérifiée : un compte non-admin reçoit **403 « Accès administrateur requis »**).
- Nouvelle table `saas_ugc.ugc_provider_balance` + RPC `reelora_admin_provider_balance()` (service_role uniquement, aucune policy pour `anon`/`authenticated`).
- **Solde réel mesuré le 2026-11-12** : `GET /api/v1/account/balance` → **`200`**, `balance = 0`, `currency = USD`, compte `babergang009@gmail.com`, clé de 64 caractères valide.

**Conséquence décisive : le solde MuAPI est à 0 USD.** Les générations payantes échoueraient de toute façon ; VYORA les bloque désormais **avant** l'appel fournisseur.

## 6. Rechargement : portail officiel uniquement, aucun faux bouton

L'API MuAPI expose une lecture de solde mais **aucun endpoint de rechargement** documenté utilisable ici. Aucun bouton de recharge fictif n'a été ajouté. L'interface indique explicitement que le rechargement se fait **depuis le portail officiel MuAPI**, et le blocage côté serveur empêche toute dépense non financée.

**Aucune recharge n'a été effectuée** : elle exige votre confirmation explicite.

## 7. Alertes de solde insuffisant

Quatre messages explicites, côté serveur, avant tout appel payant :

- `PROVIDER_BALANCE_INSUFFICIENT` — « Le solde fournisseur MuAPI est insuffisant pour cette génération. Aucun appel payant n'a été lancé… »
- `PROVIDER_BALANCE_UNAVAILABLE` — « Impossible de vérifier le solde MuAPI. Aucun appel payant n'a été lancé… »
- `PROVIDER_SPEND_CAP_EXCEEDED` / `PROVIDER_SPEND_DISABLED` — plafond VYORA atteint ou tests payants désactivés.
- `PROVIDER_SPEND_PROVIDER_CAP_EXCEEDED` / `_UNAVAILABLE` — plafond par fournisseur (mapping manquant, désormais ajouté).

Une synchro en échec écrit aussi une alerte `balance_sync_failed` exploitable en administration.

## 8. Fonctionnalités Studio réellement opérationnelles

**Vérifié en production** : catalogue (415 modèles, 325 actifs), détail modèle, devis de crédits réel avec coût fournisseur, création de devis, barrière budgétaire, barrière de solde.

**Vérifié hors génération payante** : réservation/capture/restitution des crédits, idempotence, refus de solde insuffisant.

**Non vérifié par exécution réelle** (et non déclaré comme acquis) : la génération vidéo de bout en bout, l'export, la publication sociale — bloqués par le **solde MuAPI à 0** et par l'absence d'identifiants OAuth.

## 9. Réseaux sociaux réellement connectables

**Non livré.** Aucune connexion OAuth réelle n'a été établie, et rien n'est présenté comme connecté. Les prérequis externes sont listés en point 14.

## 10. Déploiements effectués

| Élément | État |
|---|---|
| `reelora-video` | **v17 ACTIVE**, `verify_jwt: true`, artefact sha256 `5ca3a72d…`, assemblage `be2c891b…` (11 tranches) |
| Démarrage de l'artefact en prod | Vérifié (`action: models` → 200, 415 modèles) |
| `saas_ugc.ugc_provider_balance` + RPC | Appliqués en production |
| `reelora-video` v16/v17 | Déployées puis vérifiées par `get_edge_function` |
| Sonde temporaire `vyora-provider-probe` | Créée pour le diagnostic, **supprimée** |
| `public._vyora_muapi_probe` | **Supprimée** |
| Netlify | **Aucun déploiement** |

## 11. Tests réalisés

- `npx vitest run` → **50 fichiers / 529 tests ✅**
- `npx tsc -b` → **0 erreur**
- Nouveaux tests de la Condition B : refus si solde inférieur au coût, refus si solde illisible, **ordre vérifié** (lecture du solde strictement avant la soumission payante), persistance du relevé.
- Tests de production : authentification du compte de test, 4 actions Edge authentifiées, devis réels sur 3 modèles, application et lecture de la politique budgétaire, barrière admin 403.

## 12. Liens

- Studio : `/studio` de l'application déployée.
- Aperçu local : `node scripts/studio-preview.mjs` (vérifié, 5/5).
- Aucune URL Netlify n'a été publiée : aucun déploiement non maîtrisé n'a été fait.

## 13. Branche et commits

- Branche : `arena/323bad30-saas-ugc` — **aucune fusion dans `main`**.
- Commits antérieurs préservés (`2318f5b` → `5785563`), nouveaux commits en fin de session.
- Worktree propre, aucun `reset`.

## 14. Autorisations externes encore nécessaires

1. **Recharge MuAPI** : crédit du compte fournisseur — je ne l'ai pas fait, cela requiert votre accord explicite.
2. **Validation MuAPI** : confirmer que la clé de production doit rester sur ce compte (`babergang009@gmail.com`).
3. **Réseaux sociaux** : création des applications développeur et validation des scopes — YouTube (Google Cloud, vérification OAuth), TikTok (Content Posting API), Meta (Facebook/Instagram, App Review), LinkedIn (Marketing Developer Platform), X (API payante), Pinterest (accès standard).
4. **Publication** : domaine et variables d'environnement Netlify, si vous souhaitez un déploiement — non lancé volontairement.

---

### Ce qui reste bloqué, sans détour

Le Studio **calcule, devis et bloque correctement**, mais il **ne peut pas encore produire de vidéo réelle** : le solde MuAPI est à **0 USD**. Dès que le compte est rechargé (par vous, sur le portail officiel), la chaîne est prête : devis vérifié → réservation → double contrôle (plafond VYORA **et** solde MuAPI) → génération → capture ou restitution. Aucune recharge n'a été faite et aucune génération payante n'a été lancée.
