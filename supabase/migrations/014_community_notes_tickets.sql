-- ============================================================================
-- 014: Community messaging, personal notes, support tickets, and the
--      notification realtime/frequency fixes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- community_messages: a single shared room, open to every signed-in user -
-- deliberately NOT owner-isolated like every other table in this schema.
-- Read is open to all authenticated users on purpose; there is no update/
-- delete for v1 (an immutable chat log, kept simple).
-- ----------------------------------------------------------------------------
create table if not exists public.community_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists community_messages_created_at_idx on public.community_messages (created_at);

alter table public.community_messages enable row level security;

drop policy if exists "select all community_messages" on public.community_messages;
create policy "select all community_messages"
  on public.community_messages for select to authenticated
  using (true);

drop policy if exists "insert own community_messages" on public.community_messages;
create policy "insert own community_messages"
  on public.community_messages for insert to authenticated
  with check (user_id = (select auth.uid()));

grant select, insert on table public.community_messages to authenticated;

-- ----------------------------------------------------------------------------
-- get_display_names: community chat and support tickets need to show
-- *other* users' names, but profiles' own RLS only lets a regular user see
-- their own row (or everything, if admin). Rather than loosen that (which
-- would expose email/mobile/city to every user), this SECURITY DEFINER
-- function returns only id + full_name for a requested set of ids -
-- nothing else from profiles is reachable through it.
-- ----------------------------------------------------------------------------
create or replace function public.get_display_names(p_user_ids uuid[])
returns table(id uuid, full_name text)
language sql
security definer
stable
set search_path = ''
as $$
  select p.id, coalesce(p.full_name, 'User') as full_name
  from public.profiles p
  where p.id = any(p_user_ids);
$$;

revoke execute on function public.get_display_names(uuid[]) from public, anon;
grant execute on function public.get_display_names(uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- notes (personal scratchpad). Deliberately NOT extended with admin
-- visibility like the financial tables - these are private notes, not
-- portfolio data admin needs oversight of.
-- ----------------------------------------------------------------------------
create table if not exists public.notes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled',
  content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_user_id_idx on public.notes (user_id);

alter table public.notes enable row level security;

drop policy if exists "select own notes" on public.notes;
create policy "select own notes"
  on public.notes for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "insert own notes" on public.notes;
create policy "insert own notes"
  on public.notes for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own notes" on public.notes;
create policy "update own notes"
  on public.notes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own notes" on public.notes;
create policy "delete own notes"
  on public.notes for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_notes_updated_at on public.notes;
create trigger set_notes_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.notes to authenticated;

-- ----------------------------------------------------------------------------
-- support_tickets + ticket_messages ("Message to Us"). The one deliberate
-- exception to "admin is read-only": admin needs to change ticket status
-- and reply, or the feature doesn't work, so UPDATE on support_tickets and
-- INSERT on ticket_messages are both extended to admin - nothing else.
-- ----------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  -- Immutable, derived from id (itself immutable/unique), so this is safe
  -- as a generated column - unlike the date-based dedupe keys fixed
  -- earlier, integer-to-text and lpad() have no session-dependent formatting.
  ticket_number text generated always as ('TKT-' || lpad(id::text, 5, '0')) stored,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  status text not null default 'Open' check (status in ('Open', 'In Progress', 'Resolved', 'Closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists support_tickets_user_id_idx on public.support_tickets (user_id);
create index if not exists support_tickets_status_idx on public.support_tickets (status);

alter table public.support_tickets enable row level security;

drop policy if exists "select own or all tickets" on public.support_tickets;
create policy "select own or all tickets"
  on public.support_tickets for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "insert own tickets" on public.support_tickets;
create policy "insert own tickets"
  on public.support_tickets for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own or any ticket as admin" on public.support_tickets;
create policy "update own or any ticket as admin"
  on public.support_tickets for update to authenticated
  using (user_id = (select auth.uid()) or private.is_admin())
  with check (user_id = (select auth.uid()) or private.is_admin());

drop trigger if exists set_support_tickets_updated_at on public.support_tickets;
create trigger set_support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

grant select, insert, update on table public.support_tickets to authenticated;

create table if not exists public.ticket_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.support_tickets(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  is_admin_reply boolean not null default false,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists ticket_messages_ticket_id_idx on public.ticket_messages (ticket_id);

alter table public.ticket_messages enable row level security;

drop policy if exists "select messages for reachable tickets" on public.ticket_messages;
create policy "select messages for reachable tickets"
  on public.ticket_messages for select to authenticated
  using (
    exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and (t.user_id = (select auth.uid()) or private.is_admin())
    )
  );

drop policy if exists "insert messages for reachable tickets" on public.ticket_messages;
create policy "insert messages for reachable tickets"
  on public.ticket_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and (t.user_id = (select auth.uid()) or private.is_admin())
    )
  );

grant select, insert on table public.ticket_messages to authenticated;

-- ----------------------------------------------------------------------------
-- notifications: add a ticket_id link (same pattern as deal_id/schedule_id/
-- payment_id already there) and allow the new 'Support Ticket' type. The
-- check constraint is dropped/recreated by its default Postgres-assigned
-- name (a single unnamed inline column check is always named
-- <table>_<column>_check), same idempotent approach used throughout.
-- ----------------------------------------------------------------------------
alter table public.notifications add column if not exists ticket_id bigint references public.support_tickets(id) on delete cascade;
create index if not exists notifications_ticket_id_idx on public.notifications (ticket_id);

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket'));

-- ----------------------------------------------------------------------------
-- Ticket notification triggers: new ticket -> notify every admin; a reply
-- -> notify whichever side didn't just write it. SECURITY DEFINER since
-- this writes notifications for OTHER users (the admins, or the ticket
-- owner), not just the calling user's own row.
-- ----------------------------------------------------------------------------
create or replace function private.notify_new_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
begin
  for v_admin in select id from public.profiles where is_admin = true loop
    insert into public.notifications (user_id, ticket_id, type, title, message, priority, dedupe_key)
    values (
      v_admin.id, new.id, 'Support Ticket',
      format('New support ticket %s', new.ticket_number),
      format('%s: %s', new.ticket_number, new.subject),
      'Medium',
      'Support Ticket|new|' || new.id::text || '|' || v_admin.id::text || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists notify_admins_new_ticket on public.support_tickets;
create trigger notify_admins_new_ticket
  after insert on public.support_tickets
  for each row execute function private.notify_new_ticket();

create or replace function private.notify_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.support_tickets;
  v_admin record;
begin
  select * into v_ticket from public.support_tickets where id = new.ticket_id;

  if new.is_admin_reply then
    insert into public.notifications (user_id, ticket_id, type, title, message, priority, dedupe_key)
    values (
      v_ticket.user_id, new.ticket_id, 'Support Ticket',
      format('Reply on ticket %s', v_ticket.ticket_number),
      format('%s: support replied.', v_ticket.ticket_number),
      'Medium',
      'Support Ticket|reply|' || new.ticket_id::text || '|' || v_ticket.user_id::text || '|' || new.id::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  else
    for v_admin in select id from public.profiles where is_admin = true loop
      insert into public.notifications (user_id, ticket_id, type, title, message, priority, dedupe_key)
      values (
        v_admin.id, new.ticket_id, 'Support Ticket',
        format('New message on ticket %s', v_ticket.ticket_number),
        format('%s: user replied.', v_ticket.ticket_number),
        'Medium',
        'Support Ticket|userreply|' || new.ticket_id::text || '|' || v_admin.id::text || '|' || new.id::text
      )
      on conflict (user_id, dedupe_key) do nothing;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_ticket_reply on public.ticket_messages;
create trigger notify_ticket_reply
  after insert on public.ticket_messages
  for each row execute function private.notify_ticket_reply();

-- ----------------------------------------------------------------------------
-- Admin-only on-demand automation trigger. Safe to grant broadly to
-- authenticated because the function checks private.is_admin() itself and
-- raises for anyone else - the same "check inside the function body"
-- pattern used for every other SECURITY DEFINER function in this schema.
-- Gives admin a way to force the nightly checks to run immediately (e.g.
-- right after fixing a preference) instead of waiting for the schedule.
-- ----------------------------------------------------------------------------
create or replace function public.fn_admin_run_automation()
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Only an admin can run this.';
  end if;
  perform public.fn_refresh_schedule_statuses();
  perform public.fn_generate_reminders();
  perform public.fn_generate_ai_insights();
  return 'ok';
end;
$$;

revoke execute on function public.fn_admin_run_automation() from public, anon;
grant execute on function public.fn_admin_run_automation() to authenticated;

-- ----------------------------------------------------------------------------
-- Realtime: notifications and both message tables push instantly to
-- subscribed clients instead of waiting for the app's 60-second poll.
-- Postgres Changes respects each table's existing RLS - a user is only
-- ever notified of rows their own SELECT policy already allows them to see.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_messages'
  ) then
    alter publication supabase_realtime add table public.community_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ticket_messages'
  ) then
    alter publication supabase_realtime add table public.ticket_messages;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Nightly -> every 15 minutes. The underlying reminder/status-refresh logic
-- was only ever checked once a day at a fixed UTC time (010_cron.sql) -
-- combined with realtime push above, this is what actually makes
-- notifications feel responsive rather than "once a day, eventually".
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'nightly-portfolio-automation') then
    perform cron.unschedule('nightly-portfolio-automation');
  end if;
end $$;

select cron.schedule(
  'portfolio-automation-15min',
  '*/15 * * * *',
  $$
  select public.fn_refresh_schedule_statuses();
  select public.fn_generate_reminders();
  select public.fn_generate_ai_insights();
  $$
);
