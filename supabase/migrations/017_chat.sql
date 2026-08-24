-- ============================================================================
-- 017: Private/Group Chat (spec addendum Sections 10-16, 22, 30-32, 40)
-- ============================================================================
-- Deliberately separate from Community Discussion (community_messages, one
-- shared open room) and Write to Us (support_tickets/ticket_messages) -
-- nothing in this file touches either of those tables, and neither of their
-- views are edited anywhere in this migration or its frontend counterpart.
--
-- No admin bypass anywhere in this file, same reasoning as 016_contacts.sql:
-- private messages are not portfolio data.
--
-- The load-bearing design decision: a group member's `history_visible_from`
-- on conversation_members is enforced INSIDE messages' own RLS SELECT
-- policy, not just as a client-side query filter - so "don't expose old
-- history to a new member" (Section 16) is a real access-control guarantee,
-- not a UI convenience a raw query could bypass.
-- ============================================================================

create table if not exists public.conversations (
  id bigint generated always as identity primary key,
  type text not null check (type in ('DIRECT', 'GROUP')),
  created_by uuid not null references auth.users(id) on delete cascade,
  name text,
  photo_path text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz
);

create index if not exists conversations_created_by_idx on public.conversations (created_by);

-- ----------------------------------------------------------------------------
-- conversation_members. A synthetic id (see 016_contacts.sql's
-- contact_group_members comment for why) plus the natural unique().
-- Exposes the whole row to any fellow active member (so everyone can see
-- who's in the conversation, roles, etc.) - the per-viewer preference
-- columns (muted_until/archived/pinned/last_read_message_id) leak slightly
-- to other members this way, which is an accepted, non-sensitive trade-off
-- rather than a split public/private roster table.
--
-- Created here, right after the bare `conversations` table and before
-- either table's RLS policies, because `conversations`' own SELECT/UPDATE
-- policies below need to reference conversation_members - a policy is
-- checked against the schema at CREATE POLICY time, so conversation_members
-- must already exist before those policies are defined (a forward reference
-- here fails with "relation conversation_members does not exist", not a
-- deferred/runtime error).
-- ----------------------------------------------------------------------------
create table if not exists public.conversation_members (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'MEMBER' check (role in ('MEMBER', 'ADMIN', 'OWNER')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  muted_until timestamptz,
  archived boolean not null default false,
  pinned boolean not null default false,
  -- Not FK-constrained on purpose - a stale/deleted reference just means
  -- "nothing read yet", not a correctness-critical link.
  last_read_message_id bigint,
  -- The real security boundary behind Section 16 ("don't expose old
  -- history"): null means unlimited (both sides of a fresh DIRECT chat, or
  -- a group's creator); a timestamp means "nothing before this is visible",
  -- enforced in messages' own SELECT policy below, not just client-side.
  history_visible_from timestamptz not null default now(),
  unique (conversation_id, user_id)
);

create index if not exists conversation_members_conversation_id_idx on public.conversation_members (conversation_id);
create index if not exists conversation_members_user_id_idx on public.conversation_members (user_id);

-- ----------------------------------------------------------------------------
-- These two SECURITY DEFINER helpers exist entirely to avoid RLS recursion,
-- and both are defined here - before EITHER table's policies - for the same
-- reason: conversations' policies call is_conversation_member(), and
-- conversation_members' own INSERT policy calls is_conversation_creator(),
-- so both functions must exist before any policy referencing them is
-- created.
--
-- The recursion problem this avoids is two-layered:
-- 1. A policy on table X that raw-subqueries table X itself (even aliased)
--    makes Postgres re-apply that SAME policy to the inner query, forever -
--    "infinite recursion detected in policy for relation X".
-- 2. Less obviously: a policy on X that raw-subqueries table Y, where Y's
--    OWN policy raw-subqueries X back, trips the SAME guard - Postgres's
--    reentrancy check fires as soon as expanding X's quals requires
--    expanding X's quals a second time (via Y), even though that second
--    visit would resolve cheaply through a plain column check. It does not
--    credit short-circuit evaluation; the mere repeat visit is enough.
-- A SECURITY DEFINER function call is opaque to both: its own internal
-- query runs as the (RLS-bypassing) function owner, so it's never subject
-- to the calling table's - or any other table's - RLS at all, which is
-- what actually breaks the cycle in either case.
-- ----------------------------------------------------------------------------
create or replace function private.is_conversation_member(p_conversation_id bigint, p_user_id uuid, p_roles text[] default null)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = p_user_id
      and cm.left_at is null
      and (p_roles is null or cm.role = any(p_roles))
  );
$$;

revoke execute on function private.is_conversation_member(bigint, uuid, text[]) from public, anon;
grant execute on function private.is_conversation_member(bigint, uuid, text[]) to authenticated;

create or replace function private.is_conversation_creator(p_conversation_id bigint, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id and c.created_by = p_user_id
  );
$$;

revoke execute on function private.is_conversation_creator(bigint, uuid) from public, anon;
grant execute on function private.is_conversation_creator(bigint, uuid) to authenticated;

alter table public.conversations enable row level security;

-- The `created_by = auth.uid()` branch matters beyond just "the creator can
-- always see their own conversation": supabase-js's insert(...).select()
-- immediately re-reads the just-inserted row under this SAME select policy
-- to build its return value, and at that exact moment the creator's own
-- conversation_members row doesn't exist yet (it's added in a separate,
-- later API call) - without this branch, Postgres rejects the insert
-- itself with "new row violates row-level security policy for table
-- conversations", since RETURNING visibility is checked against this same
-- policy. Same root cause as the conversation_members recursion fix above:
-- a brand-new row can't yet be found via a row that depends on it existing.
--
-- These policies call private.is_conversation_member() rather than a raw
-- `exists (select ... from conversation_members ...)` subquery for a
-- second reason beyond avoiding self-recursion: conversation_members' own
-- INSERT policy (below) contains a raw subquery against `conversations`.
-- If conversations' policy ALSO held a raw subquery against
-- conversation_members, Postgres's RLS reentrancy guard sees this as
-- conversation_members -> conversations -> conversation_members within one
-- statement's qual expansion and throws "infinite recursion detected" -
-- it does not credit the fact that the innermost reference would resolve
-- cheaply; the mere repeat visit to the same relation during expansion is
-- enough to trip it. A SECURITY DEFINER function call is opaque to this
-- expansion (its own internal query runs as the bypassing function owner,
-- so it's never subject to conversation_members' RLS at all), which is
-- what actually breaks the cycle - not just short-circuit evaluation.
drop policy if exists "select member conversations" on public.conversations;
create policy "select member conversations"
  on public.conversations for select to authenticated
  using (
    created_by = (select auth.uid())
    or private.is_conversation_member(conversations.id, (select auth.uid()))
  );

drop policy if exists "insert own conversations" on public.conversations;
create policy "insert own conversations"
  on public.conversations for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists "update member conversations" on public.conversations;
create policy "update member conversations"
  on public.conversations for update to authenticated
  using (
    created_by = (select auth.uid())
    or private.is_conversation_member(conversations.id, (select auth.uid()), array['ADMIN', 'OWNER'])
  );

drop trigger if exists set_conversations_updated_at on public.conversations;
create trigger set_conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

grant select, insert, update on table public.conversations to authenticated;

alter table public.conversation_members enable row level security;

-- `user_id = auth.uid()` first: a member can always see their OWN row
-- directly, no lookup needed - this is what makes the very first insert
-- (adding yourself as OWNER to a conversation you just created) visible to
-- its own RETURNING clause, since at that instant no OTHER conversation_
-- members row exists yet to satisfy the fellow-member check below.
drop policy if exists "select fellow conversation_members" on public.conversation_members;
create policy "select fellow conversation_members"
  on public.conversation_members for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_conversation_member(conversation_members.conversation_id, (select auth.uid()))
  );

-- Bootstrapping: a user may add THEMSELVES only to a conversation they
-- created (the first-row case for a brand new DIRECT/GROUP conversation);
-- adding anyone else (or re-adding yourself after leaving) requires being
-- an existing ADMIN/OWNER of that conversation.
drop policy if exists "insert conversation_members" on public.conversation_members;
create policy "insert conversation_members"
  on public.conversation_members for insert to authenticated
  with check (
    (user_id = (select auth.uid()) and private.is_conversation_creator(conversation_members.conversation_id, (select auth.uid())))
    or private.is_conversation_member(conversation_members.conversation_id, (select auth.uid()), array['ADMIN', 'OWNER'])
  );

drop policy if exists "update conversation_members" on public.conversation_members;
create policy "update conversation_members"
  on public.conversation_members for update to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_conversation_member(conversation_members.conversation_id, (select auth.uid()), array['ADMIN', 'OWNER'])
  );

grant select, insert, update on table public.conversation_members to authenticated;

-- ----------------------------------------------------------------------------
-- messages (Sections 11, 12, 39). `status` is the sender-side lifecycle
-- only; per-recipient delivered/read state lives in message_reads since a
-- group has multiple readers at different times, which one column can't
-- represent. `forwarded_from_message_id` marks a row created by
-- fn_share_messages below - purely informational, not FK-enforced (the
-- original may later be deleted without breaking the forwarded copy).
-- ----------------------------------------------------------------------------
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  message_type text not null default 'TEXT'
    check (message_type in ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'FILE', 'CONTACT', 'SYSTEM', 'CALL')),
  content text,
  reply_to_message_id bigint references public.messages(id) on delete set null,
  forwarded_from_message_id bigint,
  status text not null default 'SENT' check (status in ('SENDING', 'SENT', 'FAILED', 'DELETED')),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index if not exists messages_conversation_id_idx on public.messages (conversation_id, created_at);
create index if not exists messages_sender_id_idx on public.messages (sender_id);

alter table public.messages enable row level security;

drop policy if exists "select visible messages" on public.messages;
create policy "select visible messages"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = messages.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
      and (cm.history_visible_from is null or messages.created_at >= cm.history_visible_from)
  ));

drop policy if exists "insert own messages" on public.messages;
create policy "insert own messages"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    )
    and not exists (
      select 1 from public.conversations c
      join public.conversation_members other
        on other.conversation_id = c.id and other.user_id <> (select auth.uid()) and other.left_at is null
      where c.id = messages.conversation_id and c.type = 'DIRECT'
        and private.is_blocked((select auth.uid()), other.user_id)
    )
  );

-- Edit/soft-delete only, never a hard delete (matches the immutable-log
-- convention already used for payments/community_messages).
drop policy if exists "update own messages" on public.messages;
create policy "update own messages"
  on public.messages for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

grant select, insert, update on table public.messages to authenticated;

create or replace function private.fn_track_message_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.content is distinct from old.content and new.deleted_at is null then
    insert into public.message_edits (message_id, previous_content, edited_at)
    values (old.id, old.content, now());
    new.edited_at := now();
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Delete for Me (Section 12) - per-user hidden flag, distinct from the
-- shared `messages.deleted_at` ("Delete for Everyone"): hiding a message for
-- yourself must never affect what other members see.
-- ----------------------------------------------------------------------------
create table if not exists public.message_hidden_for_me (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  unique (message_id, user_id)
);

alter table public.message_hidden_for_me enable row level security;

drop policy if exists "select own message_hidden_for_me" on public.message_hidden_for_me;
create policy "select own message_hidden_for_me"
  on public.message_hidden_for_me for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "insert own message_hidden_for_me" on public.message_hidden_for_me;
create policy "insert own message_hidden_for_me"
  on public.message_hidden_for_me for insert to authenticated with check (user_id = (select auth.uid()));

grant select, insert on table public.message_hidden_for_me to authenticated;

-- ----------------------------------------------------------------------------
-- Attachments / Reactions / Edits / Reads - all gated through the same
-- "active member of the parent message's conversation, respecting
-- history_visible_from" shape as messages' own SELECT policy.
-- ----------------------------------------------------------------------------
create table if not exists public.message_attachments (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  file_size_bytes bigint,
  mime_type text,
  created_at timestamptz not null default now()
);

create index if not exists message_attachments_message_id_idx on public.message_attachments (message_id);

alter table public.message_attachments enable row level security;

drop policy if exists "select visible message_attachments" on public.message_attachments;
create policy "select visible message_attachments"
  on public.message_attachments for select to authenticated
  using (exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    where m.id = message_attachments.message_id
      and (cm.history_visible_from is null or m.created_at >= cm.history_visible_from)
  ));

drop policy if exists "insert own message_attachments" on public.message_attachments;
create policy "insert own message_attachments"
  on public.message_attachments for insert to authenticated
  with check (exists (select 1 from public.messages m where m.id = message_attachments.message_id and m.sender_id = (select auth.uid())));

grant select, insert on table public.message_attachments to authenticated;

create table if not exists public.message_reactions (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);

create index if not exists message_reactions_message_id_idx on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;

drop policy if exists "select visible message_reactions" on public.message_reactions;
create policy "select visible message_reactions"
  on public.message_reactions for select to authenticated
  using (exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    where m.id = message_reactions.message_id
  ));

drop policy if exists "insert own message_reactions" on public.message_reactions;
create policy "insert own message_reactions"
  on public.message_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    where m.id = message_reactions.message_id
  ));

drop policy if exists "update own message_reactions" on public.message_reactions;
create policy "update own message_reactions"
  on public.message_reactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own message_reactions" on public.message_reactions;
create policy "delete own message_reactions"
  on public.message_reactions for delete to authenticated using (user_id = (select auth.uid()));

grant select, insert, update, delete on table public.message_reactions to authenticated;

create table if not exists public.message_edits (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  previous_content text,
  edited_at timestamptz not null default now()
);

alter table public.message_edits enable row level security;

drop policy if exists "select visible message_edits" on public.message_edits;
create policy "select visible message_edits"
  on public.message_edits for select to authenticated
  using (exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    where m.id = message_edits.message_id
  ));

grant select on table public.message_edits to authenticated;

drop trigger if exists track_message_edit on public.messages;
create trigger track_message_edit
  before update on public.messages
  for each row execute function private.fn_track_message_edit();

create table if not exists public.message_reads (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  unique (message_id, user_id)
);

create index if not exists message_reads_message_id_idx on public.message_reads (message_id);

alter table public.message_reads enable row level security;

drop policy if exists "select visible message_reads" on public.message_reads;
create policy "select visible message_reads"
  on public.message_reads for select to authenticated
  using (exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    where m.id = message_reads.message_id
  ));

drop policy if exists "insert own message_reads" on public.message_reads;
create policy "insert own message_reads"
  on public.message_reads for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null
    where m.id = message_reads.message_id
  ));

grant select, insert on table public.message_reads to authenticated;

-- ----------------------------------------------------------------------------
-- Message-sharing engine (Sections 13, 40). SECURITY INVOKER on purpose:
-- every query inside still runs through the CALLER's own RLS, so a caller
-- can only ever read (and therefore copy) messages their own
-- history_visible_from already lets them see, and the copy-insert into the
-- target conversation is gated by messages' own INSERT policy exactly like
-- an ordinary send - no bypass logic duplicated here.
-- ----------------------------------------------------------------------------
create table if not exists public.shared_message_batches (
  id bigint generated always as identity primary key,
  source_conversation_id bigint not null references public.conversations(id) on delete cascade,
  target_conversation_id bigint not null references public.conversations(id) on delete cascade,
  shared_by uuid not null references auth.users(id) on delete cascade,
  shared_at timestamptz not null default now()
);

alter table public.shared_message_batches enable row level security;

drop policy if exists "select own shared_message_batches" on public.shared_message_batches;
create policy "select own shared_message_batches"
  on public.shared_message_batches for select to authenticated
  using (exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id in (source_conversation_id, target_conversation_id)
      and cm.user_id = (select auth.uid()) and cm.left_at is null
  ));

drop policy if exists "insert own shared_message_batches" on public.shared_message_batches;
create policy "insert own shared_message_batches"
  on public.shared_message_batches for insert to authenticated
  with check (
    shared_by = (select auth.uid())
    and exists (select 1 from public.conversation_members cm where cm.conversation_id = source_conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null)
    and exists (select 1 from public.conversation_members cm where cm.conversation_id = target_conversation_id and cm.user_id = (select auth.uid()) and cm.left_at is null)
  );

grant select, insert on table public.shared_message_batches to authenticated;

create table if not exists public.shared_message_items (
  id bigint generated always as identity primary key,
  batch_id bigint not null references public.shared_message_batches(id) on delete cascade,
  source_message_id bigint not null references public.messages(id) on delete cascade
);

alter table public.shared_message_items enable row level security;

drop policy if exists "select own shared_message_items" on public.shared_message_items;
create policy "select own shared_message_items"
  on public.shared_message_items for select to authenticated
  using (exists (
    select 1 from public.shared_message_batches b
    join public.conversation_members cm on cm.conversation_id in (b.source_conversation_id, b.target_conversation_id)
    where b.id = shared_message_items.batch_id and cm.user_id = (select auth.uid()) and cm.left_at is null
  ));

drop policy if exists "insert own shared_message_items" on public.shared_message_items;
create policy "insert own shared_message_items"
  on public.shared_message_items for insert to authenticated
  with check (exists (select 1 from public.shared_message_batches b where b.id = batch_id and b.shared_by = (select auth.uid())));

grant select, insert on table public.shared_message_items to authenticated;

create or replace function public.fn_share_messages(
  p_source_conversation_id bigint,
  p_target_conversation_id bigint,
  p_message_ids bigint[]
)
returns table(source_message_id bigint, new_message_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_batch_id bigint;
  v_msg record;
  v_new_id bigint;
begin
  insert into public.shared_message_batches (source_conversation_id, target_conversation_id, shared_by)
  values (p_source_conversation_id, p_target_conversation_id, v_caller)
  returning id into v_batch_id;

  for v_msg in
    select * from public.messages
    where id = any(p_message_ids) and conversation_id = p_source_conversation_id and deleted_at is null
    order by created_at
  loop
    insert into public.messages (conversation_id, sender_id, message_type, content, forwarded_from_message_id, status)
    values (p_target_conversation_id, v_caller, v_msg.message_type, v_msg.content, v_msg.id, 'SENT')
    returning id into v_new_id;

    insert into public.shared_message_items (batch_id, source_message_id) values (v_batch_id, v_msg.id);

    source_message_id := v_msg.id;
    new_message_id := v_new_id;
    return next;
  end loop;

  update public.conversations set last_message_at = now() where id = p_target_conversation_id;
end;
$$;

grant execute on function public.fn_share_messages(bigint, bigint, bigint[]) to authenticated;

-- ----------------------------------------------------------------------------
-- Storage: chat-attachments bucket, path convention
-- {conversation_id}/{message_id}/{filename} - any active member (not just
-- the uploader) can view, matching how any member can see a shared file.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;

drop policy if exists "select chat attachments for members" on storage.objects;
create policy "select chat attachments for members"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-attachments'
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid()) and cm.left_at is null
    )
  );

drop policy if exists "insert chat attachments for members" on storage.objects;
create policy "insert chat attachments for members"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid()) and cm.left_at is null
    )
  );

-- ----------------------------------------------------------------------------
-- Notifications: reuse the existing unified table (new types), same as
-- Contact* types in 016 and Recurring* types in 015 - no parallel system.
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
                   'Principal Expected', 'Large Payment Expected', 'Missed Payment',
                   'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
                   'Support Ticket', 'Recurring Reminder', 'Recurring Overdue',
                   'Contact Reminder', 'Contact Birthday', 'Contact Important Date',
                   'New Message', 'Group Message', 'Mention', 'Incoming Call', 'Missed Call'));

alter table public.notifications add column if not exists conversation_id bigint references public.conversations(id) on delete cascade;
create index if not exists notifications_conversation_id_idx on public.notifications (conversation_id);

create or replace function private.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member record;
  v_sender_name text;
  v_conv public.conversations;
begin
  if new.message_type = 'SYSTEM' then
    return new;
  end if;
  select full_name into v_sender_name from public.profiles where id = new.sender_id;
  select * into v_conv from public.conversations where id = new.conversation_id;

  for v_member in
    select user_id, muted_until from public.conversation_members
    where conversation_id = new.conversation_id and user_id <> new.sender_id and left_at is null
  loop
    if v_member.muted_until is not null and v_member.muted_until > now() then
      continue;
    end if;
    insert into public.notifications (user_id, conversation_id, type, title, message, priority, dedupe_key)
    values (
      v_member.user_id, new.conversation_id,
      case when v_conv.type = 'GROUP' then 'Group Message' else 'New Message' end,
      case when v_conv.type = 'GROUP'
        then format('%s in %s', coalesce(v_sender_name, 'Someone'), coalesce(v_conv.name, 'a group'))
        else format('New message from %s', coalesce(v_sender_name, 'Someone')) end,
      left(coalesce(new.content, 'Sent an attachment'), 140),
      'Medium',
      'Chat Message' || '|' || new.conversation_id::text || '|' || new.id::text || '|' || v_member.user_id::text || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists notify_new_message on public.messages;
create trigger notify_new_message
  after insert on public.messages
  for each row execute function private.notify_new_message();

-- ----------------------------------------------------------------------------
-- v_my_conversations (chat inbox) - security_invoker so it only ever
-- reflects the querying user's own RLS-visible rows; explicitly filtered to
-- cm.user_id = caller since conversation_members' own SELECT policy exposes
-- every fellow member's row (needed for a member list elsewhere), which
-- this view must not fan out into one inbox row per member.
-- ----------------------------------------------------------------------------
create or replace view public.v_my_conversations
with (security_invoker = true)
as
select
  cm.id as membership_id, cm.conversation_id, cm.role, cm.joined_at, cm.left_at,
  cm.muted_until, cm.archived, cm.pinned, cm.last_read_message_id, cm.history_visible_from,
  c.type, c.name, c.photo_path, c.description, c.created_by, c.created_at as conversation_created_at,
  c.last_message_at,
  (select count(*) from public.messages m
   where m.conversation_id = c.id and m.deleted_at is null
     and (cm.history_visible_from is null or m.created_at >= cm.history_visible_from)
     and m.id > coalesce(cm.last_read_message_id, 0)
  ) as unread_count
from public.conversation_members cm
join public.conversations c on c.id = cm.conversation_id
where cm.user_id = (select auth.uid()) and cm.left_at is null;

grant select on public.v_my_conversations to authenticated;

-- ----------------------------------------------------------------------------
-- Realtime: messages and reactions push instantly, same Postgres Changes +
-- RLS-scoped delivery already used for notifications/community_messages/
-- ticket_messages.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;
