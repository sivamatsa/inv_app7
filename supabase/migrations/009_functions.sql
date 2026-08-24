-- ============================================================================
-- 009: automation functions
--   - fn_generate_payment_schedule: spec Section 22 (schedule generation)
--   - fn_record_payment:            spec Section 8  (payment processing pipeline)
--   - fn_refresh_schedule_statuses: spec Section 9  (status transitions)
--   - fn_generate_reminders:        spec Sections 10, 42 (daily automation)
--   - fn_generate_ai_insights:      spec Section 37 (deterministic, not an LLM)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- fn_generate_payment_schedule
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER (the default): runs as the calling user, so the SELECT on
-- deals and the INSERTs into payment_schedule are gated by their normal RLS
-- policies. A caller can only ever generate a schedule for their own deal -
-- there is no need to bypass RLS here, so it deliberately doesn't.
--
-- Irregular/Custom frequencies are Section 22's explicit "manual schedule
-- upload" case, so this returns 0 rows for those rather than guessing a
-- cadence. Interest math is simple (non-compounding) periodic interest on
-- the declining balance: rate_per_period = annual_roi / periods_per_year.
-- Rounding remainders are absorbed into the final instalment.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_payment_schedule(p_deal_id bigint)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  d public.deals;
  v_periods_per_year int;
  v_period_interval interval;
  v_rate_per_period numeric;
  v_balance numeric;
  v_emi numeric;
  v_interest numeric;
  v_principal numeric;
  v_total_periods int;
  v_period_no int;
  v_inserted int := 0;
  v_dates date[];
  v_end_date date;
  v_years_active numeric;
begin
  select * into d from public.deals where id = p_deal_id;
  if d.id is null then
    raise exception 'Deal % not found or not accessible', p_deal_id;
  end if;

  if d.payment_frequency in ('Irregular', 'Custom') then
    return 0;
  end if;

  -- Only touch still-pending rows - a row with a real payment against it
  -- (RECEIVED*, PARTIALLY_RECEIVED, MISSED, WAIVED, CANCELLED) is history
  -- and is never regenerated away.
  delete from public.payment_schedule
  where deal_id = p_deal_id and status in ('UPCOMING', 'DUE_TODAY', 'OVERDUE');

  v_end_date := d.maturity_date;
  if v_end_date is null then
    raise exception 'Deal % needs a maturity_date to generate a payment schedule', p_deal_id;
  end if;

  v_years_active := extract(epoch from (v_end_date::timestamp - d.start_date::timestamp)) / (365.0 * 86400);

  if d.payment_frequency = 'At Maturity' then
    v_dates := array[v_end_date];
    v_periods_per_year := 1;
  else
    case d.payment_frequency
      when 'Monthly' then v_periods_per_year := 12; v_period_interval := interval '1 month';
      when 'Quarterly' then v_periods_per_year := 4; v_period_interval := interval '3 months';
      when 'Half-Yearly' then v_periods_per_year := 2; v_period_interval := interval '6 months';
      when 'Yearly' then v_periods_per_year := 1; v_period_interval := interval '12 months';
      else raise exception 'Unhandled payment_frequency % for deal %', d.payment_frequency, p_deal_id;
    end case;

    select array_agg(gs::date order by gs) into v_dates
    from generate_series(
      coalesce(d.first_payment_date, d.start_date + v_period_interval)::timestamp,
      v_end_date::timestamp,
      v_period_interval
    ) gs;

    if v_dates is null or array_length(v_dates, 1) = 0 then
      v_dates := array[v_end_date];
    elsif v_dates[array_length(v_dates, 1)] <> v_end_date then
      v_dates := v_dates || v_end_date;
    end if;
  end if;

  v_total_periods := array_length(v_dates, 1);
  if v_total_periods > 1200 then
    raise exception 'Deal % would generate % schedule rows - check start/maturity dates', p_deal_id, v_total_periods;
  end if;

  v_rate_per_period := coalesce(d.annual_roi, 0) / 100.0 / v_periods_per_year;
  v_balance := d.invested_amount;

  if d.payout_type = 'EMI' then
    if v_rate_per_period > 0 then
      v_emi := round(
        v_balance * v_rate_per_period * power(1 + v_rate_per_period, v_total_periods)
        / (power(1 + v_rate_per_period, v_total_periods) - 1), 2);
    else
      v_emi := round(v_balance / v_total_periods, 2);
    end if;
  end if;

  for v_period_no in 1 .. v_total_periods loop
    declare
      v_is_final boolean := (v_period_no = v_total_periods);
      v_date date := v_dates[v_period_no];
    begin
      case d.payout_type
        when 'Interest Only' then
          v_interest := round(v_balance * v_rate_per_period, 2);
          v_principal := 0;
        when 'Principal at Maturity' then
          v_interest := round(d.invested_amount * v_rate_per_period, 2);
          v_principal := case when v_is_final then v_balance else 0 end;
        when 'Bullet' then
          v_interest := round(v_balance * v_rate_per_period, 2);
          v_principal := case when v_is_final then v_balance else 0 end;
        when 'Interest at Maturity' then
          v_interest := case when v_is_final
            then round(d.invested_amount * coalesce(d.annual_roi, 0) / 100.0 * v_years_active, 2)
            else 0 end;
          v_principal := case when v_is_final then v_balance else 0 end;
        when 'EMI' then
          v_interest := round(v_balance * v_rate_per_period, 2);
          v_principal := least(v_balance, greatest(0, round(v_emi - v_interest, 2)));
          if v_is_final then
            v_principal := v_balance;
          end if;
        else
          -- 'Interest + Principal' and any value not explicitly modelled
          -- above: straight-line principal, interest on declining balance.
          v_principal := case when v_is_final then v_balance else round(d.invested_amount / v_total_periods, 2) end;
          v_interest := round(v_balance * v_rate_per_period, 2);
      end case;

      insert into public.payment_schedule
        (user_id, deal_id, scheduled_date, expected_interest, expected_principal, payment_type, grace_period_days)
      values (d.user_id, d.id, v_date, v_interest, v_principal, d.payout_type, 3);

      v_balance := greatest(0, v_balance - v_principal);
      v_inserted := v_inserted + 1;
    end;
  end loop;

  update public.deals
  set next_payment_date = v_dates[1]
  where id = p_deal_id and next_payment_date is distinct from v_dates[1];

  return v_inserted;
end;
$$;

-- ----------------------------------------------------------------------------
-- fn_record_payment (spec Section 8 - the full processing pipeline in one
-- transaction). SECURITY INVOKER: every write here goes through the normal
-- RLS on payments/payment_schedule/deals/reinvestments, so a caller can only
-- ever record a payment against their own deal.
--
-- Idempotency (Section 8's last line, Section 51 rule 10) is enforced by the
-- UNIQUE(user_id, dedupe_key) constraint on payments - a repeat call with
-- the same deal/date/amount/reference raises unique_violation, which the
-- caller (manual form or import wizard) is expected to catch and treat as
-- "already recorded" rather than a hard failure.
-- ----------------------------------------------------------------------------
create or replace function public.fn_record_payment(
  p_deal_id bigint,
  p_transaction_date date,
  p_amount numeric,
  p_interest_amount numeric default null,
  p_principal_amount numeric default null,
  p_fee_amount numeric default 0,
  p_tax_amount numeric default 0,
  p_payment_reference text default null,
  p_payment_mode text default null,
  p_confirmation_method text default 'Manual',
  p_notes text default null,
  p_scheduled_payment_id bigint default null
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_deal public.deals;
  v_sched public.payment_schedule;
  v_payment_id bigint;
  v_net numeric;
  v_classification text;
  v_days_diff int;
  v_matched_total numeric;
begin
  select * into v_deal from public.deals where id = p_deal_id and user_id = v_user_id;
  if v_deal.id is null then
    raise exception 'Deal % not found or not owned by caller', p_deal_id;
  end if;

  -- Steps 1-3: identify the deal (done above) and the scheduled payment this
  -- matches - by explicit id if given, else the closest not-yet-fully-
  -- received row by date. PARTIALLY_RECEIVED is included so a second
  -- instalment against the same row is still found by this query.
  if p_scheduled_payment_id is not null then
    select * into v_sched from public.payment_schedule where id = p_scheduled_payment_id and deal_id = p_deal_id;
  else
    select * into v_sched
    from public.payment_schedule
    where deal_id = p_deal_id
      and status in ('UPCOMING', 'DUE_TODAY', 'OVERDUE', 'PARTIALLY_RECEIVED')
    order by abs(scheduled_date - p_transaction_date), scheduled_date
    limit 1;
  end if;

  v_net := p_amount - coalesce(p_fee_amount, 0) - coalesce(p_tax_amount, 0);

  insert into public.payments (
    user_id, deal_id, scheduled_payment_id, transaction_date, amount, interest_amount,
    principal_amount, fee_amount, tax_amount, net_amount, payment_reference, payment_mode,
    confirmation_method, notes
  ) values (
    v_user_id, p_deal_id, v_sched.id, p_transaction_date, p_amount, p_interest_amount,
    p_principal_amount, coalesce(p_fee_amount, 0), coalesce(p_tax_amount, 0), v_net, p_payment_reference,
    p_payment_mode, p_confirmation_method, p_notes
  )
  returning id into v_payment_id;

  -- Step 4: classify early / on-time / late against the matched schedule row.
  if v_sched.id is not null then
    v_days_diff := p_transaction_date - v_sched.scheduled_date;
    v_classification := case
      when v_days_diff < 0 then 'RECEIVED_EARLY'
      when v_days_diff = 0 then 'RECEIVED_ON_TIME'
      else 'RECEIVED_LATE'
    end;

    select coalesce(sum(amount), 0) into v_matched_total
    from public.payments
    where scheduled_payment_id = v_sched.id and not is_voided;

    -- Step 5: update the schedule row - fully resolved if everything paid
    -- against it now covers the expected total, otherwise still partial.
    update public.payment_schedule
    set status = case when v_matched_total >= coalesce(expected_total, v_matched_total)
                    then v_classification else 'PARTIALLY_RECEIVED' end,
        actual_payment_id = v_payment_id
    where id = v_sched.id;
  end if;

  -- Step 6: update the deal's last/next payment date and outstanding principal.
  update public.deals
  set last_payment_date = p_transaction_date,
      current_principal = greatest(0, current_principal - coalesce(p_principal_amount, 0)),
      next_payment_date = (
        select min(scheduled_date) from public.payment_schedule
        where deal_id = p_deal_id and status in ('UPCOMING', 'DUE_TODAY', 'OVERDUE')
      )
  where id = p_deal_id;

  -- Step 12 (reinvestment detection): logging a principal repayment as a
  -- reinvestment *candidate* is a heuristic, not a claim that it has
  -- actually been reinvested - reinvested_amount/reinvestment_date stay
  -- null until the user confirms a destination in the Reinvestments view.
  if p_principal_amount is not null and p_principal_amount > 0 then
    insert into public.reinvestments (user_id, source_payment_id, returned_amount, returned_date)
    values (v_user_id, v_payment_id, p_principal_amount, p_transaction_date);
  end if;

  -- Steps 9-11 (portfolio totals, reliability, earnings) are the
  -- v_deal_metrics / v_portfolio_summary views - always live, nothing to
  -- update. Step 13 (audit) fires automatically via the audit_payments
  -- trigger. Step 14 (notification) is left to the nightly reminder pass.
  return v_payment_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- fn_refresh_schedule_statuses (spec Section 9). Runs for every user, so it
-- must be SECURITY DEFINER; EXECUTE is revoked from regular roles so this
-- cross-user function can only be invoked by the pg_cron job in 010_cron.sql,
-- never directly by a client.
-- ----------------------------------------------------------------------------
create or replace function public.fn_refresh_schedule_statuses()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payment_schedule
  set status = 'DUE_TODAY'
  where status = 'UPCOMING' and scheduled_date = current_date;

  update public.payment_schedule
  set status = 'OVERDUE', overdue_date = coalesce(overdue_date, current_date)
  where status in ('UPCOMING', 'DUE_TODAY')
    and scheduled_date + grace_period_days < current_date;

  -- Section 9 says "unpaid after configured overdue threshold" without
  -- naming a number. This build uses grace_period_days + 30 more days
  -- before calling it MISSED outright; expose this as a per-user setting
  -- later if 30 turns out wrong for a given lender. The transition itself
  -- fires the 'Missed Payment' notification type from Section 10's list -
  -- this is the one reminder that belongs here rather than in
  -- fn_generate_reminders, since it has to happen exactly on the day the
  -- status changes, not on a fixed day-offset.
  with newly_missed as (
    update public.payment_schedule
    set status = 'MISSED'
    where status = 'OVERDUE'
      and scheduled_date + grace_period_days + 30 < current_date
    returning id, user_id, deal_id, scheduled_date, expected_total
  )
  insert into public.notifications (user_id, deal_id, schedule_id, type, title, message, priority, dedupe_key)
  select nm.user_id, nm.deal_id, nm.id, 'Missed Payment',
    format('Missed payment - %s', d.deal_name),
    format('%s expected from %s on %s has still not been confirmed and is now considered missed.',
           to_char(nm.expected_total, 'FM999,999,990.00'), d.deal_name, nm.scheduled_date),
    'Urgent',
    'Missed Payment' || '|' || nm.deal_id::text || '|' || nm.id::text || '|' || '' || '|' || current_date::text
  from newly_missed nm
  join public.deals d on d.id = nm.deal_id
  on conflict (user_id, dedupe_key) do nothing;
end;
$$;

revoke execute on function public.fn_refresh_schedule_statuses() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_reminders (spec Sections 10, 42). SECURITY DEFINER for the
-- same cross-user reason as above, same EXECUTE revocation.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_reminders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_offsets jsonb;
  v_offset int;
  v_large_threshold numeric;
  v_row record;
  v_rows int;
  v_inserted int := 0;
begin
  for v_user in select id as user_id from public.profiles loop
    select np.reminder_offset_days, np.large_payment_threshold
    into v_offsets, v_large_threshold
    from public.notification_preferences np
    where np.user_id = v_user.user_id;

    if v_offsets is null then
      v_offsets := '[-7,-3,-1,0,1,3,7,30]'::jsonb;
    end if;

    if v_large_threshold is null then
      select percentile_cont(0.9) within group (order by expected_total)
      into v_large_threshold
      from public.payment_schedule
      where user_id = v_user.user_id and expected_total > 0;
    end if;

    -- Payment due / overdue, one pass per configured offset.
    for v_offset in select jsonb_array_elements_text(v_offsets)::int loop
      for v_row in
        select ps.id as schedule_id, ps.deal_id, ps.scheduled_date, ps.expected_total, d.deal_name
        from public.payment_schedule ps
        join public.deals d on d.id = ps.deal_id
        where ps.user_id = v_user.user_id
          and ps.status in ('UPCOMING', 'DUE_TODAY', 'OVERDUE')
          and ps.scheduled_date = current_date - v_offset
      loop
        insert into public.notifications (user_id, deal_id, schedule_id, type, title, message, priority, dedupe_key)
        values (
          v_user.user_id, v_row.deal_id, v_row.schedule_id,
          case when v_offset <= 0 then 'Payment Due' else 'Payment Overdue' end,
          case when v_offset < 0 then format('Payment due in %s day(s) - %s', -v_offset, v_row.deal_name)
               when v_offset = 0 then format('Payment due today - %s', v_row.deal_name)
               else format('Payment %s day(s) overdue - %s', v_offset, v_row.deal_name) end,
          case when v_offset < 0 then
                 format('%s expected from %s on %s (in %s day(s)).',
                        to_char(v_row.expected_total, 'FM999,999,990.00'), v_row.deal_name, v_row.scheduled_date, -v_offset)
               when v_offset = 0 then
                 format('%s was expected today from %s but has not been confirmed.',
                        to_char(v_row.expected_total, 'FM999,999,990.00'), v_row.deal_name)
               else
                 format('%s from %s was expected on %s and is now %s day(s) overdue - not yet confirmed.',
                        to_char(v_row.expected_total, 'FM999,999,990.00'), v_row.deal_name, v_row.scheduled_date, v_offset)
          end,
          case when v_offset > 3 then 'High' else 'Medium' end,
          (case when v_offset <= 0 then 'Payment Due' else 'Payment Overdue' end)
            || '|' || v_row.deal_id::text || '|' || v_row.schedule_id::text || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        v_inserted := v_inserted + v_rows;
      end loop;
    end loop;

    -- Maturity reminders, same offsets applied to maturity_date.
    for v_offset in select jsonb_array_elements_text(v_offsets)::int loop
      for v_row in
        select d.id as deal_id, d.deal_name, d.maturity_date
        from public.deals d
        where d.user_id = v_user.user_id and d.status = 'ACTIVE' and d.maturity_date = current_date - v_offset
      loop
        insert into public.notifications (user_id, deal_id, type, title, message, priority, dedupe_key)
        values (
          v_user.user_id, v_row.deal_id,
          case when v_offset = 0 then 'Maturity Today' else 'Maturity Approaching' end,
          case when v_offset = 0 then format('Matures today - %s', v_row.deal_name)
               else format('Maturity in %s day(s) - %s', -v_offset, v_row.deal_name) end,
          format('%s matures on %s.', v_row.deal_name, v_row.maturity_date),
          'Medium',
          (case when v_offset = 0 then 'Maturity Today' else 'Maturity Approaching' end)
            || '|' || v_row.deal_id::text || '|' || '' || '|' || '' || '|' || current_date::text
        )
        on conflict (user_id, dedupe_key) do nothing;
        get diagnostics v_rows = row_count;
        v_inserted := v_inserted + v_rows;
      end loop;
    end loop;

    -- Large expected payments in the next 30 days.
    for v_row in
      select ps.id as schedule_id, ps.deal_id, ps.scheduled_date, ps.expected_total, d.deal_name
      from public.payment_schedule ps
      join public.deals d on d.id = ps.deal_id
      where ps.user_id = v_user.user_id
        and ps.status in ('UPCOMING', 'DUE_TODAY')
        and ps.scheduled_date between current_date and current_date + 30
        and v_large_threshold is not null and ps.expected_total >= v_large_threshold
    loop
      insert into public.notifications (user_id, deal_id, schedule_id, type, title, message, priority, dedupe_key)
      values (
        v_user.user_id, v_row.deal_id, v_row.schedule_id, 'Large Payment Expected',
        format('Large payment expected - %s', v_row.deal_name),
        format('%s expected from %s on %s.',
               to_char(v_row.expected_total, 'FM999,999,990.00'), v_row.deal_name, v_row.scheduled_date),
        'High',
        'Large Payment Expected' || '|' || v_row.deal_id::text || '|' || v_row.schedule_id::text || '|' || '' || '|' || current_date::text
      )
      on conflict (user_id, dedupe_key) do nothing;
      get diagnostics v_rows = row_count;
      v_inserted := v_inserted + v_rows;
    end loop;

    -- Reinvestment opportunities: principal returned in the last 14 days,
    -- not yet marked reinvested.
    for v_row in
      select p.deal_id, d.deal_name, r.returned_amount, r.returned_date
      from public.reinvestments r
      join public.payments p on p.id = r.source_payment_id
      join public.deals d on d.id = p.deal_id
      where r.user_id = v_user.user_id and r.reinvested_amount is null and r.returned_date >= current_date - 14
    loop
      insert into public.notifications (user_id, deal_id, type, title, message, priority, dedupe_key)
      values (
        v_user.user_id, v_row.deal_id, 'Reinvestment Opportunity',
        format('Reinvestment opportunity - %s', v_row.deal_name),
        format('%s returned from %s on %s has not been marked as reinvested yet.',
               to_char(v_row.returned_amount, 'FM999,999,990.00'), v_row.deal_name, v_row.returned_date),
        'Low',
        'Reinvestment Opportunity' || '|' || v_row.deal_id::text || '|' || '' || '|' || '' || '|' || current_date::text
      )
      on conflict (user_id, dedupe_key) do nothing;
      get diagnostics v_rows = row_count;
      v_inserted := v_inserted + v_rows;
    end loop;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_reminders() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- fn_generate_ai_insights (spec Section 37). Deterministic: every insight is
-- a template filled from a real aggregate query, with the record ids behind
-- the number saved in supporting_record_ids - not a live LLM call (there is
-- no server here to hold a model API key). This directly satisfies the
-- spec's own constraint ("AI must not invent financial figures; every
-- insight should be traceable to underlying records") rather than
-- approximating it.
-- ----------------------------------------------------------------------------
create or replace function public.fn_generate_ai_insights()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_this_month numeric;
  v_last_month numeric;
  v_pct_change numeric;
  v_total_principal numeric;
  v_maturing_90 numeric;
  v_platform record;
  v_overdue_count int;
  v_overdue_amount numeric;
  v_inserted int := 0;
  v_rows int;
begin
  for v_user in select id as user_id from public.profiles loop

    select coalesce(sum(amount), 0) into v_this_month
    from public.payments
    where user_id = v_user.user_id and not is_voided
      and date_trunc('month', transaction_date) = date_trunc('month', current_date);

    select coalesce(sum(amount), 0) into v_last_month
    from public.payments
    where user_id = v_user.user_id and not is_voided
      and date_trunc('month', transaction_date) = date_trunc('month', current_date - interval '1 month');

    if v_last_month > 0 then
      v_pct_change := round((v_this_month - v_last_month) / v_last_month * 100, 1);
      insert into public.ai_insights (user_id, category, insight_text, supporting_record_ids)
      select v_user.user_id, 'Income Trend',
        format('Income received this month (%s) is %s%% %s than last month (%s).',
               to_char(v_this_month, 'FM999,999,990.00'), abs(v_pct_change),
               case when v_pct_change >= 0 then 'higher' else 'lower' end,
               to_char(v_last_month, 'FM999,999,990.00')),
        coalesce(jsonb_agg(id), '[]'::jsonb)
      from public.payments
      where user_id = v_user.user_id and not is_voided
        and date_trunc('month', transaction_date) in (date_trunc('month', current_date), date_trunc('month', current_date - interval '1 month'));
      get diagnostics v_rows = row_count; v_inserted := v_inserted + v_rows;
    end if;

    select coalesce(sum(current_principal), 0) into v_total_principal
    from public.deals where user_id = v_user.user_id and status = 'ACTIVE';

    select coalesce(sum(current_principal), 0) into v_maturing_90
    from public.deals
    where user_id = v_user.user_id and status = 'ACTIVE'
      and maturity_date is not null and maturity_date between current_date and current_date + 90;

    if v_total_principal > 0 and v_maturing_90 > 0 then
      insert into public.ai_insights (user_id, category, insight_text, supporting_record_ids)
      select v_user.user_id, 'Maturity Concentration',
        format('%s%% of active principal (%s of %s) matures within 90 days.',
               round(v_maturing_90 / v_total_principal * 100, 1),
               to_char(v_maturing_90, 'FM999,999,990.00'), to_char(v_total_principal, 'FM999,999,990.00')),
        coalesce(jsonb_agg(id), '[]'::jsonb)
      from public.deals
      where user_id = v_user.user_id and status = 'ACTIVE'
        and maturity_date is not null and maturity_date between current_date and current_date + 90;
      get diagnostics v_rows = row_count; v_inserted := v_inserted + v_rows;
    end if;

    for v_platform in
      select d.platform_id, p.name as platform_name, sum(d.invested_amount) as invested,
             jsonb_agg(d.id) as deal_ids
      from public.deals d
      join public.platforms p on p.id = d.platform_id
      where d.user_id = v_user.user_id and d.status = 'ACTIVE'
      group by d.platform_id, p.name
    loop
      if v_total_principal > 0 and (v_platform.invested / v_total_principal) > 0.4 then
        insert into public.ai_insights (user_id, category, insight_text, supporting_record_ids)
        values (
          v_user.user_id, 'Platform Concentration',
          format('%s represents %s%% of active invested capital (%s) - concentration risk.',
                 v_platform.platform_name, round(v_platform.invested / v_total_principal * 100, 1),
                 to_char(v_platform.invested, 'FM999,999,990.00')),
          v_platform.deal_ids
        );
        v_inserted := v_inserted + 1;
      end if;
    end loop;

    select count(*), coalesce(sum(expected_total), 0) into v_overdue_count, v_overdue_amount
    from public.payment_schedule where user_id = v_user.user_id and status = 'OVERDUE';

    if v_overdue_count > 0 then
      insert into public.ai_insights (user_id, category, insight_text, supporting_record_ids)
      select v_user.user_id, 'Overdue Payments',
        format('%s payment(s) totalling %s are currently overdue.', v_overdue_count, to_char(v_overdue_amount, 'FM999,999,990.00')),
        coalesce(jsonb_agg(id), '[]'::jsonb)
      from public.payment_schedule where user_id = v_user.user_id and status = 'OVERDUE';
      get diagnostics v_rows = row_count; v_inserted := v_inserted + v_rows;
    end if;

  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_generate_ai_insights() from public, anon, authenticated;
