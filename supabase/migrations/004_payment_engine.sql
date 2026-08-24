-- ============================================================================
-- 004: payment_schedule, payments, reinvestments
-- ============================================================================
-- payment_schedule and payments reference each other (a schedule row points
-- at the payment that satisfied it; a payment points at the schedule row it
-- was matched to), so the FK from payment_schedule -> payments is added with
-- a separate ALTER TABLE once both tables exist.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- payment_schedule (spec Section 6) - expected cash flow, one row per
-- expected payment. Rows here are projections, not history: deleting/
-- regenerating future UPCOMING rows is fine, which is why deal_id cascades.
-- ----------------------------------------------------------------------------
create table if not exists public.payment_schedule (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id bigint not null references public.deals(id) on delete cascade,

  scheduled_date date not null,
  expected_interest numeric(14, 2) check (expected_interest >= 0),
  expected_principal numeric(14, 2) check (expected_principal >= 0),
  -- Always interest + principal for that installment - generated so the
  -- dashboard total can never drift from its parts.
  expected_total numeric(14, 2) generated always as (
    coalesce(expected_interest, 0) + coalesce(expected_principal, 0)
  ) stored,
  -- Free text (e.g. 'Interest', 'Principal', 'Interest+Principal') describing
  -- what this specific installment is made of - distinct from deals.payout_type,
  -- which describes the deal's overall repayment structure. Spec Section 6
  -- doesn't enumerate a closed list for this field, so it's left open.
  payment_type text,
  status text not null default 'UPCOMING'
    check (status in ('UPCOMING', 'DUE_TODAY', 'RECEIVED', 'RECEIVED_EARLY', 'RECEIVED_ON_TIME',
                       'RECEIVED_LATE', 'PARTIALLY_RECEIVED', 'OVERDUE', 'MISSED', 'WAIVED', 'CANCELLED')),
  grace_period_days int not null default 3 check (grace_period_days >= 0),
  reminder_date date,
  overdue_date date,
  -- FK to payments added below, once payments exists.
  actual_payment_id bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_schedule_user_id_idx on public.payment_schedule (user_id);
create index if not exists payment_schedule_deal_id_idx on public.payment_schedule (deal_id);
create index if not exists payment_schedule_scheduled_date_idx on public.payment_schedule (scheduled_date);
create index if not exists payment_schedule_status_idx on public.payment_schedule (status);

alter table public.payment_schedule enable row level security;

drop policy if exists "select own payment_schedule" on public.payment_schedule;
create policy "select own payment_schedule"
  on public.payment_schedule for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own payment_schedule" on public.payment_schedule;
create policy "insert own payment_schedule"
  on public.payment_schedule for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own payment_schedule" on public.payment_schedule;
create policy "update own payment_schedule"
  on public.payment_schedule for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own payment_schedule" on public.payment_schedule;
create policy "delete own payment_schedule"
  on public.payment_schedule for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_payment_schedule_updated_at on public.payment_schedule;
create trigger set_payment_schedule_updated_at
  before update on public.payment_schedule
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- payments (spec Section 7) - the real, authoritative receipt ledger. A
-- schedule row only becomes "received" through a row here referencing it
-- (spec Section 44's non-negotiable rule); this table is never truncated by
-- normal app flows, only soft-voided (spec Section 51 rule 5: never
-- permanently delete financial history from the normal UI).
--
-- deal_id is ON DELETE RESTRICT (not cascade): a deal with real payment
-- history cannot be deleted outright, only closed/written off, which keeps
-- rule 5 true at the schema level and not just as an app-layer convention.
-- ----------------------------------------------------------------------------
create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  deal_id bigint not null references public.deals(id) on delete restrict,
  scheduled_payment_id bigint references public.payment_schedule(id) on delete set null,

  transaction_date date not null,
  credited_date date,
  amount numeric(14, 2) not null check (amount > 0),
  interest_amount numeric(14, 2) check (interest_amount >= 0),
  principal_amount numeric(14, 2) check (principal_amount >= 0),
  fee_amount numeric(14, 2) not null default 0 check (fee_amount >= 0),
  tax_amount numeric(14, 2) not null default 0 check (tax_amount >= 0),
  net_amount numeric(14, 2),
  payment_reference text,
  payment_mode text,
  source text,
  confirmation_method text not null default 'Manual'
    check (confirmation_method in ('Manual', 'Excel Import', 'CSV Import', 'Bank Statement', 'API',
                                    'Webhook', 'Platform Statement', 'Automatic Reconciliation')),
  -- FK to documents added in 005_notifications_documents.sql, once that table exists.
  receipt_document_id bigint,
  notes text,

  is_voided boolean not null default false,
  voided_at timestamptz,
  voided_reason text,

  -- Closes a real gap in the Section 24 dedupe key: a plain UNIQUE constraint
  -- never collides on NULL payment_reference, so two duplicate imports that
  -- both lack a reference number would not be caught. Coalescing to '' first
  -- makes "same deal, same date, same amount, no reference" collide too.
  --
  -- transaction_date::text is deliberately NOT used here: casting a date to
  -- text depends on the session's DateStyle setting, so Postgres marks that
  -- cast STABLE rather than IMMUTABLE, and a generated column's expression
  -- must be IMMUTABLE. (transaction_date - date '1970-01-01') is plain
  -- integer day-count arithmetic with no such dependency, so it qualifies -
  -- the value itself doesn't need to be human-readable, only unique and
  -- reproducible.
  dedupe_key text generated always as (
    deal_id::text || '|' || (transaction_date - date '1970-01-01')::text || '|' || amount::text || '|' || coalesce(payment_reference, '')
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, dedupe_key)
);

create index if not exists payments_user_id_idx on public.payments (user_id);
create index if not exists payments_deal_id_idx on public.payments (deal_id);
create index if not exists payments_scheduled_payment_id_idx on public.payments (scheduled_payment_id);
create index if not exists payments_transaction_date_idx on public.payments (transaction_date);

alter table public.payments enable row level security;

drop policy if exists "select own payments" on public.payments;
create policy "select own payments"
  on public.payments for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own payments" on public.payments;
create policy "insert own payments"
  on public.payments for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own payments" on public.payments;
create policy "update own payments"
  on public.payments for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Intentionally no DELETE policy: payments are voided (is_voided = true via
-- UPDATE), never deleted, from the normal UI (spec Section 51 rule 5).

drop trigger if exists set_payments_updated_at on public.payments;
create trigger set_payments_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- Now that payments exists, wire up the FK from payment_schedule to it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_schedule_actual_payment_id_fkey'
  ) then
    alter table public.payment_schedule
      add constraint payment_schedule_actual_payment_id_fkey
      foreign key (actual_payment_id) references public.payments(id) on delete set null;
  end if;
end $$;

create index if not exists payment_schedule_actual_payment_id_idx on public.payment_schedule (actual_payment_id);

-- ----------------------------------------------------------------------------
-- reinvestments (spec Section 16)
-- ----------------------------------------------------------------------------
create table if not exists public.reinvestments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_payment_id bigint references public.payments(id) on delete set null,

  returned_amount numeric(14, 2) check (returned_amount >= 0),
  returned_date date,
  reinvested_amount numeric(14, 2) check (reinvested_amount >= 0),
  reinvestment_date date,
  new_deal_id bigint references public.deals(id) on delete set null,
  reinvestment_destination text,

  reinvestment_delay_days int generated always as (
    case when reinvestment_date is not null and returned_date is not null
      then (reinvestment_date - returned_date) end
  ) stored,
  reinvestment_ratio numeric(9, 4) generated always as (
    case when returned_amount is not null and returned_amount <> 0 and reinvested_amount is not null
      then round(reinvested_amount / returned_amount, 4) end
  ) stored,
  same_day_reinvestment boolean generated always as (
    reinvestment_date is not null and returned_date is not null and reinvestment_date = returned_date
  ) stored,

  created_at timestamptz not null default now()
);

create index if not exists reinvestments_user_id_idx on public.reinvestments (user_id);
create index if not exists reinvestments_source_payment_id_idx on public.reinvestments (source_payment_id);
create index if not exists reinvestments_new_deal_id_idx on public.reinvestments (new_deal_id);

alter table public.reinvestments enable row level security;

drop policy if exists "select own reinvestments" on public.reinvestments;
create policy "select own reinvestments"
  on public.reinvestments for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own reinvestments" on public.reinvestments;
create policy "insert own reinvestments"
  on public.reinvestments for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own reinvestments" on public.reinvestments;
create policy "update own reinvestments"
  on public.reinvestments for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own reinvestments" on public.reinvestments;
create policy "delete own reinvestments"
  on public.reinvestments for delete
  to authenticated
  using (user_id = (select auth.uid()));
