# Vérification réelle des fournisseurs Business Grow — 2026-11-11 23:28-23:29 UTC

Exécution validée explicitement par le propriétaire. **Aucune génération de texte, aucun crédit consommé,
aucune clé lue ni modifiée, aucune migration.** Chaque ligne de preuve est un appel HTTP réel exécuté par
la base de production (pg_net) vers la fonction `business-grow` déployée, avec le JWT d'un compte réel et
l'origine de l'aperçu `https://4180-ia19ukd7j0vjzx70dsuks.e2b.app`.

## Actions exécutées

| id pg_net | Action | Résultat |
| --- | --- | --- |
| 4549 | `status` (avant) | Gemini et Groq en `unverified` / `enabled:false` |
| 4550 | `providers.verify {providerKey:"gemini"}` | `healthy`, 567 ms, modèle `gemini-2.5-flash` |
| 4552 | `providers.verify {providerKey:"groq"}` | `healthy`, 491 ms, modèle `openai/gpt-oss-120b` |
| 4553 | `status` (après) | Gemini **available/enabled**, Groq **available/enabled** |

## Réponse brute du contrôle Gemini (id 4550)

```
200 {"data":{"providerKey":"gemini","modelKey":"gemini-2.5-flash","status":"healthy",
     "latencyMs":567,"errorCode":null,"availableModels":["gemini-2.5-flash","gemini-3.5-flash",
     "gemini-3-flash-preview","gemini-2.5-flash-lite", …]}}
```

Le serveur a interrogé l'API Gemini avec sa clé Edge, listé les modèles réellement accessibles et écrit
deux lignes de santé (`provider_key` global + `model_key`). Aucun contenu utilisateur n'a été généré.

## Réponse brute du contrôle Groq (id 4552)

```
200 {"data":{"providerKey":"groq","modelKey":"openai/gpt-oss-120b","status":"healthy",
     "latencyMs":491,"errorCode":null,"availableModels":["openai/gpt-oss-120b","openai/gpt-oss-20b",
     "qwen/qwen3.8-27b","meta-llama/llama-prompt-guard-2-22m", …]}}
```

## État final lu par l'interface (id 4553)

| Fournisseur | Statut | Activé | Dernier contrôle | Config | Modèles vérifiés |
| --- | --- | --- | --- | --- | --- |
| Gemini | `available` | oui | `2026-11-11T23:28:57.817Z` | `configured` | `gemini-2.5-flash` |
| Groq | `available` | oui | `2026-11-11T23:29:06.301Z` | `configured` | `openai/gpt-oss-120b` |

## Secours Groq → Gemini : opérationnel

Ce qui est vérifié :

1. **Ordre de routage** : `BUSINESS_GROW_PROVIDER_ORDER` est configuré, et le code retombe sur
   `['groq','gemini']` (`providerOrder()`), donc Groq est tenté d'abord, Gemini en second.
2. **Éligibilité Gemini pour les 7 rôles métier** (`action_plan`, `business_advisor`, `business_analysis`,
   `content_strategy`, `marketing_campaign`, `sales_analysis`, `tool_planning`) : requête reprenant
   exactement les clauses de `saas_business.bg_select_route()` (règle active, rôle actif, fournisseur
   `available`, config `configured`, modèle `verified`, capacités requises couvertes, santé
   fournisseur **et** modèle < 24 h) avec Groq exclu → **7/7 répondent `gemini` / `gemini-2.5-flash`**.
3. **Mécanique de repli** : sur `ProviderCallError`, le handler marque la tentative comme échouée,
   exclut Groq (`excludedProviders`), puis reboucle sur `attemptNumber = 2` avec
   `fallbackReason = <code d'erreur>` ; `bg_select_route()` exclut alors Groq et sélectionne Gemini.
   La réponse porte `fallbackUsed: true` et `attemptsCount: 2`.

La seule preuve non fournie est un repli **observé en direct** : il exige une panne fournisseur réelle ou
une génération authentifiée (message envoyé dans une conversation), donc un crédit consommé — exclu par
la consigne. La mécanique est couverte par les tests unitaires de repli
(`tests/business-grow-edge.test.ts`, cas `allowFallback`).

## Point de vigilance

Aucun `pg_cron` de santé fournisseur n'existe dans la base. Les deux vérifications restent valides
24 h : **Gemini jusqu'au 2026-11-12T23:28Z**, **Groq jusqu'au 2026-11-12T23:29Z**. Passé ce délai,
`bg_select_route()` ne trouvera plus de route et l'espace Business Grow répondra
`NO_VERIFIED_PROVIDER` (503). Un job `pg_cron` quotidien appelant `providers.verify` pour Groq et Gemini
élimine cette récidive — en attente de votre validation, car il touche la base (pas de migration de schéma,
mais création d'un job planifié).
