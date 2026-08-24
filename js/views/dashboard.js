/* Portfolio Dashboard (spec Section 12). KPIs from v_portfolio_summary
   (server-computed, authoritative); cash-flow buckets and "needs attention"
   lists are date-range slices of already-fetched schedule/payment rows -
   presentation slicing, not new financial calculations, so doing it in the
   client here doesn't conflict with spec Section 53. */
window.App = window.App || {};

(function () {
  // fyBounds/sumWhere now live in App.utils (shared with cashFlow.js) -
  // this file keeps local aliases so the rest of this function's body
  // doesn't need touching.
  const fyBounds = App.utils.fyBounds;

  async function renderDashboardView() {
    const pane = App.utils.qs('#pane-dashboard');
    pane.innerHTML = `
      <div class="section-title">Portfolio Dashboard <div class="line"></div><small>money, then attention, then performance</small></div>
      <div id="dashFilterBar"></div>
      <div class="kpi-grid" id="dashKpis"></div>
      <div class="grid-2">
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">Portfolio Detail</div><div id="dashStatLines"></div></div>
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">Cash Flow</div><div id="dashCashFlow"></div></div>
      </div>
      <!-- Recurring Investments & Commitments (spec Section 74) - a separate
           panel, never merged into the Deals numbers above (Section 89). -->
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Recurring Investments &amp; Commitments</div>
        <div id="dashRecurring"></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Gold</div>
        <div id="dashGold"></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Net Worth</div>
        <div id="dashNetWorth"></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Needs Your Attention</div>
        <div id="dashAttention"></div>
      </div>`;

    App.filters.renderBar(App.utils.qs('#dashFilterBar'), draw);

    async function draw() {
      const [summary, deals, metrics, schedule, payments, recurringSummary, recurringOccAll, recurringItemsAll,
        gold22kHistory, goldHoldings, goldPurchases, accounts, liabilities] = await Promise.all([
        App.api.getPortfolioSummary(), App.api.listDeals(), App.api.listDealMetrics(),
        App.api.listSchedule(), App.api.listPayments(),
        App.api.getRecurringSummary(), App.api.listRecurringOccurrences(), App.api.listRecurringItems(),
        App.api.listGoldPriceObservations({ eq: { purity: '22K' }, order: { column: 'observed_at', ascending: true } }),
        App.api.listGoldSchemeHoldings(), App.api.listGoldPurchases(),
        App.api.listAccounts(), App.api.listLiabilities(),
      ]);
      const recurringItemsById = {}; recurringItemsAll.forEach((i) => { recurringItemsById[i.id] = i; });
      const filteredDeals = App.filters.apply(deals);
      const filteredIds = new Set(filteredDeals.map((d) => d.id));
      const metricsById = {}; metrics.forEach((m) => { metricsById[m.deal_id] = m; });

      const s = summary || {};
      const cards = [
        { cls: 'c-gold', icon: '&#128176;', label: 'Total Invested', value: App.utils.fmtMoney(s.total_invested), desc: `${filteredDeals.length} deal(s) in view` },
        { cls: 'c-blue', icon: '&#128188;', label: 'Outstanding Principal', value: App.utils.fmtMoney(s.current_outstanding_principal), desc: 'Capital still deployed' },
        { cls: 'c-teal', icon: '&#128200;', label: 'Interest Earned', value: App.utils.fmtMoney(s.interest_earned), desc: `${App.utils.fmtMoney(s.interest_pending)} pending` },
        { cls: 'c-purple', icon: '&#128181;', label: 'Total Portfolio Value', value: App.utils.fmtMoney(s.total_portfolio_value), desc: 'Deployed + pending interest' },
        { cls: 'c-gold', icon: '&#11088;', label: 'Net Profit', value: App.utils.fmtMoney(s.net_profit), desc: 'Interest minus fees &amp; tax' },
      ];
      App.utils.qs('#dashKpis', pane).innerHTML = cards.map((c) => `
        <div class="kpi ${c.cls} fade-up">
          <div class="kpi-icon">${c.icon}</div>
          <div class="kpi-label">${c.label}</div>
          <div class="kpi-value">${c.value}</div>
          <div class="kpi-desc">${c.desc}</div>
        </div>`).join('');

      const activeDeals = filteredDeals.filter((d) => d.status === 'ACTIVE');
      const closedDeals = filteredDeals.filter((d) => d.status !== 'ACTIVE');
      const activeAmount = activeDeals.reduce((a, d) => a + (d.invested_amount || 0), 0);
      const closedAmount = closedDeals.reduce((a, d) => a + (d.invested_amount || 0), 0);

      App.utils.qs('#dashStatLines', pane).innerHTML = `
        <div class="stat-line"><span>Principal Returned</span><span class="v">${App.utils.fmtMoney(s.principal_returned)}</span></div>
        <div class="stat-line"><span>Expected Future Interest</span><span class="v">${App.utils.fmtMoney(s.expected_future_interest)}</span></div>
        <div class="stat-line"><span>Realized ROI</span><span class="v">${App.utils.fmtPct(s.realized_roi)}</span></div>
        <div class="stat-line"><span>Annualized ROI</span><span class="v">${App.utils.fmtPct(s.annualized_roi)}</span></div>
        <div class="stat-line"><span>Weighted Avg ROI (active)</span><span class="v">${App.utils.fmtPct(s.weighted_average_roi)}</span></div>
        <div class="stat-line"><span>Active Deals</span><span class="v">${activeDeals.length} &middot; ${App.utils.fmtMoney(activeAmount)}</span></div>
        <div class="stat-line"><span>Closed Deals</span><span class="v">${closedDeals.length} &middot; ${App.utils.fmtMoney(closedAmount)}</span></div>
      `;

      const todayISO = App.utils.todayISO();
      const in7 = App.utils.toISO(new Date(Date.now() + 7 * 86400000));
      const in30 = App.utils.toISO(new Date(Date.now() + 30 * 86400000));
      const in90 = App.utils.toISO(new Date(Date.now() + 90 * 86400000));
      const monthStart = App.utils.toISO(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
      const relevantSchedule = schedule.filter((sc) => filteredIds.has(sc.deal_id));
      const relevantPayments = payments.filter((p) => filteredIds.has(p.deal_id) && !p.is_voided);
      const sumWhere = App.utils.sumWhere;
      const pendingStatuses = ['UPCOMING', 'DUE_TODAY', 'OVERDUE'];
      const thisMonthReceived = sumWhere(relevantPayments, 'transaction_date', 'amount', monthStart, todayISO);
      const thisMonthExpected = sumWhere(relevantSchedule, 'scheduled_date', 'expected_total', monthStart, App.utils.toISO(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0)));
      const thisMonthPending = relevantSchedule.filter((sc) => pendingStatuses.includes(sc.status) && sc.scheduled_date >= monthStart).reduce((a, r) => a + (r.expected_total || 0), 0);
      const fyCur = fyBounds(App.state.profile, 'current');
      const fyPrev = fyBounds(App.state.profile, 'previous');

      App.utils.qs('#dashCashFlow', pane).innerHTML = `
        <div class="stat-line"><span>This Month Received</span><span class="v">${App.utils.fmtMoney(thisMonthReceived)}</span></div>
        <div class="stat-line"><span>This Month Expected</span><span class="v">${App.utils.fmtMoney(thisMonthExpected)}</span></div>
        <div class="stat-line"><span>This Month Pending</span><span class="v">${App.utils.fmtMoney(thisMonthPending)}</span></div>
        <div class="stat-line"><span>Next 7 Days</span><span class="v">${App.utils.fmtMoney(sumWhere(relevantSchedule.filter((r) => pendingStatuses.includes(r.status)), 'scheduled_date', 'expected_total', todayISO, in7))}</span></div>
        <div class="stat-line"><span>Next 30 Days</span><span class="v">${App.utils.fmtMoney(sumWhere(relevantSchedule.filter((r) => pendingStatuses.includes(r.status)), 'scheduled_date', 'expected_total', todayISO, in30))}</span></div>
        <div class="stat-line"><span>Next 90 Days</span><span class="v">${App.utils.fmtMoney(sumWhere(relevantSchedule.filter((r) => pendingStatuses.includes(r.status)), 'scheduled_date', 'expected_total', todayISO, in90))}</span></div>
        <div class="stat-line"><span>Current FY (${fyCur.start.slice(0, 4)})</span><span class="v">${App.utils.fmtMoney(sumWhere(relevantPayments, 'transaction_date', 'amount', fyCur.start, fyCur.end))}</span></div>
        <div class="stat-line"><span>Previous FY</span><span class="v">${App.utils.fmtMoney(sumWhere(relevantPayments, 'transaction_date', 'amount', fyPrev.start, fyPrev.end))}</span></div>
      `;

      const dueToday = relevantSchedule.filter((sc) => sc.scheduled_date === todayISO && pendingStatuses.includes(sc.status));
      const overdue = relevantSchedule.filter((sc) => sc.status === 'OVERDUE');
      const maturing30 = filteredDeals.filter((d) => d.maturity_date && d.maturity_date >= todayISO && d.maturity_date <= in30 && d.status === 'ACTIVE');
      const largeThreshold = relevantSchedule.length ? [...relevantSchedule].map((r) => r.expected_total || 0).sort((a, b) => a - b)[Math.floor(relevantSchedule.length * 0.9)] : 0;
      const largeUpcoming = relevantSchedule.filter((sc) => pendingStatuses.includes(sc.status) && (sc.expected_total || 0) >= largeThreshold && largeThreshold > 0);
      const poorReliability = filteredDeals.filter((d) => { const m = metricsById[d.id]; return m && m.payout_reliability !== null && m.payout_reliability < 70; });

      // ---- Recurring Investments & Commitments panel (Section 74) ----
      const rs = recurringSummary || {};
      App.utils.qs('#dashRecurring', pane).innerHTML = `
        <div class="grid-2">
          <div>
            <div class="stat-line"><span>This Month Expected</span><span class="v">${App.utils.fmtMoney(rs.month_expected)}</span></div>
            <div class="stat-line"><span>This Month Confirmed</span><span class="v">${App.utils.fmtMoney(rs.month_confirmed)}</span></div>
            <div class="stat-line"><span>Yet to Confirm</span><span class="v">${rs.month_yet_to_confirm_count || 0}</span></div>
            <div class="stat-line"><span>In Progress</span><span class="v">${rs.month_in_progress_count || 0}</span></div>
            <div class="stat-line"><span>Overdue</span><span class="v">${rs.month_overdue_count || 0} &middot; ${App.utils.fmtMoney(rs.month_overdue_amount)}</span></div>
          </div>
          <div>
            <div class="stat-line"><span>Active Recurring Items</span><span class="v">${rs.active_items_count || 0}</span></div>
            <div class="stat-line"><span>Next 7 Days</span><span class="v">${App.utils.fmtMoney(rs.next_7_days_amount)}</span></div>
            <div class="stat-line"><span>Next 30 Days</span><span class="v">${App.utils.fmtMoney(rs.next_30_days_amount)}</span></div>
            <div class="stat-line"><span>This Year Expected</span><span class="v">${App.utils.fmtMoney(rs.year_expected)}</span></div>
            <div class="stat-line"><span>This Year Confirmed</span><span class="v">${App.utils.fmtMoney(rs.year_confirmed)}</span></div>
          </div>
        </div>
        <div class="hint" style="margin-top:8px"><a href="#recurring" style="color:var(--gold)">Open Recurring Investments &rarr;</a></div>`;

      // ---- Gold (Gold Intelligence addendum) - international spot
      // converted to INR, never mixed into the Deals numbers above. ----
      const latest22k = gold22kHistory.length ? gold22kHistory[gold22kHistory.length - 1] : null;
      const changeSince = (days) => {
        if (!latest22k) return null;
        const cutoff = App.utils.toISO(new Date(Date.now() - days * 86400000));
        let prev = gold22kHistory[0];
        for (const o of gold22kHistory) { if (o.observed_at <= cutoff) prev = o; else break; }
        return prev && prev.price ? ((latest22k.price - prev.price) / prev.price) * 100 : null;
      };
      const goldGrams = goldHoldings.reduce((a, h) => a + h.total_grams, 0) + goldPurchases.reduce((a, p) => a + (p.net_grams || p.grams || 0), 0);
      const goldValue = latest22k ? goldGrams * latest22k.price : 0;
      const pctHtml = (v) => v == null ? '—' : `<span style="color:${v >= 0 ? 'var(--teal)' : 'var(--red)'}">${v >= 0 ? '+' : ''}${App.utils.fmtPct(v)}</span>`;
      App.utils.qs('#dashGold', pane).innerHTML = `
        <div class="grid-4">
          <div class="kpi c-gold"><div class="kpi-label">22K Gold</div><div class="kpi-value">${latest22k ? '₹' + App.utils.fmtNum(latest22k.price, 0) + '/g' : '—'}</div><div class="kpi-desc">International Spot (in INR)</div></div>
          <div class="kpi c-blue"><div class="kpi-label">7D Change</div><div class="kpi-value">${pctHtml(changeSince(7))}</div></div>
          <div class="kpi c-teal"><div class="kpi-label">30D Change</div><div class="kpi-value">${pctHtml(changeSince(30))}</div></div>
          <div class="kpi c-purple"><div class="kpi-label">My Gold</div><div class="kpi-value">${App.utils.fmtNum(goldGrams, 2)} g</div><div class="kpi-desc">${App.utils.fmtMoney(goldValue)}</div></div>
        </div>
        <div class="hint" style="margin-top:8px"><a href="#gold" id="dashOpenGold" style="color:var(--gold)">View Gold Intelligence &rarr;</a></div>`;
      const goldLink = App.utils.qs('#dashOpenGold', pane);
      if (goldLink) goldLink.addEventListener('click', (e) => { e.preventDefault(); App.router.navigate('gold'); });

      // ---- Net Worth (Accounts & Liabilities addendum) - reuses the exact
      // same deal/gold numbers already computed above, plus Accounts/
      // Liabilities, combined client-side - see netWorth.js's own header
      // comment for why this is never a server-side view. ----
      const accountsTotal = accounts.filter((a) => a.is_active).reduce((a, r) => a + (r.current_balance || 0), 0);
      const dealsOutstandingTotal = metrics.reduce((a, m) => a + (m.total_outstanding || 0), 0);
      const liabilitiesTotal = liabilities.filter((l) => l.is_active).reduce((a, r) => a + (r.outstanding_amount || 0), 0);
      const netWorthTotal = accountsTotal + dealsOutstandingTotal + goldValue - liabilitiesTotal;
      App.utils.qs('#dashNetWorth', pane).innerHTML = `
        <div class="grid-3">
          <div class="kpi c-teal"><div class="kpi-label">Net Worth</div><div class="kpi-value">${App.utils.fmtMoney(netWorthTotal)}</div></div>
          <div class="kpi c-gold"><div class="kpi-label">Total Assets</div><div class="kpi-value">${App.utils.fmtMoney(accountsTotal + dealsOutstandingTotal + goldValue)}</div></div>
          <div class="kpi c-red"><div class="kpi-label">Total Liabilities</div><div class="kpi-value">${App.utils.fmtMoney(liabilitiesTotal)}</div></div>
        </div>
        <div class="hint" style="margin-top:8px"><a href="#networth" id="dashOpenNetWorth" style="color:var(--gold)">View Net Worth &rarr;</a></div>`;
      const netWorthLink = App.utils.qs('#dashOpenNetWorth', pane);
      if (netWorthLink) netWorthLink.addEventListener('click', (e) => { e.preventDefault(); App.router.navigate('networth'); });

      // ---- Master Attention Center (Section 90) - Deals and Recurring rows
      // combined in the same "Due Today"/"Overdue" lists, each labeled with
      // its source so it's never ambiguous which module a row belongs to. ----
      const recurringDueToday = recurringOccAll.filter((o) => o.due_date === todayISO && pendingStatuses.includes(o.status));
      const recurringOverdue = recurringOccAll.filter((o) => o.status === 'OVERDUE');
      const recurringYetToConfirm = recurringOccAll.filter((o) => ['UPCOMING', 'DUE'].includes(o.status) && o.due_date >= todayISO && o.due_date <= in7);
      const recurringInProgress = recurringOccAll.filter((o) => o.status === 'IN_PROGRESS');
      const confirmedStatuses = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];
      const recurringRecentlyConfirmed = recurringOccAll.filter((o) => confirmedStatuses.includes(o.status) && o.paid_date && o.paid_date >= App.utils.toISO(new Date(Date.now() - 7 * 86400000)));

      function sourceLabel(itemId) {
        const item = recurringItemsById[itemId] || {};
        return item.item_type === 'Custom' ? (item.custom_type_label || 'Custom') : (item.item_type || 'Recurring');
      }

      const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
      function listBlock(title, rows, render) {
        return `<div style="margin-bottom:14px"><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">${title} (${rows.length})</div>
          ${rows.length ? rows.slice(0, 6).map(render).join('') : '<div class="empty-note" style="padding:8px 0">None</div>'}</div>`;
      }
      const dealRow = (color, dealId, desc) => `<div class="risk-item" data-open-deal="${dealId}" style="cursor:pointer"><div class="risk-dot" style="background:${color}"></div><div><div class="risk-name">Investment Deal &mdash; ${App.utils.escapeHtml((dealsById[dealId] || {}).deal_name)}</div><div class="risk-desc">${desc}</div></div></div>`;
      const recurringRow = (color, o, desc) => `<div class="risk-item" data-open-recurring="${o.recurring_item_id}" style="cursor:pointer"><div class="risk-dot" style="background:${color}"></div><div><div class="risk-name">${App.utils.escapeHtml(sourceLabel(o.recurring_item_id))} &mdash; ${App.utils.escapeHtml((recurringItemsById[o.recurring_item_id] || {}).item_name)}</div><div class="risk-desc">${desc}</div></div></div>`;

      const dueTodayHtml = [
        ...dueToday.map((r) => dealRow('var(--gold)', r.deal_id, App.utils.fmtMoney(r.expected_total))),
        ...recurringDueToday.map((o) => recurringRow('var(--purple)', o, App.utils.fmtMoney(o.expected_amount))),
      ];
      const overdueHtml = [
        ...overdue.map((r) => dealRow('var(--red)', r.deal_id, `${App.utils.fmtMoney(r.expected_total)} since ${App.utils.fmtDate(r.scheduled_date)}`)),
        ...recurringOverdue.map((o) => recurringRow('var(--red)', o, `${App.utils.fmtMoney(o.expected_amount)} since ${App.utils.fmtDate(o.due_date)}`)),
      ];

      App.utils.qs('#dashAttention', pane).innerHTML = `
        <div class="grid-4">
          <div><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Due Today (${dueTodayHtml.length})</div>${dueTodayHtml.length ? dueTodayHtml.slice(0, 6).join('') : '<div class="empty-note" style="padding:8px 0">None</div>'}</div>
          <div><div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Overdue (${overdueHtml.length})</div>${overdueHtml.length ? overdueHtml.slice(0, 6).join('') : '<div class="empty-note" style="padding:8px 0">None</div>'}</div>
          <div>${listBlock('Maturing in 30 Days', maturing30, (d) => `<div class="risk-item"><div class="risk-dot" style="background:var(--blue)"></div><div><div class="risk-name">${App.utils.escapeHtml(d.deal_name)}</div><div class="risk-desc">${App.utils.fmtDate(d.maturity_date)}</div></div></div>`)}</div>
          <div>${listBlock('Poor Reliability', poorReliability, (d) => `<div class="risk-item"><div class="risk-dot" style="background:var(--purple)"></div><div><div class="risk-name">${App.utils.escapeHtml(d.deal_name)}</div><div class="risk-desc">${App.utils.fmtPct(metricsById[d.id].payout_reliability, 0)} reliable</div></div></div>`)}</div>
        </div>
        ${largeUpcoming.length ? listBlock('Large Upcoming Payments', largeUpcoming, (r) => `<div class="risk-item"><div class="risk-dot" style="background:var(--gold)"></div><div><div class="risk-name">${App.utils.escapeHtml((dealsById[r.deal_id] || {}).deal_name)}</div><div class="risk-desc">${App.utils.fmtMoney(r.expected_total)} on ${App.utils.fmtDate(r.scheduled_date)}</div></div></div>`) : ''}
        ${listBlock('Recurring &mdash; Yet to Confirm (next 7 days)', recurringYetToConfirm, (o) => recurringRow('var(--blue)', o, `${App.utils.fmtMoney(o.expected_amount)} due ${App.utils.fmtDate(o.due_date)}`))}
        ${recurringInProgress.length ? listBlock('Recurring &mdash; In Progress', recurringInProgress, (o) => recurringRow('var(--blue)', o, App.utils.fmtMoney(o.expected_amount))) : ''}
        ${recurringRecentlyConfirmed.length ? listBlock('Recurring &mdash; Recently Confirmed', recurringRecentlyConfirmed, (o) => recurringRow('var(--teal)', o, `${App.utils.fmtMoney(o.actual_amount)} on ${App.utils.fmtDate(o.paid_date)}`)) : ''}
      `;

      App.utils.qsa('[data-open-deal]', pane).forEach((el) => el.addEventListener('click', () => {
        App.router.navigate('deals');
        setTimeout(() => App.dealsView.openDealDetail(Number(el.dataset.openDeal)), 60);
      }));
      App.utils.qsa('[data-open-recurring]', pane).forEach((el) => el.addEventListener('click', () => {
        App.router.navigate('recurring');
        setTimeout(() => App.recurringView.openItemDetail(Number(el.dataset.openRecurring)), 60);
      }));
    }

    await draw();
  }

  App.router.register('dashboard', renderDashboardView);
})();
