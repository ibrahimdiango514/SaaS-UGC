-- Artefacts versionnés des Edge Functions chargées à froid.
--
-- Pourquoi : le canal de déploiement disponible altère les sources longues
-- (incident business-grow v18 : corps inline de 17 Ko arrivé corrompu ⇒
-- WORKER_ERROR). La source déployée est donc un chargeur court
-- (`supabase/functions/business-grow/loader.ts`) qui lit ici le bundle exact du
-- dépôt (`supabase/functions/business-grow.edge.js`) et vérifie taille +
-- SHA-256 avant de l'exécuter.
--
-- Différence avec `public._edge_deploy_artifact` (reelora-video, une seule
-- fonction, tranches sans version) : la clé est (name, sha256). Publier une
-- nouvelle version n'écrase jamais celle que le chargeur en service attend, et
-- un retour arrière consiste à redéployer le chargeur précédent.
--
-- Contenu : uniquement du code déjà versionné dans le dépôt. Aucune donnée
-- utilisateur, aucun secret. Lecture par service_role uniquement.
create table if not exists public._edge_function_artifact (
  name text not null,
  sha256 text not null,
  chars integer not null,
  source text not null,
  source_ref text,
  created_at timestamptz not null default now(),
  primary key (name, sha256),
  -- La base recalcule l'empreinte : une ligne ne peut pas annoncer un SHA-256
  -- ou une taille qui ne correspondent pas à son contenu.
  constraint _edge_function_artifact_digest_check
    check (sha256 = encode(extensions.digest(convert_to(source, 'UTF8'), 'sha256'), 'hex')),
  constraint _edge_function_artifact_chars_check
    check (chars = char_length(source))
);

comment on table public._edge_function_artifact is
  'Bundles Edge versionnes (nom + SHA-256), lus a froid par les chargeurs et verifies avant execution.';
comment on column public._edge_function_artifact.source_ref is
  'Provenance : commit Git et chemin du bundle publie.';

alter table public._edge_function_artifact enable row level security;
revoke all on public._edge_function_artifact from public, anon, authenticated;
grant select on public._edge_function_artifact to service_role;

notify pgrst, 'reload schema';
