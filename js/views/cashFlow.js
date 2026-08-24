/* Cash Flow - a view over existing Payments/Expense/Recurring data plus
   Accounts, mostly aggregation, not new data entry (per the user's own
   wishlist description). Pure client-side aggregation over four already-
   fetched sources, no new SQL view - the exact same precedent Net Worth
   established (see netWorth.js's own header comment). Reuses
   App.utils.sumWhere/fyBounds, originally dashboard.js's own local Cash
   Flow panel helpers, now shared so this page and that panel never drift
   into two slightly different answers for "this month received".

   computeCashFlow() is extracted into its own callable function (mirroring
   netWorth.js's own computeNetWorth() shape) so the AI Portfolio Copilot can
   reuse the exact same numbers this page shows, rather than a second,
   possibly-drifting implementation inside the Copilot's own Edge Function -
   see aiCopilot.js. */
window.App = window.App || {};

(function () {
  const RECURRING_PENDING = ['UPCOMING', 'DUE', 'OVERDUE'];
  const RECURRING_CONFIRMED = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];
  const SCHEDULE_PENDING = ['UPCOMING', 'DUE_TODAY', 'OVERDUE'];

  async function computeCashFlow() {
    const [schedule, payments, expenseTxns, recurringOcc, accounts] = await Promise.all([
      App.api.listSchedule(), App.api.listPayments(), App.api.listExpenseTransactions(),
      App.api.listRecurringOccurrences(), App.api.listAccounts(),
    ]);

    const validPayments = payments.filter((p) => !p.is_voided);
    const todayISO = App.utils.todayISO();
    const in7 = App.utils.toISO(new Date(Date.now() + 7 * 86400000));
    const in30 = App.utils.toISO(new Date(Date.now() + 30 * 86400000));
    const in90 = App.utils.toISO(new Date(Date.now() + 90 * 86400000));
    const monthStart = App.utils.toISO(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const monthEnd = App.utils.toISO(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0));

    const thisMonthReceived = App.utils.sumWhere(validPayments, 'transaction_date', 'amount', monthStart, todayISO);
    const thisMonthExpected = App.utils.sumWhere(schedule, 'scheduled_date', 'expected_total', monthStart, monthEnd);
    const thisMonthRecurringConfirmed = recurringOcc.filter((o) => RECURRING_CONFIRMED.includes(o.status) && o.due_date >= monthStart && o.due_date <= monthEnd).reduce((a, o) => a + (o.actual_amount || 0), 0);
    const thisMonthRecurringPending = recurringOcc.filter((o) => RECURRING_PENDING.includes(o.status) && o.due_date >= monthStart && o.due_date <= monthEnd).reduce((a, o) => a + (o.expected_amount || 0), 0);
    const thisMonthExpenseDebit = expenseTxns.filter((t) => t.transaction_type === 'Debit' && t.transaction_date >= monthStart && t.transaction_date <= monthEnd).reduce((a, t) => a + (t.amount || 0), 0);
    const thisMonthExpenseCredit = expenseTxns.filter((t) => t.transaction_type === 'Credit' && t.transaction_date >= monthStart && t.transaction_date <= monthEnd).reduce((a, t) => a + (t.amount || 0), 0);
    const netCashMovement = thisMonthReceived - thisMonthRecurringConfirmed - (thisMonthExpenseDebit - thisMonthExpenseCredit);

    // 6-month trend: Inflow (Payments received) vs Outflow (Recurring
    // confirmed + Expense net debit), same month-bucket-loop/filter/reduce
    // pattern expenses.js's own project dashboard already uses.
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    const monthLabels = months.map((m) => m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
    const inMonth = (dateStr, m) => { const d = new Date(dateStr); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); };
    const inflowByMonth = months.map((m) => validPayments.filter((p) => inMonth(p.transaction_date, m)).reduce((a, p) => a + (p.amount || 0), 0));
    const recurringOutflowByMonth = months.map((m) => recurringOcc.filter((o) => RECURRING_CONFIRMED.includes(o.status) && o.due_date && inMonth(o.due_date, m)).reduce((a, o) => a + (o.actual_amount || 0), 0));
    const expenseOutflowByMonth = months.map((m) => expenseTxns.filter((t) => inMonth(t.transaction_date, m)).reduce((a, t) => a + (t.transaction_type === 'Debit' ? (t.amount || 0) : -(t.amount || 0)), 0));
    const outflowByMonth = recurringOutflowByMonth.map((v, i) => v + expenseOutflowByMonth[i]);

    // Upcoming: Deal schedule + Recurring occurrences, pending only,
    // combined into one Next 7/30/90 Days picture.
    const upcomingSchedule = schedule.filter((s) => SCHEDULE_PENDING.includes(s.status));
    const upcomingRecurring = recurringOcc.filter((o) => RECURRING_PENDING.includes(o.status));
    const upcomingSum = (from, to) =>
      App.utils.sumWhere(upcomingSchedule, 'scheduled_date', 'expected_total', from, to)
      + App.utils.sumWhere(upcomingRecurring, 'due_date', 'expected_amount', from, to);

    // Financial Year strip (existing dashboard precedent, widened to
    // include Recurring/Expense outflow alongside Deal inflow).
    const fyCur = App.utils.fyBounds(App.state.profile, 'current');
    const fyPrev = App.utils.fyBounds(App.state.profile, 'previous');
    const fyReceived = (b) => App.utils.sumWhere(validPayments, 'transaction_date', 'amount', b.start, b.end);
    const fyOutflow = (b) =>
      recurringOcc.filter((o) => RECURRING_CONFIRMED.includes(o.status) && o.due_date >= b.start && o.due_date <= b.end).reduce((a, o) => a + (o.actual_amount || 0), 0)
      + expenseTxns.filter((t) => t.transaction_date >= b.start && t.transaction_date <= b.end).reduce((a, t) => a + (t.transaction_type === 'Debit' ? (t.amount || 0) : -(t.amount || 0)), 0);

    // Available Cash - ties this to the Accounts data without recomputing
    // anything Net Worth doesn't already expose.
    const availableCash = accounts.filter((a) => a.is_active).reduce((a, r) => a + (r.current_balance || 0), 0);

    return {
      thisMonthReceived, thisMonthExpected, thisMonthRecurringConfirmed, thisMonthRecurringPending,
      thisMonthExpenseDebit, thisMonthExpenseCredit, netCashMovement,
      monthLabels, inflowByMonth, outflowByMonth,
      next7Days: upcomingSum(todayISO, in7), next30Days: upcomingSum(todayISO, in30), next90Days: upcomingSum(todayISO, in90),
      fyCurrentLabel: fyCur.start.slice(0, 4), fyCurrentReceived: fyReceived(fyCur), fyCurrentOutflow: fyOutflow(fyCur),
      fyPreviousReceived: fyReceived(fyPrev), fyPreviousOutflow: fyOutflow(fyPrev),
      availableCash,
    };
  }

  async function renderCashFlowView() {
    const pane = App.utils.qs('#pane-cashflow');
    pane.innerHTML = `
      <div class="section-title">Cash Flow <div class="line"></div><small>received, expected, and spent - across Deals, Recurring, and Expenses</small></div>
      <div class="kpi-grid" id="cfKpis"></div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">6-Month Trend</div>
        <div style="height:280px"><canvas id="cfTrendChart"></canvas></div>
      </div>
      <div class="grid-2" style="margin-bottom:16px">
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">Upcoming (Deals + Recurring, Pending)</div><div id="cfUpcoming"></div></div>
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">Financial Year</div><div id="cfFy"></div></div>
      </div>
      <div class="hint" id="cfAvailableCash" style="margin-top:8px"></div>`;

    const cf = await computeCashFlow();

    const cards = [
      { cls: 'c-teal', label: 'This Month Received', value: App.utils.fmtMoney(cf.thisMonthReceived), desc: 'From Deal payments' },
      { cls: 'c-blue', label: 'This Month Expected', value: App.utils.fmtMoney(cf.thisMonthExpected), desc: 'Deal schedule, this month' },
      { cls: 'c-purple', label: 'Recurring Confirmed', value: App.utils.fmtMoney(cf.thisMonthRecurringConfirmed), desc: `${App.utils.fmtMoney(cf.thisMonthRecurringPending)} yet to confirm` },
      { cls: 'c-red', label: 'Expenses (Net)', value: App.utils.fmtMoney(cf.thisMonthExpenseDebit - cf.thisMonthExpenseCredit), desc: `${App.utils.fmtMoney(cf.thisMonthExpenseDebit)} spent, ${App.utils.fmtMoney(cf.thisMonthExpenseCredit)} refunded` },
      { cls: cf.netCashMovement >= 0 ? 'c-teal' : 'c-red', label: 'Net Cash Movement', value: App.utils.fmtMoney(cf.netCashMovement), desc: 'Received − Recurring outflow − Expenses' },
    ];
    App.utils.qs('#cfKpis', pane).innerHTML = cards.map((c) => `
      <div class="kpi ${c.cls} fade-up">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}</div>
        <div class="kpi-desc">${c.desc}</div>
      </div>`).join('');

    App.charts.bar('cfTrendChart', cf.monthLabels, [
      { label: 'Inflow (Payments)', data: cf.inflowByMonth },
      { label: 'Outflow (Recurring + Expenses)', data: cf.outflowByMonth },
    ]);

    App.utils.qs('#cfUpcoming', pane).innerHTML = `
      <div class="stat-line"><span>Next 7 Days</span><span class="v">${App.utils.fmtMoney(cf.next7Days)}</span></div>
      <div class="stat-line"><span>Next 30 Days</span><span class="v">${App.utils.fmtMoney(cf.next30Days)}</span></div>
      <div class="stat-line"><span>Next 90 Days</span><span class="v">${App.utils.fmtMoney(cf.next90Days)}</span></div>
      <div class="hint" style="margin-top:8px">Deal Payment Schedule + Recurring Investments, combined - Deal amounts are expected inflows, Recurring amounts are expected outflows.</div>`;

    App.utils.qs('#cfFy', pane).innerHTML = `
      <div class="stat-line"><span>Current FY (${cf.fyCurrentLabel}) Received</span><span class="v">${App.utils.fmtMoney(cf.fyCurrentReceived)}</span></div>
      <div class="stat-line"><span>Current FY Outflow</span><span class="v">${App.utils.fmtMoney(cf.fyCurrentOutflow)}</span></div>
      <div class="stat-line"><span>Previous FY Received</span><span class="v">${App.utils.fmtMoney(cf.fyPreviousReceived)}</span></div>
      <div class="stat-line"><span>Previous FY Outflow</span><span class="v">${App.utils.fmtMoney(cf.fyPreviousOutflow)}</span></div>`;

    App.utils.qs('#cfAvailableCash', pane).innerHTML = `Available Cash across active accounts: <b>${App.utils.fmtMoney(cf.availableCash)}</b> — <a href="#networth" id="cfOpenNetWorth" style="color:var(--gold)">manage Accounts &rarr;</a>`;
    const nwLink = App.utils.qs('#cfOpenNetWorth', pane);
    if (nwLink) nwLink.addEventListener('click', (e) => { e.preventDefault(); App.router.navigate('networth'); });
  }

  App.cashFlowCalc = { computeCashFlow };
  App.router.register('cashflow', renderCashFlowView);
})();
