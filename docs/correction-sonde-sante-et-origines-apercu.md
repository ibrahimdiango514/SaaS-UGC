# Correction — « assistance IA indisponible » et « backend Business Grow injoignable »

Date : 2026-11-11 · Branche `arena/323bad30-saas-ugc` · Aucune migration, aucun crédit, aucune clé modifiée.

Les deux messages vus sur mobile avaient **deux causes serveur distinctes**, toutes deux corrigées et
vérifiées par un appel réel depuis la base de production (pg_net).

## 1. « L'assistance IA pour les scripts et prompts est indisponible »

**Symptôme** : Dashboard, bandeau d'avertissement alors que la génération de texte fonctionne.

**Cause racine** : le Dashboard lit `configured.groq` de `reelora-health`, qui ne testait que le secret
`GROQ_API_KEY`. Or le moteur réellement appelé par le Studio est `vyora-ai`, qui lit
`BUSINESS_GROW_GROQ_API_KEY` (repli `GROQ_API_KEY`). Ce secret existe, pas `GROQ_API_KEY` :
la sonde répondait donc `groq:false` alors que le moteur est opérationnel. Faux négatif, pas panne.

**Preuve avant** (pg_net id 4525, 2026-11-11T23:12Z) :

```
200 {"service":"reelora-health",...,"configured":{"groq":false,"muapi":true,"supabase":true,"worker":true}}
```

**Correction** (déployée, `reelora-health` v10) :

```ts
groq: Boolean(Deno.env.get("BUSINESS_GROW_GROQ_API_KEY") || Deno.env.get("GROQ_API_KEY")),
```

**Preuve après** (pg_net id 4534, 2026-11-11T23:16Z, `Origin: https://4180-…e2b.app`) :

```
200 {"service":"reelora-health",...,"configured":{"groq":true,"muapi":true,"supabase":true,"worker":true}}
```

**Durcissement associé** : `reelora-ai` (repli du Studio si `vyora-ai` est absent) lisait le même
`GROQ_API_KEY` obsolète et aurait répondu `GROQ_NOT_CONFIGURED` en 503. Il lit désormais
`BUSINESS_GROW_GROQ_API_KEY` / `BUSINESS_GROW_GROQ_MODEL` avec repli. Vérifié par un appel authentifié :
pg_net id 4537 → `400 INVALID_INPUT` (validation applicative atteinte, donc le contrôle de clé passe).

## 2. « Le backend Business Grow est absent ou injoignable »

**Symptôme** : onglet Business Grow, panneau « Backend Business Grow indisponible », compteurs « — ».

**Cause racine** : l'allowlist CORS de `business-grow` listait des identifiants de sandbox figés
(`5173-iu476i6ok9qrn5o47a39w.e2b.app`). L'aperçu courant vit sur un autre hôte
(`{port}-ia19ukd7j0vjzx70dsuks.e2b.app`). Toute requête du navigateur était donc rejetée en
**403 `ORIGIN_NOT_ALLOWED`**, ce que le client traduisait par « backend absent ou non déployé ».

**Preuve avant** (pg_net id 4524) :

```
403 {"error":{"code":"ORIGIN_NOT_ALLOWED","message":"Origine non autorisée."}}
```

**Correction** : `defaultAllowedOrigins` contient désormais le motif `https://*.e2b.app` (les hôtes
d'aperçu changent à chaque session), en plus des origines Netlify déjà autorisées. CORS n'est pas une
frontière d'authentification ici : chaque requête exige de toute façon un JWT VYORA.

**Preuve après** (pg_net id 4530, session réelle du compte A, `Origin: https://4180-ia19ukd7j0vjzx70dsuks.e2b.app`) :

```
200 access-control-allow-origin: https://4180-ia19ukd7j0vjzx70dsuks.e2b.app
{"data":{"providers":[…]}}   // liste réelle des fournisseurs, plus aucun 403
```

Le secret `BUSINESS_GROW_ALLOWED_ORIGINS` a également été posé avec le motif `https://*.e2b.app` pour que
la correction reste active même si l'allowlist par défaut est remplacée par une valeur d'environnement.

## État de déploiement

| Fonction | Version | Changement |
| --- | --- | --- |
| `reelora-health` | v10 | sonde `groq` alignée sur le moteur réel |
| `reelora-ai` | v9 | mêmes secrets que `vyora-ai` |
| `business-grow` | v7 | allowlist : motif `*.e2b.app` (source corrigée ; redéployer pour l'appliquer à la fonction) |

Le code source des trois fonctions est corrigé dans le dépôt. `business-grow` doit être redéployé pour
embarquer le nouveau motif ; en attendant, le secret `BUSINESS_GROW_ALLOWED_ORIGINS` couvre déjà les
aperçus `*.e2b.app`, `*.netlify.app` et le développement local — vérifié par l'appel 4530.

## Tests

`tests/business-grow-edge.test.ts` : nouveau bloc « Origines des aperçus de travail (régression CORS) »
qui accepte un aperçu e2b de n'importe quelle session et refuse un hôte usurpé
(`…e2b.app.evil.com`) ou un schéma `http`. Suite complète : **42 fichiers / 449 tests**, `tsc --noEmit` 0
erreur, `npm run build` OK, `check:edge-imports` conforme.
