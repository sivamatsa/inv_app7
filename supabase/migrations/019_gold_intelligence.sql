-- ============================================================================
-- 019: Gold Intelligence (spec addendum "Gold Intelligence Layer", Sections
--      1-37) - live gold prices, historical analytics, purchase-price bands,
--      target alerts, scenario projections, and deep integration with the
--      existing Recurring Investments "Gold Scheme"/"Gold Savings" item
--      types (015_recurring.sql).
-- ============================================================================
-- This is the first feature in this project that needs a real outbound
-- HTTPS call to a third-party service with a secret API key - something
-- pure Postgres/RLS cannot do safely on its own (a key can never live in a
-- frontend-readable table or in JS). That requires a Supabase Edge Function
-- (supabase/functions/gold-price-fetch/), deployed and given its secrets by
-- the user via the Supabase CLI - a genuine, disclosed departure from "every
-- migration is the whole runbook." Everything else here (schema, RLS, the
-- alert generator, the Gold Scheme join view) is plain SQL like every prior
-- migration.
--
-- Provider research (done via live web search, not guessed) found three
-- real, usable providers, all converting international XAU spot to INR -
-- none of them are a genuine India retail/duty-adjusted rate, so every price
-- surfaced by this module must be labeled "International Spot (converted to
-- INR)" in the UI, never "Indian retail rate":
--   - metalpriceapi.com: 100 req/month free, daily updates, returns raw
--     spot only (purity math done by the Edge Function).
--   - goldapi.io: 500 req/month free, no card, returns price_gram_24k/22k/
--     18k directly (purity math already done by them).
--   - goldprice.dev/v1/carat: completely free, keyless, public - same
--     "direct per-karat fields" shape as goldapi.io. Seeded as the DEFAULT
--     active provider below specifically because it needs no signup/key at
--     all, so this module works out of the box before anyone configures
--     anything.
--
-- No admin bypass on gold_purchases/gold_alerts (private portfolio data,
-- same reasoning as deals/contacts elsewhere in this schema). gold_providers/
-- gold_settings ARE admin-writable (private.is_admin()) since choosing/
-- configuring a shared data provider is an infra decision, not personal
-- data - but readable by everyone, since the current provider/quota is
-- shared status information every user benefits from seeing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- gold_providers - one row per known provider, including any future custom
-- one. Global, not per-user: there is exactly one shared provider selection
-- and one shared request-quota budget for the whole app instance.
-- ----------------------------------------------------------------------------
create table if not exists public.gold_providers (
  key text primary key,
  kind text not null check (kind in ('metalpriceapi', 'goldapi_io', 'goldprice_dev', 'custom')),
  display_name text not null,
  requests_limit int,
  requests_used_this_period int not null default 0,
  period_reset_at date not null default (date_trunc('month', now()) + interval '1 month')::date,
  last_fetch_at timestamptz,
  last_fetch_status text not null default 'never' check (last_fetch_status in ('never', 'ok', 'error')),
  last_error text,
  -- Only populated for kind='custom'. auth_secret_name must start with
  -- GOLD_CUSTOM_ - enforced below - so this table can never be pointed at
  -- an unrelated secret the Edge Function's environment happens to have.
  custom_config jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    kind <> 'custom'
    or custom_config is null
    or (custom_config->>'auth_secret_name') is null
    or (custom_config->>'auth_secret_name') like 'GOLD_CUSTOM_%'
  )
);

alter table public.gold_providers enable row level security;

drop policy if exists "select gold_providers" on public.gold_providers;
create policy "select gold_providers"
  on public.gold_providers for select to authenticated using (true);

drop policy if exists "admin insert gold_providers" on public.gold_providers;
create policy "admin insert gold_providers"
  on public.gold_providers for insert to authenticated with check (private.is_admin());
drop policy if exists "admin update gold_providers" on public.gold_providers;
create policy "admin update gold_providers"
  on public.gold_providers for update to authenticated using (private.is_admin()) with check (private.is_admin());
drop policy if exists "admin delete gold_providers" on public.gold_providers;
create policy "admin delete gold_providers"
  on public.gold_providers for delete to authenticated using (private.is_admin());

drop trigger if exists set_gold_providers_updated_at on public.gold_providers;
create trigger set_gold_providers_updated_at
  before update on public.gold_providers
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.gold_providers to authenticated;

insert into public.gold_providers (key, kind, display_name, requests_limit)
values
  ('metalpriceapi', 'metalpriceapi', 'MetalpriceAPI', 100),
  ('goldapi_io', 'goldapi_io', 'GoldAPI.io', 500),
  ('goldprice_dev', 'goldprice_dev', 'goldprice.dev (free, no key needed)', null)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- gold_settings - a true singleton (id is always 1). Defaults to
-- goldprice.dev since that one needs no signup/API key at all, so Gold
-- Intelligence has a real, working data source before anyone configures
-- anything.
-- ----------------------------------------------------------------------------
create table if not exists public.gold_settings (
  id int primary key default 1 check (id = 1),
  active_provider_key text references public.gold_providers(key),
  refresh_cadence text not null default 'daily' check (refresh_cadence in ('daily', 'hourly', 'every_15min')),
  updated_at timestamptz not null default now()
);

alter table public.gold_settings enable row level security;

drop policy if exists "select gold_settings" on public.gold_settings;
create policy "select gold_settings"
  on public.gold_settings for select to authenticated using (true);
drop policy if exists "admin update gold_settings" on public.gold_settings;
create policy "admin update gold_settings"
  on public.gold_settings for update to authenticated using (private.is_admin()) with check (private.is_admin());

drop trigger if exists set_gold_settings_updated_at on public.gold_settings;
create trigger set_gold_settings_updated_at
  before update on public.gold_settings
  for each row execute function public.set_updated_at();

grant select, update on table public.gold_settings to authenticated;

insert into public.gold_settings (id, active_provider_key) values (1, 'goldprice_dev')
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- gold_price_observations (Section 3) - shared market data, same category as
-- investment_categories/risk_ratings: readable by everyone, writable by
-- nobody through RLS at all. Only the Edge Function's service-role key
-- (which bypasses RLS entirely) ever inserts here.
-- ----------------------------------------------------------------------------
create table if not exists public.gold_price_observations (
  id bigint generated always as identity primary key,
  provider_key text references public.gold_providers(key) on delete set null,
  price_type text not null default 'SPOT' check (price_type in ('SPOT', 'BENCHMARK', 'RETAIL')),
  purity text not null check (purity in ('24K', '22K', '21K', '20K', '18K', '16K', '14K', '10K')),
  currency text not null default 'INR',
  unit text not null default 'gram' check (unit in ('gram', 'troy_oz')),
  price numeric not null,
  observed_at timestamptz not null,
  market text,
  city text,
  is_benchmark boolean not null default false,
  is_retail boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists gold_price_observations_purity_time_idx
  on public.gold_price_observations (purity, observed_at desc);

alter table public.gold_price_observations enable row level security;

drop policy if exists "select gold_price_observations" on public.gold_price_observations;
create policy "select gold_price_observations"
  on public.gold_price_observations for select to authenticated using (true);

grant select on table public.gold_price_observations to authenticated;

-- ----------------------------------------------------------------------------
-- gold_purchases (Sections 28/29 combined) - standalone physical-gold
-- purchases outside a Gold Scheme recurring item. Personal portfolio data,
-- owner-only, no admin bypass - same category as deals/contacts.
-- ----------------------------------------------------------------------------
create table if not exists public.gold_purchases (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purchase_date date not null,
  purity text not null check (purity in ('24K', '22K', '21K', '20K', '18K', '16K', '14K', '10K')),
  -- The market price the purchase was priced against - kept separate from
  -- making_charges/gst/other_charges/discount so "raw market price" is never
  -- mistaken for "what was actually paid" (Section 29's whole point).
  price_per_gram numeric not null,
  grams numeric not null,
  net_grams numeric,
  making_charges numeric not null default 0,
  gst numeric not null default 0,
  other_charges numeric not null default 0,
  discount numeric not null default 0,
  amount_paid numeric not null,
  source text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gold_purchases_user_id_idx on public.gold_purchases (user_id);

alter table public.gold_purchases enable row level security;

drop policy if exists "select own gold_purchases" on public.gold_purchases;
create policy "select own gold_purchases"
  on public.gold_purchases for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own gold_purchases" on public.gold_purchases;
create policy "insert own gold_purchases"
  on public.gold_purchases for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own gold_purchases" on public.gold_purchases;
create policy "update own gold_purchases"
  on public.gold_purchases for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own gold_purchases" on public.gold_purchases;
create policy "delete own gold_purchases"
  on public.gold_purchases for delete to authenticated using (user_id = (select auth.uid()));

drop trigger if exists set_gold_purchases_updated_at on public.gold_purchases;
create trigger set_gold_purchases_updated_at
  before update on public.gold_purchases
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.gold_purchases to authenticated;

-- ----------------------------------------------------------------------------
-- gold_alerts (Section 11) - personal alert configuration, owner-only.
-- ----------------------------------------------------------------------------
create table if not exists public.gold_alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_type text not null check (alert_type in
    ('TARGET_PRICE_BELOW', 'TARGET_PRICE_ABOVE', 'PERCENT_DROP', 'PERCENT_RISE', 'NEW_LOW', 'NEW_HIGH')),
  target_purity text not null default '22K' check (target_purity in ('24K', '22K', '18K')),
  target_price numeric,
  target_percent numeric,
  reference_window text not null default '1D' check (reference_window in ('1D', '7D', '30D')),
  is_recurring boolean not null default false,
  is_active boolean not null default true,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists gold_alerts_user_id_idx on public.gold_alerts (user_id);

alter table public.gold_alerts enable row level security;

drop policy if exists "select own gold_alerts" on public.gold_alerts;
create policy "select own gold_alerts"
  on public.gold_alerts for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own gold_alerts" on public.gold_alerts;
create policy "insert own gold_alerts"
  on public.gold_alerts for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own gold_alerts" on public.gold_alerts;
create policy "update own gold_alerts"
  on public.gold_alerts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own gold_alerts" on public.gold_alerts;
create policy "delete own gold_alerts"
  on public.gold_alerts for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.gold_alerts to authenticated;

-- ----------------------------------------------------------------------------
-- v_gold_scheme_holdings (Sections 16/17/19) - a join into the EXISTING
-- Recurring Investments tables, not a schema change to that module.
-- recurring_occurrences.actual_units/actual_nav already exist (015_recurring.
-- sql) and are only ever written once, at confirmation time, by
-- fn_confirm_recurring_occurrence - so "never overwrite original purchase
-- prices with today's live price" (Section 19/35) is already guaranteed by
-- construction; this view just reads what's already there.
-- ----------------------------------------------------------------------------
create or replace view public.v_gold_scheme_holdings
with (security_invoker = true)
as
select
  ri.id as recurring_item_id,
  ri.user_id,
  ri.item_name,
  ri.item_type,
  coalesce(sum(ro.actual_units) filter (where ro.actual_units is not null), 0) as total_grams,
  coalesce(sum(ro.actual_amount) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID')), 0) as total_paid,
  case when coalesce(sum(ro.actual_units) filter (where ro.actual_units is not null), 0) > 0
    then sum(ro.actual_amount) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'))
         / sum(ro.actual_units) filter (where ro.actual_units is not null)
  end as avg_purchase_price,
  count(*) filter (where ro.status in ('CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID')) as confirmed_periods,
  count(*) filter (where ro.status in ('UPCOMING', 'DUE', 'IN_PROGRESS', 'OVERDUE')) as remaining_periods
from public.recurring_items ri
left join public.recurring_occurrences ro on ro.recurring_item_id = ri.id
where ri.item_type in ('Gold Scheme', 'Gold Savings')
group by ri.id, ri.user_id, ri.item_name, ri.item_type;

grant select on public.v_gold_scheme_holdings to authenticated;

-- ----------------------------------------------------------------------------
-- Notifications: reuse the existing unified table (new types), same as every
-- prior addendum - no parallel alert-delivery system.
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket', 'Recurring Reminder', 'Recurring Overdue',
                   'Contact Reminder', 'Contact Birthday', 'Contact Important Date',
                   'New Message', 'Group Message', 'Mention', 'Incoming Call', 'Missed Call',
                   'Gold Target Price', 'Gold Price Drop', 'Gold Price Rise', 'Gold New Low', 'Gold New High'));

-- ----------------------------------------------------------------------------
-- fn_gold_provider_record_fetch - called by the Edge Function (using its own
-- service-role client, which already bypasses RLS) after every attempt,
-- successful or not. Resets the monthly counter itself when the reset date
-- has passed, then does a single atomic increment - never read-then-write,
-- since a manual "Refresh Now" click racing the daily cron job is plausible.
-- ----------------------------------------------------------------------------
create or replace function public.fn_gold_provider_record_fetch(
  p_key text, p_status text, p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.gold_providers
  set
    requests_used_this_period = case when now() > period_reset_at then 1 else requests_used_this_period + 1 end,
    period_reset_at = case when now() > period_reset_at
      then (date_trunc('month', now()) + interval '1 month')::date
      else period_reset_at end,
    last_fetch_at = now(),
    last_fetch_status = p_status,
    last_error = p_error
  where key = p_key;
end;
$$;

revoke execute on function public.fn_gold_provider_record_fetch(text, text, text) from public, anon;
grant execute on function public.fn_gold_provider_record_fetch(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_gold_alerts (Section 11/24) - cron-checked, folded into the
-- existing 15-minute automation job below, same unified-notifications reuse
-- as every other reminder engine in this app. Loops each active gold_alerts
-- row against the latest observation for its target purity.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_gold_alerts()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_alert record;
  v_latest numeric;
  v_reference numeric;
  v_low_30d numeric;
  v_high_30d numeric;
  v_should_fire boolean;
  v_title text;
  v_message text;
  v_inserted int := 0;
  v_rows int;
begin
  for v_alert in select * from public.gold_alerts where is_active loop
    select price into v_latest from public.gold_price_observations
      where purity = v_alert.target_purity order by observed_at desc limit 1;
    if v_latest is null then continue; end if;

    v_should_fire := false;
    v_title := null;
    v_message := null;

    if v_alert.alert_type = 'TARGET_PRICE_BELOW' and v_alert.target_price is not null and v_latest <= v_alert.target_price then
      v_should_fire := true;
      v_title := format('Gold hit your target - %s', v_alert.target_purity);
      v_message := format('%s gold is now %s/g, at or below your target of %s/g.', v_alert.target_purity, v_latest, v_alert.target_price);
    elsif v_alert.alert_type = 'TARGET_PRICE_ABOVE' and v_alert.target_price is not null and v_latest >= v_alert.target_price then
      v_should_fire := true;
      v_title := format('Gold reached your price alert - %s', v_alert.target_purity);
      v_message := format('%s gold is now %s/g, at or above your target of %s/g.', v_alert.target_purity, v_latest, v_alert.target_price);
    elsif v_alert.alert_type in ('PERCENT_DROP', 'PERCENT_RISE') and v_alert.target_percent is not null then
      select price into v_reference from public.gold_price_observations
        where purity = v_alert.target_purity
          and observed_at <= now() - case v_alert.reference_window when '7D' then interval '7 days' when '30D' then interval '30 days' else interval '1 day' end
        order by observed_at desc limit 1;
      if v_reference is not null and v_reference > 0 then
        if v_alert.alert_type = 'PERCENT_DROP' and (v_reference - v_latest) / v_reference * 100 >= v_alert.target_percent then
          v_should_fire := true;
          v_title := format('Gold dropped %s%% - %s', v_alert.target_percent, v_alert.target_purity);
          v_message := format('%s gold fell from %s to %s/g over the last %s.', v_alert.target_purity, v_reference, v_latest, v_alert.reference_window);
        elsif v_alert.alert_type = 'PERCENT_RISE' and (v_latest - v_reference) / v_reference * 100 >= v_alert.target_percent then
          v_should_fire := true;
          v_title := format('Gold rose %s%% - %s', v_alert.target_percent, v_alert.target_purity);
          v_message := format('%s gold rose from %s to %s/g over the last %s.', v_alert.target_purity, v_reference, v_latest, v_alert.reference_window);
        end if;
      end if;
    elsif v_alert.alert_type in ('NEW_LOW', 'NEW_HIGH') then
      select min(price), max(price) into v_low_30d, v_high_30d from public.gold_price_observations
        where purity = v_alert.target_purity and observed_at >= now() - interval '30 days';
      if v_alert.alert_type = 'NEW_LOW' and v_low_30d is not null and v_latest <= v_low_30d then
        v_should_fire := true;
        v_title := format('New 30-day low - %s gold', v_alert.target_purity);
        v_message := format('%s gold touched a new 30-day low of %s/g.', v_alert.target_purity, v_latest);
      elsif v_alert.alert_type = 'NEW_HIGH' and v_high_30d is not null and v_latest >= v_high_30d then
        v_should_fire := true;
        v_title := format('New 30-day high - %s gold', v_alert.target_purity);
        v_message := format('%s gold touched a new 30-day high of %s/g.', v_alert.target_purity, v_latest);
      end if;
    end if;

    if v_should_fire then
      insert into public.notifications (user_id, type, title, message, priority, dedupe_key)
      values (
        v_alert.user_id,
        case v_alert.alert_type
          when 'TARGET_PRICE_BELOW' then 'Gold Target Price' when 'TARGET_PRICE_ABOVE' then 'Gold Target Price'
          when 'PERCENT_DROP' then 'Gold Price Drop' when 'PERCENT_RISE' then 'Gold Price Rise'
          when 'NEW_LOW' then 'Gold New Low' else 'Gold New High' end,
        v_title, v_message, 'Medium',
        'Gold Alert' || '|' || v_alert.id::text || '|' || '' || '|' || '' || '|' || current_date::text
      )
      on conflict (user_id, dedupe_key) do nothing;
      get diagnostics v_rows = row_count;
      v_inserted := v_inserted + v_rows;

      update public.gold_alerts set last_triggered_at = now(), is_active = (is_recurring) where id = v_alert.id;
    end if;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_gold_alerts() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Cron: fold this file's alert generator into the existing 15-minute job -
-- one job, one cadence, same idiom every prior addendum has used to extend
-- 010_cron.sql's original job. (Fetching the actual gold price is NOT here -
-- that's the Edge Function's job, scheduled separately via a Supabase
-- Dashboard Cron Job pointed at it, since pure SQL cannot make an outbound
-- HTTPS call - see README.)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'portfolio-automation-15min') then
    perform cron.unschedule('portfolio-automation-15min');
  end if;
end $$;

select cron.schedule(
  'portfolio-automation-15min',
  '*/15 * * * *',
  $$
  select public.fn_refresh_schedule_statuses();
  select public.fn_generate_reminders();
  select public.fn_generate_ai_insights();
  select public.fn_generate_recurring_occurrences_all();
  select public.fn_refresh_recurring_statuses();
  select public.fn_generate_recurring_reminders();
  select public.fn_generate_contact_reminders();
  select public.fn_refresh_call_statuses();
  select public.fn_generate_gold_alerts();
  $$
);
