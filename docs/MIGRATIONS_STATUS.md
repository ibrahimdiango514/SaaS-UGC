# État des migrations — mesuré le 25 novembre 2026

Ce document répond à une seule question : **si l'on connectait ce dépôt à un projet
Supabase neuf, le backend se reconstruirait-il ?** La réponse honnête est **non,
pas entièrement** — et ce document dit exactement ce qui manque, ce qui a été
corrigé, et ce qui exige une décision de ta part.

Rien ici n'est déduit : chaque chiffre vient d'une requête sur le projet
`xbuuhfwobrafcbgtdgjx` ou d'un comptage sur les fichiers du dépôt.

---

## 1. Ce qui a été corrigé dans ce dépôt

**Les 40 vues `public` sont désormais versionnées** dans
`supabase/migrations/20261125130000_public_views_reconstruction.sql`.

Le frontend n'interroge jamais le schéma métier : il passe par des vues exposées
dans `public`, seul schéma que PostgREST publie. Ces vues n'existaient dans aucune
migration — elles avaient été créées à la main dans le tableau de bord. Sur une
base neuve, **toutes** les lectures du frontend échouaient : Studio, Grow, caisse,
réglages, profils. Les fichiers SQL paraissaient pourtant complets, puisque les
tables, elles, sont bien dans le dépôt.

La migration reproduit les définitions de production **à l'identique**, y compris
`with (security_invoker = true)`. Cette option n'est pas décorative : sans elle,
une vue s'exécute avec les droits de son propriétaire et **contourne la RLS** des
tables sous-jacentes. C'est le piège classique des vues « pratiques » — elles
transforment une base cloisonnée en base ouverte.

Vérifications réellement exécutées :

- les 22 tables interrogées par le frontend sont toutes couvertes ;
- les 40 vues de production portent bien `security_invoker=true` (requête sur
  `pg_class.reloptions`) ;
- le DDL complet des 40 vues a été exécuté dans une transaction **annulée**
  (`begin; … rollback;`) : aucune erreur ;
- la RLS est activée sur les 15 tables sensibles vérifiées, et **aucune politique
  n'est ouverte à `anon`**.

## 2. Ce qui reste absent, et pourquoi c'est bloquant pour une base neuve

| Élément | État |
|---|---|
| Les 40 vues `public` | ✅ versionnées maintenant |
| Les schémas `saas_ugc` et `ugc_private` | ❌ jamais créés par une migration |
| 32 tables de `saas_ugc` | ❌ jamais créées par une migration (dont `ugc_workspaces`, `ugc_wallets`, `ugc_credit_ledger`, `ugc_generation_jobs`) |
| Leurs contraintes, index, déclencheurs | ❌ absents |
| Leurs politiques RLS (écrites en production) | ❌ absentes |
| Les fonctions de `ugc_private` (`has_role`, `can_edit_workspace`…) | ❌ absentes |
| Le contenu de référence (`ugc_plans`, `ugc_service_catalog`, `ugc_country_pricing`) | ❌ absent |

Autrement dit : **ce dépôt ne peut pas reconstruire la base.** Il versionne 111
fichiers de migration, mais ils s'appuient sur un socle — schémas, tables de base,
fonctions d'aide, données de référence — qui n'a jamais été capturé. Les migrations
du dépôt *étendent* ce socle ; elles ne le créent pas.

C'est aussi la raison pour laquelle le frontend interroge `public.ugc_workspaces`
alors que les fichiers SQL, eux, écrivent `saas_ugc.ugc_workspaces` : la couche de
vues est le seul pont, et elle était invisible.

## 3. Les deux scénarios possibles

### Scénario A — le nouveau Netlify pointe sur le projet Supabase actuel (recommandé)

C'est le cas le plus probable, et **il ne demande aucun travail de reconstruction**.
Le site change d'hébergement, pas de backend. Il faut alors :

1. autoriser la nouvelle origine dans les listes CORS (par secret, sans toucher au
   code — voir `docs/NETLIFY_ENVIRONMENT_CHECKLIST.md` §3.5) ;
2. mettre à jour `site_url` et `uri_allow_list` dans Supabase Auth (procédure
   exacte dans `docs/NETLIFY_DEPLOYMENT_CHECKLIST.md` étape 7) ;
3. rejouer le harnais `scripts/verify-authenticated.mjs` contre le nouveau domaine.

Le trou décrit en §2 ne bloque **rien** dans ce scénario : il porte sur une
reconstruction, pas sur un fonctionnement.

### Scénario B — un projet Supabase neuf

Il faut alors capturer le socle avant de pouvoir le rejouer. Procédure :

```bash
# 1. Vidage du schéma complet, données de référence comprises.
pg_dump "$SUPABASE_DB_URL" \
  --schema=saas_ugc --schema=ugc_private --schema=public \
  --schema-only --no-owner --no-privileges > supabase/baseline/01_schemas.sql

# 2. Politiques RLS (pg_dump les inclut, mais on vérifie explicitement).
psql "$SUPABASE_DB_URL" -c "\
  select schemaname, tablename, policyname, cmd, roles::text \
  from pg_policies where schemaname in ('saas_ugc','public') order by 1,2,3;" \
  > supabase/baseline/02_policies.txt

# 3. Données de référence uniquement (jamais les données clients).
pg_dump "$SUPABASE_DB_URL" --schema=saas_ugc --data-only \
  --table=saas_ugc.ugc_plans --table=saas_ugc.ugc_service_catalog \
  --table=saas_ugc.ugc_country_pricing --table=saas_ugc.ugc_video_models \
  --table=saas_ugc.ugc_prompt_templates \
  --no-owner > supabase/baseline/03_reference_data.sql

# 4. Rejouer sur le projet neuf, dans cet ordre : 01, 02, 03, puis les migrations.
```

**Cette opération exige une autorisation explicite** : elle lit la base de
production et produit un fichier qui contient la structure complète, donc des
informations sensibles sur l'architecture. Elle ne modifie rien, mais elle ne se
lance pas sans ton accord. Je ne l'ai pas exécutée.

## 4. Mises à jour Supabase liées à la bascule

Ces actions se font dans le tableau de bord (ou par le connecteur Supabase), pas
dans une migration :

1. **Auth → URL Configuration** : `site_url` = nouvelle adresse ; `uri_allow_list`
   = **la liste complète** (l'API remplace la valeur, elle ne l'ajoute pas), avec
   `/auth/callback` pour chaque domaine encore actif pendant la transition.
2. **Edge Functions → Secrets** : ajouter la nouvelle origine aux quatre variables
   CORS (`BUSINESS_GROW_ALLOWED_ORIGINS`, `VYORA_PAYMENTS_ALLOWED_ORIGINS`,
   `VYORA_ALLOWED_ORIGINS`, `STORE_IMPORT_ALLOWED_ORIGINS`). L'audit
   `npm run audit:origins` liste précisément lesquelles sont concernées.
3. **Email templates** : vérifier qu'aucun lien de confirmation ou de
   réinitialisation ne pointe en dur vers l'ancien domaine. Le gabarit utilise
   `{{ .ConfirmationURL }}`, qui suit `site_url` — donc rien à changer si c'est
   bien le cas (à revérifier au moment de la bascule).

## 5. Studio — statut lot16/17

Les migrations `lot16`/`lot17` (`studio_runtime_quotas`, `studio_runtime_plan_matrix`,
`studio_set_plan_quota`, `studio_runtime_prepare*`, `studio_runtime_readiness`)
**ne sont pas appliquées** en production. Conséquence mesurée : l'action `quotas`
du Studio répond `409 SUBSCRIPTION_REQUIRED`, le reste du Studio fonctionne.

La procédure de résolution est en `docs/NETLIFY_DEPLOYMENT_CHECKLIST.md` étape 8.
Elle n'est pas exécutée : elle modifie le comportement de facturation, donc elle
exige une autorisation.

## 6. Ce qu'il ne faut pas conclure de ce document

- Rien ici ne dit que le backend est cassé : en production, les 33 Edge Functions,
  les 23 tables interrogées et les 94 RPC utilisées répondent.
- Rien ici ne dit que le dépôt est inutile : il versionne correctement tout ce qui
  a été écrit depuis le 8 novembre 2026.
- Ce document dit une chose précise : **le socle d'avant le 8 novembre 2026 n'a
  jamais été versionné**, il n'existe que dans la base actuelle. Un projet neuf
  exige de le capturer d'abord (§3, scénario B), avec autorisation.
