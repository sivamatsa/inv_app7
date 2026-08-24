-- ============================================================================
-- 016: Contacts module (spec addendum "Contacts, Private Chat, Calling &
--      WhatsApp Integration", Sections 1-9, 22-27, 33)
-- ============================================================================
-- Deliberately separate from Investment Deals / Recurring Investments /
-- Community Discussion / Write to Us (spec Section 45) - no shared tables,
-- no shared nav, nothing here is read by any of those views.
--
-- Unlike every financial table so far, Contacts get NO admin read bypass:
-- these are private personal records, not portfolio data, the same
-- reasoning that already excluded `notes` from private.is_admin() in
-- 013_admin_role.sql. Every policy below is plain owner-only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- contacts (Sections 2, 4, 5) - full_name is purely derived (never editable);
-- display_name is a free column the user can override, defaulted to
-- full_name by the trigger below only when left blank on insert.
-- ----------------------------------------------------------------------------
create table if not exists public.contacts (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,

  first_name text,
  middle_name text,
  last_name text,
  -- Not a Postgres GENERATED column: this exact array_to_string/array_remove/
  -- nullif expression gets rejected with "generation expression is not
  -- immutable" on Supabase (a real Postgres planner restriction on this
  -- combination, not a typo) - kept in sync by a trigger instead, same
  -- fallback approach already used for display_name below.
  full_name text,
  display_name text,
  preferred_name text,
  nickname text,
  profile_photo_path text,
  gender text,
  birthday date,
  family_relationship text,
  tags text[] not null default '{}',
  interests text[] not null default '{}',
  custom_fields jsonb not null default '{}'::jsonb,
  favorite boolean not null default false,

  company text,
  job_title text,
  department text,
  website text,
  linkedin_url text,
  work_location text,
  industry text,

  -- Set once a phone/email on this contact is matched to a registered user
  -- via find_portfolio_user() and the user explicitly links them - never
  -- set automatically just from a search hit.
  linked_user_id uuid references auth.users(id) on delete set null,

  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contacts_owner_user_id_idx on public.contacts (owner_user_id);
create index if not exists contacts_favorite_idx on public.contacts (favorite);
create index if not exists contacts_tags_idx on public.contacts using gin (tags);
create index if not exists contacts_linked_user_id_idx on public.contacts (linked_user_id);

alter table public.contacts enable row level security;

drop policy if exists "select own contacts" on public.contacts;
create policy "select own contacts"
  on public.contacts for select to authenticated
  using (owner_user_id = (select auth.uid()));

drop policy if exists "insert own contacts" on public.contacts;
create policy "insert own contacts"
  on public.contacts for insert to authenticated
  with check (owner_user_id = (select auth.uid()));

drop policy if exists "update own contacts" on public.contacts;
create policy "update own contacts"
  on public.contacts for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

drop policy if exists "delete own contacts" on public.contacts;
create policy "delete own contacts"
  on public.contacts for delete to authenticated
  using (owner_user_id = (select auth.uid()));

drop trigger if exists set_contacts_updated_at on public.contacts;
create trigger set_contacts_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

create or replace function private.fn_contacts_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.full_name := array_to_string(
    array_remove(array[nullif(new.first_name, ''), nullif(new.middle_name, ''), nullif(new.last_name, '')], null),
    ' '
  );
  if tg_op = 'INSERT' and (new.display_name is null or new.display_name = '') then
    new.display_name := nullif(new.full_name, '');
  end if;
  return new;
end;
$$;

drop trigger if exists default_contact_display_name on public.contacts;
drop trigger if exists contacts_before_write on public.contacts;
create trigger contacts_before_write
  before insert or update on public.contacts
  for each row execute function private.fn_contacts_before_write();

grant select, insert, update, delete on table public.contacts to authenticated;

-- ----------------------------------------------------------------------------
-- Phones / Emails / Addresses (Section 3) - one row per entry, denormalizing
-- user_id onto every child row (same rationale as the rest of this schema:
-- keeps RLS a plain equality check rather than a join back to contacts).
-- ----------------------------------------------------------------------------
create table if not exists public.contact_phones (
  id bigint generated always as identity primary key,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_number text not null,
  country_code text,
  label text not null default 'Other'
    check (label in ('Primary', 'Secondary', 'WhatsApp', 'Work', 'Home', 'Other')),
  is_primary boolean not null default false,
  is_whatsapp boolean not null default false,
  is_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contact_phones_contact_id_idx on public.contact_phones (contact_id);
create index if not exists contact_phones_user_id_idx on public.contact_phones (user_id);
create index if not exists contact_phones_number_idx on public.contact_phones (phone_number);

alter table public.contact_phones enable row level security;

drop policy if exists "select own contact_phones" on public.contact_phones;
create policy "select own contact_phones"
  on public.contact_phones for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_phones" on public.contact_phones;
create policy "insert own contact_phones"
  on public.contact_phones for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own contact_phones" on public.contact_phones;
create policy "update own contact_phones"
  on public.contact_phones for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_phones" on public.contact_phones;
create policy "delete own contact_phones"
  on public.contact_phones for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.contact_phones to authenticated;

create table if not exists public.contact_emails (
  id bigint generated always as identity primary key,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  label text not null default 'Other'
    check (label in ('Primary', 'Secondary', 'Work', 'Personal', 'Other')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contact_emails_contact_id_idx on public.contact_emails (contact_id);
create index if not exists contact_emails_user_id_idx on public.contact_emails (user_id);
create index if not exists contact_emails_email_idx on public.contact_emails (email);

alter table public.contact_emails enable row level security;

drop policy if exists "select own contact_emails" on public.contact_emails;
create policy "select own contact_emails"
  on public.contact_emails for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_emails" on public.contact_emails;
create policy "insert own contact_emails"
  on public.contact_emails for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own contact_emails" on public.contact_emails;
create policy "update own contact_emails"
  on public.contact_emails for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_emails" on public.contact_emails;
create policy "delete own contact_emails"
  on public.contact_emails for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.contact_emails to authenticated;

create table if not exists public.contact_addresses (
  id bigint generated always as identity primary key,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  address_type text not null default 'Other' check (address_type in ('Home', 'Work', 'Other')),
  line1 text, line2 text, city text, state text, country text, postal_code text,
  created_at timestamptz not null default now()
);

create index if not exists contact_addresses_contact_id_idx on public.contact_addresses (contact_id);
create index if not exists contact_addresses_user_id_idx on public.contact_addresses (user_id);

alter table public.contact_addresses enable row level security;

drop policy if exists "select own contact_addresses" on public.contact_addresses;
create policy "select own contact_addresses"
  on public.contact_addresses for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_addresses" on public.contact_addresses;
create policy "insert own contact_addresses"
  on public.contact_addresses for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own contact_addresses" on public.contact_addresses;
create policy "update own contact_addresses"
  on public.contact_addresses for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_addresses" on public.contact_addresses;
create policy "delete own contact_addresses"
  on public.contact_addresses for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.contact_addresses to authenticated;

-- ----------------------------------------------------------------------------
-- Groups (Section 5) - a real many-to-many, unlike tags (plain array on
-- contacts) since groups need their own identity (rename/delete/list).
-- ----------------------------------------------------------------------------
create table if not exists public.contact_groups (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists contact_groups_user_id_idx on public.contact_groups (user_id);

alter table public.contact_groups enable row level security;

drop policy if exists "select own contact_groups" on public.contact_groups;
create policy "select own contact_groups"
  on public.contact_groups for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_groups" on public.contact_groups;
create policy "insert own contact_groups"
  on public.contact_groups for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own contact_groups" on public.contact_groups;
create policy "update own contact_groups"
  on public.contact_groups for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_groups" on public.contact_groups;
create policy "delete own contact_groups"
  on public.contact_groups for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.contact_groups to authenticated;

-- A synthetic id (rather than a bare composite PK on group_id/contact_id) so
-- this table works with the frontend's generic insertRow/updateRow/deleteRow
-- helpers (which assume a single `id` column) exactly like every other table
-- in this schema - the natural key is still enforced via the unique().
create table if not exists public.contact_group_members (
  id bigint generated always as identity primary key,
  group_id bigint not null references public.contact_groups(id) on delete cascade,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (group_id, contact_id)
);

create index if not exists contact_group_members_group_id_idx on public.contact_group_members (group_id);
create index if not exists contact_group_members_contact_id_idx on public.contact_group_members (contact_id);

alter table public.contact_group_members enable row level security;

drop policy if exists "select own contact_group_members" on public.contact_group_members;
create policy "select own contact_group_members"
  on public.contact_group_members for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_group_members" on public.contact_group_members;
create policy "insert own contact_group_members"
  on public.contact_group_members for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_group_members" on public.contact_group_members;
create policy "delete own contact_group_members"
  on public.contact_group_members for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, delete on table public.contact_group_members to authenticated;

-- ----------------------------------------------------------------------------
-- Important dates / Notes / Reminders (Sections 23, 24)
-- ----------------------------------------------------------------------------
create table if not exists public.contact_important_dates (
  id bigint generated always as identity primary key,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  date_type text not null default 'Custom'
    check (date_type in ('Anniversary', 'Joining Date', 'Meeting', 'Renewal', 'Custom')),
  date date not null,
  label text,
  reminder_offset_days int,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists contact_important_dates_contact_id_idx on public.contact_important_dates (contact_id);
create index if not exists contact_important_dates_user_id_idx on public.contact_important_dates (user_id);
create index if not exists contact_important_dates_date_idx on public.contact_important_dates (date);

alter table public.contact_important_dates enable row level security;

drop policy if exists "select own contact_important_dates" on public.contact_important_dates;
create policy "select own contact_important_dates"
  on public.contact_important_dates for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_important_dates" on public.contact_important_dates;
create policy "insert own contact_important_dates"
  on public.contact_important_dates for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own contact_important_dates" on public.contact_important_dates;
create policy "update own contact_important_dates"
  on public.contact_important_dates for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_important_dates" on public.contact_important_dates;
create policy "delete own contact_important_dates"
  on public.contact_important_dates for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.contact_important_dates to authenticated;

-- contact_notes: a timestamped note log, not a single column on contacts -
-- private to the owning user, never visible to the contact even if the
-- contact is also a registered user of this app (Section 24).
create table if not exists public.contact_notes (
  id bigint generated always as identity primary key,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  note_text text not null,
  created_at timestamptz not null default now()
);

create index if not exists contact_notes_contact_id_idx on public.contact_notes (contact_id);
create index if not exists contact_notes_user_id_idx on public.contact_notes (user_id);

alter table public.contact_notes enable row level security;

drop policy if exists "select own contact_notes" on public.contact_notes;
create policy "select own contact_notes"
  on public.contact_notes for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_notes" on public.contact_notes;
create policy "insert own contact_notes"
  on public.contact_notes for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_notes" on public.contact_notes;
create policy "delete own contact_notes"
  on public.contact_notes for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, delete on table public.contact_notes to authenticated;

create table if not exists public.contact_reminders (
  id bigint generated always as identity primary key,
  contact_id bigint not null references public.contacts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  remind_at timestamptz not null,
  message text not null,
  is_done boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contact_reminders_contact_id_idx on public.contact_reminders (contact_id);
create index if not exists contact_reminders_user_id_idx on public.contact_reminders (user_id);
create index if not exists contact_reminders_remind_at_idx on public.contact_reminders (remind_at);

alter table public.contact_reminders enable row level security;

drop policy if exists "select own contact_reminders" on public.contact_reminders;
create policy "select own contact_reminders"
  on public.contact_reminders for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own contact_reminders" on public.contact_reminders;
create policy "insert own contact_reminders"
  on public.contact_reminders for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own contact_reminders" on public.contact_reminders;
create policy "update own contact_reminders"
  on public.contact_reminders for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own contact_reminders" on public.contact_reminders;
create policy "delete own contact_reminders"
  on public.contact_reminders for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.contact_reminders to authenticated;

-- ----------------------------------------------------------------------------
-- Privacy settings + discovery (Sections 9, 27) and a username for the
-- "unique user ID" discovery method.
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists username text unique;

create table if not exists public.user_privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  who_can_find_me text not null default 'Contacts'
    check (who_can_find_me in ('Anyone', 'Contacts', 'Nobody')),
  who_can_message_me text not null default 'Contacts'
    check (who_can_message_me in ('Anyone', 'Contacts', 'Nobody')),
  who_can_call_me text not null default 'Contacts'
    check (who_can_call_me in ('Anyone', 'Contacts', 'Nobody')),
  show_online_status boolean not null default true,
  show_last_seen boolean not null default true,
  show_read_receipts boolean not null default true,
  show_profile_photo boolean not null default true,
  allow_contact_discovery boolean not null default true,
  allow_group_invitations boolean not null default true,
  allow_call_invitations boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_privacy_settings enable row level security;

drop policy if exists "select own user_privacy_settings" on public.user_privacy_settings;
create policy "select own user_privacy_settings"
  on public.user_privacy_settings for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "upsert own user_privacy_settings" on public.user_privacy_settings;
create policy "upsert own user_privacy_settings"
  on public.user_privacy_settings for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "update own user_privacy_settings" on public.user_privacy_settings;
create policy "update own user_privacy_settings"
  on public.user_privacy_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop trigger if exists set_user_privacy_settings_updated_at on public.user_privacy_settings;
create trigger set_user_privacy_settings_updated_at
  before update on public.user_privacy_settings
  for each row execute function public.set_updated_at();

grant select, insert, update on table public.user_privacy_settings to authenticated;

-- ----------------------------------------------------------------------------
-- find_portfolio_user (Section 9) - SECURITY DEFINER so it can read across
-- users' profiles/contacts/privacy settings, but returns only {id,
-- display_name} for a single exact match, and returns NOTHING at all (not a
-- distinguishable "exists but private" response) whenever the target's
-- privacy settings prohibit discovery - the same "expose the absolute
-- minimum" shape as get_display_names (014_community_notes_tickets.sql).
-- "Contacts only" is interpreted as: the searcher's phone/email is already
-- saved somewhere in the TARGET's own contact list.
-- ----------------------------------------------------------------------------
create or replace function public.find_portfolio_user(p_query text)
returns table(id uuid, display_name text)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_target record;
  v_privacy record;
  v_caller_email text;
  v_caller_mobile text;
  v_is_in_target_contacts boolean;
begin
  select p.id, p.full_name into v_target
  from public.profiles p
  where p.email = p_query or p.mobile = p_query or p.username = p_query
  limit 1;

  if v_target.id is null or v_target.id = v_caller then
    return;
  end if;

  select * into v_privacy from public.user_privacy_settings where user_id = v_target.id;
  if v_privacy.user_id is null then
    v_privacy.who_can_find_me := 'Contacts';
    v_privacy.allow_contact_discovery := true;
  end if;

  if not v_privacy.allow_contact_discovery or v_privacy.who_can_find_me = 'Nobody' then
    return;
  end if;

  if v_privacy.who_can_find_me = 'Contacts' then
    select email, mobile into v_caller_email, v_caller_mobile from public.profiles where id = v_caller;
    select exists(
      select 1 from public.contacts c
      left join public.contact_phones cp on cp.contact_id = c.id
      left join public.contact_emails ce on ce.contact_id = c.id
      where c.owner_user_id = v_target.id
        and ((v_caller_mobile is not null and cp.phone_number = v_caller_mobile)
             or (v_caller_email is not null and ce.email = v_caller_email))
    ) into v_is_in_target_contacts;
    if not v_is_in_target_contacts then
      return;
    end if;
  end if;

  return query select v_target.id, coalesce(v_target.full_name, 'User');
end;
$$;

revoke execute on function public.find_portfolio_user(text) from public, anon;
grant execute on function public.find_portfolio_user(text) to authenticated;

-- ----------------------------------------------------------------------------
-- Blocking / reporting (Section 26). private.is_blocked() checks either
-- direction and is reused by messages/calls INSERT policies in
-- 017_chat.sql/018_calls_privacy.sql so a block is enforced at the database
-- level, not only hidden in the UI.
-- ----------------------------------------------------------------------------
create table if not exists public.blocked_users (
  id bigint generated always as identity primary key,
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists blocked_users_blocker_id_idx on public.blocked_users (blocker_id);
create index if not exists blocked_users_blocked_id_idx on public.blocked_users (blocked_id);

alter table public.blocked_users enable row level security;

drop policy if exists "select own blocked_users" on public.blocked_users;
create policy "select own blocked_users"
  on public.blocked_users for select to authenticated using (blocker_id = (select auth.uid()));
drop policy if exists "insert own blocked_users" on public.blocked_users;
create policy "insert own blocked_users"
  on public.blocked_users for insert to authenticated with check (blocker_id = (select auth.uid()));
drop policy if exists "delete own blocked_users" on public.blocked_users;
create policy "delete own blocked_users"
  on public.blocked_users for delete to authenticated using (blocker_id = (select auth.uid()));

grant select, insert, delete on table public.blocked_users to authenticated;

create table if not exists public.reported_users (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_id uuid not null references auth.users(id) on delete cascade,
  reason text not null,
  details text,
  status text not null default 'Open' check (status in ('Open', 'Reviewed', 'Dismissed')),
  created_at timestamptz not null default now(),
  check (reporter_id <> reported_id)
);

create index if not exists reported_users_reporter_id_idx on public.reported_users (reporter_id);

alter table public.reported_users enable row level security;

drop policy if exists "select own reported_users" on public.reported_users;
create policy "select own reported_users"
  on public.reported_users for select to authenticated using (reporter_id = (select auth.uid()));
drop policy if exists "insert own reported_users" on public.reported_users;
create policy "insert own reported_users"
  on public.reported_users for insert to authenticated with check (reporter_id = (select auth.uid()));

grant select, insert on table public.reported_users to authenticated;

create or replace function private.is_blocked(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.blocked_users
    where (blocker_id = p_user_a and blocked_id = p_user_b)
       or (blocker_id = p_user_b and blocked_id = p_user_a)
  );
$$;

revoke execute on function private.is_blocked(uuid, uuid) from public, anon;
grant execute on function private.is_blocked(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_contact_reminders (Sections 23, 24) - cron-checked, folded into
-- the existing 15-minute automation job below. Reuses the app's unified
-- notifications table (new 'Contact Reminder'/'Contact Birthday' types) -
-- no separate chat/contact notification table, same as every other reminder
-- engine in this app.
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket', 'Recurring Reminder', 'Recurring Overdue',
                   'Contact Reminder', 'Contact Birthday', 'Contact Important Date'));

alter table public.notifications add column if not exists contact_id bigint references public.contacts(id) on delete cascade;
create index if not exists notifications_contact_id_idx on public.notifications (contact_id);

create or replace function public.fn_generate_contact_reminders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_rows int;
  v_inserted int := 0;
begin
  -- Manual follow-up reminders (Section 24) due now and not yet done.
  for v_row in
    select cr.id, cr.user_id, cr.contact_id, cr.message, c.display_name
    from public.contact_reminders cr
    join public.contacts c on c.id = cr.contact_id
    where not cr.is_done and cr.remind_at <= now()
  loop
    insert into public.notifications (user_id, contact_id, type, title, message, priority, dedupe_key)
    values (
      v_row.user_id, v_row.contact_id, 'Contact Reminder',
      format('Reminder - %s', v_row.display_name),
      v_row.message, 'Medium',
      'Contact Reminder' || '|' || v_row.contact_id::text || '|' || v_row.id::text || '|' || '' || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  -- Birthdays (contacts.birthday, month/day match against today).
  for v_row in
    select c.id as contact_id, c.owner_user_id as user_id, c.display_name
    from public.contacts c
    where c.birthday is not null
      and extract(month from c.birthday) = extract(month from current_date)
      and extract(day from c.birthday) = extract(day from current_date)
      and c.archived_at is null
  loop
    insert into public.notifications (user_id, contact_id, type, title, message, priority, dedupe_key)
    values (
      v_row.user_id, v_row.contact_id, 'Contact Birthday',
      format('Birthday today - %s', v_row.display_name),
      format('%s has a birthday today.', v_row.display_name),
      'Medium',
      'Contact Birthday' || '|' || v_row.contact_id::text || '|' || '' || '|' || '' || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  -- Other important dates, honoring each row's own reminder_offset_days.
  for v_row in
    select cid.id as date_id, cid.user_id, cid.contact_id, cid.label, cid.date_type,
           coalesce(cid.reminder_offset_days, 0) as offset_days, c.display_name
    from public.contact_important_dates cid
    join public.contacts c on c.id = cid.contact_id
    where extract(month from cid.date) = extract(month from current_date + coalesce(cid.reminder_offset_days, 0))
      and extract(day from cid.date) = extract(day from current_date + coalesce(cid.reminder_offset_days, 0))
  loop
    insert into public.notifications (user_id, contact_id, type, title, message, priority, dedupe_key)
    values (
      v_row.user_id, v_row.contact_id, 'Contact Important Date',
      format('%s - %s', coalesce(v_row.label, v_row.date_type), v_row.display_name),
      format('%s (%s) for %s is coming up.', coalesce(v_row.label, v_row.date_type), v_row.date_type, v_row.display_name),
      'Low',
      'Contact Important Date' || '|' || v_row.contact_id::text || '|' || v_row.date_id::text || '|' || '' || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_contact_reminders() from public, anon, authenticated;
