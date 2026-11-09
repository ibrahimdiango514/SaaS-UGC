#!/usr/bin/env bash
# Reelora — aligne les Edge Functions live sur les sources de ce dépôt.
#
# À exécuter UNIQUEMENT après autorisation explicite : ces fonctions sont
# partagées par le projet Supabase xbuuhfwobrafcbgtdgjx et ne sont pas isolées
# par branche/Preview. Ce script ne crée aucune nouvelle fonction et ne touche
# ni aux migrations, ni aux secrets, ni aux règles de crédits.
#
# Prérequis : Supabase CLI connecté (`supabase login`) et `supabase link`.
# Aucune clé n'est stockée ici : MUAPI_API_KEY / GROQ_API_KEY restent des secrets
# serveur gérés dans Supabase, jamais dans ce dépôt.

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${REELORA_PROJECT_REF:-xbuuhfwobrafcbgtdgjx}"
supabase link --project-ref "$PROJECT_REF"

# verify_jwt=true : le jeton utilisateur est validé par la passerelle puis par GoTrue.
supabase functions deploy reelora-ai --project-ref "$PROJECT_REF"
supabase functions deploy reelora-video --project-ref "$PROJECT_REF"

# verify_jwt=false UNIQUEMENT pour la sonde et le worker. Le worker est protégé
# par le jeton Vault `reelora_worker_token` comparé en temps constant.
supabase functions deploy reelora-health --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy reelora-video-worker --project-ref "$PROJECT_REF" --no-verify-jwt

echo "Edge Functions alignées. Vérifier : curl https://$PROJECT_REF.supabase.co/functions/v1/reelora-health"
