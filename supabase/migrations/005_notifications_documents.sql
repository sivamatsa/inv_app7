-- ============================================================================
-- 005: notifications, notification_preferences, documents
-- ============================================================================

-- ----------------------------------------------------------------------------
-- notifications (spec Section 11; `type` uses Section 10's explicit reminder
-- type list, `channel` uses Section 11's explicit channel list)
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id bigint references public.deals(id) on delete cascade,
  -- Most reminder types (Payment Due/Overdue, Maturity Approaching, ...) are
  -- about an EXPECTED event, so they're naturally about a payment_schedule
  -- row, not yet an actual payment. schedule_id covers that case; payment_id
  -- (named directly in spec Section 11) is kept for notifications about a
  -- real, already-recorded payment.
  schedule_id bigint references public.payment_schedule(id) on delete cascade,
  payment_id bigint references public.payments(id) on delete cascade,

  type text not null
    check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                     'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                     'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting')),
  title text not null,
  message text not null,
  -- Not enumerated by the spec; left as free text rather than an invented
  -- closed list. App convention: 'Low' | 'Medium' | 'High' | 'Urgent'.
  priority text not null default 'Medium',
  channel text not null default 'In-app'
    check (channel in ('In-app', 'Email', 'Push', 'WhatsApp', 'Telegram')),
  -- Not enumerated by the spec; app convention: 'Pending' | 'Sent' | 'Read' | 'Dismissed' | 'Failed'.
  -- Only 'In-app' is actually delivered by this build (see README) - Email/
  -- Push/WhatsApp/Telegram rows are created but need a server-side sender
  -- wired up separately since no secret-holding backend exists here.
  status text not null default 'Pending',

  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz,

  -- Keeps the nightly reminder generator (009_functions.sql) idempotent: two
  -- runs on the same calendar day for the same event+type never duplicate,
  -- but the same event at a different lead time (e.g. day -7 vs day -3
  -- before the same payment) is a genuinely different row.
  --
  -- Computed explicitly by the inserting function (009_functions.sql), not
  -- a generated column: a generated column's expression must be IMMUTABLE,
  -- but bucketing a timestamptz by calendar day is inherently timezone-
  -- dependent - date_trunc() on a timestamptz is STABLE at best, and no
  -- amount of rewriting the expression changes that, since the volatility
  -- is fixed on the function itself. A plain column has no such
  -- restriction; ordinary INSERT/SELECT statements are free to use STABLE
  -- functions like date_trunc() and now().
  dedupe_key text not null,

  created_at timestamptz not null default now(),

  unique (user_id, dedupe_key)
);

create index if not exists notifications_user_id_idx on public.notifications (user_id);
create index if not exists notifications_deal_id_idx on public.notifications (deal_id);
create index if not exists notifications_schedule_id_idx on public.notifications (schedule_id);
create index if not exists notifications_payment_id_idx on public.notifications (payment_id);
create index if not exists notifications_scheduled_at_idx on public.notifications (scheduled_at);
create index if not exists notifications_status_idx on public.notifications (status);

alter table public.notifications enable row level security;

drop policy if exists "select own notifications" on public.notifications;
create policy "select own notifications"
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own notifications" on public.notifications;
create policy "insert own notifications"
  on public.notifications for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own notifications" on public.notifications;
create policy "update own notifications"
  on public.notifications for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own notifications" on public.notifications;
create policy "delete own notifications"
  on public.notifications for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- notification_preferences (spec Section 10 "Allow per-user customization")
-- One row per user.
-- ----------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reminder_offset_days jsonb not null default '[-7,-3,-1,0,1,3,7,30]'::jsonb,
  channels_enabled jsonb not null default '{"In-app": true, "Email": false, "Push": false, "WhatsApp": false, "Telegram": false}'::jsonb,
  -- Null = app falls back to a computed heuristic (top decile of this
  -- user's expected payments) rather than a fixed number the spec never gave.
  large_payment_threshold numeric(14, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

drop policy if exists "select own notification_preferences" on public.notification_preferences;
create policy "select own notification_preferences"
  on public.notification_preferences for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own notification_preferences" on public.notification_preferences;
create policy "insert own notification_preferences"
  on public.notification_preferences for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own notification_preferences" on public.notification_preferences;
create policy "update own notification_preferences"
  on public.notification_preferences for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop trigger if exists set_notification_preferences_updated_at on public.notification_preferences;
create trigger set_notification_preferences_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- documents (spec Section 29 - metadata table; the files themselves live in
-- Supabase Storage, wired up in 011_storage.sql)
-- ----------------------------------------------------------------------------
create table if not exists public.documents (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id bigint references public.deals(id) on delete cascade,
  payment_id bigint references public.payments(id) on delete set null,

  document_type text not null
    check (document_type in ('Investment Agreement', 'Payment Receipt', 'Lender Statement', 'Bank Statement',
                              'Maturity Statement', 'Tax Certificate', 'Screenshot', 'Other')),
  document_reference text,
  document_date date,
  notes text,

  -- Path within the `documents` storage bucket, convention
  -- `{user_id}/{deal_id-or-general}/{filename}` (enforced by storage RLS in 011).
  storage_path text not null,
  file_name text not null,
  file_size_bytes bigint,
  mime_type text,

  created_at timestamptz not null default now()
);

create index if not exists documents_user_id_idx on public.documents (user_id);
create index if not exists documents_deal_id_idx on public.documents (deal_id);
create index if not exists documents_payment_id_idx on public.documents (payment_id);

alter table public.documents enable row level security;

drop policy if exists "select own documents" on public.documents;
create policy "select own documents"
  on public.documents for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own documents" on public.documents;
create policy "insert own documents"
  on public.documents for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own documents" on public.documents;
create policy "update own documents"
  on public.documents for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own documents" on public.documents;
create policy "delete own documents"
  on public.documents for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- Now that documents exists, wire up the FK from payments.receipt_document_id.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payments_receipt_document_id_fkey'
  ) then
    alter table public.payments
      add constraint payments_receipt_document_id_fkey
      foreign key (receipt_document_id) references public.documents(id) on delete set null;
  end if;
end $$;

create index if not exists payments_receipt_document_id_idx on public.payments (receipt_document_id);
