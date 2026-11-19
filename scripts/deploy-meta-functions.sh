#!/usr/bin/env bash
# VYORA — déploiement CONTRÔLÉ des Edge Functions Meta.
#
# ## Pourquoi un script séparé
# `scripts/deploy-edge-functions.sh` déploie cinq fonctions Reelora d'un coup.
# L'exécuter pour Meta redéploierait du code hors périmètre. Ce script-ci ne
# touche QUE les trois fonctions Meta, et refuse de continuer si l'un des
# contrôles échoue.
#
# ## Ce qui change en production (et rien d'autre)
#   1. création de la fonction `meta-connect`   (verify_jwt = false)
#   2. création de la fonction `meta-webhook`   (verify_jwt = false)
#   3. création de la fonction `meta-lifecycle` (verify_jwt = false)
#      → rappels `deauthorize` et `data-deletion` exigés par Meta
#   4. AUCUNE autre fonction, AUCUNE migration, AUCUN secret, AUCUNE table.
#
# ## Ce qui est déployé
# Le CHARGEUR (`loader.ts`, 3 412 caractères), pas `index.ts` : ses imports vers
# `src/business/meta/*` ne sont pas transportés par un déploiement de fonction
# seule. Le chargeur télécharge le bundle depuis un commit figé et vérifie
# taille + SHA-256 avant exécution.
#
# ## Prérequis
#   - `supabase login` puis `supabase link --project-ref <ref>`
#   - les artéfacts et les chargeurs committés ET poussés (le chargeur lit
#     GitHub : un commit non poussé rend la fonction indisponible en 503)
#   - autorisation explicite de l'utilisateur : ce script écrit en production
#
# ## Usage
#   bash scripts/deploy-meta-functions.sh            # contrôles seuls (à blanc)
#   bash scripts/deploy-meta-functions.sh --apply    # déploie réellement
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${VYORA_PROJECT_REF:-xbuuhfwobrafcbgtdgjx}"
APPLIQUER=0
[ "${1:-}" = "--apply" ] && APPLIQUER=1

echo "Projet : $PROJECT_REF"
echo "Mode   : $([ "$APPLIQUER" = 1 ] && echo 'DÉPLOIEMENT RÉEL' || echo 'contrôles à blanc (ajoutez --apply pour déployer)')"
echo

# 1. Parité chargeur ↔ dépôt. Échoue si un artefact a bougé sans réépingle.
for f in meta-connect meta-webhook meta-lifecycle; do
  node scripts/build-edge-artifact.mjs "$f" --check
done

# 2. Le commit épinglé doit être JOIGNABLE, pas seulement présent en local.
#    Le chargeur s'exécute sur la plateforme Supabase et lit GitHub : un commit
#    existant uniquement dans ce clone produit un 503 à froid.
for f in meta-connect meta-webhook meta-lifecycle; do
  COMMIT="$(grep -o 'const COMMIT = "[0-9a-f]\{40\}"' "supabase/functions/$f/loader.ts" | grep -o '[0-9a-f]\{40\}')"
  CHEMIN="$(grep -o 'const PATH = "[^"]*"' "supabase/functions/$f/loader.ts" | cut -d'"' -f2)"
  echo -n "$f : artefact joignable au commit ${COMMIT:0:8}… "
  if git ls-remote --exit-code origin "$COMMIT" >/dev/null 2>&1 \
     || gh api "repos/ibrahimdiango514/SaaS-UGC/contents/$CHEMIN?ref=$COMMIT" --jq '.size' >/dev/null 2>&1; then
    echo "oui"
  else
    echo "NON"
    echo "  → le commit épinglé n'est pas sur GitHub : poussez-le, puis réépinglez." >&2
    exit 1
  fi
done

# 3. Les secrets nécessaires. On vérifie des NOMS, jamais des valeurs.
echo
echo "Secrets attendus sur le projet (vérification par nom) :"
ATTENDUS="META_APP_ID META_APP_SECRET META_WEBHOOK_VERIFY_TOKEN META_WHATSAPP_CONFIG_ID META_FACEBOOK_CONFIG_ID"
if command -v supabase >/dev/null 2>&1; then
  POSES="$(supabase secrets list --project-ref "$PROJECT_REF" 2>/dev/null | awk '{print $1}')"
  MANQUANTS=""
  for s in $ATTENDUS; do
    if printf '%s\n' "$POSES" | grep -qx "$s"; then echo "  ✓ $s"; else echo "  ✗ $s (absent)"; MANQUANTS="$MANQUANTS $s"; fi
  done
  if [ -n "$MANQUANTS" ]; then
    echo "  → posez-les d'abord : les fonctions démarreraient en configuration incomplète." >&2
    echo "    supabase secrets set --project-ref $PROJECT_REF NOM=\"valeur\" …" >&2
    exit 1
  fi
else
  echo "  (CLI Supabase absente : contrôle ignoré — vérifiez dans le tableau de bord)"
fi

if [ "$APPLIQUER" != 1 ]; then
  echo
  echo "Contrôles passés. Rien n'a été déployé."
  echo "Pour déployer : bash scripts/deploy-meta-functions.sh --apply"
  exit 0
fi

echo
echo "Déploiement des chargeurs (jamais index.ts)…"
supabase functions deploy meta-connect \
  --project-ref "$PROJECT_REF" --no-verify-jwt --entrypoint loader.ts
supabase functions deploy meta-webhook \
  --project-ref "$PROJECT_REF" --no-verify-jwt --entrypoint loader.ts
supabase functions deploy meta-lifecycle \
  --project-ref "$PROJECT_REF" --no-verify-jwt --entrypoint loader.ts

echo
echo "Déployé. Vérification :"
echo "  npm run meta:readiness"
