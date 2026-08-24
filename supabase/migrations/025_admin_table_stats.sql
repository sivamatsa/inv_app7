-- ============================================================================
-- 025: Database Health - one admin-only function so the Admin page can show
--      "how many rows and how much space does each table actually use"
--      without the user having to leave the app and dig through the
--      Supabase Dashboard's own Database section.
-- ============================================================================
-- Row counts come from pg_stat_user_tables.n_live_tup - a planner estimate
-- kept up to date by autovacuum, not a live COUNT(*) - deliberately, so
-- checking this never triggers a full table scan on a table someone is
-- specifically wondering whether to archive. Good enough for "which tables
-- are basically empty," which is the actual question being answered.
-- No "last used" column: Postgres doesn't track per-table last-access time
-- by default, and adding that instrumentation is a distinct, heavier
-- feature than what was asked for here.
-- ============================================================================

create or replace function public.fn_admin_table_stats()
returns table (table_name text, estimated_rows bigint, total_size_bytes bigint, total_size_pretty text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only an admin can run this.';
  end if;
  -- set search_path = '' means every system object below must be fully
  -- schema-qualified (pg_catalog.*) too, not just public.* ones - an
  -- unqualified pg_stat_user_tables/pg_total_relation_size would fail to
  -- resolve at all under an empty search_path.
  return query
    select
      s.relname::text as table_name,
      s.n_live_tup as estimated_rows,
      pg_catalog.pg_total_relation_size(s.relid) as total_size_bytes,
      pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(s.relid)) as total_size_pretty
    from pg_catalog.pg_stat_user_tables s
    where s.schemaname = 'public'
    order by pg_catalog.pg_total_relation_size(s.relid) desc;
end;
$$;

revoke execute on function public.fn_admin_table_stats() from public, anon;
grant execute on function public.fn_admin_table_stats() to authenticated;
