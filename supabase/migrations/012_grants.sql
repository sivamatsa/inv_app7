-- ============================================================================
-- 012: explicit privilege grants
-- ============================================================================
-- Every earlier migration enabled RLS and wrote policies, but RLS only
-- controls which ROWS a role can see once it can reach the table at all -
-- it does not grant table-level access by itself. Supabase's Data API used
-- to expose new public-schema tables to anon/authenticated automatically;
-- that default is being phased out (opt-in required going forward), so this
-- migration makes the grants explicit rather than relying on it. Without
-- this, every request from the app can fail even though RLS is configured
-- correctly - a missing GRANT and a missing RLS policy produce the same
-- symptom (access denied / relation not reachable) but need different fixes.
--
-- This app requires sign-in for everything - there is no signed-out feature
-- surface - so nothing is granted to `anon`. RLS remains the real security
-- boundary for every operation; these grants only open the door that RLS
-- then filters.
-- ============================================================================

grant usage on schema public to authenticated;

grant select, insert, update, delete on table
  public.profiles,
  public.platforms,
  public.deals,
  public.payment_schedule,
  public.payments,
  public.reinvestments,
  public.notifications,
  public.notification_preferences,
  public.documents,
  public.audit_logs,
  public.imports,
  public.portfolio_goals,
  public.cash_transactions,
  public.investment_categories,
  public.risk_ratings,
  public.bank_transactions,
  public.payment_matches,
  public.tax_records,
  public.ai_insights,
  public.scenario_simulations,
  public.integration_configs,
  public.shared_portfolios,
  public.portfolio_members
to authenticated;

-- Views need their own grant independent of the underlying tables.
grant select on public.v_deal_metrics, public.v_portfolio_summary to authenticated;

-- RPC functions called directly by the app (SECURITY INVOKER - the grant
-- lets a user reach the function at all; the function body's own queries
-- are still subject to every table's RLS policies as that user).
grant execute on function public.fn_generate_payment_schedule(bigint) to authenticated;
grant execute on function public.fn_record_payment(
  bigint, date, numeric, numeric, numeric, numeric, numeric, text, text, text, text, bigint
) to authenticated;

-- The nightly-automation functions stay locked down (009_functions.sql
-- already revokes these from public/anon/authenticated - repeated here so
-- this file is a complete, correct picture on its own, not because the
-- earlier revoke needs redoing):
revoke execute on function public.fn_refresh_schedule_statuses() from public, anon, authenticated;
revoke execute on function public.fn_generate_reminders() from public, anon, authenticated;
revoke execute on function public.fn_generate_ai_insights() from public, anon, authenticated;
