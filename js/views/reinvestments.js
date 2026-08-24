/* Reinvestment Intelligence (spec Section 16). Candidate rows are created
   automatically by fn_record_payment whenever a principal repayment is
   recorded (reinvested_amount left null); this view is where the user
   resolves each one - confirm what actually happened - and where the
   aggregate stats the spec asks for get computed from those resolved rows. */
window.App = window.App || {};

(function () {
  async function openResolveModal(r, deals) {
    const dealOptions = deals.map((d) => ({ value: d.id, label: d.deal_name }));
    const fields = [
      { key: 'reinvested_amount', label: 'Reinvested Amount', type: 'number', required: true },
      { key: 'reinvestment_date', label: 'Reinvestment Date', type: 'date', required: true },
      { key: 'new_deal_id', label: 'New Deal (if applicable)', type: 'select', numeric: true, options: dealOptions },
      { key: 'reinvestment_destination', label: 'Destination (free text if not a tracked deal)' },
    ];
    App.ui.open({
      title: `Resolve Reinvestment - ${App.utils.fmtMoney(r.returned_amount)} returned ${App.utils.fmtDate(r.returned_date)}`,
      bodyHtml: App.ui.renderForm(fields, { reinvestment_date: App.utils.todayISO(), reinvested_amount: r.returned_amount }),
      actions: [
        { label: 'Not Reinvested (kept as cash)', className: 'btn-outline', onClick: async () => {
          await App.api.updateReinvestment(r.id, { reinvested_amount: 0, reinvestment_date: App.utils.todayISO() });
          App.utils.toast('Marked as kept in cash'); App.ui.close(); App.router.refreshCurrent();
        } },
        { label: 'Save', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.toast('Fill in amount and date', 'err'); return; }
          await App.api.updateReinvestment(r.id, values);
          App.utils.toast('Reinvestment recorded'); App.ui.close(); App.router.refreshCurrent();
        } },
      ],
    });
  }

  async function renderReinvestmentsView() {
    const pane = App.utils.qs('#pane-reinvestments');
    pane.innerHTML = `
      <div class="section-title">Reinvestment Intelligence <div class="line"></div><small>what happened to principal once it came back</small></div>
      <div class="panel"><div class="chart-title" style="margin-bottom:10px">Portfolio Reinvestment Stats</div><div class="grid-4" id="reinvestStats"></div></div>
      <div class="panel"><div class="chart-title" style="margin-bottom:10px">Pending Resolution</div><div class="table-scroll"><table class="data" id="pendingTable"></table></div></div>
      <div class="panel"><div class="chart-title" style="margin-bottom:10px">Resolved History</div><div class="table-scroll"><table class="data" id="resolvedTable"></table></div></div>`;

    const [reinvestments, payments, deals] = await Promise.all([App.api.listReinvestments(), App.api.listPayments(), App.api.listDeals()]);
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    const paymentsById = {}; payments.forEach((p) => { paymentsById[p.id] = p; });
    const dealNameFor = (r) => { const p = paymentsById[r.source_payment_id]; return p ? (dealsById[p.deal_id] || {}).deal_name : '—'; };

    const pending = reinvestments.filter((r) => r.reinvested_amount === null);
    const resolved = reinvestments.filter((r) => r.reinvested_amount !== null);
    const actuallyReinvested = resolved.filter((r) => r.reinvested_amount > 0);

    const totalReturned = resolved.reduce((a, r) => a + (r.returned_amount || 0), 0);
    const totalReinvested = resolved.reduce((a, r) => a + (r.reinvested_amount || 0), 0);
    const ratio = totalReturned > 0 ? totalReinvested / totalReturned * 100 : null;
    const sameDayPct = actuallyReinvested.length ? actuallyReinvested.filter((r) => r.same_day_reinvestment).length / actuallyReinvested.length * 100 : null;
    const avgDelay = actuallyReinvested.length ? actuallyReinvested.reduce((a, r) => a + (r.reinvestment_delay_days || 0), 0) / actuallyReinvested.length : null;
    const avgAmount = actuallyReinvested.length ? actuallyReinvested.reduce((a, r) => a + r.reinvested_amount, 0) / actuallyReinvested.length : null;

    App.utils.qs('#reinvestStats', pane).innerHTML = `
      <div class="stat-line"><span>Reinvestment Ratio</span><span class="v">${ratio !== null ? App.utils.fmtPct(ratio) : '—'}</span></div>
      <div class="stat-line"><span>Same-Day Reinvestment %</span><span class="v">${sameDayPct !== null ? App.utils.fmtPct(sameDayPct) : '—'}</span></div>
      <div class="stat-line"><span>Avg Reinvestment Delay</span><span class="v">${avgDelay !== null ? App.utils.fmtNum(avgDelay, 0) + 'd' : '—'}</span></div>
      <div class="stat-line"><span>Avg Reinvestment Amount</span><span class="v">${avgAmount !== null ? App.utils.fmtMoney(avgAmount) : '—'}</span></div>`;

    App.utils.qs('#pendingTable', pane).innerHTML = `<thead><tr><th>Source Deal</th><th>Returned</th><th>Returned Date</th><th>Days Since</th><th></th></tr></thead>
      <tbody>${pending.map((r) => `<tr><td>${App.utils.escapeHtml(dealNameFor(r))}</td><td>${App.utils.fmtMoney(r.returned_amount)}</td><td>${App.utils.fmtDate(r.returned_date)}</td>
        <td>${App.utils.daysBetween(r.returned_date, App.utils.todayISO())}d</td><td><button class="btn btn-sm btn-gold" data-resolve="${r.id}">Resolve</button></td></tr>`).join('')
        || '<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:20px">Nothing pending.</td></tr>'}</tbody>`;
    App.utils.qsa('[data-resolve]', pane).forEach((b) => b.addEventListener('click', () => openResolveModal(pending.find((r) => r.id === Number(b.dataset.resolve)), deals)));

    App.utils.qs('#resolvedTable', pane).innerHTML = `<thead><tr><th>Source Deal</th><th>Returned</th><th>Reinvested</th><th>Ratio</th><th>Delay</th><th>Destination</th></tr></thead>
      <tbody>${resolved.map((r) => `<tr><td>${App.utils.escapeHtml(dealNameFor(r))}</td><td>${App.utils.fmtMoney(r.returned_amount)}</td><td>${App.utils.fmtMoney(r.reinvested_amount)}</td>
        <td>${r.reinvestment_ratio !== null ? App.utils.fmtPct(r.reinvestment_ratio * 100) : '—'}</td><td>${r.reinvestment_delay_days ?? '—'}d</td>
        <td>${r.new_deal_id ? App.utils.escapeHtml((dealsById[r.new_deal_id] || {}).deal_name || '') : App.utils.escapeHtml(r.reinvestment_destination || 'Cash')}</td></tr>`).join('')
        || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No resolved reinvestments yet.</td></tr>'}</tbody>`;
  }

  App.router.register('reinvestments', renderReinvestmentsView);
})();
