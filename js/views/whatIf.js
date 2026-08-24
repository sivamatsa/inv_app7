/* What-If Simulator (spec Section 33) + Investment Comparison (spec
   Section 34), as tabs of one view. */
window.App = window.App || {};

(function () {
  async function renderWhatIfView() {
    const pane = App.utils.qs('#pane-whatif');
    pane.innerHTML = `
      <div class="section-title">What-If &amp; Compare <div class="line"></div><small>projections, clearly labelled as such</small></div>
      <div class="panel">
        <div class="tabbar">
          <button class="tab-btn active" data-tab="sim">What-If Simulator</button>
          <button class="tab-btn" data-tab="cmp">Compare Deals</button>
        </div>
        <div class="tab-pane active" data-pane="sim" id="simBody"></div>
        <div class="tab-pane" data-pane="cmp" id="cmpBody"></div>
      </div>`;
    App.utils.qsa('.tab-btn', pane).forEach((btn) => btn.addEventListener('click', () => {
      App.utils.qsa('.tab-btn', pane).forEach((b) => b.classList.toggle('active', b === btn));
      App.utils.qsa('.tab-pane', pane).forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
    }));

    await renderSimTab(App.utils.qs('#simBody', pane));
    await renderCompareTab(App.utils.qs('#cmpBody', pane));
  }

  async function renderSimTab(host) {
    const fields = [
      { key: 'amount', label: 'Amount', type: 'number', required: true },
      { key: 'annualRoiPct', label: 'Annual ROI %', type: 'number', required: true },
      { key: 'tenureMonths', label: 'Tenure (months)', type: 'number', required: true },
      { key: 'scenario', label: 'Scenario', type: 'select', options: [
        { value: 'withdraw_interest', label: 'Withdraw interest, keep principal' },
        { value: 'reinvest_every_payment', label: 'Reinvest every payment (compounding)' },
        { value: 'reinvest_principal_only', label: 'Reinvest principal only at maturity' },
      ] },
    ];
    host.innerHTML = App.ui.renderForm(fields) + `<div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-gold" id="runSim">Run Simulation</button></div>
      <div id="simResult" style="margin-top:16px"></div>
      <div class="table-scroll" style="margin-top:16px"><div class="chart-title" style="margin-bottom:8px">Saved Scenarios</div><table class="data" id="savedScenarios"></table></div>`;

    async function drawSaved() {
      const scenarios = await App.api.listScenarios();
      App.utils.qs('#savedScenarios', host).innerHTML = `<thead><tr><th>Name</th><th>Type</th><th>Amount</th><th>Final Principal</th><th>Total Interest</th><th>Annualized</th><th></th></tr></thead>
        <tbody>${scenarios.map((s) => `<tr><td>${App.utils.escapeHtml(s.scenario_name)}</td><td>${s.scenario_type}</td><td>${App.utils.fmtMoney(s.inputs.amount)}</td><td>${App.utils.fmtMoney(s.outputs.finalPrincipal)}</td><td>${App.utils.fmtMoney(s.outputs.totalInterest)}</td><td>${App.utils.fmtPct(s.outputs.annualizedReturn)}</td>
          <td><button class="icon-btn del" data-del-scenario="${s.id}">&#128465;</button></td></tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:16px">No saved scenarios.</td></tr>'}</tbody>`;
      App.utils.qsa('[data-del-scenario]', host).forEach((b) => b.addEventListener('click', async () => { await App.api.deleteScenario(Number(b.dataset.delScenario)); drawSaved(); }));
    }

    App.utils.qs('#runSim', host).addEventListener('click', async () => {
      const { values, errors } = App.ui.readForm(fields);
      if (errors.length) { App.utils.toast('Fill in amount, ROI and tenure', 'err'); return; }
      const result = App.calc.whatIf(values);
      App.utils.qs('#simResult', host).innerHTML = `
        <div class="hint" style="margin-bottom:10px"><b>This is a projection, not a guarantee.</b> ${result.note || ''}</div>
        <div class="grid-4">
          <div class="kpi c-gold"><div class="kpi-label">Final Principal</div><div class="kpi-value">${App.utils.fmtMoney(result.finalPrincipal)}</div></div>
          <div class="kpi c-teal"><div class="kpi-label">Total Interest</div><div class="kpi-value">${App.utils.fmtMoney(result.totalInterest)}</div></div>
          <div class="kpi c-blue"><div class="kpi-label">Cash Received</div><div class="kpi-value">${App.utils.fmtMoney(result.cashReceived)}</div></div>
          <div class="kpi c-purple"><div class="kpi-label">Annualized Return</div><div class="kpi-value">${App.utils.fmtPct(result.annualizedReturn)}</div></div>
        </div>
        <div class="stat-line"><span>Reinvestment Effect</span><span class="v">${App.utils.fmtMoney(result.reinvestmentEffect)}</span></div>
        <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-outline btn-sm" id="saveScenarioBtn">Save this scenario</button></div>`;
      App.utils.qs('#saveScenarioBtn', host).addEventListener('click', async () => {
        const name = prompt('Name this scenario:', `${values.scenario} - ${App.utils.fmtMoney(values.amount)}`);
        if (!name) return;
        await App.api.saveScenario({ scenario_name: name, scenario_type: values.scenario, inputs: result.inputs, outputs: result });
        App.utils.toast('Scenario saved');
        drawSaved();
      });
    });

    await drawSaved();
  }

  async function renderCompareTab(host) {
    const [deals, metrics] = await Promise.all([App.api.listDeals(), App.api.listDealMetrics()]);
    const metricsById = {}; metrics.forEach((m) => { metricsById[m.deal_id] = m; });
    host.innerHTML = `
      <div class="hint" style="margin-bottom:10px">Select two or more deals to compare side by side.</div>
      <select multiple class="search-input" id="cmpSelect" style="height:120px;width:100%;margin-bottom:12px">
        ${deals.map((d) => `<option value="${d.id}">${App.utils.escapeHtml(d.deal_name)} — ${App.utils.fmtMoney(d.invested_amount)}</option>`).join('')}
      </select>
      <div style="margin-bottom:12px">
        <label class="hint">Sort by </label>
        <select class="search-input" id="cmpSort" style="width:auto">
          <option value="roi">ROI</option><option value="expectedIncome">Expected Income</option><option value="tenureMonths">Tenure</option>
          <option value="risk">Risk</option><option value="maturity">Maturity</option><option value="reliability">Reliability</option>
        </select>
      </div>
      <div class="table-scroll"><table class="data" id="cmpTable"></table></div>`;

    function draw() {
      const selectedIds = App.utils.qsa('option:checked', App.utils.qs('#cmpSelect', host)).map((o) => Number(o.value));
      const sortKey = App.utils.qs('#cmpSort', host).value;
      const pairs = selectedIds.map((id) => ({ deal: deals.find((d) => d.id === id), metrics: metricsById[id] }));
      const rows = App.calc.compareDeals(pairs).sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || String(a[sortKey] || '').localeCompare(String(b[sortKey] || '')));
      App.utils.qs('#cmpTable', host).innerHTML = `<thead><tr><th>Deal</th><th>Amount</th><th>ROI</th><th>Tenure</th><th>Frequency</th><th>Expected Income</th><th>Risk</th><th>Reliability</th><th>Maturity</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${App.utils.escapeHtml(r.name)}</td><td>${App.utils.fmtMoney(r.amount)}</td><td>${App.utils.fmtPct(r.roi)}</td><td>${r.tenureMonths ?? '—'}mo</td><td>${r.frequency}</td><td>${App.utils.fmtMoney(r.expectedIncome)}</td><td>${r.risk || '—'}</td><td>${App.utils.fmtPct(r.reliability, 0)}</td><td>${App.utils.fmtDate(r.maturity)}</td></tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text3);padding:16px">Select deals above to compare.</td></tr>'}</tbody>`;
    }
    App.utils.qs('#cmpSelect', host).addEventListener('change', draw);
    App.utils.qs('#cmpSort', host).addEventListener('change', draw);
    draw();
  }

  App.router.register('whatif', renderWhatIfView);
})();
