# Incrément 06 — endpoints officiels et validation exécutable (sans génération)

## Modifications

- Résolveur d'endpoint commun au serveur et à l'administration : lit la déclaration
  officielle, conserve les 46 différences ID/endpoint, accepte les chemins à plusieurs
  segments et les versions avec points. Aucun remplacement global d'ID, aucun endpoint
  inventé. Bloque traversées, URL étrangères, escapes, query strings et contradictions.
- Les sept endpoints absents du schéma imbriqué sont présents dans **les champs
  de premier niveau des fiches officielles**, confirmés par sept GET HTTP 200 le
  2026-11-20. `endpoint_url` vaut l'ID exact et `endpoint` vaut `/api/v1/` suivi
  de cet ID pour :
  `minimax-h3-open-reference-to-video`, `qwen-image-text-to-image-2512-lora`,
  `qwen-image-text-to-image-lora`, `qwen3-image-to-image`, `qwen3-pro-image-to-image`,
  `qwen3-pro-text-to-image`, `qwen3-text-to-image`.
  Les requêtes pg_net de preuve sont 17818 à 17824 (cache technique temporaire).
- Migration additive : conserve ces sept déclarations dans `endpoint_evidence`,
  avec URL source, date et HTTP. Le RPC admin retourne l'évidence avec les gardes
  existantes. Les synchronisations futures conservent aussi les déclarations de
  premier niveau ; le schéma brut reste séparé des métadonnées VYORA.
- Formulaire dans la fiche admin : paramètres typés, enums, booléens, tableaux
  JSON, valeurs par défaut, ordre fournisseur, types `int`/`float`/`text`, bornes,
  longueurs, pas numérique et médias HTTPS. Validation locale puis serveur.
- Action `validate_muapi_input` : lit le schéma stocké avec le JWT admin,
  ignore tout schéma/prix soumis, refuse les fiches non vérifiées, limite le corps
  et ne renvoie pas les prompts/médias. Ne contacte aucun fournisseur.
- Les contraintes conditionnelles, sources de choix externes et mots-clés inconnus
  bloquent tout le formulaire au lieu d'être silencieusement ignorés.
- Publication Edge préparée par artefact adressé par contenu, sans écrasement
  d'artefact précédent. Générateur contrôlé en CI et test de parité.

## Preuves et limites

- Avant migration, base production : 861 modèles, 854 chemins de schéma valides
  selon le résolveur, 46 différences ID/chemin, 0 activé Studio.
- 3182 tests / 192 fichiers réussis localement, build et typechecks frontend/Edge,
  contrôle imports ; après prise en charge des points dans les versions, 20 tests
  endpoints/parité rejoués et réussis. La CI rejoue la suite sur le commit livré.
- PGlite : migration appliquée, preuves lisibles seulement après garde admin,
  sauvegarde refusée sans service_role, isolation de l'évidence et du schéma,
  aucun modèle activé, aucune permission de lecture directe accordée aux clients.
- Tests HTTP simulés : rejet non-admin avant lecture de fiche, schéma serveur
  faisant autorité, refus type erroné, corps trop grand et fiche non vérifiée,
  aucune requête fournisseur. Tests React : valeurs typées et contraintes inconnues.

Ce formulaire **exécute une validation, pas une génération**. Il est réservé à
l'administration. L'upload privé, les contraintes multimédias exprimées seulement
par du texte, les choix distants/conditions, le routage d'exécution, la tarification,
la réservation/capture/remboursement et les résultats/polling universels restent à
raccorder. Les URL ne sont pas téléchargées : leur type MIME, taille, DNS et contenu
ne sont pas vérifiés ici. Le futur moteur devra les contrôler avant tout appel.
Aucun modèle universel n'est marqué intégré, opérationnel ou activé par cet incrément.
Les 415 modèles vidéo historiques ne sont pas modifiés. Aucun appel payant ni débit.

## Déploiement

Au moment de la préparation de cette note : non déployé. La PR doit passer la CI,
être fusionnée selon les protections, puis la migration et le chargeur doivent être
publiés. Les preuves et versions finales seront consignées dans la PR. Aucun secret
supplémentaire n'est requis pour cette validation sans fournisseur. Des sessions
admin/utilisateur réelles restent nécessaires pour le parcours authentifié E2E.
