-- ============================================================================
-- 002: Lookup / taxonomy tables (spec Section 39 "investment_categories",
--      "risk_ratings")
-- ============================================================================
-- These are UI-dropdown sources, not enforced foreign keys: `deals` stores
-- category/sub_category/risk_rating as plain text (per spec Section 4's flat
-- field list) so a user can always type a new value even if it isn't in the
-- lookup list yet. user_id = null rows are system defaults visible to every
-- signed-in user; a user can add their own on top (e.g. a platform-specific
-- risk grade) without being able to edit/delete the system defaults.
-- ============================================================================

create table if not exists public.investment_categories (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  investment_type text not null,
  category text not null,
  sub_category text,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.investment_categories is
  'UI dropdown source for deals.investment_type/category/sub_category. Not an enforced FK - deals stores the text directly.';

create index if not exists investment_categories_user_id_idx on public.investment_categories (user_id);

alter table public.investment_categories enable row level security;

drop policy if exists "read system + own categories" on public.investment_categories;
create policy "read system + own categories"
  on public.investment_categories for select
  to authenticated
  using (user_id is null or user_id = (select auth.uid()));

drop policy if exists "insert own categories" on public.investment_categories;
create policy "insert own categories"
  on public.investment_categories for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own categories" on public.investment_categories;
create policy "update own categories"
  on public.investment_categories for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own categories" on public.investment_categories;
create policy "delete own categories"
  on public.investment_categories for delete
  to authenticated
  using (user_id = (select auth.uid()));

insert into public.investment_categories (investment_type, category, sub_category, is_system)
select * from (values
  ('P2P Lending', 'P2P', 'Consumer Loan', true),
  ('P2P Lending', 'P2P', 'Business Loan', true),
  ('P2P Lending', 'P2P', 'Secured Loan', true),
  ('Lending', 'Peer Lending', 'Personal Loan', true),
  ('Fixed Income', 'Fixed Deposit', 'Bank FD', true),
  ('Fixed Income', 'Fixed Deposit', 'Corporate FD', true),
  ('Fixed Income', 'Bond', 'Government Bond', true),
  ('Fixed Income', 'Bond', 'Corporate Bond', true),
  ('Fixed Income', 'Debenture', null, true),
  ('Deposit', 'Recurring Deposit', null, true),
  ('Gold', 'Gold Scheme', 'Digital Gold', true),
  ('Gold', 'Gold Scheme', 'Sovereign Gold Bond', true),
  ('Other', 'Other', null, true)
) as v(investment_type, category, sub_category, is_system)
where not exists (
  select 1 from public.investment_categories existing
  where existing.is_system = true and existing.investment_type = v.investment_type
    and existing.category = v.category and coalesce(existing.sub_category,'') = coalesce(v.sub_category,'')
);

create table if not exists public.risk_ratings (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  code text not null,
  label text not null,
  description text,
  sort_order int not null default 0,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists risk_ratings_user_id_idx on public.risk_ratings (user_id);

alter table public.risk_ratings enable row level security;

drop policy if exists "read system + own risk ratings" on public.risk_ratings;
create policy "read system + own risk ratings"
  on public.risk_ratings for select
  to authenticated
  using (user_id is null or user_id = (select auth.uid()));

drop policy if exists "insert own risk ratings" on public.risk_ratings;
create policy "insert own risk ratings"
  on public.risk_ratings for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own risk ratings" on public.risk_ratings;
create policy "update own risk ratings"
  on public.risk_ratings for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "delete own risk ratings" on public.risk_ratings;
create policy "delete own risk ratings"
  on public.risk_ratings for delete
  to authenticated
  using (user_id = (select auth.uid()));

insert into public.risk_ratings (code, label, description, sort_order, is_system)
select * from (values
  ('LOW', 'Low Risk', 'Strong collateral/guarantor, reliable platform history', 1, true),
  ('MEDIUM', 'Medium Risk', 'Some uncertainty in recovery or platform track record', 2, true),
  ('HIGH', 'High Risk', 'Weak collateral, limited platform history, or early warning signs', 3, true),
  ('VERY_HIGH', 'Very High Risk', 'Significant default risk observed or expected', 4, true),
  ('UNRATED', 'Not Rated', 'Risk has not been assessed yet', 0, true)
) as v(code, label, description, sort_order, is_system)
where not exists (
  select 1 from public.risk_ratings existing where existing.is_system = true and existing.code = v.code
);
