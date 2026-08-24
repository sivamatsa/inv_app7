-- ============================================================================
-- 008: derived-financials views (spec Section 5, 12, 17)
-- ============================================================================
-- SECURITY: every view here is created WITH (security_invoker = true).
-- Without that, a view runs with its OWNER's privileges (the migration
-- role), which bypasses RLS on the underlying tables entirely - querying it
-- as any user would silently return every user's rows. security_invoker
-- (Postgres 15+) makes the view run as the querying user instead, so the
-- normal deals/payments RLS policies still apply. This is the single most
-- important line in this file - do not drop it when editing these views.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- v_deal_metrics (spec Section 5) - one row per deal, all derived fields
-- computed live from payments/payment_schedule rather than stored, so they
-- can never go stale (satisfies Section 51 rule 9 "derive totals from
-- transaction records" and Section 41 "automatic recalculation" by
-- construction - there is nothing to recalculate, it's always fresh).
-- ----------------------------------------------------------------------------
create or replace view public.v_deal_metrics
with (security_invoker = true)
as
select
  d.id as deal_id,
  d.user_id,
  d.platform_id,
  d.status,
  d.invested_amount,
  d.current_principal,

  (current_date - d.start_date) as days_active,
  case when d.maturity_date is not null then (d.maturity_date - current_date) end as days_to_maturity,
  case when d.maturity_date is not null
    then extract(year from age(d.maturity_date, current_date)) * 12 + extract(month from age(d.maturity_date, current_date))
  end as months_remaining,

  coalesce(pay.principal_returned, 0) as principal_returned,
  coalesce(pay.interest_received, 0) as interest_received,
  coalesce(sched.interest_pending, 0) as interest_pending,
  coalesce(sched.interest_overdue, 0) as interest_overdue,
  -- Section 5 core logic: Total Received = Principal + Interest + Other Income.
  -- "Other income" isn't separately modeled, so this uses each payment's
  -- gross `amount` (which already covers anything not split into
  -- principal/interest) rather than summing the two parts and risking
  -- double-counting against a payment that only ever had `amount` filled in.
  coalesce(pay.total_received, 0) as total_received,
  -- Section 5 core logic: Outstanding = Invested Amount - Principal Received.
  greatest(0, d.invested_amount - coalesce(pay.principal_returned, 0)) as total_outstanding,

  case when d.invested_amount > 0
    then round(coalesce(pay.interest_received, 0) / d.invested_amount * 100, 4)
  end as realized_roi,
  case when d.invested_amount > 0 and (current_date - d.start_date) > 0
    then round(coalesce(pay.interest_received, 0) / d.invested_amount * 100
               * (365.0 / (current_date - d.start_date)), 4)
  end as annualized_realized_roi,
  coalesce(d.annual_roi,
    case when d.invested_amount > 0 then round(d.expected_total_interest / d.invested_amount * 100, 4) end
  ) as expected_roi,

  coalesce(pay.payout_count, 0) as payout_count,
  coalesce(sched.missed_payment_count, 0) as missed_payment_count,
  coalesce(sched.late_payment_count, 0) as late_payment_count,
  coalesce(sched.early_payment_count, 0) as early_payment_count,
  coalesce(sched.on_time_payment_count, 0) as on_time_payment_count,

  -- Section 17's exact formula: (early + on-time completed) / total
  -- completed scheduled x 100, excluding rows still in the future (UPCOMING/
  -- DUE_TODAY/OVERDUE haven't resolved yet, so they're excluded from both
  -- sides of the ratio, not counted as failures).
  case when coalesce(sched.completed_count, 0) > 0
    then round((coalesce(sched.early_payment_count, 0) + coalesce(sched.on_time_payment_count, 0)
                 + coalesce(sched.plain_received_count, 0))::numeric / sched.completed_count * 100, 2)
  end as payout_reliability,

  case when d.invested_amount > 0
    then round(coalesce(pay.principal_returned, 0) / d.invested_amount * 100, 2)
  end as recovery_percentage,

  case
    when d.status in ('CLOSED', 'MATURED') then 'Matured'
    when d.maturity_date is null then 'No Maturity Date'
    when d.maturity_date <= current_date then 'Past Maturity'
    when d.maturity_date <= current_date + interval '30 days' then 'Maturing Soon'
    else 'Active'
  end as maturity_status

from public.deals d
left join lateral (
  select
    sum(p.principal_amount) filter (where not p.is_voided) as principal_returned,
    sum(p.interest_amount) filter (where not p.is_voided) as interest_received,
    sum(p.amount) filter (where not p.is_voided) as total_received,
    count(*) filter (where not p.is_voided) as payout_count
  from public.payments p
  where p.deal_id = d.id
) pay on true
left join lateral (
  select
    sum(ps.expected_interest) filter (where ps.status in ('UPCOMING', 'DUE_TODAY', 'OVERDUE')) as interest_pending,
    sum(ps.expected_interest) filter (where ps.status = 'OVERDUE') as interest_overdue,
    count(*) filter (where ps.status = 'MISSED') as missed_payment_count,
    count(*) filter (where ps.status = 'RECEIVED_LATE') as late_payment_count,
    count(*) filter (where ps.status = 'RECEIVED_EARLY') as early_payment_count,
    count(*) filter (where ps.status = 'RECEIVED_ON_TIME') as on_time_payment_count,
    count(*) filter (where ps.status = 'RECEIVED') as plain_received_count,
    count(*) filter (where ps.status in
      ('RECEIVED', 'RECEIVED_EARLY', 'RECEIVED_ON_TIME', 'RECEIVED_LATE', 'PARTIALLY_RECEIVED', 'MISSED')
    ) as completed_count
  from public.payment_schedule ps
  where ps.deal_id = d.id
) sched on true;

-- ----------------------------------------------------------------------------
-- v_portfolio_summary (spec Section 12) - one row per user, the dashboard
-- headline numbers. Built on top of v_deal_metrics (already security_invoker)
-- so it inherits the same RLS-safety; still declared explicitly for clarity.
-- ----------------------------------------------------------------------------
create or replace view public.v_portfolio_summary
with (security_invoker = true)
as
select
  d.user_id,

  sum(d.invested_amount) as total_invested,
  sum(d.current_principal) as current_outstanding_principal,
  sum(vdm.principal_returned) as principal_returned,
  sum(vdm.interest_received) as interest_earned,
  sum(vdm.interest_pending) as interest_pending,
  sum(case when d.status = 'ACTIVE' then coalesce(d.expected_total_interest, 0) - vdm.interest_received else 0 end)
    as expected_future_interest,
  -- Total portfolio value = capital still deployed + interest earned but not
  -- yet withdrawn/reinvested. Documented here because the spec names this
  -- metric without a formula.
  sum(d.current_principal) + sum(vdm.interest_pending) as total_portfolio_value,
  sum(vdm.interest_received) - sum(d.fees) - sum(d.tax_withheld) as net_profit,

  case when sum(d.invested_amount) > 0
    then round(sum(vdm.interest_received) / sum(d.invested_amount) * 100, 4)
  end as realized_roi,
  case when sum(d.invested_amount) > 0 and avg(vdm.days_active) > 0
    then round(sum(vdm.interest_received) / sum(d.invested_amount) * 100 * (365.0 / avg(vdm.days_active)), 4)
  end as annualized_roi,
  -- Weighted by capital, active deals with a known rate only (this is meant
  -- to read as "the yield of capital currently at work", not a lifetime
  -- average including closed deals). The filter is repeated identically on
  -- both sides so a deal with no annual_roi set is excluded from the ratio
  -- entirely, rather than counted in the denominator but not the numerator
  -- (which would silently understate the result).
  case when sum(d.invested_amount) filter (where d.status = 'ACTIVE' and d.annual_roi is not null) > 0
    then round(
      sum(d.annual_roi * d.invested_amount) filter (where d.status = 'ACTIVE' and d.annual_roi is not null)
      / sum(d.invested_amount) filter (where d.status = 'ACTIVE' and d.annual_roi is not null), 4)
  end as weighted_average_roi,

  count(*) filter (where d.status = 'ACTIVE') as active_deals_count,
  count(*) filter (where d.status in ('CLOSED', 'MATURED')) as closed_deals_count,
  count(distinct d.id) filter (where vdm.missed_payment_count > 0 or vdm.interest_overdue > 0) as overdue_deals_count

from public.deals d
join public.v_deal_metrics vdm on vdm.deal_id = d.id
group by d.user_id;
