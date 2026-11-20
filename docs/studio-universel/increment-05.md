# Incrément 05 — reprise et confidentialité (en cours)

## Récupération

PR #32 vérifiée fusionnée dans main, commit 3cf8114. Main fusionné sur la branche
Arena courante, sans changement de branche. Le clone initial était superficiel :
récupération de l'historique avant fusion. `97f36c0` est absent localement et
introuvable via GitHub (422), y compris après récupération de l'ancienne branche.
L'ancien increment-05 n'est pas publié. Les travaux non publiés de l'autre
workspace ne sont pas récupérables depuis ce clone : ne pas prétendre le contraire.

## Correctif client

Le filtre des devis conservait `available=true` mais retirait `billing_units` :
l'ancien frontend pouvait planter et afficher un faux prix zéro via `cost_usd ?? 0`.
Désormais `available=false` force le chemin historique « montant indisponible »,
`verified` porte la vérification pour le nouveau frontend, et `billing_units=[]`
préserve la structure sans prix. Le message est constant et aucun diagnostic
fournisseur n'est recopié. Le devis en crédits, son identifiant et ses garde-fous
restent dans l'enveloppe estimate existante. Les branches admin restent intactes.
Le filtre confidentialité de vyora-ai de la PR #32 est réutilisé sans réécriture.

## Bascule préparée

`scripts/build-privacy-release.mjs` produit trois chargeurs et un SQL transactionnel
avec noms d'artefacts suffixés par le SHA-256 complet. Aucun écrasement du nom
historique `reelora-video` : les instances à froid de l'ancienne révision peuvent
encore charger leurs tranches. Chaque chargeur vérifie taille et empreinte avant
exécution. Ce script ne publie rien et n'appelle aucun fournisseur.

## Validation

102 tests ciblés réussis, typecheck frontend et Edge, imports Deno et build OK.
Suite complète : 3149/3151 au premier passage ; les deux échecs provenaient de
l'absence locale du commit historique 2538511 épinglé par store-import/store-connect.
Après récupération de ce commit, les 22 tests du fichier concerné passent sans
modification de ces fonctions ni affaiblissement des assertions. La CI récupère
explicitement ce commit et exécute la suite, les types et le build.

## Production et limites

Projet principal confirmé ACTIVE_HEALTHY : xbuuhfwobrafcbgtdgjx, aucun autre projet
créé. Inventaire Edge lu : reelora-video v24, video-quote v11, vyora-ai v13.
Ces numéros sont un constat avant déploiement, pas une preuve de correction.
À cet instant, aucune Edge Function, migration ni frontend de cet incrément n'est
déployé. Le moteur universel n'est pas achevé ; aucun modèle universel activé,
aucune correspondance inventée, aucune génération ou débit client testé.
Accès à la configuration des protections GitHub refusé (403) ; aucune tentative
de contournement. La fusion doit satisfaire les contrôles réels de GitHub.
