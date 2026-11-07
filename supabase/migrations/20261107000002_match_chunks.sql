-- ============================================================
-- ClinicDesk — Vector Search Function (match_chunks)
-- Week 4, Part A
-- ============================================================

create or replace function public.match_chunks(
  p_clinic_id        uuid,
  p_query_embedding  extensions.vector(1536),
  p_match_count      int default 4
)
returns table (
  id             uuid,
  document_id    uuid,
  document_title text,
  content        text,
  page           int,
  similarity     float
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    d.title as document_title,
    c.content,
    c.page,
    -- Cosine similarity = 1 - cosine distance (<=> operator)
    (1 - (c.embedding <=> p_query_embedding))::float as similarity
  from public.chunks c
  inner join public.documents d on d.id = c.document_id
  where c.clinic_id = p_clinic_id
    and d.clinic_id = p_clinic_id
    and c.embedding is not null
  -- Order by cosine distance ascending so Postgres can utilize chunks_embedding_hnsw index
  order by c.embedding <=> p_query_embedding asc
  limit least(greatest(coalesce(p_match_count, 4), 1), 10);
$$;

-- Revoke execute from public, anon, and authenticated; grant only to service_role
revoke all on function public.match_chunks(uuid, extensions.vector(1536), int) from public;
revoke execute on function public.match_chunks(uuid, extensions.vector(1536), int) from anon, authenticated;
grant execute on function public.match_chunks(uuid, extensions.vector(1536), int) to service_role;

