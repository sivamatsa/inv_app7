/* Earnings Intelligence (spec Section 14). */
window.App = window.App || {};

(function () {
  async function renderEarningsView() {
    const pane = App.utils.qs('#pane-earnings');
    pane.innerHTML = `
      <div class="section-title">Earnings Intelligence <div class="line"></div><small>income now, income ahead</small></div>
      <div class="kpi-grid" id="earnKpis"></div>
      <div class="grid-2">
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">FY Target Progress</div><div id="earnFyTarget"></div></div>
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">Concentration &amp; Growth</div><div id="earnConcentration"></div></div>
      </div>
      <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Expected Income Ahead</div><div class="chart-subtitle">Next 30 / 90 / 365 days</div></div></div><div class="chart-wrap"><canvas id="chExpectedAhead"></canvas></div></div>`;

    const [deals, schedule, payments, goals] = await Promise.all([
      App.api.listDeals(), App.api.listSchedule(), App.api.listPayments(), App.api.listGoals({ eq: { is_active: true } }),
    ]);
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    const validPayments = payments.filter((p) => !p.is_voided);
    const pendingStatuses = ['UPCOMING', 'DUE_TODAY', 'OVERDUE'];
    const today = App.utils.today0();
    const todayISO = App.utils.todayISO();
    const monthStart = App.utils.toISO(new Date(today.getFullYear(), today.getMonth(), 1));
    const monthEnd = App.utils.toISO(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    const lastMonthStart = App.utils.toISO(new Date(today.getFullYear(), today.getMonth() - 1, 1));
    const lastMonthEnd = App.utils.toISO(new Date(today.getFullYear(), today.getMonth(), 0));

    const sumRange = (rows, dateKey, amtKey, from, to, extra) => rows.filter((r) => r[dateKey] >= from && r[dateKey] <= to && (!extra || extra(r))).reduce((a, r) => a + (r[amtKey] || 0), 0);

    const earnedThisMonth = sumRange(validPayments, 'transaction_date', 'amount', monthStart, todayISO);
    const expectedThisMonth = sumRange(schedule, 'scheduled_date', 'expected_total', monthStart, monthEnd);
    const pendingThisMonth = sumRange(schedule, 'scheduled_date', 'expected_total', monthStart, monthEnd, (r) => pendingStatuses.includes(r.status));
    const overdueThisMonth = sumRange(schedule, 'scheduled_date', 'expected_total', monthStart, todayISO, (r) => r.status === 'OVERDUE');
    const earnedLastMonth = sumRange(validPayments, 'transaction_date', 'amount', lastMonthStart, lastMonthEnd);

    const cards = [
      { cls: 'c-teal', icon: '&#128176;', label: 'Earned This Month', value: App.utils.fmtMoney(earnedThisMonth) },
      { cls: 'c-blue', icon: '&#128197;', label: 'Expected This Month', value: App.utils.fmtMoney(expectedThisMonth) },
      { cls: 'c-gold', icon: '&#9203;', label: 'Pending This Month', value: App.utils.fmtMoney(pendingThisMonth) },
      { cls: 'c-red', icon: '&#9888;', label: 'Overdue This Month', value: App.utils.fmtMoney(overdueThisMonth) },
      { cls: 'c-purple', icon: '&#128200;', label: 'Income vs Last Month', value: (earnedThisMonth >= earnedLastMonth ? '+' : '') + App.utils.fmtMoney(earnedThisMonth - earnedLastMonth) },
    ];
    App.utils.qs('#earnKpis', pane).innerHTML = cards.map((c) => `
      <div class="kpi ${c.cls}"><div class="kpi-icon">${c.icon}</div><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div></div>`).join('');

    const goal = goals[0];
    const fyStartMonth = (App.state.profile && App.state.profile.financial_year_start_month) || 4;
    const fyStartDay = (App.state.profile && App.state.profile.financial_year_start_day) || 1;
    let fyStartYear = today.getFullYear();
    if (today < new Date(fyStartYear, fyStartMonth - 1, fyStartDay)) fyStartYear--;
    const fyStart = App.utils.toISO(new Date(fyStartYear, fyStartMonth - 1, fyStartDay));
    const fyEnd = App.utils.toISO(new Date(fyStartYear + 1, fyStartMonth - 1, fyStartDay - 1));
    const fyEarned = sumRange(validPayments, 'transaction_date', 'amount', fyStart, todayISO);
    const fyProjected = fyEarned + sumRange(schedule, 'scheduled_date', 'expected_total', todayISO, fyEnd, (r) => pendingStatuses.includes(r.status));
    const target = goal ? goal.target_annual_income : null;
    const gap = target ? Math.max(0, target - fyProjected) : null;

    App.utils.qs('#earnFyTarget', pane).innerHTML = `
      <div class="stat-line"><span>FY Earned So Far</span><span class="v">${App.utils.fmtMoney(fyEarned)}</span></div>
      <div class="stat-line"><span>FY Projected</span><span class="v">${App.utils.fmtMoney(fyProjected)}</span></div>
      <div class="stat-line"><span>FY Target</span><span class="v">${target ? App.utils.fmtMoney(target) : 'Not set (see Goals)'}</span></div>
      <div class="stat-line"><span>Gap to Target</span><span class="v">${gap !== null ? App.utils.fmtMoney(gap) : '—'}</span></div>
    `;

    const monthsActive = [...new Set(validPayments.map((p) => p.transaction_date.slice(0, 7)))].length || 1;
    const totalEarned = validPayments.reduce((a, p) => a + (p.amount || 0), 0);
    const monthlyAvg = totalEarned / monthsActive;
    const sortedByIncome = [...deals].map((d) => ({ d, income: validPayments.filter((p) => p.deal_id === d.id).reduce((a, p) => a + (p.amount || 0), 0) })).sort((a, b) => b.income - a.income);
    const top3Income = sortedByIncome.slice(0, 3).reduce((a, x) => a + x.income, 0);
    const incomeConcentration = totalEarned > 0 ? (top3Income / totalEarned * 100) : 0;

    App.utils.qs('#earnConcentration', pane).innerHTML = `
      <div class="stat-line"><span>Monthly Average Income</span><span class="v">${App.utils.fmtMoney(monthlyAvg)}</span></div>
      <div class="stat-line"><span>Annualized Income</span><span class="v">${App.utils.fmtMoney(monthlyAvg * 12)}</span></div>
      <div class="stat-line"><span>Income Growth (MoM)</span><span class="v">${earnedLastMonth > 0 ? App.utils.fmtPct((earnedThisMonth - earnedLastMonth) / earnedLastMonth * 100) : '—'}</span></div>
      <div class="stat-line"><span>Top-3 Deal Income Concentration</span><span class="v">${App.utils.fmtPct(incomeConcentration)}</span></div>
    `;

    const in30 = App.utils.toISO(new Date(Date.now() + 30 * 86400000));
    const in90 = App.utils.toISO(new Date(Date.now() + 90 * 86400000));
    const in365 = App.utils.toISO(new Date(Date.now() + 365 * 86400000));
    const ahead = [
      sumRange(schedule, 'scheduled_date', 'expected_total', todayISO, in30, (r) => pendingStatuses.includes(r.status)),
      sumRange(schedule, 'scheduled_date', 'expected_total', todayISO, in90, (r) => pendingStatuses.includes(r.status)),
      sumRange(schedule, 'scheduled_date', 'expected_total', todayISO, in365, (r) => pendingStatuses.includes(r.status)),
    ];
    App.charts.bar('chExpectedAhead', ['Next 30 days', 'Next 90 days', 'Next 365 days'], [{ label: 'Expected Income', data: ahead }], { plugins: { legend: { display: false } } });
  }

  App.router.register('earnings', renderEarningsView);
})();
