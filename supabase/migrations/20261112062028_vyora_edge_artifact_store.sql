-- Réplique locale de la migration appliquée en production
-- `vyora_edge_artifact_store` (version 20261112062028).
--
-- `public._edge_deploy_artifact` stocke le code métier de `reelora-video`
-- (43 Ko) par tranches gzip+base64. Le chargeur déployé
-- (`supabase/functions/reelora-video/bootstrap.ts`) relit ces tranches à froid,
-- vérifie la taille et le SHA-256 avant d'évaluer le module.
--
-- Contenu : uniquement du code déjà versionné dans le dépôt
-- (`supabase/functions/reelora-video.edge.js`). Aucune donnée utilisateur,
-- aucun secret. Accès service_role uniquement.
create table if not exists public._edge_deploy_artifact (
  seq int primary key,
  chunk text not null,
  created_at timestamptz not null default now()
);

comment on table public._edge_deploy_artifact is
  'Artefact Edge reelora-video (tranches gzip+base64). Utilise par le chargeur runtime, verifie par SHA-256.';

alter table public._edge_deploy_artifact enable row level security;
revoke all on public._edge_deploy_artifact from public, anon, authenticated;
grant select, insert, delete on public._edge_deploy_artifact to service_role;
