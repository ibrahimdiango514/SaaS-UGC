# Incrément 04 — état partiel vérifié

## Résultat et portée

Cet incrément n'est pas terminé. En production sur `xbuuhfwobrafcbgtdgjx`, le registre contient toujours 861 modèles publics MuAPI et 861 fiches ; aucun n'a `studio_enabled=true`, `account_access=available`, `integration_status=integrated` ou `e2e_verified`. Ne pas confondre ces statuts avec les 415 modèles vidéo du parcours historique : ceux-ci restent intacts, 412 ont leurs indicateurs historiques `active` et `is_enabled` vrais et `is_coming_soon` faux ; ce décompte ne prouve pas leur disponibilité ou un E2E. Le nombre effectivement affiché dans le Studio déployé n'a pas été mesuré avec une session réelle.

Une migration additive `20261120015111_studio_catalog_admin_read` a été appliquée : `studio_catalog_admin_models` fournit recherche, filtres et pagination par curseur ; `studio_catalog_admin_model_detail` lit une fiche, ses schémas et 20 changements récents au maximum. Les deux RPC vérifient l'administrateur existant, `search_path` vide, EXECUTE révoqué pour `anon` et accordé à `authenticated` avec garde interne. La pagination à 50 éléments est une taille de page, pas un plafonnement de la totalité du catalogue. Aucun statut, tarif, crédit ou modèle n'est modifié par ces RPC. La réponse de la fiche n'invente pas de coûts, marges, preuves de test ou accès.

Avant migration : rôles, RLS sans politiques client des cinq tables privées, triggers, 11 crons actifs, colonnes et absence de conflit de nom vérifiés ; aucun cron ou fonction historique remplacé. Après migration : version confirmée dans l'historique, EXECUTE et `security definer` vérifiés, refus sans identité `not_authenticated`, appel REST anonyme HTTP 401, compte de 861 modèles et 861 schémas conservé, 0 activé, santé DB/Auth/REST verte. Journaux Edge non fournis par le connecteur. Aucun JWT administrateur ou utilisateur non-admin réel n'était disponible : le succès admin, l'échec non-admin authentifié et le parcours navigateur de production n'ont pas été établis.

Une interface locale `UniversalCatalogBrowser` exploite ces RPC : pages, recherche, filtres de catégorie/statut, détail, schémas, aperçu **en lecture seule** des champs déclarés et 20 événements récents. Elle ne contient pas de bouton d'activation factice. Elle ne constitue pas un formulaire de génération ni une administration complète des tarifs. L'espace admin local conserve l'ancien catalogue vidéo en parallèle. **Frontend non déployé** : le dépôt indique une garde de production Netlify limitée à la branche `main` et une autre voie Cloudflare manuelle ; l'intégration GitHub ne permet pas ici de lister les secrets Actions (403). Aucun contournement ni publication sur un autre site ou une autre branche. La disponibilité de la page locale dans l'application de production n'est donc pas revendiquée.

## Fiches et endpoints

Les 861 schémas comprennent un schéma de sortie dans `schemas.output_data` ou `output_schema`. Dans `schemas.input_data`, 854 fiches déclarent `endpoint_url` : 808 égalent l'ID catalogue, 46 sont différents, et 7 sont absents. Un endpoint déclaré par le fournisseur n'est ni la preuve d'un endpoint complet utilisable, ni la preuve que le compte y a accès ; aucun appel de génération n'a validé ces mappings. Les sept absents sont : `minimax-h3-open-reference-to-video`, `qwen-image-text-to-image-2512-lora`, `qwen-image-text-to-image-lora`, `qwen3-image-to-image`, `qwen3-pro-image-to-image`, `qwen3-pro-text-to-image`, `qwen3-text-to-image`. Le validateur local est partiel et non raccordé au moteur de génération ; des champs réels comprennent `field`, `step`, `format` et des contraintes conditionnelles qui nécessitent une implémentation sûre avant activation.

## État des fournisseurs

`vyora-provider-discovery` v2 a été déployée : ajout d'un GET du catalogue MuAPI avec `MUAPI_API_KEY`, sans génération, écriture de registre ni retour de clés ou prix. Refus jeton invalide HTTP 403, appel interne valide HTTP 200 ; le jeton de santé existant reste partagé et doit idéalement être remplacé par un jeton dédié. Les en-têtes de l'appel interne `pg_net` peuvent persister temporairement dans les files techniques privilégiées. La réponse MuAPI avec clé contient 861 modèles sur sa première page, comme la réponse publique ; cette route est aussi publique et le résultat ne prouve pas que la clé est valide ni l'autorisation de générer chacun des modèles. Les autres premières pages accessibles par GET : Groq 11, Gemini 50, Gonka 4, LLM7 86, Ollama 24, OpenRouter 442. Complétude inconnue.

Les statuts suivants sont ceux observés dans le registre Business ou les sondes de lecture, sans nouveau test de génération :

| Fournisseur | Diagnostic | Ce qui manque ou reste à faire |
|---|---|---|
| MuAPI | Secret présent ; GET public et GET avec clé 200, 861 chacun | Aucun secret supplémentaire identifié ; accès par modèle, devis et intégration à vérifier. |
| Groq / Gemini | Secrets présents ; GET 200 ; registre Business activé/available | Rien à fournir sur les preuves actuelles ; pas de nouvelle génération E2E. |
| Gonka / LLM7 | Secrets présents ; GET 200 ; registre Business activé/available | Rien à fournir sur les preuves actuelles ; divergence avec l'indicateur `ai_provider_configs` marqué missing. |
| OpenRouter | Secret présent, GET 200 ; registre désactivé/degraded, ancien `AI_EMPTY_RESPONSE` | Aucun remplacement de clé justifié par les preuves ; diagnostiquer modèle, réponse et routage. |
| Ollama Cloud | Secret présent, GET 200 ; registre désactivé/degraded, ancien `PROVIDER_PAYMENT_REQUIRED` HTTP 402 | Vérifier l'abonnement ou le crédit du compte Ollama Cloud ; ne pas acheter. L'URL Cloud existante est `https://ollama.com/v1`. Une instance auto-hébergée alternative demanderait une URL HTTPS accessible des Edge Functions et une configuration compatible, mais n'est pas requise pour utiliser l'URL Cloud existante. |
| Cloudflare Workers AI | Token présent ; identifiant de compte absent, `PROVIDER_ACCOUNT_ID_MISSING` | `BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID` dans les secrets Supabase ; le token existant `BUSINESS_GROW_CLOUDFLARE_API_TOKEN` ne doit pas être demandé à nouveau. Ses permissions restent à vérifier. |
| Anthropic | Désactivé/non vérifié ; aucune clé Edge correspondante, protocole natif local seulement | Clé API requise si utilisation souhaitée ; convention locale `BUSINESS_GROW_ANTHROPIC_API_KEY`, mais descripteur et adaptateur natif non raccordés en production : une clé seule ne suffit pas. |
| DeepSeek | Désactivé/non vérifié ; aucune clé Edge correspondante, URL et nom de secret non renseignés dans le registre de production | Clé requise si souhaité : convention `BUSINESS_GROW_DEEPSEEK_API_KEY` (migration locale non appliquée : alias `DEEPSEEK_API_KEY`) ; configuration serveur et validation restent nécessaires. |
| xAI / Grok | Désactivé/non vérifié ; aucune clé Edge correspondante, descripteur incomplet | Clé requise si souhaité : convention `BUSINESS_GROW_GROK_API_KEY` ; l'alias `XAI_API_KEY` figure dans une migration locale non appliquée. Configuration et validation restent nécessaires. |
| Mistral | Désactivé/non vérifié ; aucune clé Edge correspondante, descripteur incomplet | Clé requise si souhaité : convention `BUSINESS_GROW_MISTRAL_API_KEY` ; alias local non appliqué `MISTRAL_API_KEY`. Configuration et validation restent nécessaires. |
| OpenAI / Kilo | Désactivés/non vérifiés ; aucune clé Edge correspondante, descripteurs incomplets | Clés requises si souhaités : conventions `BUSINESS_GROW_OPENAI_API_KEY` / `BUSINESS_GROW_KILO_API_KEY` ; endpoints, capacités et intégration restent à vérifier. |

Les conventions ci-dessus proviennent du code Business local ; les lignes de registre concernées ont `api_key_env=null`. Ne pas prétendre qu'un nom est déjà raccordé dans tous les chemins déployés. Ne jamais fournir les valeurs des secrets dans le chat.

## Sécurité, prix et travail restant

Fuite P0 de coûts fournisseurs encore présente dans les anciennes fonctions `video-quote` et `reelora-video`, potentiellement `vyora-ai`. Les correctifs locaux ne sont pas déployés : l'ancien frontend dépend des champs retirés et pourrait planter ou afficher 0. Budget et idempotence locaux ne sont pas déployés ; le comportement de la RPC d'idempotence production doit être corrigé avec une stratégie compatible pour les appels et leases historiques. Ne pas activer de nouveaux modèles avant contrôle du coût, accès, permissions, réservation et remboursements. Le cron Business existant peut modifier les états et tronquer une synchronisation ; non modifié.

Aucun moteur universel multimodal complet, formulaire de génération fonctionnel, stockage/polling universel, activation admin ou preuve de génération E2E n'a été livré. Les 861 modèles ne sont donc ni visibles dans le nouveau catalogue Studio de production ni activés. Les points requis pour une génération réelle facturée sont : choisir un modèle avec schéma, endpoint, accès et devis vérifiés ; tester création, polling ou webhook, stockage privé, réservation/capture et éventuel remboursement avec un compte de test et une autorisation explicite de génération payante.

## Tests

- Suite complète locale : **3 148 tests réussis / 186 fichiers** ; build, typecheck frontend et Edge, contrôle imports et `git diff --check` réussis.
- Tests ciblés UI : navigation, pagination, filtres, aperçu des paramètres et erreurs, avec mocks. Tests découverte : GET uniquement, absence de secrets/prix, rejet du jeton invalide.
- PGlite éphémère : refus anon/non-admin simulés, refus de lecture directe, 111 modèles parcourus en trois pages sans doublon, recherche, filtre, détail et historique. La simulation ne prouve pas la politique d'un JWT réel.
- Aucune génération fournisseur, achat ou débit client exécuté ; les requêtes GET et l'infrastructure peuvent néanmoins entraîner des coûts contractuels non mesurés.
