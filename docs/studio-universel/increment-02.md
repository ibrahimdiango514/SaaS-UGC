> **Archive historique.** La directive d’isolation a été remplacée : voir `increment-03.md` pour l’état et les opérations sur le projet principal.

# Incrément 02 — état partiel, non déployé

## Environnement et sécurité

Le connecteur ne montre qu'un projet : `ibrahimdiango514's Project` (`xbuuhfwobrafcbgtdgjx`), considéré comme production. Aucun projet de développement isolé n'est disponible. Le connecteur impose un mot de passe dans les arguments `create_project` ; il n'offre pas ici de moyen de générer/acheminer ce mot de passe confidentiellement hors de la conversation. Aucun jeton de gestion Supabase n'est disponible au processus local, Docker et la CLI Supabase ne sont pas installés. Aucun projet n'a été créé. Créer un projet depuis le tableau de bord Supabase, puis le rendre accessible au connecteur, sans transmettre de mot de passe dans le chat. Ne pas copier de secrets de production dans ce projet ; configurer séparément les accès de test selon le besoin.

Sept migrations historiques ont été détectées par `node scripts/check-isolated-migrations.mjs` comme contenant des références de production, des crons ou des appels réseau. Le script inspecte uniquement les fichiers ; son code de sortie 1 est volontaire. En particulier, quatre migrations contiennent directement le ref de production. Un `supabase db push` brut sur un nouvel environnement serait dangereux : il faut adapter et vérifier les migrations, et désactiver/contrôler les tâches planifiées avant leur application. La configuration frontend exemple contient aussi l'URL de production ; ne pas l'utiliser telle quelle pour un test isolé.

Les seules opérations Supabase de ce tour sont des lectures (liste de projets, organisations, branches, fonctions et réponses HTTP précédemment enregistrées). Aucune écriture, modification de production, déploiement, génération ou dépense fournisseur n'a été réalisée.

## Inventaire Edge Functions

18 entrées `index.ts` sont présentes localement ; **aucune n'a été déployée dans un environnement isolé**, celui-ci n'existant pas encore :

- Studio et IA : `reelora-ai`, `vyora-ai`, `reelora-video`, `reelora-video-worker`, `video-quote`, `universal-catalog`, `vyora-ai-providers`, `vyora-provider-health`, `reelora-health`.
- Business et accès : `business-grow`, `reelora-owner-bootstrap`.
- MCP et commerce : `mcp-client`, `vyora-mcp`, `store-connect`, `store-import`.
- Paiements : `vyora-payments`, `vyora-payments-reconcile`, `vyora-saspay-webhook`.

La production possède en outre des fonctions sans entrée correspondante dans ce dépôt : `saspay-reconcile`, `saspay-checkout`, `saspay-webhook`, `saspay-verify`, `provision-platform-agency`, `create-platform-agency`, `create-agency-member-v2`, `redeem-agency-invitation-v2`, `invite-agency-member`, `reset-agent-password-v2`, `vyora-bg-seed`, `vyora-oauth`, `dashboard-assistant`, `platform-dashboard-summary`. Leur statut d'obsolescence ou de nécessité n'est pas établi. Ne pas les supprimer ni les déployer à l'aveugle. Les réglages JWT des webhooks et callbacks doivent être vérifiés fonction par fonction ; plusieurs reposent sur une authentification spécifique plutôt que sur un JWT de passerelle.

## Code ajouté ou corrigé

- `universal-catalog/details.ts` et `index.ts` : action administrateur de récupération de fiches publiques par lots bornés, uniquement pour des modèles déjà enregistrés, GET seulement, trois requêtes simultanées au maximum, contrôle des identifiants, refus des redirections, catégorisation des échecs et conservation de l'ancien schéma en cas d'échec. Cette action ne prouve ni l'accès compte ni la compatibilité d'un adaptateur.
- Migration `20261124090000_studio_muapi_model_details.sql` : état privé de collecte et RPC service-role de sélection/sauvegarde. Testée localement sur PGlite, non appliquée à Supabase.
- `universal-catalog/schema.ts` : validation défensive d'un sous-ensemble des schémas (champs déclarés et requis, types scalaires et tableaux simples, enums et limites), refus des constructions non prises en charge. **Non raccordée à la génération** et non présentée comme un validateur complet JSON Schema.
- `_shared/ai-core/router.ts` : un tarif inconnu n'est plus considéré comme gratuit lorsque le budget est épuisé.
- `_shared/ai-core/engine.ts`, `vyora-ai/index.ts` et `vyora-ai-providers/index.ts` : lorsqu'une clé d'idempotence est demandée, absence ou échec du verrou interdit l'appel fournisseur ; refus des rejoués quel que soit leur statut ; pas de repli historique en cas d'échec du routage explicite. Les appels historiques sans routage explicite ne sont pas encore tous raccordés au registre.
- Migration `20261124100000_ai_call_idempotency_fail_closed.sql` : corrige le claim initial et empêche de réexécuter automatiquement une clé déjà utilisée, même après expiration ; récupération manuelle des cas incertains à concevoir. Testée localement sur PGlite, non appliquée à Supabase.
- `vyora-ai/index.ts` : suppression du coût fournisseur dans la réponse client `complete` et remplacement des erreurs brutes par un message générique côté client. Le coût reste disponible au service interne ; pas d'affirmation d'audit exhaustif de tous les parcours du SaaS.
- Bundles et chargeurs `vyora-ai` / `vyora-ai-providers` régénérés avec deux nouvelles migrations de publication d'artefact, sans modifier les migrations historiques. Non déployés.

## Catalogue et fournisseurs : chiffres vérifiables

La réponse publique précédemment récupérée annonce 861 références uniques : image→vidéo 205 ; texte→texte 168 ; texte→vidéo 121 ; vidéo→vidéo 92 ; image→image 91 ; texte→image 85 ; texte→audio 27 ; LoRA 17 ; autre 16 ; audio→vidéo 16 ; entraînement 13 ; image→3D 7 ; texte→3D 3. Ces catégories proviennent de la réponse observée, pas d'un nouvel import.

Sur les 861 fiches publiques auparavant demandées, 854 avaient répondu HTTP 200 et 7 avaient expiré. Une lecture de ces réponses conservées montre que les 854 fiches réussies ont la structure `input_schema.schemas.input_data` attendue par le chargeur ; cela ne prouve pas que tous leurs paramètres sont validables ni que leurs adaptateurs existent.

- Projet isolé : aucun ; modèles réels importés dans son registre : **0**.
- Schémas intégrés dans le registre isolé : **0** ; nouveau validateur testé sur schémas synthétiques ; une fiche MuAPI représentative testée par mock.
- Adaptateurs universels nouvellement raccordés aux 861 modèles : **0** ; modèles réellement validés E2E : **0**.
- Fournisseurs configurés/vérifiés dans un projet isolé : **0**. Le cœur LLM préexistant possède des gabarits OpenAI-compatible, Gemini et Cloudflare, ainsi que les intégrations vidéo historiques ; leur présence dans le code n'établit ni credentials ni fonctionnement dans le futur projet. Anthropic et les autres protocoles non couverts ne sont pas présentés comme intégrés.
- Le test catalogue à 861 entrées de l'incrément 01 utilise des données synthétiques et ne représente pas 861 modèles réels testés.

## Tests

- `npm run build`, `npm run typecheck:edge`, `npm run check:edge-imports` et parité des chargeurs IA : réussis. Le build inclut le contrôle TypeScript frontend.
- Suite globale : 3 132 réussis, 2 échecs dans `store-import-artifact.test.ts` car les artefacts store-import/store-connect ne sont pas présents au commit épinglé par les tests.
- Tests isolés de migrations sur PGlite avec rôles et schémas simulés : collecte des détails, conservation sur échec, restrictions d'accès et verrou d'idempotence réussis. Ils ne remplacent pas les tests Supabase/RLS réels.
- Aucune génération payante réelle, aucun test E2E réel ni débit fournisseur.

## Non terminé et prochaine étape

Il manque l'environnement isolé, la neutralisation des migrations historiques, le déploiement/vérification de chaque fonction, l'import réel des 861 modèles et de leurs fiches, le registre multi-fournisseurs unifié, le moteur multimodal, la gestion générique des jobs et le raccordement Studio. Les corrections locales de confidentialité et de budget ne protègent pas la production avant déploiement approuvé séparément.

Après création et connexion d'un projet Supabase de test isolé : vérifier son identité, préparer et tester les migrations sans URL/crons production, configurer Auth et secrets de test séparés, déployer progressivement, exécuter la synchronisation publique réelle et réconcilier les IDs, puis avancer par adaptateur avec mocks et sans lancer de génération payante.
