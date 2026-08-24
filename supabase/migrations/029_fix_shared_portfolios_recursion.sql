-- ============================================================================
-- 029: Fix "infinite recursion detected in policy for relation
--      shared_portfolios" - the exact same mutual cross-table RLS
--      recursion class already hit and fixed once for
--      conversations/conversation_members (017_chat.sql).
-- ============================================================================
-- shared_portfolios' own SELECT policy (013_admin_role.sql) subqueries
-- portfolio_members ("am I a member of this portfolio"), and
-- portfolio_members' SELECT policy (007/013) subqueries shared_portfolios
-- right back ("am I the owner of this portfolio's row") - a genuine
-- mutual two-table cycle, present since the very first migration that
-- created these tables. It went undetected until now because nothing in
-- the app actually queried either table until this addendum's Admin ->
-- Shared Portfolios panel became the first real caller.
--
-- Fix: the same technique used for conversations - two small SECURITY
-- DEFINER helper functions, opaque to the planner's own qual-expansion
-- pass, so checking one table's policy no longer requires re-expanding
-- the other table's policy inline.
-- ============================================================================

create or replace function private.is_portfolio_owner(p_portfolio_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.shared_portfolios sp
    where sp.id = p_portfolio_id and sp.owner_user_id = (select auth.uid())
  );
$$;

create or replace function private.is_portfolio_member(p_portfolio_id bigint)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.portfolio_members pm
    where pm.portfolio_id = p_portfolio_id and pm.member_user_id = (select auth.uid())
  );
$$;

revoke execute on function private.is_portfolio_owner(bigint) from public, anon;
grant execute on function private.is_portfolio_owner(bigint) to authenticated;
revoke execute on function private.is_portfolio_member(bigint) from public, anon;
grant execute on function private.is_portfolio_member(bigint) to authenticated;

-- shared_portfolios: replace the direct portfolio_members subquery with
-- the helper.
drop policy if exists "select owned or member portfolios" on public.shared_portfolios;
create policy "select owned or member portfolios"
  on public.shared_portfolios for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or private.is_portfolio_member(id)
    or private.is_admin()
  );

-- portfolio_members: replace the direct shared_portfolios subquery with
-- the helper, in both its SELECT policy and its "owner manages
-- membership" ALL policy (024_portfolio_sharing_admin_users.sql) - that
-- one had the exact same direct-subquery shape and would recurse just as
-- badly on insert/update/delete.
drop policy if exists "select own membership or as owner" on public.portfolio_members;
create policy "select own membership or as owner"
  on public.portfolio_members for select to authenticated
  using (
    member_user_id = (select auth.uid())
    or private.is_portfolio_owner(portfolio_id)
    or private.is_admin()
  );

drop policy if exists "owner manages membership" on public.portfolio_members;
create policy "owner manages membership"
  on public.portfolio_members for all to authenticated
  using (private.is_portfolio_owner(portfolio_id) or private.is_admin())
  with check (private.is_portfolio_owner(portfolio_id) or private.is_admin());
