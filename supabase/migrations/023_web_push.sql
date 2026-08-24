-- ============================================================================
-- 023: Web Push notifications - the PWA's service worker (installed in the
--      earlier PWA addendum) has sat there able to receive push but with
--      nothing ever sending one. This adds the subscription-storage side;
--      the sending side is the new send-web-push Edge Function (deployed
--      separately, see README) using real VAPID keys generated for this
--      build (also in the README) via npm:web-push - no hand-rolled crypto.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- push_subscriptions - one row per browser/device a user has enabled push
-- on (the same endpoint/keys the Push API's subscribe() call returns).
-- Owner-only, no admin bypass - a push subscription's endpoint URL is
-- effectively a bearer credential for delivering to that specific device;
-- there's no legitimate reason for anyone but the owning user to read it.
-- ----------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "select own push_subscriptions" on public.push_subscriptions;
create policy "select own push_subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own push_subscriptions" on public.push_subscriptions;
create policy "insert own push_subscriptions"
  on public.push_subscriptions for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own push_subscriptions" on public.push_subscriptions;
create policy "delete own push_subscriptions"
  on public.push_subscriptions for delete
  to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, delete on public.push_subscriptions to authenticated;
grant usage, select on sequence public.push_subscriptions_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- Idempotency + opt-in flag, same shape as email_sent_at/email_frequency
-- (021/022) - push is a separate channel with its own on/off switch, not
-- tied to the email cadence.
-- ----------------------------------------------------------------------------
alter table public.notifications add column if not exists push_sent_at timestamptz;
alter table public.notification_preferences add column if not exists push_enabled boolean not null default false;
