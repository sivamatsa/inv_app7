-- ============================================================================
-- 036: Reconciliation Center - extends the existing Bank Reconciliation
--      matcher (payments.js, bank_transactions/payment_matches from
--      007_optional_tables.sql) to also resolve a bank transaction against a
--      Recurring occurrence, not just a Deal payment schedule row. One new
--      nullable column - payment_matches already supports a match resolving
--      to nothing-in-particular (both deal_id and payment_id are nullable),
--      so this follows the same shape rather than introducing a new table.
-- ============================================================================

alter table public.payment_matches
  add column if not exists recurring_occurrence_id bigint references public.recurring_occurrences(id) on delete set null;

create index if not exists payment_matches_recurring_occurrence_id_idx
  on public.payment_matches (recurring_occurrence_id);
