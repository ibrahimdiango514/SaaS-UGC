-- ============================================================================
-- 20261115120000 · VYORA AI CORE — fix `ai_memory_search` (tsquery)
--
-- La migration 20261115100000 construisait la requête de recherche en
-- tsvector et l'utilisait là où PostgreSQL exige un TSQUERY :
--   ts_rank_cd(v_query_tsv, m.search_tsv)  →  function does not exist
--   m.search_tsv @@ v_query_tsv            →  opérateur inconnu
-- Toute recherche de mémoire levait donc une exception ; la conversation
-- restait opérationnelle (best-effort) mais la MÉMORISATION était annulée
-- (la recherche de versionnage précédant l'écriture échouait).
--
-- Correction : plainto_tsquery('simple', …) sur la requête brute — robuste
-- à n'importe quel texte utilisateur (pas de parse error possible).
-- Même signature, mêmes privilèges : CREATE OR REPLACE conserve l'ACL
-- (EXECUTE réservé bg_edge, cf. 20261115100000).
-- ============================================================================

create or replace function saas_business.ai_memory_search(
  p_user_id uuid,
  p_workspace_id uuid,
  p_query text,
  p_embedding double precision[],
  p_limit integer,
  p_categories text[]
) returns table (
  id uuid, category text, title text, content text, confidence text,
  score double precision, created_at timestamptz
)
language plpgsql security definer stable set search_path = pg_catalog, saas_business, saas_ugc as $$
declare
  v_limit integer;
  v_query tsquery;
begin
  v_limit := coalesce(nullif(p_limit, 0), 8);
  if v_limit < 1 or v_limit > 25 then v_limit := 8; end if;
  perform saas_business.bg_assert_workspace_access(p_user_id, p_workspace_id);
  v_query := plainto_tsquery('simple', coalesce(btrim(p_query), ''));

  return query
  select m.id, m.category, m.title, m.content, m.confidence,
         (case when p_embedding is null
               then 0.60 * ts_rank_cd(m.search_tsv, v_query)
                    + 0.40 * exp(-extract(epoch from (now() - m.created_at)) / (90.0 * 86400))
               else 0.45 * ts_rank_cd(m.search_tsv, v_query)
                    + 0.30 * exp(-extract(epoch from (now() - m.created_at)) / (90.0 * 86400))
                    + 0.25 * coalesce(saas_business.cosine_similarity(m.embedding, p_embedding), 0)
          end)
         * (case m.confidence when 'fact' then 1.0 when 'hypothesis' then 0.85 else 0.70 end) as score,
         m.created_at
  from saas_business.ai_memories m
  where m.deleted_at is null
    and m.superseded_by is null
    and (m.valid_until is null or m.valid_until > now())
    and (
      m.user_id = p_user_id
      or (p_workspace_id is not null and m.workspace_id = p_workspace_id)
    )
    and (p_categories is null or m.category = any(p_categories))
    and m.search_tsv @@ v_query
  order by score desc, m.created_at desc
  limit v_limit;
end $$;
