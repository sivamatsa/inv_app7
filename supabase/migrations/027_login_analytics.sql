-- ============================================================================
-- 027: Login/visit analytics, visible to admin only.
-- ============================================================================
-- Scope decision, stated plainly rather than built silently either way: the
-- original request included "if consent is rejected, take available
-- information anyway." That defeats the point of asking, so it is NOT built
-- that way here - consent_given=false still logs a row (so "logins today"
-- counts stay accurate), but the app only ever calls the logging Edge
-- Function with IP/geo/device fields omitted when the user declined. This
-- is the one place in this migration batch where the built behavior
-- deliberately differs from the literal request - flagged for the user to
-- push back on if they actually want it collected regardless.
-- ============================================================================

alter table public.profiles add column if not exists analytics_consent boolean;

-- ----------------------------------------------------------------------------
-- login_events - deliberately the most locked-down table in this schema:
-- no SELECT policy for regular users at all (admin-only), no INSERT policy
-- for anyone (only the log-login Edge Function's service-role client ever
-- writes a row, tied to the caller's own verified auth.uid() at write time -
-- there is nothing for a regular `authenticated` policy to grant either
-- direction, same shape as gold_price_observations but for select instead
-- of write).
-- ----------------------------------------------------------------------------
create table if not exists public.login_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  ip_address text,
  city text,
  region text,
  country text,
  user_agent text,
  browser text,
  os text,
  device_type text,
  consent_given boolean not null
);

create index if not exists login_events_user_id_idx on public.login_events (user_id);
create index if not exists login_events_occurred_at_idx on public.login_events (occurred_at desc);

alter table public.login_events enable row level security;

drop policy if exists "admin select login_events" on public.login_events;
create policy "admin select login_events"
  on public.login_events for select
  to authenticated
  using (private.is_admin());

grant select on public.login_events to authenticated;
