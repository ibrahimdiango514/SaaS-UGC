# Publication des artefacts Edge Functions

Procédure reproductible. Remplace la lacune signalée dans la revue de la PR #11 :
un script `publish-edge-artifact.mjs` était cité dans un commit sans exister dans
le dépôt, rendant la publication impossible à rejouer.

---

## 1. Le problème que résout ce mécanisme

Le canal de déploiement Supabase **altère les sources longues** : au-delà de
~2 000 caractères, un corps envoyé arrive modifié. Les Edge Functions dont le
code dépasse cette limite ne peuvent donc pas être déployées directement.

La solution est un **chargeur court** déployé à leur place :

```
supabase/functions/vyora-oauth/loader.ts   ← déployé (3,5 Ko)
        │
        │ lit les tranches
        ▼
public._edge_function_artifact_slices      ← l'artefact (7 tranches)
        │
        │ concatène, décompresse, VÉRIFIE taille et SHA-256
        ▼
   exécute le code métier
```

Un artefact absent, tronqué ou modifié **n'est jamais exécuté** : le chargeur
échoue en `503 EDGE_ARTIFACT_UNAVAILABLE` et l'erreur est explicite.

## 2. La table de stockage

`public._edge_function_artifact_slices` :

| Colonne | Type | Rôle |
|---|---|---|
| `name` | `text not null` | nom logique (« vyora-oauth ») |
| `part` | `integer not null` | numéro de tranche, base 0 |
| `chunk` | `text not null` | tranche du gzip en base64 (≤ 2 000 car.) |

Clé primaire composite `(name, part)` — c'est aussi ce qui rend l'insertion
idempotente via `on conflict`.

**Accès** : RLS activée **sans politique** (refus par défaut), privilèges révoqués
pour `anon` et `authenticated`, accordés à `service_role` seul. Aucun client ne
peut lire les bundles publiés.

Cette table **n'existait dans aucune migration** avant
`20261116055000_edge_function_artifact_slices.sql` : elle avait été créée
directement en production, ce qui rendait impossible la reconstitution d'une base
neuve.

## 3. Procédure

### Vérifier avant de publier

```bash
node scripts/publish-edge-artifact.mjs --list
node scripts/publish-edge-artifact.mjs --check
```

`--check` compare **trois représentations** et échoue si l'une diverge :

1. le **bundle reconstruit** depuis `supabase/functions/vyora-oauth/index.ts` ;
2. le **chargeur** `supabase/functions/vyora-oauth/loader.ts` (taille + SHA-256) ;
3. la **migration** `20261116060000_vyora_oauth_artifact.sql` (contenu des
   tranches, pas seulement le nombre).

Sortie attendue :

```
vyora-oauth : cohérent (34126 caractères, 7 tranches, sha256 b2101d1416d60022…)
```

### Régénérer

```bash
node scripts/publish-edge-artifact.mjs vyora-oauth
```

Écrit trois fichiers :

| Fichier | Contenu |
|---|---|
| `supabase/functions/vyora-oauth/loader.ts` | le chargeur à déployer |
| `supabase/functions/vyora-oauth.edge.js` | le bundle brut, source exécutable |
| `supabase/migrations/2026111606…_artifact.sql` | les tranches à insérer |

### Déployer

**Aucune étape n'est automatisée.** Le script n'écrit que des fichiers ; il ne
touche ni à la base ni au réseau. La mise en production reste une décision
humaine :

1. revue du diff produit ;
2. application de la migration (insertion des tranches, transactionnelle) ;
3. déploiement du chargeur `loader.ts` comme source de la fonction ;
4. vérification du comportement (voir §5).

## 4. Garanties vérifiées par les tests

`tests/publish-edge-artifact.test.ts` — **24 tests** :

| Garantie | Test |
|---|---|
| Découpage sans perte | recomposition == base64 d'origine |
| Limite du canal respectée | aucune tranche > 2 000 car. |
| **Reproductibilité** | deux builds successifs → même SHA-256 |
| **Une seule vérité** | délègue à `build-edge-loader.mjs`, sortie identique |
| Cohérence des trois représentations | SHA-256, taille, contenu des tranches |
| Vérification avant exécution | `size_mismatch`, `digest_mismatch`, `missing` |
| Aucun secret dans le bundle | `ya29.`, `sk-…`, clé privée |
| Aucune instruction de module | pas d'`export`/`import` dans le bundle |
| **Aucun effet de bord** | imports `node:` uniquement, aucune fonction base |

Un sabotage a confirmé que le filet mord : altérer **une seule tranche** dans la
migration fait échouer **4 tests**.

## 5. Vérification après déploiement

| Cas | Attendu |
|---|---|
| `POST` sans en-tête | `401 unauthorized` |
| `POST` avec `Bearer <uuid>` | `401 unauthorized` |
| `POST` avec un JWT valide | l'action s'exécute |
| `GET ?action=callback` sans jeton | atteint le handler (`400 state_invalid`) |
| Artefact tronqué en base | `503 EDGE_ARTIFACT_UNAVAILABLE` |

La dernière ligne se teste en supprimant une tranche en transaction annulée.

## 6. Limites connues

- **`vyora-oauth` n'est pas encore publié.** La production tourne la version 1,
  dont le chargeur attend 18 868 caractères et 4 tranches. Le dépôt en produit
  34 126 et 7. La faille d'authentification corrigée n'est donc **pas active en
  production** tant que ce déploiement n'a pas eu lieu.
- **Le script ne gère qu'un artefact** (`vyora-oauth`). En ajouter se fait dans
  `ARTIFACTS` ; `vyora-ai`, `vyora-ai-providers` et `vyora-provider-health` ont
  leurs propres migrations, hors périmètre VYORA Connect.
- **Aucun test de bout en bout** contre la fonction déployée : le bac à sable
  n'a pas d'accès réseau à `supabase.co`.
