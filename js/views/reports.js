/* Financial Year Reporting + Tax Tracking (spec Sections 27, 28). Explicitly
   does not compute a final tax liability - spec Section 28: "Do not claim
   to calculate final tax liability unless configured for applicable tax
   rules," which this build isn't. */
window.App = window.App || {};

(function () {
  function defaultFyRange() {
    const month = (App.state.profile && App.state.profile.financial_year_start_month) || 4;
    const day = (App.state.profile && App.state.profile.financial_year_start_day) || 1;
    const now = App.utils.today0();
    let startYear = now.getFullYear();
    if (now < new Date(startYear, month - 1, day)) startYear--;
    return { from: App.utils.toISO(new Date(startYear, month - 1, day)), to: App.utils.toISO(new Date(startYear + 1, month - 1, day - 1)), label: `FY${startYear}-${String(startYear + 1).slice(2)}` };
  }

  async function renderReportsView() {
    const pane = App.utils.qs('#pane-reports');
    const fy = defaultFyRange();
    pane.innerHTML = `
      <div class="section-title">Reports — Tax &amp; Financial Year <div class="line"></div><small>${fy.label} by default; pick a custom range below</small></div>
      <div class="panel">
        <div class="filterbar">
          <div class="filter-group"><label>From</label><input type="date" class="date-mini" id="repFrom" value="${fy.from}"></div>
          <div class="filter-group"><label>To</label><input type="date" class="date-mini" id="repTo" value="${fy.to}"></div>
          <div class="filter-group"><label>&nbsp;</label><button class="btn btn-outline btn-sm" id="repRun">Run</button></div>
        </div>
        <div class="kpi-grid" id="repKpis"></div>
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="chart-title">Tax Records</div>
          <button class="btn btn-gold btn-sm" id="genTaxRecord">Generate for this range</button>
        </div>
        <div class="hint">This is a tracking tool, not a tax calculator - it totals what your records show (gross interest, tax deducted/TDS). It does not compute your final tax liability under any specific tax regime.</div>
        <div class="table-scroll" style="margin-top:10px"><table class="data" id="taxTable"></table></div>
      </div>`;

    async function run() {
      const from = App.utils.qs('#repFrom', pane).value;
      const to = App.utils.qs('#repTo', pane).value;
      const [payments, deals] = await Promise.all([App.api.listPayments({ gte: { transaction_date: from }, lte: { transaction_date: to } }), App.api.listDeals({ gte: { start_date: from }, lte: { start_date: to } })]);
      const validPayments = payments.filter((p) => !p.is_voided);
      const fyIncome = validPayments.reduce((a, p) => a + (p.interest_amount || 0), 0);
      const fyPrincipalReturned = validPayments.reduce((a, p) => a + (p.principal_amount || 0), 0);
      const fyInvestment = deals.reduce((a, d) => a + (d.invested_amount || 0), 0);
      const fyTaxWithheld = validPayments.reduce((a, p) => a + (p.tax_amount || 0), 0);
      const fyFees = validPayments.reduce((a, p) => a + (p.fee_amount || 0), 0);
      const fyProfit = fyIncome - fyFees - fyTaxWithheld;
      const allSchedule = await App.api.listSchedule({ gte: { scheduled_date: from }, lte: { scheduled_date: to }, in: { status: ['UPCOMING', 'DUE_TODAY', 'OVERDUE', 'PARTIALLY_RECEIVED'] } });
      const fyPendingIncome = allSchedule.reduce((a, s) => a + (s.expected_interest || 0), 0);

      const cards = [
        { label: 'FY Income (Interest)', value: App.utils.fmtMoney(fyIncome), cls: 'c-teal' },
        { label: 'FY Principal Returned', value: App.utils.fmtMoney(fyPrincipalReturned), cls: 'c-blue' },
        { label: 'FY Investment', value: App.utils.fmtMoney(fyInvestment), cls: 'c-gold' },
        { label: 'FY Profit', value: App.utils.fmtMoney(fyProfit), cls: 'c-purple' },
        { label: 'FY Tax Withheld', value: App.utils.fmtMoney(fyTaxWithheld), cls: 'c-red' },
        { label: 'FY Pending Income', value: App.utils.fmtMoney(fyPendingIncome), cls: 'c-gold' },
      ];
      App.utils.qs('#repKpis', pane).innerHTML = cards.map((c) => `<div class="kpi ${c.cls}"><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div></div>`).join('');
      pane._lastRange = { from, to, fyIncome, fyTaxWithheld };
    }

    App.utils.qs('#repRun', pane).addEventListener('click', run);

    async function drawTaxTable() {
      const records = await App.api.listTaxRecords();
      App.utils.qs('#taxTable', pane).innerHTML = `<thead><tr><th>Financial Year</th><th>Gross Interest</th><th>Tax Deducted</th><th>TDS</th><th>Net Interest</th><th>Notes</th></tr></thead>
        <tbody>${records.map((r) => `<tr><td>${r.financial_year}</td><td>${App.utils.fmtMoney(r.gross_interest)}</td><td>${App.utils.fmtMoney(r.tax_deducted)}</td><td>${App.utils.fmtMoney(r.tds)}</td><td>${App.utils.fmtMoney(r.net_interest)}</td><td>${App.utils.escapeHtml(r.tax_notes || '—')}</td></tr>`).join('')
          || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No tax records yet.</td></tr>'}</tbody>`;
    }

    App.utils.qs('#genTaxRecord', pane).addEventListener('click', async () => {
      const r = pane._lastRange || defaultFyRange();
      try {
        await App.api.createTaxRecord({
          financial_year: fy.label, gross_interest: r.fyIncome || 0, tax_deducted: r.fyTaxWithheld || 0,
          tds: r.fyTaxWithheld || 0, net_interest: (r.fyIncome || 0) - (r.fyTaxWithheld || 0),
        });
        App.utils.toast('Tax record generated from current totals - review and edit as needed');
        drawTaxTable();
      } catch (e) { App.utils.toast('Could not generate tax record: ' + (e.message || e), 'err'); }
    });

    await run();
    await drawTaxTable();
  }

  App.router.register('reports', renderReportsView);
})();
