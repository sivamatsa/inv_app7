-- ============================================================================
-- 028: Blog / Knowledge Sharing - a shared space for any signed-in user to
--      post or share knowledge, same visibility model as Community
--      Discussion (014_community_notes_tickets.sql): open to every
--      signed-in user on purpose, one of the few deliberately shared
--      (not per-user-isolated) corners of this app.
-- ============================================================================

create table if not exists public.blog_posts (
  id bigint generated always as identity primary key,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null,
  category text,
  tags text[] not null default '{}',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blog_posts_author_user_id_idx on public.blog_posts (author_user_id);
create index if not exists blog_posts_created_at_idx on public.blog_posts (created_at desc);

alter table public.blog_posts enable row level security;

drop policy if exists "select all blog_posts" on public.blog_posts;
create policy "select all blog_posts"
  on public.blog_posts for select to authenticated using (true);

drop policy if exists "insert own blog_posts" on public.blog_posts;
create policy "insert own blog_posts"
  on public.blog_posts for insert to authenticated
  with check (author_user_id = (select auth.uid()));

drop policy if exists "update own blog_posts" on public.blog_posts;
create policy "update own blog_posts"
  on public.blog_posts for update to authenticated
  using (author_user_id = (select auth.uid()) or private.is_admin())
  with check (author_user_id = (select auth.uid()) or private.is_admin());

drop policy if exists "delete own blog_posts" on public.blog_posts;
create policy "delete own blog_posts"
  on public.blog_posts for delete to authenticated
  using (author_user_id = (select auth.uid()) or private.is_admin());

drop trigger if exists set_blog_posts_updated_at on public.blog_posts;
create trigger set_blog_posts_updated_at
  before update on public.blog_posts
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.blog_posts to authenticated;
grant usage, select on sequence public.blog_posts_id_seq to authenticated;

create table if not exists public.blog_comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.blog_posts(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists blog_comments_post_id_idx on public.blog_comments (post_id);

alter table public.blog_comments enable row level security;

drop policy if exists "select all blog_comments" on public.blog_comments;
create policy "select all blog_comments"
  on public.blog_comments for select to authenticated using (true);

drop policy if exists "insert own blog_comments" on public.blog_comments;
create policy "insert own blog_comments"
  on public.blog_comments for insert to authenticated
  with check (author_user_id = (select auth.uid()));

drop policy if exists "delete own blog_comments" on public.blog_comments;
create policy "delete own blog_comments"
  on public.blog_comments for delete to authenticated
  using (author_user_id = (select auth.uid()) or private.is_admin());

grant select, insert, delete on public.blog_comments to authenticated;
grant usage, select on sequence public.blog_comments_id_seq to authenticated;
