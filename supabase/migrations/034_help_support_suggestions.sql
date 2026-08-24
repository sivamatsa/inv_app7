-- ============================================================================
-- 034: Help & Assistant, User Support & Feature Suggestion Hub.
-- Extends the existing "Message to Us" ticket system (014) with category/
-- priority/assignment/internal notes/attachments/guest submission, and adds
-- a brand-new, deliberately separate Feature Suggestions system (voting,
-- roadmap, duplicate detection). See the plan's own scope decisions for the
-- reasoning behind each design choice below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- support_tickets alterations. user_id becomes nullable (a guest/pre-login
-- submission has none - see fn_submit_guest_ticket below); the four-value
-- status set from 014 is replaced with the full lifecycle the spec asks
-- for. This table has live rows on the user's real project, so existing
-- 'Open' rows are remapped to 'New' BEFORE the constraint is replaced -
-- doing it the other way around would make the alter fail outright.
-- ----------------------------------------------------------------------------
alter table public.support_tickets alter column user_id drop not null;

alter table public.support_tickets add column if not exists category text;
alter table public.support_tickets add column if not exists priority text not null default 'Medium';
alter table public.support_tickets add column if not exists assigned_to uuid references auth.users(id) on delete set null;
alter table public.support_tickets add column if not exists first_response_at timestamptz;
alter table public.support_tickets add column if not exists resolution_rating int;
alter table public.support_tickets add column if not exists resolution_comment text;
alter table public.support_tickets add column if not exists guest_name text;
alter table public.support_tickets add column if not exists guest_email text;
alter table public.support_tickets add column if not exists guest_message text;
alter table public.support_tickets add column if not exists account_email text;

alter table public.support_tickets drop constraint if exists support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category is null or category in (
    'Cannot Create Account', 'Forgot Password', 'Email Verification Issue', 'Account Locked',
    'Cannot Log In', 'Other Account Issue', 'Investment/Deal Issue', 'Dashboard Issue',
    'Excel/Import Issue', 'Notification/Reminder Issue', 'Gold Intelligence Issue', 'Document Issue',
    'Chat/Contact Issue', 'Report a Problem', 'Security Report', 'General Question',
    'Contact Administrator'
  ));
update public.support_tickets set category = 'General Question' where category is null;
alter table public.support_tickets alter column category set default 'General Question';
alter table public.support_tickets alter column category set not null;

alter table public.support_tickets drop constraint if exists support_tickets_priority_check;
alter table public.support_tickets add constraint support_tickets_priority_check
  check (priority in ('Critical', 'High', 'Medium', 'Low'));

alter table public.support_tickets drop constraint if exists support_tickets_resolution_rating_check;
alter table public.support_tickets add constraint support_tickets_resolution_rating_check
  check (resolution_rating is null or resolution_rating between 1 and 5);

alter table public.support_tickets drop constraint if exists support_tickets_owner_or_guest;
alter table public.support_tickets add constraint support_tickets_owner_or_guest
  check (user_id is not null or guest_email is not null);

-- 'Open' -> 'New' before the new, larger status set replaces the old
-- 4-value one - see the header comment above.
update public.support_tickets set status = 'New' where status = 'Open';
alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in (
    'New', 'Acknowledged', 'In Progress', 'Waiting for User', 'Waiting for Admin',
    'Resolved', 'Closed', 'Rejected', 'Reopened'
  ));
alter table public.support_tickets alter column status set default 'New';

-- Guest tickets are intentionally one-shot (scope decision #2) - nobody,
-- not even admin, can post a ticket_messages row against one. This isn't
-- just a UX choice: 014's notify_ticket_reply() trigger extracts
-- v_ticket.user_id to notify the ticket owner on an admin reply, and a
-- guest ticket's user_id is null - letting a message through would violate
-- notifications.user_id's own not-null constraint the moment that trigger
-- fired. Replacing 014's original policy (which only checked owner-or-admin)
-- with this stricter version closes that off at the RLS layer, not just in
-- the UI.
drop policy if exists "insert messages for reachable tickets" on public.ticket_messages;
create policy "insert messages for reachable tickets"
  on public.ticket_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and t.user_id is not null and (t.user_id = (select auth.uid()) or private.is_admin())
    )
  );

create index if not exists support_tickets_category_idx on public.support_tickets (category);
create index if not exists support_tickets_assigned_to_idx on public.support_tickets (assigned_to);
create index if not exists support_tickets_guest_email_idx on public.support_tickets (guest_email);

-- ----------------------------------------------------------------------------
-- ticket_internal_notes - admin-only, both directions. A guest/owner never
-- has any policy granting them access, not even read - the same
-- isolate-into-its-own-table technique already used for login_events (027),
-- applied here because a bare column on support_tickets would be visible to
-- that ticket's own owner under the existing owner-or-admin SELECT policy.
-- ----------------------------------------------------------------------------
create table if not exists public.ticket_internal_notes (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.support_tickets(id) on delete cascade,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists ticket_internal_notes_ticket_id_idx on public.ticket_internal_notes (ticket_id);

alter table public.ticket_internal_notes enable row level security;

drop policy if exists "admin only select ticket notes" on public.ticket_internal_notes;
create policy "admin only select ticket notes"
  on public.ticket_internal_notes for select to authenticated
  using (private.is_admin());

drop policy if exists "admin only insert ticket notes" on public.ticket_internal_notes;
create policy "admin only insert ticket notes"
  on public.ticket_internal_notes for insert to authenticated
  with check (private.is_admin() and admin_user_id = (select auth.uid()));

grant select, insert on table public.ticket_internal_notes to authenticated;
grant usage, select on sequence public.ticket_internal_notes_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- fn_submit_guest_ticket - the ONLY door for a pre-login visitor to create a
-- ticket. Deliberately a guarded SECURITY DEFINER function rather than a raw
-- `grant insert ... to anon` + RLS policy: it needs no anon grant on the
-- table at all (just EXECUTE on this one function), it does its own
-- rate-limit check, and it returns only the generated ticket_number - never
-- the full row - which also sidesteps a real trap a bare anon insert would
-- hit (Postgres applies the SELECT policy to an INSERT's own RETURNING
-- clause; with no anon SELECT policy at all, `.insert().select()` would
-- come back empty even on a successful insert and throw client-side).
-- ----------------------------------------------------------------------------
create or replace function public.fn_submit_guest_ticket(
  p_category text,
  p_guest_name text,
  p_guest_email text,
  p_guest_message text,
  p_account_email text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recent_count int;
  v_ticket_number text;
begin
  if p_category not in ('Cannot Create Account', 'Forgot Password', 'Contact Administrator') then
    raise exception 'Invalid category for a guest request.';
  end if;
  if coalesce(trim(p_guest_name), '') = '' or coalesce(trim(p_guest_email), '') = '' or coalesce(trim(p_guest_message), '') = '' then
    raise exception 'Name, email, and a description are all required.';
  end if;

  -- Cheap abuse guard: no per-IP visibility is available here (this app has
  -- never read PostgREST's request-header GUC anywhere, including
  -- login_events, which gets IP via a service-role Edge Function instead) -
  -- a per-email daily cap is what's actually feasible at the RLS/SQL layer,
  -- and every new ticket already notifies every admin immediately, so a
  -- spam burst is self-alerting rather than silent.
  select count(*) into v_recent_count
  from public.support_tickets
  where guest_email = p_guest_email and created_at > now() - interval '24 hours';
  if v_recent_count >= 5 then
    raise exception 'Too many requests from this email today - please try again tomorrow, or wait for a reply to your existing request.';
  end if;

  insert into public.support_tickets (subject, category, guest_name, guest_email, guest_message, account_email, priority)
  values (
    p_category, p_category, trim(p_guest_name), trim(p_guest_email), trim(p_guest_message), p_account_email,
    case when p_category in ('Cannot Create Account', 'Forgot Password') then 'High' else 'Medium' end
  )
  returning ticket_number into v_ticket_number;

  return v_ticket_number;
end;
$$;

revoke execute on function public.fn_submit_guest_ticket(text, text, text, text, text) from public;
grant execute on function public.fn_submit_guest_ticket(text, text, text, text, text) to anon, authenticated;

-- PostgREST needs schema-level USAGE for the `anon` role before it can even
-- resolve this function by name, regardless of the function-level EXECUTE
-- grant above - this is the FIRST anon-role grant anywhere in this project
-- (012_grants.sql's own comment states plainly that nothing was granted to
-- anon before now: "This app requires sign-in for everything"). Scoped as
-- narrowly as possible: anon gets schema USAGE (a no-op without a specific
-- object grant) and EXECUTE on this one function - no anon grant exists on
-- any table, so there is no anon read/write path into this schema beyond
-- exactly what fn_submit_guest_ticket itself does internally.
grant usage on schema public to anon;

-- ----------------------------------------------------------------------------
-- documents: one more nullable FK, same reuse-the-existing-attachment-system
-- technique as expense_transaction_id before it. Logged-in-only by design -
-- a guest ticket has no authenticated session for Storage's owner-folder RLS
-- to scope an upload to.
-- ----------------------------------------------------------------------------
alter table public.documents add column if not exists ticket_id bigint references public.support_tickets(id) on delete cascade;

alter table public.documents drop constraint if exists documents_document_type_check;
alter table public.documents add constraint documents_document_type_check
  check (document_type in ('Investment Agreement', 'Payment Receipt', 'Lender Statement', 'Bank Statement',
                            'Maturity Statement', 'Tax Certificate', 'Screenshot', 'Other',
                            'Support Ticket Attachment'));

-- ----------------------------------------------------------------------------
-- feature_suggestions - deliberately separate from support_tickets (never
-- mixed into one generic inbox, per the spec's own explicit instruction).
-- Readable by every authenticated user (`using (true)`, same openness as
-- community_messages/blog_posts already in this app) - that's what makes
-- voting and a shared roadmap possible at all.
-- ----------------------------------------------------------------------------
create table if not exists public.feature_suggestions (
  id bigint generated always as identity primary key,
  suggestion_number text generated always as ('SUG-' || lpad(id::text, 5, '0')) stored,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  category text not null check (category in
    ('New Feature', 'Existing Feature Improvement', 'UI/UX', 'AI Suggestion', 'Integration', 'Other')),
  description text,
  problem_being_solved text,
  suggested_solution text,
  expected_benefit text,
  priority text not null default 'Medium' check (priority in ('Critical', 'High', 'Medium', 'Low')),
  related_feature text,
  notify_on_implement boolean not null default true,
  status text not null default 'Submitted' check (status in
    ('Submitted', 'Under Review', 'Accepted', 'Planned', 'In Development', 'Testing', 'Released',
     'Rejected', 'Duplicate', 'Archived')),
  duplicate_of bigint references public.feature_suggestions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feature_suggestions_status_idx on public.feature_suggestions (status);
create index if not exists feature_suggestions_user_id_idx on public.feature_suggestions (user_id);

alter table public.feature_suggestions enable row level security;

drop policy if exists "select all suggestions" on public.feature_suggestions;
create policy "select all suggestions"
  on public.feature_suggestions for select to authenticated
  using (true);

drop policy if exists "insert own suggestions" on public.feature_suggestions;
create policy "insert own suggestions"
  on public.feature_suggestions for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own pending or admin suggestions" on public.feature_suggestions;
create policy "update own pending or admin suggestions"
  on public.feature_suggestions for update to authenticated
  using ((user_id = (select auth.uid()) and status = 'Submitted') or private.is_admin())
  with check ((user_id = (select auth.uid()) and status = 'Submitted') or private.is_admin());

drop trigger if exists set_feature_suggestions_updated_at on public.feature_suggestions;
create trigger set_feature_suggestions_updated_at
  before update on public.feature_suggestions
  for each row execute function public.set_updated_at();

grant select, insert, update on table public.feature_suggestions to authenticated;
grant usage, select on sequence public.feature_suggestions_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- suggestion_internal_notes - same admin-only shape as ticket_internal_notes.
-- ----------------------------------------------------------------------------
create table if not exists public.suggestion_internal_notes (
  id bigint generated always as identity primary key,
  suggestion_id bigint not null references public.feature_suggestions(id) on delete cascade,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists suggestion_internal_notes_suggestion_id_idx on public.suggestion_internal_notes (suggestion_id);

alter table public.suggestion_internal_notes enable row level security;

drop policy if exists "admin only select suggestion notes" on public.suggestion_internal_notes;
create policy "admin only select suggestion notes"
  on public.suggestion_internal_notes for select to authenticated
  using (private.is_admin());

drop policy if exists "admin only insert suggestion notes" on public.suggestion_internal_notes;
create policy "admin only insert suggestion notes"
  on public.suggestion_internal_notes for insert to authenticated
  with check (private.is_admin() and admin_user_id = (select auth.uid()));

grant select, insert on table public.suggestion_internal_notes to authenticated;
grant usage, select on sequence public.suggestion_internal_notes_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- suggestion_votes - `using (true)` select (needed so the security_invoker
-- view below means anything for a non-admin caller), own-only insert/delete.
-- Double-vote is blocked atomically by the unique constraint, not an
-- app-level check-then-insert race.
-- ----------------------------------------------------------------------------
create table if not exists public.suggestion_votes (
  id bigint generated always as identity primary key,
  suggestion_id bigint not null references public.feature_suggestions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (suggestion_id, user_id)
);

create index if not exists suggestion_votes_suggestion_id_idx on public.suggestion_votes (suggestion_id);

alter table public.suggestion_votes enable row level security;

drop policy if exists "select all votes" on public.suggestion_votes;
create policy "select all votes"
  on public.suggestion_votes for select to authenticated
  using (true);

drop policy if exists "insert own vote" on public.suggestion_votes;
create policy "insert own vote"
  on public.suggestion_votes for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own vote" on public.suggestion_votes;
create policy "delete own vote"
  on public.suggestion_votes for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, delete on table public.suggestion_votes to authenticated;
grant usage, select on sequence public.suggestion_votes_id_seq to authenticated;

create or replace view public.v_suggestion_vote_counts
with (security_invoker = true) as
select suggestion_id, count(*) as vote_count
from public.suggestion_votes
group by suggestion_id;

grant select on public.v_suggestion_vote_counts to authenticated;

-- ----------------------------------------------------------------------------
-- Notifications: 6 new type values, plus the audit trigger attached to both
-- new tables (the generic audit_row_change() trigger, same as every other
-- financial/content table in this app - not an isolated audit system, per
-- the plan's own explicit "integrate with existing Audit History" decision).
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket', 'Recurring Reminder', 'Recurring Overdue',
                   'Contact Reminder', 'Contact Birthday', 'Contact Important Date',
                   'New Message', 'Group Message', 'Mention', 'Incoming Call', 'Missed Call',
                   'Gold Target Price', 'Gold Price Drop', 'Gold Price Rise', 'Gold New Low', 'Gold New High',
                   'Calendar Reminder', 'Expense Budget Warning', 'Expense Budget Exceeded',
                   'Account Creation Request', 'Password Assistance Requested', 'Security Report Filed',
                   'Ticket Assigned', 'New Feature Suggestion', 'Suggestion Status Changed'));

alter table public.notifications add column if not exists suggestion_id bigint references public.feature_suggestions(id) on delete cascade;
create index if not exists notifications_suggestion_id_idx on public.notifications (suggestion_id);

-- Replaces 014's version: same "notify every admin" loop, now branching on
-- the ticket's category to pick a more specific type/priority. Fires
-- identically whether the ticket came from a signed-in user or
-- fn_submit_guest_ticket above - one trigger, one insert path either way.
create or replace function private.notify_new_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
  v_type text;
  v_priority text;
begin
  v_type := case new.category
    when 'Cannot Create Account' then 'Account Creation Request'
    when 'Forgot Password' then 'Password Assistance Requested'
    when 'Security Report' then 'Security Report Filed'
    else 'Support Ticket'
  end;
  v_priority := case when new.category = 'Security Report' then 'Critical'
    when new.category in ('Cannot Create Account', 'Forgot Password') then 'High'
    else 'Medium' end;

  for v_admin in select id from public.profiles where is_admin = true loop
    insert into public.notifications (user_id, ticket_id, type, title, message, priority, dedupe_key)
    values (
      v_admin.id, new.id, v_type,
      format('New %s: %s', lower(new.category), new.ticket_number),
      format('%s: %s', new.ticket_number, coalesce(new.subject, new.guest_message)),
      v_priority,
      v_type || '|new|' || new.id::text || '|' || v_admin.id::text || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;

create or replace function private.notify_ticket_assigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to then
    insert into public.notifications (user_id, ticket_id, type, title, message, priority, dedupe_key)
    values (
      new.assigned_to, new.id, 'Ticket Assigned',
      format('Ticket %s assigned to you', new.ticket_number),
      format('%s: %s', new.ticket_number, coalesce(new.subject, new.guest_message)),
      'Medium',
      'Ticket Assigned|' || new.id::text || '|' || new.assigned_to::text || '|' || now()::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_admins_new_ticket on public.support_tickets;
create trigger notify_admins_new_ticket
  after insert on public.support_tickets
  for each row execute function private.notify_new_ticket();

drop trigger if exists notify_ticket_assigned_trg on public.support_tickets;
create trigger notify_ticket_assigned_trg
  after update on public.support_tickets
  for each row execute function private.notify_ticket_assigned();

create or replace function private.notify_new_suggestion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin record;
begin
  for v_admin in select id from public.profiles where is_admin = true loop
    insert into public.notifications (user_id, suggestion_id, type, title, message, priority, dedupe_key)
    values (
      v_admin.id, new.id, 'New Feature Suggestion',
      format('New suggestion: %s', new.title),
      format('%s (%s)', new.title, new.category),
      'Low',
      'New Feature Suggestion|' || new.id::text || '|' || v_admin.id::text || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;

create or replace function private.notify_suggestion_status_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.notify_on_implement then
    insert into public.notifications (user_id, suggestion_id, type, title, message, priority, dedupe_key)
    values (
      new.user_id, new.id, 'Suggestion Status Changed',
      format('Your suggestion "%s" is now %s', new.title, new.status),
      format('%s: %s -> %s', new.suggestion_number, old.status, new.status),
      'Low',
      'Suggestion Status Changed|' || new.id::text || '|' || new.status || '|' || now()::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_admins_new_suggestion on public.feature_suggestions;
create trigger notify_admins_new_suggestion
  after insert on public.feature_suggestions
  for each row execute function private.notify_new_suggestion();

drop trigger if exists notify_suggestion_status_changed_trg on public.feature_suggestions;
create trigger notify_suggestion_status_changed_trg
  after update on public.feature_suggestions
  for each row execute function private.notify_suggestion_status_changed();

-- first_response_at: set once, the first time an admin reply lands on a
-- ticket - a trigger rather than relying on the client to remember, same
-- reasoning as every other server-enforced invariant in this schema.
create or replace function private.set_ticket_first_response()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_admin_reply then
    update public.support_tickets
    set first_response_at = coalesce(first_response_at, now())
    where id = new.ticket_id;
  end if;
  return new;
end;
$$;

drop trigger if exists set_ticket_first_response_trg on public.ticket_messages;
create trigger set_ticket_first_response_trg
  after insert on public.ticket_messages
  for each row execute function private.set_ticket_first_response();

-- Generic audit trail, same trigger every other content/financial table in
-- this app already uses - not an isolated audit system. feature_suggestions.
-- user_id is never null (every suggestion has a real author), so this is a
-- plain, unconditional attachment exactly like every prior table.
drop trigger if exists audit_feature_suggestions on public.feature_suggestions;
create trigger audit_feature_suggestions
  after insert or update or delete on public.feature_suggestions
  for each row execute function public.audit_row_change();

-- support_tickets is different: a guest ticket has user_id = null, and
-- audit_row_change() extracts user_id straight from the row to attribute
-- the audit_logs entry - inserting a null there would violate
-- audit_logs.user_id's own not-null constraint and roll back the ENTIRE
-- guest ticket submission inside fn_submit_guest_ticket. Split into two
-- WHEN-guarded triggers (one for INSERT/UPDATE checking NEW, one for DELETE
-- checking OLD - a single combined trigger can't safely reference both in
-- one WHEN clause) so a guest ticket's own actions are simply never
-- audit-logged via this generic mechanism, while every authenticated
-- ticket keeps exactly the same audit trail every other table gets.
drop trigger if exists audit_support_tickets on public.support_tickets;
drop trigger if exists audit_support_tickets_iu on public.support_tickets;
create trigger audit_support_tickets_iu
  after insert or update on public.support_tickets
  for each row when (new.user_id is not null)
  execute function public.audit_row_change();

drop trigger if exists audit_support_tickets_d on public.support_tickets;
create trigger audit_support_tickets_d
  after delete on public.support_tickets
  for each row when (old.user_id is not null)
  execute function public.audit_row_change();
