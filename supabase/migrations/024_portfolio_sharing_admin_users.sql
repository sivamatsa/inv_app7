-- ============================================================================
-- 024: True peer/family portfolio sharing (Viewer-only) + admin user
--      management (deactivate/reactivate/delete/create).
-- ============================================================================
-- shared_portfolios/portfolio_members (007_optional_tables.sql) have existed
-- since the very first build, explicitly flagged as "created so the feature
-- has a home" but never wired into any other table's RLS. This migration is
-- that deferred wiring - Viewer-only (read access), not the full Owner/
-- Editor/Viewer role model the table already has columns for: giving a
-- second person write access into someone else's deal/payment CRUD flows is
-- a materially bigger surface than what was actually asked for ("let a
-- spouse SEE a portfolio"). Editor stays reserved for later.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The "switch" - an owner (or admin, on their behalf) can flip sharing off
-- without deleting the membership rows, so re-enabling later doesn't mean
-- re-inviting everyone.
-- ----------------------------------------------------------------------------
alter table public.shared_portfolios add column if not exists is_active boolean not null default true;

-- ----------------------------------------------------------------------------
-- Admin can manage sharing directly (create a shared portfolio for any
-- user, add/remove members, flip the switch) rather than only each owner
-- managing their own - same "admin bypass added as one more OR-clause"
-- technique 013_admin_role.sql already used for SELECT; here it's needed on
-- insert/update/delete too since admin is meant to actively manage this,
-- not just view it.
-- ----------------------------------------------------------------------------
drop policy if exists "insert own shared_portfolios" on public.shared_portfolios;
create policy "insert own shared_portfolios"
  on public.shared_portfolios for insert to authenticated
  with check (owner_user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "update own shared_portfolios" on public.shared_portfolios;
create policy "update own shared_portfolios"
  on public.shared_portfolios for update to authenticated
  using (owner_user_id = (select auth.uid()) or private.is_admin())
  with check (owner_user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "delete own shared_portfolios" on public.shared_portfolios;
create policy "delete own shared_portfolios"
  on public.shared_portfolios for delete to authenticated
  using (owner_user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "owner manages membership" on public.portfolio_members;
create policy "owner manages membership"
  on public.portfolio_members for all to authenticated
  using (
    portfolio_id in (select id from public.shared_portfolios where owner_user_id = (select auth.uid()))
    or private.is_admin()
  )
  with check (
    portfolio_id in (select id from public.shared_portfolios where owner_user_id = (select auth.uid()))
    or private.is_admin()
  );

-- ----------------------------------------------------------------------------
-- private.has_portfolio_view_access() - the Viewer-side counterpart to
-- private.is_admin(), same SECURITY DEFINER/STABLE shape. True for your own
-- data, for admin, or for an ACTIVE shared portfolio you're a member of.
-- ----------------------------------------------------------------------------
create or replace function private.has_portfolio_view_access(p_target_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    p_target_user_id = (select auth.uid())
    or private.is_admin()
    or exists (
      select 1
      from public.shared_portfolios sp
      join public.portfolio_members pm on pm.portfolio_id = sp.id
      where sp.owner_user_id = p_target_user_id
        and sp.is_active
        and pm.member_user_id = (select auth.uid())
    );
$$;

revoke execute on function private.has_portfolio_view_access(uuid) from public, anon;
grant execute on function private.has_portfolio_view_access(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Extend the same seven portfolio-data tables' SELECT policies with the new
-- helper, exactly the drop/create idiom 013_admin_role.sql used for
-- private.is_admin(). gold_purchases previously had NO admin bypass either
-- (019_gold_intelligence.sql's own comment called this "same reasoning as
-- deals/contacts," which doesn't actually hold - deals has an admin bypass,
-- contacts deliberately doesn't; gold_purchases belongs with deals, not
-- contacts) - both bypasses are added together here since they're the same
-- one-line fix. gold_alerts is left untouched: it's a personal alert
-- configuration, not portfolio holdings, same category as
-- notification_preferences.
-- ----------------------------------------------------------------------------
drop policy if exists "select own deals" on public.deals;
create policy "select own deals"
  on public.deals for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "select own payment_schedule" on public.payment_schedule;
create policy "select own payment_schedule"
  on public.payment_schedule for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "select own payments" on public.payments;
create policy "select own payments"
  on public.payments for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "select own reinvestments" on public.reinvestments;
create policy "select own reinvestments"
  on public.reinvestments for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "select own recurring_items" on public.recurring_items;
create policy "select own recurring_items"
  on public.recurring_items for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "select own recurring_occurrences" on public.recurring_occurrences;
create policy "select own recurring_occurrences"
  on public.recurring_occurrences for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "select own gold_purchases" on public.gold_purchases;
create policy "select own gold_purchases"
  on public.gold_purchases for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

-- security_invoker views over these tables (v_deal_metrics, v_recurring_summary,
-- v_recurring_consistency, v_gold_scheme_holdings) need no separate change -
-- they already run under the caller's own row-visibility on the base tables
-- above, so the new OR-clause takes effect through them automatically.

-- ----------------------------------------------------------------------------
-- profiles.is_active - a fast, RLS-visible mirror of the real Supabase Auth
-- ban state (set by admin-user-management's service-role calls, never by
-- the app directly). The actual sign-in block is enforced by Supabase Auth
-- itself (auth.admin.updateUserById ban_duration) - this column exists so
-- the Admin page can show status without a service-role round trip on
-- every page load, not so this column alone can be trusted as the boundary.
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists is_active boolean not null default true;
