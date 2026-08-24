-- ============================================================================
-- 013: Admin role - read-only cross-user visibility
-- ============================================================================
-- New users registering and signing in already worked before this file:
-- Supabase Auth handles signup, and handle_new_user() (003_profiles_platforms_deals.sql)
-- already provisions a profiles row automatically, with every table's
-- existing RLS already isolating each user to their own rows. What this
-- file adds is a way for one designated user (admin) to also READ every
-- other user's rows - it does not change what a regular user can do at all.
--
-- Deliberately read-only for admin: every policy touched here is a SELECT
-- policy only. INSERT/UPDATE/DELETE policies are untouched, so an admin
-- still cannot modify another user's financial records through the app -
-- only view them. If write access for admin is wanted later, that is a
-- separate, explicit decision, not a side effect of this migration.
-- ============================================================================

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- The private schema is created here, first, before anything below
-- references it (protect_is_admin() and is_admin() both live in it) -
-- referencing a schema-qualified name before the schema exists fails with
-- "schema does not exist", the same class of ordering bug fixed in
-- 007_optional_tables.sql for shared_portfolios/portfolio_members.
create schema if not exists private;
grant usage on schema private to authenticated;

-- ----------------------------------------------------------------------------
-- Close a real privilege-escalation gap before it can be used: the existing
-- "update own profile" policy (003_profiles_platforms_deals.sql) restricts
-- which ROW a user can update (their own), not which COLUMNS - RLS has no
-- column-level granularity. The app's UI never exposes is_admin as
-- editable, but that's not a security boundary: any signed-in user could
-- otherwise call the update endpoint directly
-- (`supabase.from('profiles').update({is_admin: true}).eq('id', myOwnId)`)
-- and RLS would allow it, since it is their own row. This trigger silently
-- reverts any attempted change to is_admin that arrives via the normal
-- `authenticated` role (i.e. through the app/PostgREST), while still
-- allowing the one-time manual SQL statement below (run from the SQL
-- Editor, which connects as a different role) to actually work.
-- ----------------------------------------------------------------------------
create or replace function private.protect_is_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_admin is distinct from old.is_admin and current_user = 'authenticated' then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_is_admin_column on public.profiles;
create trigger protect_is_admin_column
  before update on public.profiles
  for each row execute function private.protect_is_admin();

-- ----------------------------------------------------------------------------
-- private.is_admin(): SECURITY DEFINER so it can read profiles.is_admin
-- regardless of the caller's own RLS, but it only ever checks the CALLING
-- user's own row (auth.uid(), no parameter to pass someone else's id) - it
-- cannot be used to probe whether an arbitrary other user is an admin.
-- Kept in a non-exposed `private` schema per the RLS-performance pattern:
-- indexed lookup, not a per-row function call, and not reachable directly
-- by anon/authenticated.
-- ----------------------------------------------------------------------------
create or replace function private.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = (select auth.uid())), false);
$$;

revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- Extend every user-owned table's SELECT policy with "or private.is_admin()".
-- investment_categories and risk_ratings are intentionally not touched -
-- they're shared taxonomy, already readable by every signed-in user, not
-- personal data that needed owner-restriction in the first place.
-- ----------------------------------------------------------------------------

drop policy if exists "select own profile" on public.profiles;
create policy "select own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own platforms" on public.platforms;
create policy "select own platforms"
  on public.platforms for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own deals" on public.deals;
create policy "select own deals"
  on public.deals for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own payment_schedule" on public.payment_schedule;
create policy "select own payment_schedule"
  on public.payment_schedule for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own payments" on public.payments;
create policy "select own payments"
  on public.payments for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own reinvestments" on public.reinvestments;
create policy "select own reinvestments"
  on public.reinvestments for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own notifications" on public.notifications;
create policy "select own notifications"
  on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own notification_preferences" on public.notification_preferences;
create policy "select own notification_preferences"
  on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own documents" on public.documents;
create policy "select own documents"
  on public.documents for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own imports" on public.imports;
create policy "select own imports"
  on public.imports for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own audit_logs" on public.audit_logs;
create policy "select own audit_logs"
  on public.audit_logs for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own portfolio_goals" on public.portfolio_goals;
create policy "select own portfolio_goals"
  on public.portfolio_goals for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own cash_transactions" on public.cash_transactions;
create policy "select own cash_transactions"
  on public.cash_transactions for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own bank_transactions" on public.bank_transactions;
create policy "select own bank_transactions"
  on public.bank_transactions for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own payment_matches" on public.payment_matches;
create policy "select own payment_matches"
  on public.payment_matches for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own tax_records" on public.tax_records;
create policy "select own tax_records"
  on public.tax_records for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own ai_insights" on public.ai_insights;
create policy "select own ai_insights"
  on public.ai_insights for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own scenario_simulations" on public.scenario_simulations;
create policy "select own scenario_simulations"
  on public.scenario_simulations for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select own integration_configs" on public.integration_configs;
create policy "select own integration_configs"
  on public.integration_configs for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "select owned or member portfolios" on public.shared_portfolios;
create policy "select owned or member portfolios"
  on public.shared_portfolios for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or id in (select portfolio_id from public.portfolio_members where member_user_id = (select auth.uid()))
    or private.is_admin()
  );

drop policy if exists "select own membership or as owner" on public.portfolio_members;
create policy "select own membership or as owner"
  on public.portfolio_members for select to authenticated
  using (
    member_user_id = (select auth.uid())
    or portfolio_id in (select id from public.shared_portfolios where owner_user_id = (select auth.uid()))
    or private.is_admin()
  );

-- Storage: admin can view/download any user's documents, same read-only
-- reasoning as every table above (no insert/update/delete grant for admin).
drop policy if exists "select own documents in storage" on storage.objects;
create policy "select own documents in storage"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and ((select auth.uid())::text = (storage.foldername(name))[1] or private.is_admin()));

-- ----------------------------------------------------------------------------
-- Make yourself admin (run this once, manually, after this migration):
--
--   update public.profiles set is_admin = true where email = 'your@email.com';
--
-- Intentionally not automated - deciding who is admin is a one-time human
-- call, not something a migration should guess at.
-- ----------------------------------------------------------------------------
