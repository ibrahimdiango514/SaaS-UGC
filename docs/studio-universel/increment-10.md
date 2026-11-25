# Increment 10 — compteurs universels et actualisation

Le compteur historique `metrics.models.total` mesure uniquement les vidéos (415), pas les références universelles (861). Les vues admin utilisent désormais une même RPC admin avec total, préparés, intégrés validés, opérationnels, activation configurée, disponibles Studio et problèmes. Aucun total n'est figé dans le frontend. Les anciens moteurs et métriques historiques sont conservés et explicitement nommés.

Migration additive : `20261120050000_studio_catalog_truth.sql`. Aucune activation ni attestation n'est créée. Les vues catalogue, détails, progression, santé et Studio se rafraîchissent après écritures locales, au focus et toutes les 20 secondes lorsque visibles. Les devis deviennent invalides lorsque la sélection change côté serveur.

Validation locale : 3211 tests / 198 fichiers, typecheck frontend et Edge, contrôle imports Edge, build production verts. Les tests PGlite utilisent uniquement des portefeuilles factices ; aucune génération fournisseur.

Situation mesurée avant publication : 861 références, 520 préparées, 0 configurations runtime, 0 activations, 0 accès exécution confirmés, runtime global fermé. Cette livraison corrige la visibilité, elle ne clôture pas l'activation MuAPI. Restent droits d'exécution, tarifs SORAHNEX/plafonds validés, attestations réelles (payantes non autorisées), contraintes non prises en charge et quotas des catégories non vidéo/image/texte. Ne pas confondre présence au catalogue et disponibilité opérationnelle.
