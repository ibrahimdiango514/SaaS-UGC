#!/bin/sh
# ===========================================================================
# Rideau 1 — commande `[build].ignore` de netlify.toml
# ===========================================================================
# Netlify évalue cette commande AVANT toute installation. Code de sortie 0 =
# build ANNULÉ (aucun crédit, aucun déploiement). Code 1 = on continue vers la
# commande de build, où le rideau 2 revérifie tout.
#
# Pourquoi un script et non une ligne dans netlify.toml
# ----------------------------------------------------
# L'ancienne version était une seule ligne TOML de ~700 caractères contenant
# l'identifiant et le nom du site en dur. Changer de site imposait de modifier
# ce texte illisible, puis de le recopier à l'identique dans
# netlify-build-guard.sh — deux occasions de se tromper, et une migration qui
# échouait à la dernière minute. Ici, l'identité est lue dans `netlify.site.conf`
# et la logique est la MÊME que celle du rideau 2 (`scripts/netlify-guard-lib.sh`).
#
# Comportement : FERMÉ PAR DÉFAUT. Toute variable absente, toute incohérence,
# tout site non déclaré → build annulé, avec la raison exacte écrite au journal.
#
# Utilisable localement sans risque : sans les variables que Netlify seul
# fournit (SITE_ID, SITE_NAME, BRANCH), ce script ANNULE. Il n'autorise jamais
# un build par accident, et il ne fait rien d'autre que lire des variables.
set -u

# Racine du dépôt : Netlify exécute la commande depuis la racine clonée.
ICI=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ICI_DEPOT=$(CDPATH= cd -- "$ICI/.." && pwd)
. "$ICI/netlify-guard-lib.sh"

verifier_garde ignore
statut=$?

if [ "$statut" -eq 0 ]; then
  echo "garde ignore: build autorise (site $SITE_ID, branche $BRANCH, autorisation humaine présente)"
  exit 1
fi
echo "garde ignore: build annule (conditions non reunies)"
exit 0
