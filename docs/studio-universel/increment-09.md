# Increment09 — premier lot d’adaptateurs MuAPI déployé

## Preuves techniques et publication

PR38 fusionnée après CI44672902805 verte ; main
`89a2efe3ff9c5a5729097aeb93f1ef329314846a`.
**197 fichiers / 3207 tests** réussis localement ; CI typechecks frontend/Edge,
imports, parité des bundles, tests et build réussie.

Supabase principal uniquement. Migration `studio_family_progress` appliquée sous
la version réelle **20261120041508** ; fichier renommé vers cette version.
SQL du commit03e8d65 récupéré par pg_net17955 HTTP200 et contrôlé SHA256
`38b184c788cd5c158a08a2387a6db3193e78f6da15a0498f24130253f9297bb9` avant exécution.
Artefact SQL pg_net17956 HTTP200, SHA256
`b33e0398605ac75605564c8ccf38dc8330d04add23a9bdf936c3da1e972cef82`.
`studio-runtime` **v2 ACTIVE**, verify_jwt=false avec gardes Auth/Vault internes.
Bundle immuable `d8b59c45da9117d061d80b9f0c5bca3bd14f09d04b165b7d3bc1300c6aa997c0`,
37760 caractères / 9 tranches. Ancien artefact conservé.

## Références officielles gratuites

GET `https://api.muapi.ai/openapi.json` HTTP200 (pg_net17941). L’OpenAPI confirme :
- POST aux chemins explicitement déclarés ; retour `request_id`.
- GET `/api/v1/predictions/{id}/result` pour le suivi.
- queued/pending/processing/completed/failed/cancelled.
- Endpoint d’estimation `/api/v1/models/{name}/estimate-cost`.
- Tags de fonctionnalités, opération et schéma de requête par endpoint.

Aucun POST de génération effectué. Les schémas de résultat des fiches servent à
lier deux parseurs **distincts** : `muapi_output_envelope_v1` (`output.outputs`)
et `muapi_output_urls_v1` (`output` tableau URI). Les contrats texte copiés ou
ambigus ne sont pas interprétés comme une preuve de sortie texte.
Chaque tâche nouvelle garde son protocole en snapshot ; ancien chemin conservé.

Le worker integrations relit l’OpenAPI, vérifie l’existence de chaque POST lié,
classe par tag officiel (sinon catégorie déclarée), vérifie schéma/entrées/sorties,
exécute les tests de parseur et un contrôle négatif de validation par modèle,
puis enregistre le rapport privé. Il ne réserve ni crédits ni dépense fournisseur.
Il consulte également le catalogue avec MUAPI_API_KEY via GET uniquement :
**visibilité authentifiée n’est jamais transformée en accès de génération confirmé**.

## Résultats enregistrés dans la base principale

Après le premier passage (déclenché par pg_net17968) :

| Mesure | Nombre |
|---|---:|
| Modèles analysés/persistés | 861 |
| Familles fonctionnelles | 19 |
| Signatures d’entrée distinctes | 648 |
| POST officiellement confirmé par OpenAPI et déclaration cohérente | 840 |
| Schémas pris en charge par le validateur | 816 |
| Protocoles de résultat liés | 313 |
| Tests simulés réussis | 306 |
| Intégrations préparées | **298** |
| Intégrations bloquées | 563 |
| Visibles au catalogue avec clé | 861 |

Répartition préparée / total par famille :

| Famille | Préparés | Total |
|---|---:|---:|
| Génération audio | 19 | 31 |
| Animation/avatar | 4 | 8 |
| Édition image | 36 | 65 |
| Amélioration image | 15 | 29 |
| Image vers3D | 0 | 7 |
| Image vers image (catégorie de repli) | 0 | 9 |
| Image vers vidéo | 75 | 159 |
| Lip-sync | 6 | 8 |
| LoRA | 0 | 8 |
| Multimodal | 0 | 134 |
| Autres | 0 | 14 |
| Storyboard | 0 | 1 |
| Texte | 0 | 31 |
| Texte vers3D | 0 | 3 |
| Texte vers image | 53 | 94 |
| Texte vers vidéo | 53 | 117 |
| Entraînement | 0 | 3 |
| Édition/effets vidéo | 37 | 137 |
| Vidéo vers vidéo (catégorie de repli) | 0 | 3 |

Les sous-types speech-to-speech/TTS/upscaling précis non déclarés par le tag ne
sont PAS inventés depuis le nom ; ils restent rattachés à la famille déclarée
et à vérifier. Les 3D/ZIP/formats non pris en charge sont explicitement bloqués.

## Tableau administrateur et sécurité

Table privée `saas_ugc.studio_model_integrations`, RPC admin paginée/filtrable,
intégrée à l’explorateur du catalogue. Étapes persistées, protocoles, blocages,
source OpenAPI/opération/empreinte, prix/accès/test réel/activation distincts.
Cron réévaluation horaire installé. Changement de schéma → états périmés ;
changement du contrat OpenAPI → désactivation/invalidation d’attestation,
conservation des prix/configurations et historique des générations.

Permissions réelles mesurées : SELECT anon/authenticated table=false ;
RPC save authenticated=false, service_role=true ; RPC lecture anon=false,
authenticated=true **avec contrôle admin interne**. Tests PGlite de ce contrôle,
des empreintes obsolètes et de la persistance. Pas de session navigateur admin
réelle : affichage authentifié en production non revendiqué comme testé E2E.

## Sens exact des compteurs

**298 préparés ne signifie pas298 opérationnels.** Pour ces modèles : contrat
lié, formulaire/validation structurelle, chemin média pris en charge, parseur
et cycle simulés. Restent la revue des contraintes exprimées en prose,
la tarification SORAHNEX, le coût plafond, les droits par modèle et le test réel
sous autorisation financière distincte. Aucun test de génération réel réalisé.

Aucun modèle activé, aucun crédit client débité, aucune génération facturée.
Les politiques de quotas audio/autres et le budget global partagé restent des
gardes avant activation. Aucun secret supplémentaire requis pour ce lot MuAPI.
Les propositions de secrets des autres fournisseurs restent dans increment08 ;
elles ne sont pas présentées comme déjà raccordées au Studio.
