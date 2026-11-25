# shellcheck shell=sh
# ===========================================================================
# Logique COMMUNE des deux rideaux de la garde de déploiement Netlify
# ===========================================================================
# Sourcé par `scripts/netlify-ignore.sh` (rideau 1) et par
# `scripts/netlify-build-guard.sh` (rideau 2). Une seule implémentation : les
# deux rideaux ne peuvent pas diverger, ce qui était le défaut de la version
# précédente (deux copies de la même condition, à garder synchronisées à la main).
#
# Fournit :
#   verifier_garde <contexte>   → 0 si le déploiement est AUTORISÉ, 1 sinon.
#                                 Écrit la raison exacte du refus sur stderr.
#   charger_identite            → lit netlify.site.conf dans ID_ATTENDU / NOM_ATTENDU.
#
# Règles, toutes exigées (fermé par défaut) :
#   1. L'identité autorisée est LISIBLE et bien formée (netlify.site.conf).
#   2. SITE_ID est présent et ÉGAL à l'identifiant autorisé.
#   3. SITE_NAME est présent et ÉGAL au nom autorisé.
#   4. SITE_NAME n'est pas celui de l'ancien site (refus explicite).
#   5. BRANCH vaut exactement « main » (seule source de production).
#   6. AUTORISATION_DEPLOIEMENT vaut exactement « true » (acte humain).
#   7. AUTORISATION_DEPLOIEMENT_NOM vaut exactement la variable autorisée.
#   8. L'opt-in de build du site vaut exactement « true ».
#
# Aucune liste noire : l'identité est POSITIVE. Un site inconnu est refusé parce
# qu'il n'est pas celui du fichier, jamais parce qu'il figure sur une liste.

# --- Noms des variables ------------------------------------------------------
# Constantes, jamais lues depuis l'environnement : si le nom de la variable
# d'autorisation était lui-même configurable, un site pourrait se déclarer
# autorisé en renommant sa variable. C'est ce que veut dire « aucun contournement
# par une simple modification du nom ».
AUTORISATION_DEPLOIEMENT="SORAHNEX_DEPLOY_AUTHORIZED"
AUTORISATION_DEPLOIEMENT_NOM="sorahnex-deploy"
OPT_IN_BUILD="VYORA_BUILD_ENABLED"
FICHIER_IDENTITE="netlify.site.conf"

# --- Lecture de l'identité autorisée ----------------------------------------
# Format : une paire CLE=valeur par ligne, commentaires en `#`.
# Aucune exécution : le fichier est lu ligne à ligne, la valeur est prise
# littéralement après le premier `=`. Un fichier versionné doit rester inerte.
charger_identite() {
  ID_ATTENDU=""
  NOM_ATTENDU=""
  ANCIEN_NOM=""
  ANCIEN_ID=""
  ID_DECLARE=""
  _fichier="$1/$FICHIER_IDENTITE"
  if [ ! -f "$_fichier" ]; then
    echo "GARDE NETLIFY — configuration introuvable : $FICHIER_IDENTITE" >&2
    return 1
  fi
  while IFS= read -r _ligne || [ -n "$_ligne" ]; do
    case "$_ligne" in
      '' | '#'*) continue ;;
    esac
    _cle=${_ligne%%=*}
    _valeur=${_ligne#*=}
    # Retire les espaces de bord (sans `xargs`, qui interprète les guillemets).
    _valeur=$(printf '%s' "$_valeur" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    case "$_cle" in
      SITE_ID) ID_ATTENDU=$_valeur ;;
      SITE_NAME) NOM_ATTENDU=$_valeur ;;
      ANCIEN_SITE_NAME) ANCIEN_NOM=$_valeur ;;
      ANCIEN_SITE_ID) ANCIEN_ID=$_valeur ;;
      A_DECLARER) ID_DECLARE=$_valeur ;;
    esac
  done < "$_fichier"
}

# --- Verrou d'autorisation humaine ------------------------------------------
# Le second jeton (`AUTORISATION_DEPLOIEMENT_NOM`) n'est pas décoratif : il
# garantit que la variable a été déclarée POUR CE MÉCANISME, avec la valeur
# attendue, et pas héritée d'un autre outil. Un site qui poserait
# `SORAHNEX_DEPLOY_AUTHORIZED=true` sans le jeton reste bloqué.
verifier_autorisation_humaine() {
  if [ "${SORAHNEX_DEPLOY_AUTHORIZED:-}" != "true" ]; then
    return 1
  fi
  if [ "${SORAHNEX_DEPLOY_AUTHORIZED_NAME:-}" != "$AUTORISATION_DEPLOIEMENT_NOM" ]; then
    return 1
  fi
  return 0
}

# --- Vérification principale -------------------------------------------------
# $1 = contexte (« ignore » ou « build »), seulement pour le journal.
verifier_garde() {
  _contexte=${1:-build}

  # 1. Identité autorisée lisible.
  if ! charger_identite "$ICI_DEPOT"; then
    return 1
  fi
  case "$ID_ATTENDU" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) refuser "SITE_ID autorisé absent ou mal formé dans $FICHIER_IDENTITE (UUID minuscule attendu)" || return 1 ;;
  esac
  case "$NOM_ATTENDU" in
    '' | *[!a-z0-9-]*) refuser "SITE_NAME autorisé absent ou mal formé dans $FICHIER_IDENTITE (minuscules, chiffres, tirets)" || return 1 ;;
  esac
  if [ -n "$ANCIEN_NOM" ] && [ "$NOM_ATTENDU" = "$ANCIEN_NOM" ]; then
    refuser "le nom autorisé ne peut pas être celui de l'ancien site ($ANCIEN_NOM)" || return 1
  fi

  # 0. Aucun site n'est encore déclaré : le cas NORMAL avant une migration.
  # Sans cette règle, un dépôt pas encore configuré accuse l'absence d'une
  # variable (VYORA_BUILD_ENABLED) et envoie l'utilisateur régler un réglage qui
  # ne changera rien : la vraie cause est « aucun site n'est autorisé », et elle
  # est visible ici sans avoir à lire les seize autres lignes d'état.
  if [ -n "${ID_DECLARE:-}" ] && [ "${SITE_ID:-}" != "${ID_ATTENDU:-}" ]; then
    if [ -n "${SITE_ID:-}" ] && [ "$SITE_ID" = "$ID_DECLARE" ]; then
      refuser "le site ${SITE_ID} existe déjà et n'est pas encore AUTORISÉ. C'est volontaire : l'autorisation se donne à l'étape 2 de docs/NETLIFY_DEPLOYMENT_CHECKLIST.md, quand tu me fournis son identité. Rien ne se publie sur un site non déclaré." || return 1
    fi
    if [ -n "${SITE_ID:-}" ]; then
      refuser "ce site (${SITE_ID}) n'est ni le site autorisé (${ID_ATTENDU}) ni le site à déclarer (${ID_DECLARE}). La liste des sites autorisés ne se devine pas." || return 1
    fi
  fi

  # 2-4. Identité réelle du site.
  if [ -z "${SITE_ID:-}" ]; then
    refuser "SITE_ID absent : identité du site invérifiable. Ce n'est pas un environnement Netlify, ou le site n'est pas relié au dépôt." || return 1
  fi
  # Un ancien site est refusé AVANT la comparaison d'identifiant : sinon le
  # message generique « pas le site autorise » masquerait la vraie raison.
  if [ -n "$ANCIEN_ID" ] && [ "$SITE_ID" = "$ANCIEN_ID" ]; then
    refuser "ce site ($SITE_ID) est un ANCIEN site, explicitement écarté : une bascule ne doit jamais republier par accident sur l'ancien hébergement." || return 1
  fi
  if [ "$SITE_ID" != "$ID_ATTENDU" ]; then
    refuser "ce site ($SITE_ID) n'est pas le site autorisé ($ID_ATTENDU). Rien ne se publie sur un site qui n'est pas déclaré dans $FICHIER_IDENTITE." || return 1
  fi
  if [ -z "${SITE_NAME:-}" ]; then
    refuser "SITE_NAME absent : identité du site invérifiable." || return 1
  fi
  if [ -n "$ANCIEN_NOM" ] && [ "$SITE_NAME" = "$ANCIEN_NOM" ]; then
    refuser "ce site porte le nom de l'ANCIEN site ($ANCIEN_NOM) : aucun déploiement n'y est autorisé." || return 1
  fi
  if [ "$SITE_NAME" != "$NOM_ATTENDU" ]; then
    refuser "ce site s'appelle « $SITE_NAME », le site autorisé s'appelle « $NOM_ATTENDU »." || return 1
  fi

  # 5. Branche de production.
  if [ "${BRANCH:-}" != "main" ]; then
    refuser "seule la branche main est déployée (branche reçue : ${BRANCH:-<absente>})." || return 1
  fi

  # 6-7. Autorisation humaine.
  if [ "${SORAHNEX_DEPLOY_AUTHORIZED:-}" != "true" ]; then
    refuser "AUTORISATION HUMAINE ABSENTE. Un déploiement de production réussi coûte 15 crédits Netlify. Déclarez $AUTORISATION_DEPLOIEMENT=true sur CE site, juste avant de publier, puis retirez-la. Voir docs/NETLIFY_DEPLOYMENT_CHECKLIST.md." || return 1
  fi
  if [ "${SORAHNEX_DEPLOY_AUTHORIZED_NAME:-}" != "$AUTORISATION_DEPLOIEMENT_NOM" ]; then
    refuser "jeton d'autorisation absent ou incorrect. La variable $AUTORISATION_DEPLOIEMENT doit être accompagnée de SORAHNEX_DEPLOY_AUTHORIZED_NAME=$AUTORISATION_DEPLOIEMENT_NOM (les deux, ensemble)." || return 1
  fi

  # 8. Opt-in de build du site.
  if [ "${VYORA_BUILD_ENABLED:-}" != "true" ]; then
    refuser "$OPT_IN_BUILD doit valoir exactement « true » sur ce site (Site configuration → Environment variables)." || return 1
  fi

  return 0
}

# --- Refus -------------------------------------------------------------------
# Message à la fois lisible et exploitable en CI : la raison exacte d'abord,
# puis l'état complet des variables, puis la commande qui répare.
refuser() {
  {
    echo "======================================================================"
    echo "GARDE NETLIFY — déploiement REFUSÉ (rideau: ${_contexte:-build})"
    echo "======================================================================"
    echo "Raison : $1"
    echo
    echo "État observé :"
    echo "  SITE_ID                     = ${SITE_ID:-<absent>}"
    echo "  SITE_NAME                   = ${SITE_NAME:-<absent>}"
    echo "  BRANCH                      = ${BRANCH:-<absent>}"
    echo "  $OPT_IN_BUILD      = ${VYORA_BUILD_ENABLED:-<absent>}"
    echo "  $AUTORISATION_DEPLOIEMENT = ${SORAHNEX_DEPLOY_AUTHORIZED:-<absent>}"
    echo "  ${AUTORISATION_DEPLOIEMENT}_NAME = ${SORAHNEX_DEPLOY_AUTHORIZED_NAME:-<absent>}"
    echo
    echo "Site autorisé (source : $FICHIER_IDENTITE) :"
    echo "  SITE_ID   = ${ID_ATTENDU:-<illisible>}"
    echo "  SITE_NAME = ${NOM_ATTENDU:-<illisible>}"
    echo
    echo "Aucun déploiement n'a eu lieu, aucun crédit n'a été consommé."
    echo "Procédure : docs/NETLIFY_DEPLOYMENT_CHECKLIST.md"
    echo "======================================================================"
  } >&2
  return 1
}
