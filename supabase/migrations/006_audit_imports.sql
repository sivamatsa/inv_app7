-- ============================================================================
-- 006: imports, audit_logs, and the generic audit trigger (spec Sections
--      30, 31, 51 rule 6 "Maintain audit history")
-- ============================================================================

-- ----------------------------------------------------------------------------
-- imports (spec Section 31)
-- ----------------------------------------------------------------------------
create table if not exists public.imports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  filename text not null,
  source text not null default 'Excel Import' check (source in ('Excel Import', 'CSV Import')),
  imported_at timestamptz not null default now(),
  total_rows int not null default 0,
  successful_rows int not null default 0,
  duplicate_rows int not null default 0,
  failed_rows int not null default 0,
  status text not null default 'Processing'
    check (status in ('Processing', 'Completed', 'Completed with Errors', 'Failed')),
  error_report jsonb not null default '[]'::jsonb
);

create index if not exists imports_user_id_idx on public.imports (user_id);

alter table public.imports enable row level security;

drop policy if exists "select own imports" on public.imports;
create policy "select own imports"
  on public.imports for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own imports" on public.imports;
create policy "insert own imports"
  on public.imports for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own imports" on public.imports;
create policy "update own imports"
  on public.imports for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No delete policy: import history is never removed (spec Section 31 "Allow
-- review of previous imports").

-- ----------------------------------------------------------------------------
-- audit_logs (spec Section 30). Read-only to regular users: every row is
-- written exclusively by the audit_row_change() trigger below (SECURITY
-- DEFINER, bypasses RLS as the function owner), so a user can see their own
-- audit trail but cannot forge or tamper with it via the API.
-- ----------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  table_name text not null,
  record_id bigint,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE', 'VOID')),
  field_name text,
  old_value text,
  new_value text,
  source text not null default 'system',
  import_id bigint references public.imports(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists audit_logs_user_id_idx on public.audit_logs (user_id);
create index if not exists audit_logs_table_record_idx on public.audit_logs (table_name, record_id);
create index if not exists audit_logs_import_id_idx on public.audit_logs (import_id);

alter table public.audit_logs enable row level security;

drop policy if exists "select own audit_logs" on public.audit_logs;
create policy "select own audit_logs"
  on public.audit_logs for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- Generic audit trigger. Attached (below) to every table listed in spec
-- Section 30's examples: deals, payments, payment_schedule, reinvestments.
-- INSERT/DELETE log a single row with the whole record as JSON; UPDATE logs
-- one row per column that actually changed (old value + new value), which
-- matches the spec's own examples ("ROI changed", "Maturity date changed")
-- much more precisely than a single whole-row diff would.
-- ----------------------------------------------------------------------------
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_old_val text;
  v_new_val text;
  v_ignored_keys text[] := array['updated_at', 'created_at'];
begin
  if tg_op = 'DELETE' then
    v_user_id := (to_jsonb(OLD) ->> 'user_id')::uuid;
    insert into public.audit_logs (user_id, table_name, record_id, action, old_value, source)
    values (v_user_id, tg_table_name, (to_jsonb(OLD) ->> 'id')::bigint, 'DELETE', to_jsonb(OLD)::text, 'system');
    return OLD;
  elsif tg_op = 'INSERT' then
    v_user_id := (to_jsonb(NEW) ->> 'user_id')::uuid;
    insert into public.audit_logs (user_id, table_name, record_id, action, new_value, source)
    values (v_user_id, tg_table_name, (to_jsonb(NEW) ->> 'id')::bigint, 'INSERT', to_jsonb(NEW)::text, 'system');
    return NEW;
  else
    v_user_id := (to_jsonb(NEW) ->> 'user_id')::uuid;
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_ignored_keys) then
        continue;
      end if;
      v_old_val := v_old ->> v_key;
      v_new_val := v_new ->> v_key;
      if v_old_val is distinct from v_new_val then
        insert into public.audit_logs (user_id, table_name, record_id, action, field_name, old_value, new_value, source)
        values (v_user_id, tg_table_name, (v_new ->> 'id')::bigint, 'UPDATE', v_key, v_old_val, v_new_val, 'system');
      end if;
    end loop;
    return NEW;
  end if;
end;
$$;

revoke execute on function public.audit_row_change() from public, anon, authenticated;

drop trigger if exists audit_deals on public.deals;
create trigger audit_deals
  after insert or update or delete on public.deals
  for each row execute function public.audit_row_change();

drop trigger if exists audit_payments on public.payments;
create trigger audit_payments
  after insert or update or delete on public.payments
  for each row execute function public.audit_row_change();

drop trigger if exists audit_payment_schedule on public.payment_schedule;
create trigger audit_payment_schedule
  after insert or update or delete on public.payment_schedule
  for each row execute function public.audit_row_change();

drop trigger if exists audit_reinvestments on public.reinvestments;
create trigger audit_reinvestments
  after insert or update or delete on public.reinvestments
  for each row execute function public.audit_row_change();
