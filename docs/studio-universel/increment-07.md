# Increment 07 — runtime universel, développement non publié

20 novembre 2026. Branche `arena/7260129f-saas-ugc`.

## Réalisé dans le dépôt

- Runtime indépendant des 415 vidéos historiques : consultation paginée, projection client sans coûts internes, devis, réservation, soumission unique, statut, historique.
- Migration locale avec tables privées/RLS, RPC client/admin/service explicitement séparées, réservation wallet existant, capture/release idempotents, budget journalier, trois tâches simultanées par client, rate limit devis, schéma/prix versionnés.
- Une soumission ambiguë ne provoque jamais une nouvelle soumission automatique. Elle reste `uncertain`, avec réservation conservée, pour réconciliation administrative.
- Studio `/app/studio/universel`, catégories/recherche/pagination/formulaire partagé, import privé, prix crédits puis confirmation explicite, historique.
- Configuration admin par modèle : crédits, coût plafond privé, abonnement, quota, sortie, activation et coupe-circuit global. L’attestation facturée n’est pas exposée au navigateur.
- Téléchargement des résultats avec DNS public vérifié et connexion TLS épinglée, plafond 50 Mio, redirections revérifiées, détection de signatures. Transport binaire isolé : aucun changement des artefacts historiques store-import.
- Entrées utilisateur limitées aux objets `studio-inputs` du workspace autorisé ; contrôle taille et signature côté serveur, URLs signées temporaires. Les ZIP ne sont jamais décompressés.

## Preuves locales

- TypeScript frontend et Edge passent ; vérification imports Edge passe ; build frontend passe.
- Suite complète : **194 fichiers, 3189 tests réussis** après correction du mock admin et récupération du commit des artefacts historiques épinglés.
- Test PGlite : migration appliquée sur schéma simulé, isolation utilisateur, activation sans attestation refusée, réservation/rejeu/capture/refund sans doublon, quote invalidée si schéma changé.
- Aucun appel payant, aucune génération, aucun débit réel. Les attestations du test sont exclusivement dans la base PGlite éphémère.

## Non terminé — ne pas publier comme intégration complète

- Migration **non appliquée** sur le principal ; Edge runtime **non déployée** ; frontend **non publié** pour cet incrément. Aucun modèle activé.
- Protocole prédictions actuellement strict et limité ; chaque famille de sorties/entrée exige ses preuves officielles, pas une extrapolation depuis le nom. Aucun résultat distant réel validé.
- Endpoint d’estimation obligatoire dans la configuration serveur `estimate_path`, absent par défaut et non modifiable par le navigateur. Ne pas le déduire du nom. Collecte de preuve officielle/attestation et invalidation lors de modification de cet endpoint à compléter.
- Les catégories sans politique de quota explicite sont bloquées ; audio/voix/autres nécessitent une politique dédiée, pas un quota arbitraire.
- Conditions de schémas non prises en charge toujours bloquées ; pas de couverture complète annoncée des 861 modèles.
- Réconciliation administrative des soumissions incertaines, expiration/mise en attente des traitements trop longs, preuve de coût réel et réservation dépenses partagée avec les autres moteurs à finir.
- Concurrence des quotas avec les anciens clients/moteurs à vérifier au niveau global, pas seulement entre tâches universelles.
- Vérification d’appartenance Storage, traitement sécurisé et conformité réelle des conteneurs média à approfondir (signature seule ne prouve pas un média décodable).
- Actions worker pour polling/sync/détails présentes mais ordonnanceur cron **non installé**, contrats RPC et permissions à vérifier contre la base réelle. Rapport sync RPC non encore affiché dans UI dédiée.
- Publication immutable Edge/loader, tests handler d’intégration simulés complets, tests UI Studio, permissions réelles admin/client, procédure PR/CI/main/Netlify et sondes production restent à réaliser.

Ce document distingue code local testé et production. Il ne prouve ni compatibilité universelle ni parcours payant opérationnel.
