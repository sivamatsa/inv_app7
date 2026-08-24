-- ============================================================================
-- 031: Expense & Project Cost Management - a generic, reusable engine
--      (Project -> Category -> Budget -> Transaction -> Vendor -> Documents)
--      rather than a "Home Expenses" tab. Home Construction is just the
--      first project; Wedding/Travel/Education/etc. are configuration, not
--      new development - see the plan file's own scope-decision list for
--      what's deliberately deferred (OCR/AI bill entry, an AI assistant,
--      month-end locking, construction-progress tracking, PDF export, a
--      second recurring-schedule engine - recurring BILLS like Rent/EMI/
--      Insurance already belong in the Recurring Investments module).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- expense_projects - unlimited projects, any type. project_type is free
-- text on purpose ("unlimited custom projects" is explicit in the spec) -
-- the 11 suggested types are a client-side icon/label lookup, not a DB
-- constraint.
-- ----------------------------------------------------------------------------
create table if not exists public.expense_projects (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  project_type text not null default 'Other',
  start_date date,
  end_date date,
  budget_total numeric,
  currency text not null default 'INR',
  description text,
  status text not null default 'Active' check (status in ('Active', 'Completed', 'On Hold', 'Cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expense_projects_user_id_idx on public.expense_projects (user_id);

alter table public.expense_projects enable row level security;

drop policy if exists "select own expense_projects" on public.expense_projects;
create policy "select own expense_projects"
  on public.expense_projects for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_projects" on public.expense_projects;
create policy "insert own expense_projects"
  on public.expense_projects for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_projects" on public.expense_projects;
create policy "update own expense_projects"
  on public.expense_projects for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_projects" on public.expense_projects;
create policy "delete own expense_projects"
  on public.expense_projects for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_expense_projects_updated_at on public.expense_projects;
create trigger set_expense_projects_updated_at
  before update on public.expense_projects
  for each row execute function public.set_updated_at();

drop trigger if exists audit_expense_projects on public.expense_projects;
create trigger audit_expense_projects
  after insert or update or delete on public.expense_projects
  for each row execute function public.audit_row_change();

-- ----------------------------------------------------------------------------
-- expense_categories - Category AND Sub-category are the same table; a
-- "sub-category" is just a row whose parent_category_id is set. A
-- transaction's single category_id can point at either level.
-- ----------------------------------------------------------------------------
create table if not exists public.expense_categories (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.expense_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  parent_category_id bigint references public.expense_categories(id) on delete cascade,
  budget_amount numeric,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists expense_categories_project_id_idx on public.expense_categories (project_id);
create index if not exists expense_categories_parent_id_idx on public.expense_categories (parent_category_id);

alter table public.expense_categories enable row level security;

drop policy if exists "select own expense_categories" on public.expense_categories;
create policy "select own expense_categories"
  on public.expense_categories for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_categories" on public.expense_categories;
create policy "insert own expense_categories"
  on public.expense_categories for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_categories" on public.expense_categories;
create policy "update own expense_categories"
  on public.expense_categories for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_categories" on public.expense_categories;
create policy "delete own expense_categories"
  on public.expense_categories for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists audit_expense_categories on public.expense_categories;
create trigger audit_expense_categories
  after insert or update or delete on public.expense_categories
  for each row execute function public.audit_row_change();

-- ----------------------------------------------------------------------------
-- expense_vendors - own table (not Contacts): a vendor needs GST/bank-UPI
-- reference fields Contacts doesn't have, and is portfolio-adjacent
-- financial data (Viewer-shareable), unlike Contacts which is deliberately
-- private with no admin/Viewer bypass at all. Optionally linked to an
-- existing Contact for convenience, never required.
-- ----------------------------------------------------------------------------
create table if not exists public.expense_vendors (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  address text,
  category text,
  gst_number text,
  bank_upi_reference text,
  linked_contact_id bigint references public.contacts(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expense_vendors_user_id_idx on public.expense_vendors (user_id);

alter table public.expense_vendors enable row level security;

drop policy if exists "select own expense_vendors" on public.expense_vendors;
create policy "select own expense_vendors"
  on public.expense_vendors for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_vendors" on public.expense_vendors;
create policy "insert own expense_vendors"
  on public.expense_vendors for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_vendors" on public.expense_vendors;
create policy "update own expense_vendors"
  on public.expense_vendors for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_vendors" on public.expense_vendors;
create policy "delete own expense_vendors"
  on public.expense_vendors for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_expense_vendors_updated_at on public.expense_vendors;
create trigger set_expense_vendors_updated_at
  before update on public.expense_vendors
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- expense_advances - a vendor advance; "remaining advance" is amount_paid
-- minus the sum of transactions linked to it via expense_transactions.advance_id.
-- ----------------------------------------------------------------------------
create table if not exists public.expense_advances (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.expense_projects(id) on delete cascade,
  vendor_id bigint not null references public.expense_vendors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_paid numeric not null,
  date_paid date not null default current_date,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists expense_advances_project_id_idx on public.expense_advances (project_id);
create index if not exists expense_advances_vendor_id_idx on public.expense_advances (vendor_id);

alter table public.expense_advances enable row level security;

drop policy if exists "select own expense_advances" on public.expense_advances;
create policy "select own expense_advances"
  on public.expense_advances for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_advances" on public.expense_advances;
create policy "insert own expense_advances"
  on public.expense_advances for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_advances" on public.expense_advances;
create policy "update own expense_advances"
  on public.expense_advances for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_advances" on public.expense_advances;
create policy "delete own expense_advances"
  on public.expense_advances for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- expense_transactions - the core table, the full expanded field list.
-- `amount` is ALWAYS the base/INR value, so every dashboard aggregate below
-- works unchanged regardless of currency; foreign_currency/foreign_amount/
-- exchange_rate are optional extra fields for record-keeping only, never
-- fetched live (no clean free FX source - same honesty as the FD reference
-- rate elsewhere in this app) and never overwritten.
-- ----------------------------------------------------------------------------
create table if not exists public.expense_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id bigint not null references public.expense_projects(id) on delete cascade,
  category_id bigint references public.expense_categories(id) on delete set null,
  transaction_date date not null default current_date,
  item text not null,
  amount numeric not null,
  transaction_type text not null check (transaction_type in ('Debit', 'Credit')),
  credit_type text check (credit_type in ('Refund', 'Advance Return', 'Discount', 'Received From Someone', 'Material Return', 'Other')),
  payment_method text check (payment_method in ('Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque', 'Other')),
  account_source text,
  vendor_id bigint references public.expense_vendors(id) on delete set null,
  description text,
  invoice_number text,
  payment_status text not null default 'Paid' check (payment_status in ('Paid', 'Pending', 'Partially Paid', 'Overdue', 'Cancelled')),
  amount_paid numeric,
  due_date date,
  advance_id bigint references public.expense_advances(id) on delete set null,
  notes text,
  currency text not null default 'INR',
  foreign_currency text,
  foreign_amount numeric,
  exchange_rate numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expense_transactions_project_id_idx on public.expense_transactions (project_id);
create index if not exists expense_transactions_category_id_idx on public.expense_transactions (category_id);
create index if not exists expense_transactions_vendor_id_idx on public.expense_transactions (vendor_id);
create index if not exists expense_transactions_date_idx on public.expense_transactions (transaction_date);

alter table public.expense_transactions enable row level security;

drop policy if exists "select own expense_transactions" on public.expense_transactions;
create policy "select own expense_transactions"
  on public.expense_transactions for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_transactions" on public.expense_transactions;
create policy "insert own expense_transactions"
  on public.expense_transactions for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_transactions" on public.expense_transactions;
create policy "update own expense_transactions"
  on public.expense_transactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_transactions" on public.expense_transactions;
create policy "delete own expense_transactions"
  on public.expense_transactions for delete to authenticated
  using (user_id = (select auth.uid()));

drop trigger if exists set_expense_transactions_updated_at on public.expense_transactions;
create trigger set_expense_transactions_updated_at
  before update on public.expense_transactions
  for each row execute function public.set_updated_at();

drop trigger if exists audit_expense_transactions on public.expense_transactions;
create trigger audit_expense_transactions
  after insert or update or delete on public.expense_transactions
  for each row execute function public.audit_row_change();

-- ----------------------------------------------------------------------------
-- expense_recurring_templates - a saved-values template for one-click
-- quick-entry (pre-fills the Add Transaction form). Deliberately NOT a
-- generation engine - no cron involvement, no auto-created occurrences.
-- Recurring BILLS (Rent/EMI/Insurance/Subscription/...) already belong in
-- the Recurring Investments module; this is only for a project's own
-- repeated line items (e.g. a weekly labour payment during construction).
-- ----------------------------------------------------------------------------
create table if not exists public.expense_recurring_templates (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.expense_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item text not null,
  category_id bigint references public.expense_categories(id) on delete set null,
  default_amount numeric,
  payment_method text,
  vendor_id bigint references public.expense_vendors(id) on delete set null,
  description text,
  frequency text check (frequency in ('Weekly', 'Monthly', 'Custom')),
  interval_days int,
  created_at timestamptz not null default now()
);

create index if not exists expense_recurring_templates_project_id_idx on public.expense_recurring_templates (project_id);

alter table public.expense_recurring_templates enable row level security;

drop policy if exists "select own expense_recurring_templates" on public.expense_recurring_templates;
create policy "select own expense_recurring_templates"
  on public.expense_recurring_templates for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_recurring_templates" on public.expense_recurring_templates;
create policy "insert own expense_recurring_templates"
  on public.expense_recurring_templates for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_recurring_templates" on public.expense_recurring_templates;
create policy "update own expense_recurring_templates"
  on public.expense_recurring_templates for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_recurring_templates" on public.expense_recurring_templates;
create policy "delete own expense_recurring_templates"
  on public.expense_recurring_templates for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- Custom Fields (spec Section 25) - the mechanism that makes Home
-- Construction's Floor/Room/Material/Quantity/Unit and Wedding's
-- Function/Guest Count/Venue configuration, not code.
-- ----------------------------------------------------------------------------
create table if not exists public.expense_project_custom_fields (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.expense_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  field_name text not null,
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date', 'select')),
  field_options jsonb,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists expense_project_custom_fields_project_id_idx on public.expense_project_custom_fields (project_id);

alter table public.expense_project_custom_fields enable row level security;

drop policy if exists "select own expense_project_custom_fields" on public.expense_project_custom_fields;
create policy "select own expense_project_custom_fields"
  on public.expense_project_custom_fields for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(user_id));

drop policy if exists "insert own expense_project_custom_fields" on public.expense_project_custom_fields;
create policy "insert own expense_project_custom_fields"
  on public.expense_project_custom_fields for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "update own expense_project_custom_fields" on public.expense_project_custom_fields;
create policy "update own expense_project_custom_fields"
  on public.expense_project_custom_fields for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "delete own expense_project_custom_fields" on public.expense_project_custom_fields;
create policy "delete own expense_project_custom_fields"
  on public.expense_project_custom_fields for delete to authenticated
  using (user_id = (select auth.uid()));

create table if not exists public.expense_transaction_custom_values (
  id bigint generated always as identity primary key,
  transaction_id bigint not null references public.expense_transactions(id) on delete cascade,
  custom_field_id bigint not null references public.expense_project_custom_fields(id) on delete cascade,
  value text,
  unique (transaction_id, custom_field_id)
);

alter table public.expense_transaction_custom_values enable row level security;

-- Ownership of a custom value is derived through its parent transaction
-- (this table has no user_id of its own - a value has no meaning without
-- its transaction) - same "join through the parent" shape as
-- message_reactions/message_reads elsewhere in this schema.
drop policy if exists "select own expense_transaction_custom_values" on public.expense_transaction_custom_values;
create policy "select own expense_transaction_custom_values"
  on public.expense_transaction_custom_values for select to authenticated
  using (exists (
    select 1 from public.expense_transactions t where t.id = transaction_id
      and (t.user_id = (select auth.uid()) or private.is_admin() or private.has_portfolio_view_access(t.user_id))
  ));

drop policy if exists "insert own expense_transaction_custom_values" on public.expense_transaction_custom_values;
create policy "insert own expense_transaction_custom_values"
  on public.expense_transaction_custom_values for insert to authenticated
  with check (exists (select 1 from public.expense_transactions t where t.id = transaction_id and t.user_id = (select auth.uid())));

drop policy if exists "update own expense_transaction_custom_values" on public.expense_transaction_custom_values;
create policy "update own expense_transaction_custom_values"
  on public.expense_transaction_custom_values for update to authenticated
  using (exists (select 1 from public.expense_transactions t where t.id = transaction_id and t.user_id = (select auth.uid())))
  with check (exists (select 1 from public.expense_transactions t where t.id = transaction_id and t.user_id = (select auth.uid())));

drop policy if exists "delete own expense_transaction_custom_values" on public.expense_transaction_custom_values;
create policy "delete own expense_transaction_custom_values"
  on public.expense_transaction_custom_values for delete to authenticated
  using (exists (select 1 from public.expense_transactions t where t.id = transaction_id and t.user_id = (select auth.uid())));

-- ----------------------------------------------------------------------------
-- Documents (011_storage.sql) get one more nullable link - reuses the
-- existing table/bucket/RLS as-is, not a new parallel attachment system.
-- ----------------------------------------------------------------------------
alter table public.documents add column if not exists expense_transaction_id bigint references public.expense_transactions(id) on delete cascade;
create index if not exists documents_expense_transaction_id_idx on public.documents (expense_transaction_id);

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.expense_projects to authenticated;
grant select, insert, update, delete on public.expense_categories to authenticated;
grant select, insert, update, delete on public.expense_vendors to authenticated;
grant select, insert, update, delete on public.expense_advances to authenticated;
grant select, insert, update, delete on public.expense_transactions to authenticated;
grant select, insert, update, delete on public.expense_recurring_templates to authenticated;
grant select, insert, update, delete on public.expense_project_custom_fields to authenticated;
grant select, insert, update, delete on public.expense_transaction_custom_values to authenticated;
grant usage, select on sequence public.expense_projects_id_seq to authenticated;
grant usage, select on sequence public.expense_categories_id_seq to authenticated;
grant usage, select on sequence public.expense_vendors_id_seq to authenticated;
grant usage, select on sequence public.expense_advances_id_seq to authenticated;
grant usage, select on sequence public.expense_transactions_id_seq to authenticated;
grant usage, select on sequence public.expense_recurring_templates_id_seq to authenticated;
grant usage, select on sequence public.expense_project_custom_fields_id_seq to authenticated;
grant usage, select on sequence public.expense_transaction_custom_values_id_seq to authenticated;

-- ----------------------------------------------------------------------------
-- Views (security_invoker so they only ever reflect the caller's own
-- RLS-visible rows - same pattern as v_deal_metrics/v_recurring_summary).
-- ----------------------------------------------------------------------------
create or replace view public.v_expense_project_summary
with (security_invoker = true)
as
select
  p.id as project_id, p.user_id, p.name, p.budget_total,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0) as total_debit,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Credit'), 0) as total_credit,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0)
    - coalesce(sum(t.amount) filter (where t.transaction_type = 'Credit'), 0) as net_expense,
  coalesce(sum(coalesce(t.amount_paid, t.amount)) filter (where t.transaction_type = 'Debit' and t.payment_status = 'Paid'), 0)
    + coalesce(sum(t.amount_paid) filter (where t.transaction_type = 'Debit' and t.payment_status = 'Partially Paid'), 0) as total_paid,
  coalesce(sum(t.amount - coalesce(t.amount_paid, 0)) filter (where t.transaction_type = 'Debit' and t.payment_status in ('Pending', 'Partially Paid', 'Overdue')), 0) as total_pending,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit' and date_trunc('month', t.transaction_date) = date_trunc('month', current_date)), 0) as this_month_total,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit' and date_trunc('year', t.transaction_date) = date_trunc('year', current_date)), 0) as this_year_total,
  p.budget_total - (
    coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0)
    - coalesce(sum(t.amount) filter (where t.transaction_type = 'Credit'), 0)
  ) as budget_remaining
from public.expense_projects p
left join public.expense_transactions t on t.project_id = p.id
group by p.id, p.user_id, p.name, p.budget_total;

grant select on public.v_expense_project_summary to authenticated;

create or replace view public.v_expense_category_summary
with (security_invoker = true)
as
select
  c.id as category_id, c.project_id, c.user_id, c.name, c.parent_category_id, c.budget_amount,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0) as actual_spent,
  case when c.budget_amount is not null then c.budget_amount - coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0) end as remaining,
  case when c.budget_amount is not null and c.budget_amount > 0
    then round(coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0) / c.budget_amount * 100, 1)
  end as pct_used
from public.expense_categories c
left join public.expense_transactions t on t.category_id = c.id
group by c.id, c.project_id, c.user_id, c.name, c.parent_category_id, c.budget_amount;

grant select on public.v_expense_category_summary to authenticated;

create or replace view public.v_expense_vendor_summary
with (security_invoker = true)
as
select
  v.id as vendor_id, v.user_id, v.name,
  coalesce(sum(t.amount) filter (where t.transaction_type = 'Debit'), 0) as total_paid,
  count(t.id) as transaction_count,
  coalesce(sum(t.amount - coalesce(t.amount_paid, 0)) filter (where t.transaction_type = 'Debit' and t.payment_status in ('Pending', 'Partially Paid', 'Overdue')), 0) as pending_amount
from public.expense_vendors v
left join public.expense_transactions t on t.vendor_id = v.id
group by v.id, v.user_id, v.name;

grant select on public.v_expense_vendor_summary to authenticated;

-- ----------------------------------------------------------------------------
-- Notifications: one more type pair, same unified table as every other
-- alert in this app - no parallel alert-delivery system.
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
                   'Calendar Reminder', 'Expense Budget Warning', 'Expense Budget Exceeded'));

alter table public.notifications add column if not exists expense_category_id bigint references public.expense_categories(id) on delete cascade;
create index if not exists notifications_expense_category_id_idx on public.notifications (expense_category_id);

-- ----------------------------------------------------------------------------
-- fn_generate_expense_budget_alerts - cron-checked, mirrors
-- fn_generate_gold_alerts()'s exact shape (percentage-crossing check ->
-- notification with a dedupe_key). Fires at >=90% (Warning) and >=100%
-- (Exceeded) of a category's own budget_amount - project-level totals
-- aren't alerted on separately, since every category rolling up to 100%+
-- of its own budget already implies the project is over too.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_expense_budget_alerts()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cat record;
  v_inserted int := 0;
  v_rows int;
begin
  for v_cat in
    select * from public.v_expense_category_summary
    where budget_amount is not null and budget_amount > 0 and pct_used >= 90
  loop
    insert into public.notifications (user_id, expense_category_id, type, title, message, priority, dedupe_key)
    values (
      v_cat.user_id, v_cat.category_id,
      case when v_cat.pct_used >= 100 then 'Expense Budget Exceeded' else 'Expense Budget Warning' end,
      case when v_cat.pct_used >= 100
        then format('%s budget exceeded by %s', v_cat.name, to_char(v_cat.actual_spent - v_cat.budget_amount, 'FM999999999.00'))
        else format('%s has reached %s%% of its budget', v_cat.name, v_cat.pct_used)
      end,
      format('%s: spent %s of a %s budget (%s%%).', v_cat.name, v_cat.actual_spent, v_cat.budget_amount, v_cat.pct_used),
      case when v_cat.pct_used >= 100 then 'High' else 'Medium' end,
      (case when v_cat.pct_used >= 100 then 'Expense Budget Exceeded' else 'Expense Budget Warning' end)
        || '|' || v_cat.category_id::text || '|' || '' || '|' || '' || '|' || current_date::text
    )
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_expense_budget_alerts() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Admin automation button + cron: fold the new alert generator into the
-- existing 15-minute job and fn_admin_run_automation(), same
-- unschedule-by-name/reschedule idiom every prior addendum has used.
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
  perform public.fn_generate_recurring_occurrences_all();
  perform public.fn_refresh_recurring_statuses();
  perform public.fn_generate_recurring_reminders();
  perform public.fn_generate_contact_reminders();
  perform public.fn_refresh_call_statuses();
  perform public.fn_generate_gold_alerts();
  perform public.fn_generate_calendar_event_reminders();
  perform public.fn_generate_expense_budget_alerts();
  return 'ok';
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'portfolio-automation-15min') then
    perform cron.unschedule('portfolio-automation-15min');
  end if;
end $$;

select cron.schedule(
  'portfolio-automation-15min',
  '*/15 * * * *',
  $$
  select public.fn_refresh_schedule_statuses();
  select public.fn_generate_reminders();
  select public.fn_generate_ai_insights();
  select public.fn_generate_recurring_occurrences_all();
  select public.fn_refresh_recurring_statuses();
  select public.fn_generate_recurring_reminders();
  select public.fn_generate_contact_reminders();
  select public.fn_refresh_call_statuses();
  select public.fn_generate_gold_alerts();
  select public.fn_generate_calendar_event_reminders();
  select public.fn_generate_expense_budget_alerts();
  $$
);
