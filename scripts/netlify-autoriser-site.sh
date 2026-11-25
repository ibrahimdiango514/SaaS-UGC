#!/bin/sh
# ===========================================================================
# Autoriser un site Netlify — un seul geste, vérifiable
# ===========================================================================
# Usage :
#   sh scripts/netlify-autoriser-site.sh <SITE_ID> <SITE_NAME>
#
# Ce script ne fait qu'une chose : réécrire `netlify.site.conf` en déplaçant le
# site actuellement autorisé vers `ANCIEN_SITE_ID` / `ANCIEN_SITE_NAME`, puis
# vérifier que la garde accepte le nouveau et refuse l'ancien.
#
# Pourquoi un script plutôt qu'une édition à la main
# --------------------------------------------------
# Une bascule d'identité touche quatre lignes qui doivent rester cohérentes :
# si l'ancien site n'est pas déplacé, il reste autorisé ET redevient une cible
# possible. C'est exactement l'erreur qui republierait sur l'ancien hébergement.
#
# Le script REFUSE d'écrire si :
#   - l'identifiant n'est pas un UUID minuscule ;
#   - le nom n'est pas en minuscules/chiffres/tirets ;
#   - le site demandé est déjà l'ancien site (on n'y retourne pas).
set -u

ICI=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPOT=$(CDPATH= cd -- "$ICI/.." && pwd)
CONF="$DEPOT/netlify.site.conf"

if [ "$#" -ne 2 ]; then
  echo "Usage : sh scripts/netlify-autoriser-site.sh <SITE_ID> <SITE_NAME>" >&2
  echo "Exemple : sh scripts/netlify-autoriser-site.sh 6ec85a76-bf5f-4eed-9d9e-0a8f6b7f9803 saas-ugc" >&2
  exit 2
fi

NOUVEAU_ID=$1
NOUVEAU_NOM=$2

case "$NOUVEAU_ID" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *)
    echo "REFUS : identifiant mal formé. Un identifiant Netlify est un UUID en minuscules," >&2
    echo "        de la forme 6ec85a76-bf5f-4eed-9d9e-0a8f6b7f9803." >&2
    exit 1 ;;
esac

case "$NOUVEAU_NOM" in
  '' | *[!a-z0-9-]*)
    echo "REFUS : nom mal formé. Attendu : minuscules, chiffres et tirets seulement." >&2
    echo "        Attention au suffixe aléatoire de Netlify (ex. saas-ugc-0d54) : il fait" >&2
    echo "        partie du nom et doit être inclus." >&2
    exit 1 ;;
esac

if [ ! -f "$CONF" ]; then
  echo "REFUS : $CONF introuvable. Ce script doit tourner dans le dépôt." >&2
  exit 1
fi

ANCIEN_ID_ACTUEL=$(sed -n 's/^SITE_ID=//p' "$CONF" | head -1)
ANCIEN_NOM_ACTUEL=$(sed -n 's/^SITE_NAME=//p' "$CONF" | head -1)
ANCIEN_ID_REFUSE=$(sed -n 's/^ANCIEN_SITE_ID=//p' "$CONF" | head -1)

if [ "$NOUVEAU_ID" = "$ANCIEN_ID_REFUSE" ]; then
  echo "REFUS : $NOUVEAU_ID est un site explicitement écarté. On n'y retourne pas." >&2
  exit 1
fi

if [ "$NOUVEAU_ID" = "$ANCIEN_ID_ACTUEL" ]; then
  echo "Information : $NOUVEAU_ID est déjà le site autorisé. Rien à faire."
  exit 0
fi

echo "Bascule d'identité :"
echo "  site autorisé  : ${ANCIEN_ID_ACTUEL:-<absent>} (${ANCIEN_NOM_ACTUEL:-<absent>})"
echo "  devient ancien : il sera REFUSÉ nommément"
echo "  nouveau autorisé : $NOUVEAU_ID ($NOUVEAU_NOM)"
echo

python3 - "$CONF" "$NOUVEAU_ID" "$NOUVEAU_NOM" "$ANCIEN_ID_ACTUEL" "$ANCIEN_NOM_ACTUEL" <<'PY'
import re, sys

chemin, nouvel_id, nouveau_nom, ancien_id, ancien_nom = sys.argv[1:6]
with open(chemin, encoding='utf-8') as flux:
    texte = flux.read()

# Les deux valeurs autorisées.
texte = re.sub(r'(?m)^SITE_ID=.*$', f'SITE_ID={nouvel_id}', texte)
texte = re.sub(r'(?m)^SITE_NAME=.*$', f'SITE_NAME={nouveau_nom}', texte)

# L'ancien site ne doit surtout pas rester autorisé : on le déplace sur la ligne
# de refus. C'est la seule façon d'être certain qu'il ne redeviendra pas une
# cible par simple oubli.
if ancien_id and re.search(r'(?m)^ANCIEN_SITE_ID=', texte):
    texte = re.sub(r'(?m)^ANCIEN_SITE_ID=.*$', f'ANCIEN_SITE_ID={ancien_id}', texte)
if ancien_nom and re.search(r'(?m)^ANCIEN_SITE_NAME=', texte):
    texte = re.sub(r'(?m)^ANCIEN_SITE_NAME=.*$', f'ANCIEN_SITE_NAME={ancien_nom}', texte)

with open(chemin, 'w', encoding='utf-8') as flux:
    flux.write(texte)
PY

echo "netlify.site.conf réécrit :"
grep -E '^(SITE_ID|SITE_NAME|ANCIEN_SITE_ID|ANCIEN_SITE_NAME)=' "$CONF" | sed 's/^/  /'
echo

# Vérification immédiate : le nouveau passe, l'ancien est refusé.
BASE="PATH=${PATH:-/usr/bin:/bin} BRANCH=main VYORA_BUILD_ENABLED=true SORAHNEX_DEPLOY_AUTHORIZED=true SORAHNEX_DEPLOY_AUTHORIZED_NAME=sorahnex-deploy"

if env $BASE SITE_ID="$NOUVEAU_ID" SITE_NAME="$NOUVEAU_NOM" sh "$ICI/netlify-build-guard.sh" >/dev/null 2>&1; then
  echo "  ✅ nouveau site : build AUTORISÉ (les huit conditions sont réunies)"
else
  echo "  ❌ nouveau site : build encore refusé — lancer sh scripts/netlify-build-guard.sh pour la raison" >&2
fi

if env $BASE SITE_ID="$ANCIEN_ID_ACTUEL" SITE_NAME="$ANCIEN_NOM_ACTUEL" sh "$ICI/netlify-build-guard.sh" >/dev/null 2>&1; then
  echo "  ⚠️  l'ancien site est ENCORE autorisé : quelque chose n'a pas été déplacé" >&2
else
  echo "  ✅ ancien site : refusé, comme il se doit"
fi

cat <<'RAPPEL'

Prochaine étape : commiter ce fichier et fusionner. Tant que la modification n'est
pas sur la branche que Netlify construit, la garde en service reste l'ancienne.
RAPPEL
