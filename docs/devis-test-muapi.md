# Tarification vidéo VYORA — état de validation

**Statut : configuration désactivée par défaut. Aucun devis réel ni génération payante
n'a été demandé ou lancé dans cette validation.** Les tests du dépôt utilisent des
réponses simulées localement ; ils ne vérifient ni les identifiants serveur ni le
catalogue ou les tarifs du compte MuAPI de production.

## Contrat de tarification

Les crédits sont calculés côté serveur à partir du coût fournisseur obtenu pour les
paramètres validés du modèle, du taux USD/FCFA, de la valeur d'un crédit, des coûts
additionnels et de la majoration configurée :

`ceil((coût fournisseur USD + coût additionnel USD) × taux USD/FCFA × (1 + majoration / 100) / valeur FCFA d'un crédit)`

Les nouveaux paramètres sont initialisés sans valeurs opérationnelles, avec la
tarification désactivée et une majoration par défaut de 110 %. Un administrateur doit
configurer les valeurs et activer la tarification après une synchronisation récente du
catalogue. Les changements sont journalisés.

## Devis et création

- L'estimation utilise l'identifiant public du modèle et les paramètres acceptés par son
  schéma serveur. Les paramètres envoyés au fournisseur ne sont pas repris dans la
  réponse au client.
- Quand la tarification est active et vérifiable, le serveur crée un devis opaque en
  crédits, associé à l'utilisateur, au service, au modèle, aux paramètres de tarification
  et à la version de configuration.
- Le devis expire après 10 minutes. La réservation atomique vérifie sa propriété, son
  expiration, le service, le modèle et la version de tarification avant de réserver
  exactement le montant du devis.
- Si le coût ne peut pas être vérifié, aucun devis valide n'est créé et la génération ne
  peut pas démarrer. Les crédits Studio restent indépendants du quota Business Grow.
- Les coûts fournisseurs et identifiants techniques restent réservés aux vues
  d'administration ; les réponses normales du Studio exposent un coût en crédits.

## Validation locale

Les tests ciblés couvrent la formule, les estimations disponibles ou indisponibles,
l'expiration et l'usage des devis, la validation des paramètres, les permissions du
catalogue détaillé et la restitution en cas d'échec. `npm.cmd run typecheck`,
`npm.cmd run build` et les suites de tests ciblées doivent être exécutés avant toute
publication.

Aucun secret ne doit être ajouté au client, à la documentation ou aux tests. Ne pas
appliquer la migration, activer les tarifs, appeler un endpoint de génération, déployer
ou modifier des données de production sans autorisation explicite.
