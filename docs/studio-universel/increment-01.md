> **Archive historique.** La directive d’isolation a été remplacée : voir `increment-03.md` pour l’état et les opérations sur le projet principal.

# Studio universel — incrément 01

## Périmètre et état réel

Travail local uniquement. Aucun déploiement, aucune migration de production, aucune génération et aucun débit. La réponse publique MuAPI examinée auparavant contient 861 modèles toutes catégories ; on a confirmé en lecture seule qu'elle annonce `total: 861`, et que les 861 noms et tableaux de champs respectent les formats attendus. Le test de 861 entrées est **synthétique** : les 861 références réelles ne sont pas encore importées dans le nouveau registre. Un catalogue public ne prouve ni l'accès du compte, ni l'intégration ou une génération de bout en bout.

## Changements

- `universal-catalog/catalog.ts` : lecture GET du catalogue public complet sans filtre vidéo, contrôle du total, pagination par lien `next` explicite, limites, déduplication de copies identiques, refus de conflits et de redirections/liens externes. Aucun endpoint de génération appelé. Les prix bruts ne sont pas copiés dans les métadonnées normalisées.
- `universal-catalog/index.ts` : action manuelle `sync_muapi` derrière le contrôle administrateur existant `reelora_admin_overview`; persistance via service role après récupération complète. Pas encore d'interface admin ni de tâche automatique. Catalogue public uniquement : pas de vérification d'accès compte.
- Migration `20261123090000_studio_universal_catalog.sql` : tables privées de modèles, synchronisations et changements, RLS et permissions restrictives ; RPC transactionnelle service role. Conserve les réglages locaux et schémas détaillés déjà présents ; signale les disparitions et réapparitions sans suppression, journalise les changements et refuse une réduction suspecte supérieure à la moitié d'un catalogue existant d'au moins 20 modèles. L'état initial est `account_access=unverified`, `integration_status=catalog_only`, `studio_enabled=false`. Aucune action sur les registres Business, les crédits ou la table vidéo existante.
- `customer-quote.ts`, `reelora-video/index.ts`, `video-quote/index.ts` : réponses clients limitées à disponibilité et indication de prompt requis ; calcul du devis en crédits conservé côté serveur. Les données fournisseur restent internes. La suppression d'affichage dans `ProviderQuotePanel` protège aussi face à une ancienne réponse, mais ne remplace pas la correction serveur.
- `reelora-video.bundle.ts` et `.edge.js` régénérés localement ; `tsconfig.edge.json`, preview et tests adaptés. La fonction `video-quote` importe désormais un module partagé : il faut l'inclure au bundling de déploiement.

## Vérifications

- `npm run typecheck`, `npm run typecheck:edge`, `npm run build`, `npm run check:edge-imports` : réussis.
- Huit suites ciblées : 115 tests réussis, incluant les réponses HTTP des deux parcours de devis, un catalogue synthétique de 861 modèles, pagination, autorisation, refus des catalogues incomplets et parité du bundle.
- Migration exécutée sur PostgreSQL embarqué PGlite éphémère, avec schémas et rôles Supabase simulés : insertion, conservation des réglages et du schéma, modification, disparition, réapparition, doublon, refus d'un rôle non autorisé et de lecture directe réussis. Ce n'est pas un test d'intégration Supabase complet.
- Suite globale : 3119 réussis, 2 échecs dans `store-import-artifact.test.ts` : les artefacts store-import/store-connect sont absents du commit épinglé vérifié par ces tests. Aucun changement de ces artefacts n'a été conservé.

## Limites et suites

Le registre n'est pas encore raccordé au Studio ni au registre de fournisseurs existant. Les fiches détaillées/schémas dynamiques, accès compte, synchronisation automatique, administration, prix internes, adaptateurs multi-usages, jobs normalisés et E2E restent à réaliser. Le chargeur ne suit que des liens `next` explicites ; tout autre protocole de pagination doit être validé avant prise en charge. Le test synthétique ne démontre pas la réception réelle des 861 modèles par cette nouvelle fonction. Les chemins de devis corrigés ne constituent pas un audit exhaustif de toutes les réponses de l'application.

Avant toute mise en production : revue de sécurité et d'impact, test sur Supabase isolé, validation de la pagination réelle et du bundling, puis approbation explicite de la migration et du déploiement. La migration crée trois tables et une RPC privées sans importer de données ; une synchronisation ultérieure modifierait uniquement ce nouveau registre et ses journaux. Le code déployé actuellement conserve son comportement antérieur jusqu'au déploiement des correctifs.
