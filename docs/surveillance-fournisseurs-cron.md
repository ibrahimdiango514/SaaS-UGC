# Surveillance automatique des fournisseurs IA (Groq, Gemini)

Job `pg_cron` en production sur `xbuuhfwobrafcbgtdgjx`. Objectif : ne plus jamais retomber sur
`NO_VERIFIED_PROVIDER` (503) parce que les contrôles de santé ont plus de 24 h — la cause exacte du blocage
Business Grow corrigé manuellement le 2026-11-11.

Migration : `supabase/migrations/20261111234500_vyora_provider_health_cron.sql`
Fonction : `supabase/functions/vyora-provider-health/index.ts`

## Jobs créés et actifs

| jobid | Nom | Fréquence (UTC) | Rôle |
| --- | --- | --- | --- |
| 7 | `vyora-provider-health-daily` | `0 2,14 * * *` | Contrôle quotidien des deux fournisseurs |
| 8 | `vyora-provider-health-collect` | `*/5 * * * *` | Collecte des réponses pg_net, trace HTTP |
| 9 | `vyora-provider-health-fresh-guard` | `20 * * * *` | Ré-envoi si un fournisseur n'a plus de contrôle < 20 h |
| 10 | `vyora-provider-health-watchdog` | `40 6 * * *` | Alerte si la surveillance elle-même est muette (> 26 h) |

## Réponse aux sept conditions

1. **Avant l'expiration des 24 h** — envoi quotidien à 02:00 et 14:00 UTC **plus** un garde-fou horaire qui
   ré-envoie dès qu'un fournisseur n'a plus de contrôle réussi de moins de 20 h (marge de 4 h). Le premier
   envoi réel a eu lieu à 23:43 UTC, soit ~18 h avant l'expiration des contrôles précédents.
2. **Authentification serveur sécurisée** — jeton aléatoire de 256 bits dans Supabase Vault
   (`vyora_provider_health_token`), lu par `vyora_provider_health_cron_token()` dont l'EXECUTE est réservé au
   `service_role` (et à la session `postgres` de pg_cron). Comparaison à temps constant dans l'Edge Function,
   en-tête `x-vyora-cron` obligatoire, jeton jamais renvoyé au client ni journalisé. Aucune clé fournisseur ne
   quitte Edge Functions : Gemini et Groq sont interrogés depuis la fonction avec les secrets Edge existants.
3. **Aucune génération, aucun crédit** — le service n'appelle que les endpoints de catalogue
   (`GET https://api.groq.com/openai/v1/models`, `GET https://generativelanguage.googleapis.com/v1beta/models`).
   Il n'existe aucun appel de complétion : deux tests verrouillent l'absence de `chat/completions` et de
   `:generateContent`. Aucun quota, aucun crédit, aucune table de facturation n'est touché.
   *Prix éventuel : Google documente un endpoint `ListModels` gratuit ; Groq ne facture pas la liste des modèles.
   Aucun débit n'a été observé sur les tableaux de coûts existants.*
4. **Aucune exécution concurrente** — nom de job unique, verrou consultatif transactionnel
   `pg_try_advisory_xact_lock(hashtext('vyora_provider_health'))` partagé par l'envoi et la collecte, et
   `SELECT … FOR UPDATE SKIP LOCKED` sur l'état de chaque fournisseur.
5. **Résultats enregistrés** — `saas_business.ai_provider_health_checks` (source de vérité du routage) **et**
   `saas_business.provider_health_cron_runs` (statut, latence, code d'erreur, HTTP, id pg_net, horodatage).
   `saas_business.provider_health_cron_state` conserve l'état courant par fournisseur.
6. **Échecs et alertes** — alerte `saas_immobilier.admin_alerts` (console admin, dédupliquée) **et**
   notification in-app aux administrateurs (rôle VYORA `admin` + administrateurs plateforme), avec
   déduplication 12 h ; l'alerte est refermée automatiquement au premier contrôle réussi. Cas couverts :
   fournisseur en échec (3 échecs consécutifs ⇒ ré-alerte), HTTP 401/403 du job (critique), 404/5xx,
   absence de réponse après 5 min, état périmé > 26 h, jeton Vault manquant.
7. **Job réellement actif** — vérifié dans `cron.job` (jobid, `active = true`) **et** dans `cron.job_run_details`
   (`vyora-provider-health-collect` : `succeeded`, 2026-11-11 23:45:00 UTC). Le panneau admin
   « Fournisseurs IA » affiche ces mêmes données via la RPC `vyora_provider_health_status()`.

## Preuves d'exécution réelle (2026-11-11)

| id pg_net | Fournisseur | HTTP | Statut | Latence | Modèle vérifié |
| --- | --- | --- | --- | --- | --- |
| 4573 | Groq | 200 | `healthy` | 177 ms | `openai/gpt-oss-120b` (11 modèles visibles) |
| 4574 | Gemini | 200 | `healthy` | 82 ms | `gemini-2.5-flash` (50 modèles visibles) |

Collecte : `collect_final` a marqué les deux exécutions `collected` (HTTP 200) à 23:47:31 UTC.
Le job planifié `vyora-provider-health-collect` s'était déjà exécuté seul à 23:45:00 UTC (`succeeded`).

Chemin d'alerte vérifié en transaction annulée (aucune donnée créée) : 1 alerte console + 2 notifications
(`sbcaiagency999@gmail.com`, `nabilayediango910@gmail.com`) pour une panne simulée.

## Fonction de sauvegarde

Le service est distinct de `business-grow` volontairement : le gateway Supabase exige un JWT utilisateur sur
`business-grow` (`verify_jwt = true`), ce qu'un job pg_cron ne peut pas fournir. Cette fonction est donc
`verify_jwt = false` **mais** protégée par le jeton Vault ci-dessus — même modèle que `reelora-video-worker`.

## Limite connue

Les modèles vérifiés par ce job (le modèle configuré de chaque fournisseur) sont re-marqués `healthy` toutes
les 20 h. Les **autres** modèles déjà `verified` (par exemple `gemini-3.5-flash`) ne sont pas revérifiés : une
route qui les préférerait explicitement expirerait au bout de 24 h. Le routage par défaut (Groq prioritaire,
Gemini en secours) n'est pas concerné.
