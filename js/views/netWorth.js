/* Accounts & Liabilities, and Net Worth (035_accounts_liabilities_net_worth.sql).
   Net Worth is computed client-side by combining data this app already owns
   elsewhere - Accounts (this module), Liabilities (this module), Deals
   (v_deal_metrics.total_outstanding), and Gold (Gold Scheme holdings +
   standalone purchases x the latest 22K price, the exact same math
   dashboard.js's own Gold panel already uses) - never a new multi-table SQL
   view. History is a lightweight daily snapshot the client upserts on first
   view each day.

   Time Machine (added later, still zero new migration) reuses this exact
   snapshot mechanism: net_worth_snapshots.breakdown is a jsonb column, so
   giving it real per-row holdings detail (not just the four aggregate
   totals it started with) needed no schema change at all - just a richer
   JS object written into a column that was already flexible. One nav item,
   four tabs, same pattern as gold.js/expenses.js. */
window.App = window.App || {};

(function () {
  const TABS = [
    { key: 'networth', label: 'Net Worth' },
    { key: 'accounts', label: 'Accounts' },
    { key: 'liabilities', label: 'Liabilities' },
    { key: 'timemachine', label: 'Time Machine' },
  ];
  const ACCOUNT_TYPES = ['Bank', 'Cash', 'Wallet', 'Investment Account', 'Other'];
  const LIABILITY_TYPES = ['Credit Card', 'Personal Loan', 'Home Loan', 'Vehicle Loan', 'Other Loan'];

  let state = { tab: 'networth' };

  async function computeNetWorth() {
    const [accounts, liabilities, deals, dealMetrics, goldHoldings, goldPurchases, goldObs] = await Promise.all([
      App.api.listAccounts(), App.api.listLiabilities(), App.api.listDeals(),
      App.api.listDealMetrics(), App.api.listGoldSchemeHoldings(), App.api.listGoldPurchases(),
      App.api.listGoldPriceObservations({ eq: { purity: '22K' }, order: { column: 'observed_at', ascending: false }, limit: 1 }),
    ]);
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    const activeAccounts = accounts.filter((a) => a.is_active);
    const activeLiabilities = liabilities.filter((l) => l.is_active);
    const dealsWithOutstanding = dealMetrics.filter((m) => (m.total_outstanding || 0) > 0);
    const accountsTotal = activeAccounts.reduce((a, r) => a + (r.current_balance || 0), 0);
    const dealsTotal = dealMetrics.reduce((a, m) => a + (m.total_outstanding || 0), 0);
    const price22k = goldObs.length ? goldObs[0].price : 0;
    const goldGrams = goldHoldings.reduce((a, h) => a + h.total_grams, 0) + goldPurchases.reduce((a, p) => a + (p.net_grams || p.grams || 0), 0);
    const goldTotal = goldGrams * price22k;
    const liabilitiesTotal = activeLiabilities.reduce((a, r) => a + (r.outstanding_amount || 0), 0);
    const totalAssets = accountsTotal + dealsTotal + goldTotal;
    const netWorth = totalAssets - liabilitiesTotal;
    return {
      accounts, liabilities, accountsTotal, dealsTotal, goldTotal, goldGrams, price22k,
      liabilitiesTotal, totalAssets, netWorth,
      breakdown: {
        accounts: accountsTotal, deals: dealsTotal, gold: goldTotal, liabilities: liabilitiesTotal,
        // Time Machine's own real payload - per-row detail, not just the
        // four totals above (which stay for backward-compatible reading of
        // any snapshot saved before this addendum shipped).
        holdings: {
          accounts: activeAccounts.map((a) => ({ id: a.id, name: a.account_name, balance: a.current_balance })),
          liabilities: activeLiabilities.map((l) => ({ id: l.id, name: l.liability_name, outstanding: l.outstanding_amount })),
          deals: dealsWithOutstanding.map((m) => ({ id: m.deal_id, name: (dealsById[m.deal_id] || {}).deal_name || `Deal #${m.deal_id}`, outstanding: m.total_outstanding })),
          gold: { grams: goldGrams, value: goldTotal },
        },
      },
    };
  }

  async function renderNetWorthView() {
    const pane = App.utils.qs('#pane-networth');
    pane.innerHTML = `
      <div class="section-title">Net Worth <div class="line"></div><small>accounts, liabilities, deals and gold, combined</small></div>
      <div class="chip-row" id="nwTabRow" style="margin-bottom:16px">${TABS.map((t) => `<div class="chip ${t.key === state.tab ? 'active' : ''}" data-nw-tab="${t.key}">${t.label}</div>`).join('')}</div>
      <div id="nwTabHost"></div>`;

    App.utils.qsa('[data-nw-tab]', pane).forEach((chip) => chip.addEventListener('click', () => {
      state.tab = chip.dataset.nwTab;
      App.utils.qsa('[data-nw-tab]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      drawTab();
    }));

    async function drawTab() {
      const host = App.utils.qs('#nwTabHost', pane);
      if (state.tab === 'networth') await drawNetWorthTab(host);
      else if (state.tab === 'accounts') await drawAccountsTab(host);
      else if (state.tab === 'liabilities') await drawLiabilitiesTab(host);
      else if (state.tab === 'timemachine') await drawTimeMachineTab(host);
    }

    async function drawNetWorthTab(host) {
      const nw = await computeNetWorth();
      const snapshots = (await App.api.listNetWorthSnapshots()).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

      // Upsert today's snapshot once per calendar day - the (user_id,
      // snapshot_date) unique constraint means revisiting the same day only
      // ever updates that one row, never duplicates it.
      const today = App.utils.todayISO();
      const alreadyToday = snapshots.find((s) => s.snapshot_date === today);
      if (!alreadyToday) {
        await App.api.upsertNetWorthSnapshot({
          snapshot_date: today, total_assets: nw.totalAssets, total_liabilities: nw.liabilitiesTotal,
          net_worth: nw.netWorth, breakdown: nw.breakdown,
        });
      }
      const allSnapshots = alreadyToday ? snapshots : snapshots.concat([{ snapshot_date: today, net_worth: nw.netWorth }]);

      const lastMonth = allSnapshots.filter((s) => s.snapshot_date < today).slice(-30)[0];
      const growth = lastMonth ? nw.netWorth - lastMonth.net_worth : null;
      const growthPct = lastMonth && lastMonth.net_worth ? (growth / Math.abs(lastMonth.net_worth)) * 100 : null;
      const liabilityRatio = nw.totalAssets > 0 ? (nw.liabilitiesTotal / nw.totalAssets) * 100 : 0;

      host.innerHTML = `
        <div class="panel" id="nwKpiPanel"></div>
        <div class="grid-2" style="margin-bottom:16px">
          <div class="panel"><div class="chart-title" style="margin-bottom:10px">Asset Allocation</div><div style="height:260px"><canvas id="nwAllocChart"></canvas></div></div>
          <div class="panel">
            <div class="chart-title" style="margin-bottom:10px">Snapshot</div>
            <div class="stat-line"><span>Total Assets</span><span class="v">${App.utils.fmtMoney(nw.totalAssets)}</span></div>
            <div class="stat-line"><span>Total Liabilities</span><span class="v">${App.utils.fmtMoney(nw.liabilitiesTotal)}</span></div>
            <div class="stat-line"><span>Liability Ratio</span><span class="v">${App.utils.fmtPct(liabilityRatio)}</span></div>
            <div class="stat-line"><span>Growth vs ~30 Days Ago</span><span class="v" style="color:${growth == null ? 'inherit' : growth >= 0 ? 'var(--teal)' : 'var(--red)'}">${growth == null ? '—' : (growth >= 0 ? '+' : '') + App.utils.fmtMoney(growth) + (growthPct != null ? ` (${App.utils.fmtPct(growthPct)})` : '')}</span></div>
            <button class="btn btn-outline btn-sm" id="nwSaveSnapshotBtn" style="margin-top:10px">Save Snapshot Now</button>
          </div>
        </div>
        <div class="panel">
          <div class="chart-title" style="margin-bottom:10px">Net Worth History</div>
          <div style="height:260px"><canvas id="nwHistoryChart"></canvas></div>
        </div>
        <div class="hint" style="margin-top:12px">Gold value uses the same latest-refreshed price shown in Gold Intelligence; Deal value is each active deal's current outstanding principal, not what you originally invested. Every balance here is manually entered - there's no live bank feed.</div>`;

      App.utils.qs('#nwKpiPanel', host).innerHTML = `
        <div class="grid-4">
          <div class="kpi c-gold fade-up"><div class="kpi-label">Total Assets</div><div class="kpi-value">${App.utils.fmtMoney(nw.totalAssets)}</div></div>
          <div class="kpi c-red fade-up"><div class="kpi-label">Total Liabilities</div><div class="kpi-value">${App.utils.fmtMoney(nw.liabilitiesTotal)}</div></div>
          <div class="kpi c-teal fade-up"><div class="kpi-label">Net Worth</div><div class="kpi-value">${App.utils.fmtMoney(nw.netWorth)}</div></div>
          <div class="kpi c-purple fade-up"><div class="kpi-label">My Gold</div><div class="kpi-value">${App.utils.fmtNum(nw.goldGrams, 2)} g</div><div class="kpi-desc">${App.utils.fmtMoney(nw.goldTotal)}</div></div>
        </div>`;

      App.charts.doughnut('nwAllocChart',
        ['Accounts', 'Deals', 'Gold'],
        [nw.accountsTotal, nw.dealsTotal, nw.goldTotal]);

      App.charts.line('nwHistoryChart',
        allSnapshots.map((s) => App.utils.fmtDate(s.snapshot_date)),
        [{ label: 'Net Worth', data: allSnapshots.map((s) => s.net_worth) }]);

      App.utils.qs('#nwSaveSnapshotBtn', host).addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          await App.api.upsertNetWorthSnapshot({
            snapshot_date: App.utils.todayISO(), total_assets: nw.totalAssets, total_liabilities: nw.liabilitiesTotal,
            net_worth: nw.netWorth, breakdown: nw.breakdown,
          });
          App.utils.toast('Snapshot saved');
          await drawNetWorthTab(host);
        } catch (err) { App.utils.toast('Could not save snapshot: ' + (err.message || err), 'err'); e.target.disabled = false; }
      });
    }

    async function drawAccountsTab(host) {
      const accounts = await App.api.listAccounts();
      const total = accounts.filter((a) => a.is_active).reduce((a, r) => a + (r.current_balance || 0), 0);
      host.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="chart-title" style="margin:0">Accounts</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" id="nwExportAccountsBtn">&#8595; Export</button>
            <button class="btn btn-gold btn-sm" id="nwAddAccountBtn">+ Add Account</button>
          </div>
        </div>
        <div class="hint" style="margin-bottom:8px">Total across active accounts: <b>${App.utils.fmtMoney(total)}</b></div>
        <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Type</th><th>Institution</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${accounts.map((a) => `<tr>
          <td>${App.utils.escapeHtml(a.account_name)}</td><td>${a.account_type}</td>
          <td>${App.utils.escapeHtml(a.institution || '—')}</td><td>${App.utils.fmtMoney(a.current_balance)}</td>
          <td><span class="badge ${a.is_active ? 'st-active' : 'st-cancelled'}">${a.is_active ? 'Active' : 'Inactive'}</span></td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-outline" data-edit-acct="${a.id}">Edit</button>
            <button class="icon-btn del" data-del-acct="${a.id}">&#128465;</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No accounts yet.</td></tr>'}</tbody></table></div>`;

      App.utils.qs('#nwAddAccountBtn', host).addEventListener('click', () => openAccountForm(null, () => drawAccountsTab(host)));
      App.utils.qs('#nwExportAccountsBtn', host).addEventListener('click', async () => {
        try { await App.exportData.exportSection('accounts'); } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
      });
      App.utils.qsa('[data-edit-acct]', host).forEach((b) => b.addEventListener('click', () => openAccountForm(accounts.find((a) => a.id === Number(b.dataset.editAcct)), () => drawAccountsTab(host))));
      App.utils.qsa('[data-del-acct]', host).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this account?')) return;
        await App.api.deleteAccount(Number(b.dataset.delAcct));
        drawAccountsTab(host);
      }));
    }

    async function drawLiabilitiesTab(host) {
      const liabilities = await App.api.listLiabilities();
      const total = liabilities.filter((l) => l.is_active).reduce((a, r) => a + (r.outstanding_amount || 0), 0);
      host.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="chart-title" style="margin:0">Liabilities</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" id="nwExportLiabilitiesBtn">&#8595; Export</button>
            <button class="btn btn-gold btn-sm" id="nwAddLiabilityBtn">+ Add Liability</button>
          </div>
        </div>
        <div class="hint" style="margin-bottom:8px">Total outstanding across active liabilities: <b>${App.utils.fmtMoney(total)}</b>. This is a balance you owe, not a bill-payment reminder - recurring bill confirmations (e.g. a credit card's monthly payment) stay in Recurring Investments.</div>
        <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Type</th><th>Lender</th><th>Outstanding</th><th>EMI</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${liabilities.map((l) => `<tr>
          <td>${App.utils.escapeHtml(l.liability_name)}</td><td>${l.liability_type}</td>
          <td>${App.utils.escapeHtml(l.lender || '—')}</td><td>${App.utils.fmtMoney(l.outstanding_amount)}</td>
          <td>${l.emi_amount ? App.utils.fmtMoney(l.emi_amount) : '—'}</td>
          <td><span class="badge ${l.is_active ? 'st-active' : 'st-cancelled'}">${l.is_active ? 'Active' : 'Inactive'}</span></td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-outline" data-edit-liab="${l.id}">Edit</button>
            <button class="icon-btn del" data-del-liab="${l.id}">&#128465;</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">No liabilities yet.</td></tr>'}</tbody></table></div>`;

      App.utils.qs('#nwAddLiabilityBtn', host).addEventListener('click', () => openLiabilityForm(null, () => drawLiabilitiesTab(host)));
      App.utils.qs('#nwExportLiabilitiesBtn', host).addEventListener('click', async () => {
        try { await App.exportData.exportSection('liabilities'); } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
      });
      App.utils.qsa('[data-edit-liab]', host).forEach((b) => b.addEventListener('click', () => openLiabilityForm(liabilities.find((l) => l.id === Number(b.dataset.editLiab)), () => drawLiabilitiesTab(host))));
      App.utils.qsa('[data-del-liab]', host).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this liability?')) return;
        await App.api.deleteLiability(Number(b.dataset.delLiab));
        drawLiabilitiesTab(host);
      }));
    }

    // ---- Time Machine - point-in-time reconstruction from
    // net_worth_snapshots.breakdown.holdings, never a live query against
    // historical data (there isn't any) - resolution is exactly whatever
    // days a snapshot happened to be saved on, stated plainly in the UI. ----
    async function drawTimeMachineTab(host) {
      const allSnapshots = (await App.api.listNetWorthSnapshots()).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
      const dated = allSnapshots.filter((s) => s.breakdown && s.breakdown.holdings);

      if (!dated.length) {
        host.innerHTML = `
          <div class="chart-title" style="margin-bottom:10px">Time Machine</div>
          <div class="empty-note">No detailed snapshots yet - visit the Net Worth tab (or click "Save Snapshot Now" there) to create your first one. Time Machine can only show detail for dates you've actually visited Net Worth on since it started tracking history - it can't retroactively reconstruct earlier dates.</div>`;
        return;
      }
      if (!state.tm) state.tm = { mode: 'today', dateA: dated[dated.length - 1].snapshot_date, dateB: dated.length > 1 ? dated[dated.length - 2].snapshot_date : dated[0].snapshot_date };

      const dateOptions = dated.map((s) => s.snapshot_date);
      host.innerHTML = `
        <div class="chart-title" style="margin-bottom:10px">Time Machine</div>
        <div class="hint" style="margin-bottom:10px">Time Machine can only show detail for dates you've actually visited Net Worth on since it started tracking history - it can't retroactively reconstruct earlier dates.</div>
        <div class="chip-row" style="margin-bottom:12px">
          <div class="chip ${state.tm.mode === 'today' ? 'active' : ''}" data-tm-mode="today">Compare to Today</div>
          <div class="chip ${state.tm.mode === 'compare' ? 'active' : ''}" data-tm-mode="compare">Compare Two Dates</div>
        </div>
        <div class="form-grid" style="margin-bottom:16px">
          <div class="field"><label>${state.tm.mode === 'today' ? 'Date' : 'Date A'}</label>
            <select id="tmDateA">${dateOptions.map((d) => `<option value="${d}" ${d === state.tm.dateA ? 'selected' : ''}>${App.utils.fmtDate(d)}</option>`).join('')}</select>
          </div>
          ${state.tm.mode === 'compare' ? `<div class="field"><label>Date B</label>
            <select id="tmDateB">${dateOptions.map((d) => `<option value="${d}" ${d === state.tm.dateB ? 'selected' : ''}>${App.utils.fmtDate(d)}</option>`).join('')}</select>
          </div>` : ''}
        </div>
        <div id="tmResult"></div>`;

      App.utils.qsa('[data-tm-mode]', host).forEach((chip) => chip.addEventListener('click', () => { state.tm.mode = chip.dataset.tmMode; drawTimeMachineTab(host); }));
      App.utils.qs('#tmDateA', host).addEventListener('change', (e) => { state.tm.dateA = e.target.value; drawResult(); });
      const dateBEl = App.utils.qs('#tmDateB', host);
      if (dateBEl) dateBEl.addEventListener('change', (e) => { state.tm.dateB = e.target.value; drawResult(); });

      function diffRows(listA, listB, nameKey, valueKey) {
        const byIdA = {}; (listA || []).forEach((r) => { byIdA[r.id] = r; });
        const byIdB = {}; (listB || []).forEach((r) => { byIdB[r.id] = r; });
        const ids = new Set([...Object.keys(byIdA), ...Object.keys(byIdB)]);
        return Array.from(ids).map((id) => {
          const a = byIdA[id], b = byIdB[id];
          const before = a ? a[valueKey] : null, after = b ? b[valueKey] : null;
          const status = !a ? 'Added' : !b ? 'Removed' : (before !== after ? 'Changed' : 'Unchanged');
          return { name: (b || a)[nameKey], before, after, delta: (after || 0) - (before || 0), status };
        }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
      }

      function diffTable(labelA, labelB, rows) {
        const body = rows.map((r) => `<tr>
          <td>${App.utils.escapeHtml(r.name)}</td>
          <td>${r.before == null ? '—' : App.utils.fmtMoney(r.before)}</td>
          <td>${r.after == null ? '—' : App.utils.fmtMoney(r.after)}</td>
          <td style="color:${r.delta > 0 ? 'var(--teal)' : r.delta < 0 ? 'var(--red)' : 'inherit'}">${r.delta === 0 ? '—' : (r.delta > 0 ? '+' : '') + App.utils.fmtMoney(r.delta)}</td>
          <td><span class="badge ${r.status === 'Added' ? 'st-active' : r.status === 'Removed' ? 'st-cancelled' : 'st-due'}">${r.status}</span></td>
        </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:12px">None</td></tr>';
        return `<div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>${App.utils.escapeHtml(labelA)}</th><th>${App.utils.escapeHtml(labelB)}</th><th>&Delta;</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
      }

      async function drawResult() {
        const resEl = App.utils.qs('#tmResult', host);
        const snapA = dated.find((s) => s.snapshot_date === state.tm.dateA);
        let hB, totalsB, labelB;
        if (state.tm.mode === 'today') {
          const nwToday = await computeNetWorth();
          hB = nwToday.breakdown.holdings;
          totalsB = { net_worth: nwToday.netWorth };
          labelB = 'Today';
        } else {
          const snapB = dated.find((s) => s.snapshot_date === state.tm.dateB);
          hB = snapB ? snapB.breakdown.holdings : null;
          totalsB = snapB ? { net_worth: snapB.net_worth } : null;
          labelB = snapB ? App.utils.fmtDate(snapB.snapshot_date) : '—';
        }
        if (!snapA || !hB) { resEl.innerHTML = '<div class="empty-note">Pick two dates to compare.</div>'; return; }
        const hA = snapA.breakdown.holdings;
        const labelA = App.utils.fmtDate(snapA.snapshot_date);
        const netWorthDelta = totalsB.net_worth - snapA.net_worth;
        const goldA = hA.gold ? hA.gold.value : 0, goldB = hB.gold ? hB.gold.value : 0;

        resEl.innerHTML = `
          <div class="grid-3" style="margin-bottom:14px">
            <div class="kpi c-gold"><div class="kpi-label">${App.utils.escapeHtml(labelA)}</div><div class="kpi-value">${App.utils.fmtMoney(snapA.net_worth)}</div></div>
            <div class="kpi c-teal"><div class="kpi-label">${App.utils.escapeHtml(labelB)}</div><div class="kpi-value">${App.utils.fmtMoney(totalsB.net_worth)}</div></div>
            <div class="kpi" style="color:${netWorthDelta >= 0 ? 'var(--teal)' : 'var(--red)'}"><div class="kpi-label">Change</div><div class="kpi-value">${(netWorthDelta >= 0 ? '+' : '') + App.utils.fmtMoney(netWorthDelta)}</div></div>
          </div>
          <div class="stat-line"><span>Gold Value</span><span class="v" style="color:${goldB - goldA >= 0 ? 'var(--teal)' : 'var(--red)'}">${App.utils.fmtMoney(goldA)} &rarr; ${App.utils.fmtMoney(goldB)} (${goldB - goldA >= 0 ? '+' : ''}${App.utils.fmtMoney(goldB - goldA)})</span></div>
          <div class="chart-title" style="margin:14px 0 8px">Accounts</div>
          ${diffTable(labelA, labelB, diffRows(hA.accounts, hB.accounts, 'name', 'balance'))}
          <div class="chart-title" style="margin:14px 0 8px">Deals (Outstanding)</div>
          ${diffTable(labelA, labelB, diffRows(hA.deals, hB.deals, 'name', 'outstanding'))}
          <div class="chart-title" style="margin:14px 0 8px">Liabilities</div>
          ${diffTable(labelA, labelB, diffRows(hA.liabilities, hB.liabilities, 'name', 'outstanding'))}`;
      }

      await drawResult();
    }

    function openAccountForm(existing, onDone) {
      const fields = [
        { key: 'account_name', label: 'Account Name', required: true },
        { key: 'account_type', label: 'Type', type: 'select', options: ACCOUNT_TYPES, required: true },
        { key: 'institution', label: 'Institution / Bank' },
        { key: 'account_number_masked', label: 'Account Number (masked)' },
        { key: 'currency', label: 'Currency' },
        { key: 'opening_balance', label: 'Opening Balance', type: 'number' },
        { key: 'current_balance', label: 'Current Balance', type: 'number', required: true },
        { key: 'is_active', label: 'Active', type: 'select', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] },
        { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
      ];
      const values = existing ? Object.assign({}, existing, { is_active: String(existing.is_active) }) : { currency: 'INR', is_active: 'true' };
      App.ui.open({
        title: existing ? 'Edit Account' : 'Add Account',
        bodyHtml: `<div id="acctFormHost"></div><div class="auth-error" id="acctFormError"></div>`,
        onMount: (body) => { App.utils.qs('#acctFormHost', body).innerHTML = App.ui.renderForm(fields, values); },
        actions: [
          { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
          { label: existing ? 'Save Changes' : 'Add Account', className: 'btn-gold', onClick: async () => {
            const { values: v, errors } = App.ui.readForm(fields);
            if (errors.length) { App.utils.qs('#acctFormError').textContent = 'Fill in the required fields.'; return; }
            v.is_active = v.is_active === 'true' || v.is_active === true;
            try {
              if (existing) await App.api.updateAccount(existing.id, v); else await App.api.createAccount(v);
              App.ui.close(); App.utils.toast('Account saved'); if (onDone) onDone();
            } catch (e) { App.utils.qs('#acctFormError').textContent = 'Could not save: ' + (e.message || e); }
          } },
        ],
      });
    }

    function openLiabilityForm(existing, onDone) {
      const fields = [
        { key: 'liability_name', label: 'Liability Name', required: true },
        { key: 'liability_type', label: 'Type', type: 'select', options: LIABILITY_TYPES, required: true },
        { key: 'lender', label: 'Lender / Bank' },
        { key: 'principal_amount', label: 'Original Principal', type: 'number' },
        { key: 'outstanding_amount', label: 'Outstanding Amount', type: 'number', required: true },
        { key: 'interest_rate', label: 'Interest Rate (%)', type: 'number' },
        { key: 'emi_amount', label: 'EMI Amount', type: 'number' },
        { key: 'start_date', label: 'Start Date', type: 'date' },
        { key: 'end_date', label: 'End Date', type: 'date' },
        { key: 'next_payment_date', label: 'Next Payment Date', type: 'date' },
        { key: 'is_active', label: 'Active', type: 'select', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] },
        { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
      ];
      const values = existing ? Object.assign({}, existing, { is_active: String(existing.is_active) }) : { is_active: 'true' };
      App.ui.open({
        title: existing ? 'Edit Liability' : 'Add Liability',
        bodyHtml: `<div id="liabFormHost"></div><div class="auth-error" id="liabFormError"></div>`,
        onMount: (body) => { App.utils.qs('#liabFormHost', body).innerHTML = App.ui.renderForm(fields, values); },
        actions: [
          { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
          { label: existing ? 'Save Changes' : 'Add Liability', className: 'btn-gold', onClick: async () => {
            const { values: v, errors } = App.ui.readForm(fields);
            if (errors.length) { App.utils.qs('#liabFormError').textContent = 'Fill in the required fields.'; return; }
            v.is_active = v.is_active === 'true' || v.is_active === true;
            try {
              if (existing) await App.api.updateLiability(existing.id, v); else await App.api.createLiability(v);
              App.ui.close(); App.utils.toast('Liability saved'); if (onDone) onDone();
            } catch (e) { App.utils.qs('#liabFormError').textContent = 'Could not save: ' + (e.message || e); }
          } },
        ],
      });
    }

    await drawTab();
  }

  // Exposed so the AI Copilot can reuse the exact same computation instead
  // of a second, possibly-drifting implementation inside its Edge Function -
  // see aiCopilot.js.
  App.netWorthCalc = { computeNetWorth };
  App.router.register('networth', renderNetWorthView);
})();
