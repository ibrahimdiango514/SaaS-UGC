# Incrément 03 — projet principal, état et limites vérifiées

Ce rapport remplace l'état provisoire antérieur. Le projet `xbuuhfwobrafcbgtdgjx` est utilisé directement ; aucun deuxième projet, reset ou rejeu global des migrations historiques. Les relevés datés du 20 novembre 2026 ci-dessous utilisent les horodatages observés côté infrastructure.

## Production : base et catalogue MuAPI

Quatre migrations additives appliquées et enregistrées par Supabase :

- `20261120010940_studio_universal_catalog` : registre privé, synchronisations, changements et RPC de synchronisation.
- `20261120011030_studio_muapi_model_details` : fiches et RPC de sauvegarde.
- `20261120012718_studio_catalog_admin_summary` : agrégats sans prix, garde administrateur.
- `20261120013110_studio_detail_history` : événements privés prospectifs pour les vérifications et changements de fiches/schémas.

Les tables privées ont RLS active et aucun SELECT client anon/authenticated ; les RPC d'écriture sont réservées au rôle service. La RPC d'agrégats est accessible au rôle authenticated mais contrôle elle-même l'administrateur ; un appel sans identité a bien retourné `not_authenticated`. Un vrai admin et un utilisateur authentifié non-admin n'ont pas été testés.

Une requête publique MuAPI a retourné HTTP 200, 861 identifiants uniques et 13 catégories ; import effectif par l'opérateur SQL via `studio_sync_muapi_catalog`, synchronisation `5c7bf534-40c7-4776-908e-05139b4c06d2` : **861 ajoutés, 0 changé, 0 absent**. Les **861 fiches et schémas** ont été enregistrés via `studio_save_muapi_detail` : 854 réponses initiales HTTP 200, puis sept relances réussies après erreurs DNS temporaires. Tous les 415 identifiants vidéo historiques correspondent ; les 446 autres références ne sont pas ajoutées au registre vidéo historique. Les données existantes ne sont pas supprimées.

| Catégorie | Nombre |
|---|---:|
| image → vidéo | 205 |
| texte → texte | 168 |
| texte → vidéo | 121 |
| vidéo → vidéo | 92 |
| image → image | 91 |
| texte → image | 85 |
| texte → audio | 27 |
| LoRA | 17 |
| autre | 16 |
| audio → vidéo | 16 |
| entraînement | 13 |
| image → 3D | 7 |
| texte → 3D | 3 |

Les 861 références restent `catalog_only`, `account_access=unverified`, `studio_enabled=false`. Le catalogue public ne prouve ni l'accès du compte ni une intégration. Les 861 événements initiaux de catalogue sont présents. L'historique des fiches est **prospectif** : après sa création, `creatify-lipsync` a été rafraîchi et un événement `detail_checked` HTTP 200 confirmé ; les 861 fiches importées précédemment ne sont pas rétroactivement historisées.

`universal-catalog` est `ACTIVE` v1 avec JWT obligatoire, bundle SHA-256 `6ebc30317a4bec857903d945971422817a51fbd0cfc41e242dc711f15f25d850`. Les appels sans JWT et avec JWT invalide retournent 401. **L'import a utilisé la RPC opérateur, pas une action Edge admin** ; aucun test E2E admin/non-admin réel. L'interface admin de lecture/synchronisation est locale, testée par mocks et non déployée. Aucun cron universel ajouté. La réponse publique annonçait le total observé et aucun `next`, ce qui ne prouve pas qu'il n'y ait jamais d'omission silencieuse côté fournisseur. Le code garde des plafonds de 50 000 modèles et 1 000 pages et des contrôles d'incomplétude partiels : à revoir avant d'automatiser les synchronisations, sans prétendre satisfaire l'absence de limite arbitraire.

## P0 : risques encore ouverts

- `video-quote` v11 et `reelora-video` en production exposent des coûts ou tarifs fournisseur ; `vyora-ai` peut aussi en exposer. L'audit global n'est pas exhaustif. Filtrage local et tests existent, mais **aucun correctif P0 n'est déployé**. L'ancien frontend utilise notamment `quote.billing_units.length` ; retirer isolément ces champs du backend peut casser l'interface ou afficher zéro. Une livraison coordonnée et un plan de compatibilité/rollback sont nécessaires.
- La RPC d'idempotence en production a un défaut lors de la première réservation et réautorise des clés terminées/expirées. Correctif local fail-closed et budget préparés mais non appliqués : la sémantique des appelants historiques et les sept leases observées, dont une en cours lors de l'audit, doivent être prises en compte. Les chemins historiques ne sont pas tous couverts.
- Comparaison statique des 415 vidéos : 239 avec champs requis `{prompt,image_url}`, 86 avec champs additionnels connus du backend, 87 avec au moins un champ requis non reconnu, et 3 coming soon. Cinq divergences de noms de champs entre registre historique et schémas publics : `gemini-omni-flash-1-1-image-to-video`, `kling-4.0-flash-keyframe-to-video` et `kling-4.0-keyframe-to-video` (`first_frame_url` contre `image_url`) ; `gemini-omni-image-to-video` (`image_urls` contre `images_list`) ; `seedance-2-video-edit` (`video_urls` contre `videos_list`). Analyse statique, pas une preuve d'exécution.
- Les jobs, tentatives et assets vidéo étaient vides lors de l'audit : aucun E2E vidéo prouvé. Grow, auth, paiements et fonctions historiques n'ont pas été redéployés pour ce travail.

## Fournisseurs : découverte gratuite et risques du cron historique

La nouvelle fonction isolée `vyora-provider-discovery` est déployée `ACTIVE` v1, JWT de passerelle désactivé mais jeton interne Vault vérifié en temps constant par le code, avec refus si absent ou invalide. Le jeton préexistant de santé fournisseur est réutilisé : ce choix élargit son périmètre d'autorisation et mérite un jeton dédié avant une exploitation pérenne. Test réel : sans jeton 401, jeton invalide 403, jeton interne valide 200. La fonction ne fait que des GET de catalogue sur une liste d'URL fixes, sans redirection et sans écrire dans le registre ni renvoyer prix ou secrets. L'appel interne par `pg_net` peut conserver temporairement ses en-têtes dans les files techniques selon la rétention de l'extension ; leur accès doit rester privilégié. Aucun cron de découverte ajouté.

Résultats d'un seul appel réel en lecture seule, **première page seulement, complétude non vérifiée** : MuAPI public 861 ; Groq 11 ; Gemini 50 ; Gonka 4 ; LLM7 86 ; Ollama 24 ; OpenRouter 442 ; tous HTTP 200. Cloudflare non configuré pour cet appel car identifiant de compte absent. Ces résultats ne prouvent ni génération, ni tarification, ni accès à tous les modèles, ni santé effective du Studio. Ollama et OpenRouter restent désactivés/dégradés dans le registre Business malgré l'accès GET ; on ne change pas leur activation sur cette seule preuve. Gemini, Groq, Gonka et LLM7 y étaient activés/available ; Anthropic, DeepSeek, Grok, Kilo, Mistral et OpenAI désactivés/non vérifiés. Certains indicateurs de configuration Gonka/LLM7 divergent des anciennes sondes ; investigation nécessaire.

Attention : le cron Business préexistant exécute `vyora_ai_providers_dispatch(false)`. L'ancienne sonde peut modifier activation/statut des fournisseurs et synchroniser des modèles via une RPC qui marque les modèles absents avant insertion ; son code limite la liste transmise à 400. Ce cron n'a pas été déclenché ni modifié. En local, le mode `catalog_only` ne modifie plus le registre et le mode historique refuse une synchronisation explicitement tronquée à plus de 400 modèles ; cela ne prouve pas la complétude des listes de moins de 400. Correctif non déployé, avec tests de non-mutation et artefact régénéré. Il ne faut pas remplacer le cron ou le bundle existant sans tester ses dépendances et son rollback.

Un adaptateur protocole natif Anthropic isolé existe localement et a été testé avec mocks uniquement ; il n'est ni enregistré, ni déployé, ni vérifié contre une API. Les adaptateurs OpenAI-compatible, Gemini et Cloudflare existants et le registre Business ne démontrent pas l'intégration opérationnelle de chaque fournisseur ni de chaque parcours Studio. Le bundle Grow épinglé n'a pas été modifié.

## Tests et vérifications

- Suite locale complète : **3 145 tests réussis dans 185 fichiers**. Les tests avec mocks ne remplacent pas les parcours réels.
- `npm run typecheck`, `npm run typecheck:edge`, `npm run check:edge-imports`, `npm run build`, `git diff --check` : réussis après les dernières corrections.
- Tests de migrations additifs sur PGlite éphémère et vérifications de permissions, triggers et santé base/Auth/REST en production. Les journaux Edge ne sont pas accessibles avec les outils disponibles.
- Tests de découverte : refus sans jeton/avec jeton invalide et appel interne réel ; résultats ci-dessus. Aucun test de génération payante, débit client ou achat fournisseur effectué. Les GET, fonctions et ressources Supabase peuvent néanmoins avoir un coût d'infrastructure ou de trafic selon les contrats ; aucun montant exact n'est établi.

## Suite prioritaire

1. Traiter la fuite P0 par livraison coordonnée frontend/backend, inventaire des consommateurs, tests auth et stratégie rollback ; vérifier aussi les autres endpoints.
2. Tester et déployer progressivement idempotence et budget sans casser les reprises historiques ; inspecter les leases au moment du changement.
3. Renforcer pagination, preuve de complétude et suppression des plafonds arbitraires avant synchronisations automatiques ; tester l'Edge avec vrais comptes admin/non-admin.
4. Implémenter le moteur universel complet (validation, mapping, devis en crédits, réservation, jobs/polling/webhooks, stockage privé, retries et remboursements) et raccorder les modalités effectivement supportées au Studio. Le validateur local est partiel et non raccordé à la génération.
5. Vérifier fournisseurs, adaptateurs et modèles un par un, avec des niveaux distincts configuration / catalogue / accès réel / intégration / E2E. Aucune référence importée ne doit être présentée comme utilisable avant validation réelle et autorisation de test payant si nécessaire.
