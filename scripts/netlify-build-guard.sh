#!/bin/sh
# Garde de build Netlify — second rideau, exécuté EN TÊTE de la commande de
# build (`[build].command` dans netlify.toml), donc dans l'environnement de
# build complet où Netlify documente `SITE_ID`, `SITE_NAME`, `BRANCH`.
#
# Pourquoi deux rideaux : la commande `[build].ignore` est évaluée avant le
# build et ne voit pas de façon fiable les variables de métadonnées du site
# (`SITE_ID`, `SITE_NAME`) — c'est ce qui a fait annuler le déploiement de
# `14a61ec` : `[ "$SITE_ID" != "…" ]` avec une variable vide est toujours vrai.
# `ignore` garde donc ce qu'elle voit sûrement (branche, opt-in explicite) et
# ce script tranche l'identité du site, avec la vraie valeur, juste avant
# `npm ci`. Un refus ici coûte quelques secondes, jamais un déploiement.
#
# Usage : sh scripts/netlify-build-guard.sh <site-id-autorisé>
# Code de sortie : 0 = build autorisé ; 1 = build refusé (message explicite).
#
# Règles (toutes doivent être vraies) :
#   1. VYORA_BUILD_ENABLED = "true"  — opt-in explicite déclaré sur le site ;
#   2. BRANCH = "main"               — seule source déployée en production ;
#   3. SITE_NAME ≠ "vyora-ugc"       — nom de l'ANCIEN site (ancien compte) :
#                                      refus explicite, quel que soit l'ID ;
#   4. SITE_ID présent ET égal à l'identifiant autorisé (nouveau site).
set -u

attendu="${1:-}"
ANCIEN_SITE_NAME="vyora-ugc"

refuser() {
  echo "GARDE NETLIFY — build refusé : $1" >&2
  echo "  SITE_ID=${SITE_ID:-<absent>} SITE_NAME=${SITE_NAME:-<absent>} BRANCH=${BRANCH:-<absent>} VYORA_BUILD_ENABLED=${VYORA_BUILD_ENABLED:-<absent>}" >&2
  echo "  Site autorisé : ${attendu:-<non fourni>} (voir netlify.toml et docs/migration-nouveau-netlify.md)." >&2
  exit 1
}

case "$attendu" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) refuser "identifiant de site autorisé absent ou mal formé (UUID minuscule attendu en argument)" ;;
esac

[ "${VYORA_BUILD_ENABLED:-}" = "true" ] || refuser "VYORA_BUILD_ENABLED doit valoir exactement « true » sur ce site"
[ "${BRANCH:-}" = "main" ] || refuser "seule la branche main est déployée (branche reçue : ${BRANCH:-<absente>})"
[ "${SITE_NAME:-}" != "$ANCIEN_SITE_NAME" ] || refuser "ce site porte le nom de l'ANCIEN site (${ANCIEN_SITE_NAME}) : aucun déploiement n'y est autorisé"
[ -n "${SITE_ID:-}" ] || refuser "SITE_ID absent de l'environnement de build : identité du site invérifiable"
[ "$SITE_ID" = "$attendu" ] || refuser "ce site (${SITE_ID}) n'est pas le site de production autorisé"

echo "GARDE NETLIFY — build autorisé : site ${SITE_ID} (${SITE_NAME:-sans nom}), branche ${BRANCH}."
exit 0
