#!/bin/sh
# Garde de build Netlify — second rideau, exécuté EN TÊTE de la commande de
# build (`[build].command` dans netlify.toml), dans l'environnement de build
# complet. Le premier rideau est la commande `[build].ignore`, évaluée avant
# toute installation ; les deux exigent les MÊMES quatre conditions.
#
# Preuve de terrain (journal Netlify du déploiement ca410d5, 2026-11-18) :
#   BRANCH=main  VYORA_BUILD_ENABLED=absent  SITE_ID=fc88d197-…  SITE_NAME=vyora-saas-ugc
# → Netlify expose bien BRANCH, SITE_ID et SITE_NAME ; seule la variable d'opt-in
# manquait sur le nouveau site. Les deux rideaux ont refusé comme prévu.
#
# Usage : sh scripts/netlify-build-guard.sh <site-id-autorisé> <site-name-autorisé>
# Code de sortie : 0 = build autorisé ; 1 = build refusé (message explicite,
# valeurs reçues écrites dans le journal). Un refus intervient avant `npm ci` :
# quelques secondes, jamais un déploiement.
#
# Règles (toutes doivent être vraies) :
#   1. VYORA_BUILD_ENABLED = "true"   — opt-in explicite déclaré sur le site ;
#   2. BRANCH = "main"                — seule source déployée en production ;
#   3. SITE_NAME ≠ "vyora-ugc"        — nom de l'ANCIEN site : refus explicite ;
#   4. SITE_ID présent ET égal à l'identifiant autorisé ;
#   5. SITE_NAME présent ET égal au nom autorisé (nouveau site).
set -u

attendu_id="${1:-}"
attendu_nom="${2:-}"
ANCIEN_SITE_NAME="vyora-ugc"

refuser() {
  echo "GARDE NETLIFY — build refusé : $1" >&2
  echo "  SITE_ID=${SITE_ID:-<absent>} SITE_NAME=${SITE_NAME:-<absent>} BRANCH=${BRANCH:-<absent>} VYORA_BUILD_ENABLED=${VYORA_BUILD_ENABLED:-<absent>}" >&2
  echo "  Site autorisé : ${attendu_id:-<non fourni>} / ${attendu_nom:-<non fourni>} (voir netlify.toml et docs/migration-nouveau-netlify.md §3)." >&2
  exit 1
}

case "$attendu_id" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) refuser "identifiant de site autorisé absent ou mal formé (UUID minuscule attendu en 1er argument)" ;;
esac
case "$attendu_nom" in
  "" | *[!a-z0-9-]*) refuser "nom de site autorisé absent ou mal formé (minuscules, chiffres, tirets attendus en 2e argument)" ;;
  "$ANCIEN_SITE_NAME") refuser "le nom autorisé ne peut pas être celui de l'ancien site (${ANCIEN_SITE_NAME})" ;;
esac

[ "${VYORA_BUILD_ENABLED:-}" = "true" ] || refuser "VYORA_BUILD_ENABLED doit valoir exactement « true » sur ce site (Site configuration → Environment variables)"
[ "${BRANCH:-}" = "main" ] || refuser "seule la branche main est déployée (branche reçue : ${BRANCH:-<absente>})"
[ "${SITE_NAME:-}" != "$ANCIEN_SITE_NAME" ] || refuser "ce site porte le nom de l'ANCIEN site (${ANCIEN_SITE_NAME}) : aucun déploiement n'y est autorisé"
[ -n "${SITE_ID:-}" ] || refuser "SITE_ID absent de l'environnement de build : identité du site invérifiable"
[ "$SITE_ID" = "$attendu_id" ] || refuser "ce site (${SITE_ID}) n'est pas le site de production autorisé"
[ -n "${SITE_NAME:-}" ] || refuser "SITE_NAME absent de l'environnement de build : identité du site invérifiable"
[ "$SITE_NAME" = "$attendu_nom" ] || refuser "ce site s'appelle « ${SITE_NAME} », le site autorisé s'appelle « ${attendu_nom} »"

echo "GARDE NETLIFY — build autorisé : site ${SITE_ID} (${SITE_NAME}), branche ${BRANCH}."
exit 0
