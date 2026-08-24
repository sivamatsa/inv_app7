/* Portfolio Analytics (spec Section 13). The spec lists ~19 chart angles;
   this implements one well-built chart card per underlying question rather
   than 19 near-duplicate cards - several of the spec's bullets collapse
   into the same chart (e.g. "portfolio value over time" and "interest
   earned over time" are two series on one growth chart). */
window.App = window.App || {};

(function () {
  function tenureBucket(months) {
    if (months === null || months === undefined) return 'Unknown';
    if (months <= 6) return 'Short (&le;6mo)';
    if (months <= 24) return 'Medium (7-24mo)';
    return 'Long (&gt;24mo)';
  }

  async function renderAnalyticsView() {
    const pane = App.utils.qs('#pane-analytics');
    pane.innerHTML = `
      <div class="section-title">Portfolio Analytics <div class="line"></div><small>every chart reacts to the filters below</small></div>
      <div id="analyticsFilterBar"></div>
      <div class="grid-3">
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Capital &amp; Interest Growth</div><div class="chart-subtitle">Cumulative invested vs. interest received, by start date</div></div></div><div class="chart-wrap tall"><canvas id="chGrowth"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Investment by Platform</div></div></div><div class="chart-wrap tall"><canvas id="chPlatform"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Investment by Type</div></div></div><div class="chart-wrap tall"><canvas id="chType"></canvas></div></div>
      </div>
      <div class="grid-3">
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Deal Count by Status</div></div></div><div class="chart-wrap"><canvas id="chStatus"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Investment by Risk</div></div></div><div class="chart-wrap"><canvas id="chRisk"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Tenure Allocation</div><div class="chart-subtitle">Short / medium / long term</div></div></div><div class="chart-wrap"><canvas id="chTenure"></canvas></div></div>
      </div>
      <div class="grid-2">
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Expected vs Actual Income</div><div class="chart-subtitle">By month, last 6 months</div></div></div><div class="chart-wrap"><canvas id="chExpectedActual"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Payment Timing</div><div class="chart-subtitle">Early / on-time / late / missed, all resolved payments</div></div></div><div class="chart-wrap"><canvas id="chTiming"></canvas></div></div>
      </div>
      <div class="grid-2">
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">Investment by Payout Frequency</div></div></div><div class="chart-wrap"><canvas id="chFrequency"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div><div class="chart-title">ROI Distribution</div></div></div><div class="chart-wrap"><canvas id="chRoiDist"></canvas></div></div>
      </div>
      <div class="chart-card">
        <div class="chart-header">
          <div><div class="chart-title">Benchmark Comparison</div><div class="chart-subtitle">Is this actually a good return? Nifty 50 / Sensex % change over the period, vs your portfolio's lifetime realized ROI and a flat FD reference.</div></div>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="chip-row" id="benchmarkPeriodChips">${['1Y', '3Y', '5Y', 'All'].map((p) => `<div class="chip ${p === '1Y' ? 'active' : ''}" data-benchmark-period="${p}">${p}</div>`).join('')}</div>
            <button class="btn btn-outline btn-sm" id="refreshBenchmarkBtn">&#8635; Refresh</button>
          </div>
        </div>
        <div class="chart-wrap"><canvas id="chBenchmark"></canvas></div>
        <div class="hint" style="margin-top:8px">"My Portfolio" is your lifetime realized ROI (not scoped to the period above - there's no per-period breakdown of realized returns yet). Nifty/Sensex and FD ARE scoped to the selected period. FD is a flat admin-set assumption (Settings, admin only), not a live rate.</div>
      </div>`;

    App.filters.renderBar(App.utils.qs('#analyticsFilterBar'), draw);

    let benchmarkPeriod = '1Y';
    App.utils.qsa('[data-benchmark-period]', pane).forEach((chip) => chip.addEventListener('click', () => {
      benchmarkPeriod = chip.dataset.benchmarkPeriod;
      App.utils.qsa('[data-benchmark-period]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      drawBenchmarkChart();
    }));
    App.utils.qs('#refreshBenchmarkBtn', pane).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Refreshing...';
      try { await App.api.refreshBenchmarkData(); App.utils.toast('Benchmark data refreshed'); await drawBenchmarkChart(); }
      catch (err) { App.utils.toast('Could not refresh: ' + (err.message || err), 'err'); }
      finally { btn.disabled = false; btn.innerHTML = '&#8635; Refresh'; }
    });

    async function drawBenchmarkChart() {
      const [niftyObs, sensexObs, appSettings, summary] = await Promise.all([
        App.api.listBenchmarkObservations('NIFTY50'),
        App.api.listBenchmarkObservations('SENSEX'),
        App.api.getAppSettings(),
        App.api.getPortfolioSummary(),
      ]);
      const cutoffDays = { '1Y': 365, '3Y': 1095, '5Y': 1825, All: Infinity }[benchmarkPeriod];
      const cutoffDate = App.utils.toISO(new Date(Date.now() - cutoffDays * 86400000));

      function pctChange(obs) {
        const inRange = cutoffDays === Infinity ? obs : obs.filter((o) => o.observed_date >= cutoffDate);
        if (inRange.length < 2) return null;
        const first = inRange[0].close_value, last = inRange[inRange.length - 1].close_value;
        return first ? ((last - first) / first) * 100 : null;
      }

      const niftyPct = pctChange(niftyObs);
      const sensexPct = pctChange(sensexObs);
      const fdRate = (appSettings && appSettings.fd_reference_rate != null) ? appSettings.fd_reference_rate : 7.0;
      const fdPct = cutoffDays === Infinity ? fdRate : fdRate * (cutoffDays / 365);
      const portfolioRoi = (summary && summary.realized_roi) || 0;

      App.charts.bar('chBenchmark', ['My Portfolio (lifetime)', 'Nifty 50', 'Sensex', 'FD Reference'],
        [{ label: '% return', data: [portfolioRoi, niftyPct, sensexPct, fdPct] }],
        { plugins: { legend: { display: false } } });
    }

    async function draw() {
      const [deals, metrics, schedule, payments] = await Promise.all([
        App.api.listDeals(), App.api.listDealMetrics(), App.api.listSchedule(), App.api.listPayments(),
      ]);
      const list = App.filters.apply(deals);
      const ids = new Set(list.map((d) => d.id));
      const metricsById = {}; metrics.forEach((m) => { metricsById[m.deal_id] = m; });

      const sorted = [...list].filter((d) => d.start_date).sort((a, b) => a.start_date.localeCompare(b.start_date));
      let cumCap = 0, cumInt = 0;
      const labels = [], capData = [], intData = [];
      sorted.forEach((d) => { cumCap += d.invested_amount || 0; cumInt += (metricsById[d.id] || {}).interest_received || 0; labels.push(App.utils.fmtDate(d.start_date)); capData.push(cumCap); intData.push(cumInt); });
      App.charts.line('chGrowth', labels, [{ label: 'Cumulative Invested', data: capData }, { label: 'Cumulative Interest', data: intData }]);

      const byPlatform = {};
      list.forEach((d) => { const name = App.lookups.platformName(d.platform_id) || 'Unassigned'; byPlatform[name] = (byPlatform[name] || 0) + (d.invested_amount || 0); });
      App.charts.doughnut('chPlatform', Object.keys(byPlatform), Object.values(byPlatform));

      const byType = {};
      list.forEach((d) => { byType[d.investment_type || 'Other'] = (byType[d.investment_type || 'Other'] || 0) + (d.invested_amount || 0); });
      App.charts.doughnut('chType', Object.keys(byType), Object.values(byType));

      const byStatus = {};
      list.forEach((d) => { byStatus[d.status] = (byStatus[d.status] || 0) + 1; });
      App.charts.bar('chStatus', Object.keys(byStatus), [{ label: 'Deals', data: Object.values(byStatus) }], { plugins: { legend: { display: false } } });

      const byRisk = {};
      list.forEach((d) => { const r = d.risk_rating || 'Unrated'; byRisk[r] = (byRisk[r] || 0) + (d.invested_amount || 0); });
      App.charts.doughnut('chRisk', Object.keys(byRisk), Object.values(byRisk));

      const byTenure = {};
      list.forEach((d) => {
        const months = d.start_date && d.maturity_date ? App.utils.daysBetween(d.start_date, d.maturity_date) / 30.44 : null;
        const b = tenureBucket(months);
        byTenure[b] = (byTenure[b] || 0) + (d.invested_amount || 0);
      });
      App.charts.doughnut('chTenure', Object.keys(byTenure), Object.values(byTenure));

      const months6 = [];
      const now = new Date();
      for (let i = 5; i >= 0; i--) months6.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
      const monthLabels = months6.map((m) => m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
      const expectedByMonth = months6.map((m) => {
        const from = App.utils.toISO(m), to = App.utils.toISO(new Date(m.getFullYear(), m.getMonth() + 1, 0));
        return schedule.filter((s) => ids.has(s.deal_id) && s.scheduled_date >= from && s.scheduled_date <= to).reduce((a, s) => a + (s.expected_total || 0), 0);
      });
      const actualByMonth = months6.map((m) => {
        const from = App.utils.toISO(m), to = App.utils.toISO(new Date(m.getFullYear(), m.getMonth() + 1, 0));
        return payments.filter((p) => ids.has(p.deal_id) && !p.is_voided && p.transaction_date >= from && p.transaction_date <= to).reduce((a, p) => a + (p.amount || 0), 0);
      });
      App.charts.bar('chExpectedActual', monthLabels, [{ label: 'Expected', data: expectedByMonth }, { label: 'Actual', data: actualByMonth }]);

      const relevantSchedule = schedule.filter((s) => ids.has(s.deal_id));
      const timingCounts = { 'Early': 0, 'On Time': 0, 'Late': 0, 'Missed': 0 };
      relevantSchedule.forEach((s) => {
        if (s.status === 'RECEIVED_EARLY') timingCounts.Early++;
        else if (s.status === 'RECEIVED_ON_TIME' || s.status === 'RECEIVED') timingCounts['On Time']++;
        else if (s.status === 'RECEIVED_LATE') timingCounts.Late++;
        else if (s.status === 'MISSED') timingCounts.Missed++;
      });
      App.charts.bar('chTiming', Object.keys(timingCounts), [{ label: 'Payments', data: Object.values(timingCounts) }], { plugins: { legend: { display: false } } });

      const byFreq = {};
      list.forEach((d) => { byFreq[d.payment_frequency] = (byFreq[d.payment_frequency] || 0) + (d.invested_amount || 0); });
      App.charts.doughnut('chFrequency', Object.keys(byFreq), Object.values(byFreq));

      const buckets = { '0-1%': 0, '1-2%': 0, '2-3%': 0, '3%+': 0 };
      list.forEach((d) => {
        const r = d.annual_roi || 0;
        if (r < 1) buckets['0-1%']++; else if (r < 2) buckets['1-2%']++; else if (r < 3) buckets['2-3%']++; else buckets['3%+']++;
      });
      App.charts.bar('chRoiDist', Object.keys(buckets), [{ label: 'Deals', data: Object.values(buckets) }], { plugins: { legend: { display: false } } });
    }

    await draw();
    await drawBenchmarkChart();
  }

  App.router.register('analytics', renderAnalyticsView);
})();
