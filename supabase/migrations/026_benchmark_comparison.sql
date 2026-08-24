-- ============================================================================
-- 026: Benchmark Comparison - so a realized ROI number has real-world
--      context (Nifty 50 / Sensex over the same period, plus a flat FD
--      reference rate), not just an absolute percentage.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- benchmark_observations - shared market data, same RLS shape as
-- gold_price_observations: readable by every signed-in user, no
-- insert/update/delete policy for anyone but the benchmark-fetch Edge
-- Function's service-role client (bypasses RLS entirely by design).
-- ----------------------------------------------------------------------------
create table if not exists public.benchmark_observations (
  id bigint generated always as identity primary key,
  symbol text not null check (symbol in ('NIFTY50', 'SENSEX')),
  observed_date date not null,
  close_value numeric not null,
  created_at timestamptz not null default now(),
  unique (symbol, observed_date)
);

create index if not exists benchmark_observations_symbol_date_idx on public.benchmark_observations (symbol, observed_date desc);

alter table public.benchmark_observations enable row level security;

drop policy if exists "select benchmark_observations" on public.benchmark_observations;
create policy "select benchmark_observations"
  on public.benchmark_observations for select
  to authenticated
  using (true);

grant select on public.benchmark_observations to authenticated;

-- ----------------------------------------------------------------------------
-- FD rate has no clean free live-data source, so it stays a simple,
-- admin-editable static assumption rather than a fabricated "live" number -
-- same honesty pattern as every other externally-sourced number in this
-- app. app_settings already exists (022_calendar_events_email_digest_audit_toggle.sql)
-- as the one admin-only global-settings singleton.
-- ----------------------------------------------------------------------------
alter table public.app_settings add column if not exists fd_reference_rate numeric not null default 7.0;
