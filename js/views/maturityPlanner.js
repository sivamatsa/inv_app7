/* Maturity Planner (spec Section 15). Forward-looking: every row is still
   an ACTIVE deal. The reinvestment "decision" (Reinvest/Withdraw/Partially
   reinvest/Keep as cash/Decide later) is soft planning state, not a
   financial record - it's kept in localStorage rather than a new DB table,
   since nothing has actually happened yet (spec's own "Decide later" option
   confirms this is meant to be provisional). Once principal is actually
   returned, the real Reinvestments view (backed by the reinvestments table)
   takes over as the source of truth. */
window.App = window.App || {};

(function () {
  const DECISION_KEY = 'maturityDecisions';
  function getDecisions() { try { return JSON.parse(localStorage.getItem(DECISION_KEY) || '{}'); } catch (e) { return {}; } }
  function setDecision(dealId, decision, destination) {
    const all = getDecisions();
    all[dealId] = { decision, destination, at: new Date().toISOString() };
    localStorage.setItem(DECISION_KEY, JSON.stringify(all));
  }

  async function renderMaturityView() {
    const pane = App.utils.qs('#pane-maturity');
    pane.innerHTML = `
      <div class="section-title">Maturity Planner <div class="line"></div><small>every active deal, sorted by days remaining</small></div>
      <div class="panel"><div class="table-scroll"><table class="data" id="maturityTable"></table></div></div>`;

    const [deals, schedule] = await Promise.all([
      App.api.listDeals({ eq: { status: 'ACTIVE' } }), App.api.listSchedule({ in: { status: ['UPCOMING', 'DUE_TODAY', 'OVERDUE', 'PARTIALLY_RECEIVED'] } }),
    ]);
    const withMaturity = deals.filter((d) => d.maturity_date).sort((a, b) => a.maturity_date.localeCompare(b.maturity_date));
    const decisions = getDecisions();
    const todayISO = App.utils.todayISO();

    const rows = withMaturity.map((d) => {
      const remainingInterest = schedule.filter((s) => s.deal_id === d.id && s.scheduled_date <= d.maturity_date).reduce((a, s) => a + (s.expected_interest || 0), 0);
      const daysRemaining = App.utils.daysBetween(todayISO, d.maturity_date);
      const projectedReinvestEarning = d.current_principal && d.annual_roi ? d.current_principal * (d.annual_roi / 100) : null;
      const reminderDate = App.utils.toISO(new Date(new Date(d.maturity_date).getTime() - 7 * 86400000));
      const dec = decisions[d.id];
      return { d, remainingInterest, daysRemaining, projectedReinvestEarning, reminderDate, dec };
    });

    const table = App.utils.qs('#maturityTable', pane);
    table.innerHTML = `<thead><tr><th>Deal</th><th>Maturity</th><th>Days Left</th><th>Principal Returning</th><th>Expected Final Interest</th><th>Projected Reinvest Earning (1yr, same rate)</th><th>Reminder Date</th><th>Decision</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${App.utils.escapeHtml(r.d.deal_name)}</td>
          <td>${App.utils.fmtDate(r.d.maturity_date)}</td>
          <td>${r.daysRemaining}d</td>
          <td>${App.utils.fmtMoney(r.d.current_principal)}</td>
          <td>${App.utils.fmtMoney(r.remainingInterest)}</td>
          <td>${r.projectedReinvestEarning !== null ? App.utils.fmtMoney(r.projectedReinvestEarning) : '—'}</td>
          <td>${App.utils.fmtDate(r.reminderDate)}</td>
          <td>
            <select class="search-input" data-decision="${r.d.id}" style="font-size:11px;padding:5px 8px">
              ${['Decide later', 'Reinvest', 'Withdraw', 'Partially reinvest', 'Keep as cash'].map((o) => `<option ${r.dec && r.dec.decision === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
          </td>
        </tr>`).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:24px">No active deals with a maturity date.</td></tr>`}</tbody>`;

    App.utils.qsa('[data-decision]', table).forEach((sel) => sel.addEventListener('change', () => {
      const dealId = Number(sel.dataset.decision);
      setDecision(dealId, sel.value, null);
      App.utils.toast('Decision saved');
      if (sel.value === 'Reinvest') {
        App.utils.toast('Opening a new deal to reinvest into...', 'info');
        App.router.navigate('deals');
        setTimeout(() => App.dealsView && App.dealsView.openDealWizard(null), 300);
      }
    }));
  }

  App.router.register('maturity', renderMaturityView);
})();
