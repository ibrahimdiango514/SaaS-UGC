#!/bin/sh
# ===========================================================================
# Rideau 2 — en TÊTE de la commande de build (`[build].command`)
# ===========================================================================
# S'exécute dans l'environnement de build complet, AVANT `npm ci` : un refus
# coûte quelques secondes et n'installe rien, ne construit rien, ne publie rien.
#
# Pourquoi ce rideau existe en plus du rideau 1 : un « Trigger deploy » manuel
# depuis l'interface Netlify ou une relance de déploiement ne repasse pas
# forcément par la commande `ignore`. Ce rideau-ci est dans la commande de
# build : il s'exécute à chaque fois.
#
# La logique est partagée avec le rideau 1 (`scripts/netlify-guard-lib.sh`) et
# l'identité autorisée vit dans `netlify.site.conf`. Changer de site = modifier
# ce seul fichier.
#
# Usage : sh scripts/netlify-build-guard.sh
# Code de sortie : 0 = build autorisé ; 1 = refus (message explicite, zéro coût).
set -u

ICI=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ICI_DEPOT=$(CDPATH= cd -- "$ICI/.." && pwd)

if [ ! -f "$ICI/netlify-guard-lib.sh" ]; then
  echo "GARDE NETLIFY — bibliothèque de garde introuvable (scripts/netlify-guard-lib.sh). Build refusé." >&2
  exit 1
fi
. "$ICI/netlify-guard-lib.sh"

if verifier_garde build; then
  echo "GARDE NETLIFY — build autorisé : site ${SITE_ID} (${SITE_NAME}), branche ${BRANCH}."
  exit 0
fi
exit 1
