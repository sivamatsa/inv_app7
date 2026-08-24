/* Deal Management (spec Sections 4, 18, 21). List + a 4-step create/edit
   wizard matching Section 21's step grouping + a tabbed detail modal
   matching Section 18. */
window.App = window.App || {};

(function () {
  const DEAL_FIELDS = [
    // Step 1: identity
    { key: 'deal_name', label: 'Deal Name', required: true, step: 1, span: 2 },
    { key: 'external_deal_id', label: 'External Deal ID (platform reference)', step: 1 },
    { key: 'investment_type', label: 'Investment Type', required: true, step: 1,
      type: 'select', options: () => [...new Set(App.state.categories.map((c) => c.investment_type))] },
    { key: 'category', label: 'Category', step: 1 },
    { key: 'sub_category', label: 'Sub Category', step: 1 },
    { key: 'platform_id', label: 'Platform / Lender', step: 1, numeric: true,
      type: 'select', options: () => App.state.platforms.map((p) => ({ value: p.id, label: p.name })) },
    { key: 'account_reference', label: 'Account / Reference Number', step: 1 },
    // Step 2: financial + dates
    { key: 'invested_amount', label: 'Invested Amount', required: true, type: 'number', step: 2 },
    { key: 'principal_amount', label: 'Principal Amount', required: true, type: 'number', step: 2 },
    { key: 'original_principal', label: 'Original Principal', required: true, type: 'number', step: 2 },
    { key: 'annual_roi', label: 'Annual ROI %', type: 'number', step: 2 },
    { key: 'monthly_roi', label: 'Monthly ROI %', type: 'number', step: 2 },
    { key: 'interest_rate', label: 'Interest Rate %', type: 'number', step: 2 },
    { key: 'interest_rate_type', label: 'Interest Rate Type', step: 2, placeholder: 'Fixed / Floating' },
    { key: 'start_date', label: 'Start Date', required: true, type: 'date', step: 2 },
    { key: 'investment_date', label: 'Investment Date', type: 'date', step: 2 },
    { key: 'maturity_date', label: 'Maturity Date', type: 'date', step: 2 },
    { key: 'expected_total_interest', label: 'Expected Total Interest', type: 'number', step: 2 },
    { key: 'expected_total_return', label: 'Expected Total Return', type: 'number', step: 2 },
    { key: 'fees', label: 'Fees', type: 'number', step: 2 },
    { key: 'tax_withheld', label: 'Tax Withheld', type: 'number', step: 2 },
    // Step 3: payment configuration
    { key: 'payment_frequency', label: 'Payment Frequency', required: true, step: 3,
      type: 'select', options: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'At Maturity', 'Irregular', 'Custom'] },
    { key: 'payout_type', label: 'Payout Type', required: true, step: 3,
      type: 'select', options: ['Interest Only', 'Interest + Principal', 'Principal at Maturity', 'Interest at Maturity', 'EMI', 'Bullet', 'Custom'] },
    { key: 'payment_day', label: 'Payment Day of Month', type: 'number', step: 3 },
    { key: 'first_payment_date', label: 'First Payment Date', type: 'date', step: 3 },
    { key: 'payment_method', label: 'Payment Method', step: 3 },
    { key: 'interest_calculation_method', label: 'Interest Calculation Method', step: 3, placeholder: 'Simple / Compound / Reducing Balance' },
    { key: 'principal_repayment_method', label: 'Principal Repayment Method', step: 3 },
    // Step 4: risk + status
    { key: 'status', label: 'Status', step: 4, type: 'select',
      options: ['ACTIVE', 'MATURED', 'CLOSED', 'DEFAULTED', 'PARTIALLY_RECOVERED', 'WRITTEN_OFF', 'CANCELLED', 'ON_HOLD'] },
    { key: 'risk_rating', label: 'Risk Rating', step: 4, type: 'select', options: () => App.state.riskRatings.map((r) => r.code) },
    { key: 'risk_category', label: 'Risk Category', step: 4 },
    { key: 'collateral_available', label: 'Collateral Available', step: 4, type: 'checkbox' },
    { key: 'collateral_value', label: 'Collateral Value', step: 4, type: 'number' },
    { key: 'guarantor_available', label: 'Guarantor Available', step: 4, type: 'checkbox' },
    { key: 'platform_rating', label: 'Platform Rating', step: 4 },
    { key: 'user_risk_rating', label: 'Your Risk Assessment', step: 4 },
    { key: 'default_probability', label: 'Default Probability %', step: 4, type: 'number' },
    { key: 'notes', label: 'Notes', step: 4, type: 'textarea', span: 4 },
  ];

  function resolvedFields(step) {
    return DEAL_FIELDS.filter((f) => f.step === step).map((f) => Object.assign({}, f, {
      options: typeof f.options === 'function' ? f.options() : f.options,
    }));
  }

  let wizardStep = 1;
  let wizardDealId = null;

  function stepperHtml() {
    const labels = ['1. Identity', '2. Amount & Dates', '3. Payment Setup', '4. Risk & Status'];
    return `<div class="wizard-steps">${labels.map((l, i) => `<div class="wizard-step ${wizardStep === i + 1 ? 'active' : wizardStep > i + 1 ? 'done' : ''}">${l}</div>`).join('')}</div>`;
  }

  function renderWizardBody(values) {
    return `${stepperHtml()}<div id="wizardFieldsHost">${App.ui.renderForm(resolvedFields(wizardStep), values)}</div>`;
  }

  function openDealWizard(existing) {
    wizardStep = 1;
    wizardDealId = existing ? existing.id : null;
    const collected = Object.assign({}, existing || {});

    function renderStep() {
      App.utils.qs('#sharedModalBody').innerHTML = renderWizardBody(collected);
      wireStepFields();
    }

    function wireStepFields() {
      resolvedFields(wizardStep).forEach((f) => {
        const elx = App.utils.qs('#fld_' + f.key);
        if (!elx) return;
        elx.addEventListener('change', () => {
          const { values } = App.ui.readForm([f]);
          Object.assign(collected, values);
          if (['invested_amount', 'annual_roi', 'start_date', 'maturity_date'].includes(f.key)) previewExpected();
        });
      });
      previewExpected();
    }

    function previewExpected() {
      if (wizardStep !== 2) return;
      const amt = App.utils.parseNum(App.utils.qs('#fld_invested_amount')?.value);
      const roi = App.utils.parseNum(App.utils.qs('#fld_annual_roi')?.value);
      const start = App.utils.qs('#fld_start_date')?.value;
      const maturity = App.utils.qs('#fld_maturity_date')?.value;
      if (amt && roi && start && maturity) {
        const years = App.utils.daysBetween(start, maturity) / 365;
        const est = App.calc.simpleExpectedInterest(amt, roi, years);
        const field = App.utils.qs('#fld_expected_total_interest');
        if (field && !field.value) field.placeholder = `est. ${App.utils.fmtMoney(est)}`;
      }
    }

    function actionsForStep() {
      const actions = [];
      if (wizardStep > 1) actions.push({ label: '&larr; Back', className: 'btn-outline', onClick: () => { captureStep(); wizardStep--; renderStep(); } });
      if (wizardStep < 4) actions.push({ label: 'Next &rarr;', className: 'btn-gold', onClick: () => { if (captureStep()) { wizardStep++; renderStep(); refreshActions(); } } });
      else actions.push({ label: existing ? 'Save Changes' : 'Create Deal', className: 'btn-gold', onClick: submitWizard });
      actions.push({ label: 'Cancel', className: 'btn-outline', onClick: App.ui.close });
      return actions;
    }

    function refreshActions() {
      const el = App.utils.qs('#sharedModalActions');
      el.innerHTML = '';
      actionsForStep().forEach((a) => {
        const btn = document.createElement('button');
        btn.className = 'btn ' + a.className;
        btn.innerHTML = a.label;
        btn.addEventListener('click', a.onClick);
        el.appendChild(btn);
      });
    }

    function captureStep() {
      const { values, errors } = App.ui.readForm(resolvedFields(wizardStep));
      Object.assign(collected, values);
      if (errors.length) { App.utils.toast('Fill in the required fields before continuing', 'err'); return false; }
      return true;
    }

    async function submitWizard() {
      if (!captureStep()) return;
      try {
        if (!existing) {
          collected.current_principal = collected.invested_amount;
          const saved = await App.api.createDeal(collected);
          App.utils.toast('Deal created');
          if (saved.maturity_date && !['Irregular', 'Custom'].includes(saved.payment_frequency)) {
            try { await App.api.generateSchedule(saved.id); App.utils.toast('Payment schedule generated'); }
            catch (e) { App.utils.toast('Deal saved, but schedule generation failed: ' + (e.message || e), 'err'); }
          }
        } else {
          const patch = Object.assign({}, collected);
          delete patch.current_principal; // never blindly overwritten from the edit form
          // `collected` was seeded from the whole existing deal row (so the
          // wizard can show its current values across steps), not just the
          // form fields - strip the system-managed columns that came along
          // for the ride before sending this back as an UPDATE. `id` in
          // particular isn't just "shouldn't change", Postgres rejects the
          // update outright ("column can only be updated to DEFAULT") since
          // it's a GENERATED ALWAYS AS IDENTITY column.
          delete patch.id;
          delete patch.user_id;
          delete patch.created_at;
          delete patch.updated_at;
          await App.api.updateDeal(existing.id, patch);
          App.utils.toast('Deal updated');
        }
        App.ui.close();
        App.router.refreshCurrent();
      } catch (e) {
        App.utils.toast('Could not save deal: ' + (e.message || e), 'err');
      }
    }

    App.ui.open({ title: existing ? 'Edit Deal' : 'New Deal', bodyHtml: renderWizardBody(collected), onMount: () => { wireStepFields(); refreshActions(); } });
  }

  // A deal with recorded payments literally cannot be deleted - payments.deal_id
  // is `on delete restrict` on purpose (this app's "never delete financial
  // history via a side effect" rule). Postgres surfaces that as a foreign-key
  // violation (error code 23503); caught here and shown as a friendly message
  // pointing at the existing Close action, instead of a raw DB error.
  function openDeleteDealModal(deal, onDone) {
    App.ui.open({
      title: 'Delete Deal',
      bodyHtml: `
        <div class="hint" style="color:var(--red,#e5484d);margin-bottom:10px">This permanently deletes "${App.utils.escapeHtml(deal.deal_name)}" and its payment schedule. There is no undo.</div>
        <div class="field span2"><label>Type the deal name to confirm: ${App.utils.escapeHtml(deal.deal_name)}</label><input id="confirmDeleteDealName" type="text"></div>
        <div class="auth-error" id="deleteDealError"></div>`,
      actions: [
        { label: 'Delete Permanently', className: 'btn-outline', onClick: async () => {
          const typed = App.utils.qs('#confirmDeleteDealName').value.trim();
          if (typed !== deal.deal_name) { App.utils.qs('#deleteDealError').textContent = 'Name does not match - nothing was deleted.'; return; }
          try {
            await App.api.deleteDeal(deal.id);
            App.utils.toast('Deal deleted');
            App.ui.close();
            if (onDone) onDone();
          } catch (e) {
            App.utils.qs('#deleteDealError').textContent = e.code === '23503'
              ? 'This deal has recorded payments and can\'t be deleted - edit it and set Status to CLOSED instead to keep its history.'
              : (e.message || String(e));
          }
        } },
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });
  }

  async function openDealDetail(dealId) {
    const [deal, metricsAll, schedule, payments, documents] = await Promise.all([
      App.api.getDeal(dealId),
      App.api.listDealMetrics(),
      App.api.listSchedule({ eq: { deal_id: dealId } }),
      App.api.listPayments({ eq: { deal_id: dealId } }),
      App.api.listDocuments({ eq: { deal_id: dealId } }),
    ]);
    const metrics = metricsAll.find((m) => m.deal_id === dealId) || {};

    const overviewHtml = `
      <div class="grid-2">
        <div>
          <div class="stat-line"><span>Invested Amount</span><span class="v">${App.utils.fmtMoney(deal.invested_amount)}</span></div>
          <div class="stat-line"><span>ROI</span><span class="v">${App.utils.fmtPct(deal.annual_roi)}</span></div>
          <div class="stat-line"><span>Start Date</span><span class="v">${App.utils.fmtDate(deal.start_date)}</span></div>
          <div class="stat-line"><span>Maturity</span><span class="v">${App.utils.fmtDate(deal.maturity_date)}</span></div>
          <div class="stat-line"><span>Tenure</span><span class="v">${App.utils.fmtNum(App.utils.daysBetween(deal.start_date, deal.maturity_date))} days</span></div>
        </div>
        <div>
          <div class="stat-line"><span>Status</span><span class="badge st-${(deal.status || '').toLowerCase()}">${deal.status}</span></div>
          <div class="stat-line"><span>Outstanding Principal</span><span class="v">${App.utils.fmtMoney(metrics.total_outstanding)}</span></div>
          <div class="stat-line"><span>Platform</span><span class="v">${App.utils.escapeHtml(App.lookups.platformName(deal.platform_id))}</span></div>
          <div class="stat-line"><span>Payment Frequency</span><span class="v">${deal.payment_frequency || '—'}</span></div>
          <div class="stat-line"><span>Payout Type</span><span class="v">${deal.payout_type || '—'}</span></div>
        </div>
      </div>`;

    const performanceHtml = `
      <div class="grid-2">
        <div>
          <div class="stat-line"><span>Interest Received</span><span class="v">${App.utils.fmtMoney(metrics.interest_received)}</span></div>
          <div class="stat-line"><span>Interest Pending</span><span class="v">${App.utils.fmtMoney(metrics.interest_pending)}</span></div>
          <div class="stat-line"><span>Principal Returned</span><span class="v">${App.utils.fmtMoney(metrics.principal_returned)}</span></div>
          <div class="stat-line"><span>Total Received</span><span class="v">${App.utils.fmtMoney(metrics.total_received)}</span></div>
        </div>
        <div>
          <div class="stat-line"><span>Realized ROI</span><span class="v">${App.utils.fmtPct(metrics.realized_roi)}</span></div>
          <div class="stat-line"><span>Annualized Realized ROI</span><span class="v">${App.utils.fmtPct(metrics.annualized_realized_roi)}</span></div>
          <div class="stat-line"><span>Payment Reliability</span><span class="v">${App.utils.fmtPct(metrics.payout_reliability)}</span></div>
          <div class="stat-line"><span>Recovery %</span><span class="v">${App.utils.fmtPct(metrics.recovery_percentage)}</span></div>
        </div>
      </div>`;

    const historyHtml = `
      <div class="table-scroll" style="max-height:280px">
        <table class="data"><thead><tr><th>Scheduled</th><th>Expected</th><th>Status</th><th>Actual Date</th><th>Actual Amount</th></tr></thead>
        <tbody>${schedule.map((s) => {
          const actual = payments.find((p) => p.id === s.actual_payment_id);
          return `<tr><td>${App.utils.fmtDate(s.scheduled_date)}</td><td>${App.utils.fmtMoney(s.expected_total)}</td>
            <td><span class="badge ${App.utils.statusBadgeClass(s.status)}">${s.status}</span></td>
            <td>${actual ? App.utils.fmtDate(actual.transaction_date) : '—'}</td>
            <td>${actual ? App.utils.fmtMoney(actual.amount) : '—'}</td></tr>`;
        }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">No schedule yet</td></tr>'}</tbody></table>
      </div>`;

    const documentsHtml = `
      <div class="card-row">${documents.map((d) => `
        <div class="integration-card"><div class="name">${App.utils.escapeHtml(d.file_name)}</div>
        <div class="status">${d.document_type} · ${App.utils.fmtDate(d.document_date)}</div></div>`).join('') || '<div class="empty-note">No documents attached.</div>'}
      </div>`;

    const bodyHtml = `
      <div class="tabbar" id="detailTabs">
        <button class="tab-btn active" data-tab="ov">Overview</button>
        <button class="tab-btn" data-tab="pf">Performance</button>
        <button class="tab-btn" data-tab="hi">Payment History</button>
        <button class="tab-btn" data-tab="dc">Documents</button>
      </div>
      <div class="tab-pane active" data-pane="ov">${overviewHtml}</div>
      <div class="tab-pane" data-pane="pf">${performanceHtml}</div>
      <div class="tab-pane" data-pane="hi">${historyHtml}</div>
      <div class="tab-pane" data-pane="dc">${documentsHtml}</div>`;

    App.ui.open({
      title: deal.deal_name, bodyHtml,
      actions: [
        { label: 'Edit', className: 'btn-outline', onClick: () => { App.ui.close(); openDealWizard(deal); } },
        { label: 'Delete', className: 'btn-outline', onClick: () => openDeleteDealModal(deal, () => App.router.refreshCurrent()) },
        { label: 'Close', className: 'btn-gold', onClick: App.ui.close },
      ],
      onMount: (body) => {
        App.utils.qsa('.tab-btn', body.parentElement).forEach((btn) => {
          btn.addEventListener('click', () => {
            App.utils.qsa('.tab-btn', body.parentElement).forEach((b) => b.classList.toggle('active', b === btn));
            App.utils.qsa('.tab-pane', body).forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
          });
        });
      },
    });
  }

  let sortKey = 'created_at';
  let sortDir = 'desc';
  let statusTab = 'all'; // 'all' | 'active' | 'closed' - independent of the global filter bar's own Status dropdown

  async function renderDealsView() {
    const pane = App.utils.qs('#pane-deals');
    pane.innerHTML = `
      <div class="section-title">Deal Management <div class="line"></div><small>every investment, one universal model</small></div>
      <div id="dealsFilterBar"></div>
      <div class="panel">
        <div class="tabbar" id="dealsStatusTabs">
          <button class="tab-btn active" data-status-tab="all">All Deals</button>
          <button class="tab-btn" data-status-tab="active">Active Deals</button>
          <button class="tab-btn" data-status-tab="closed">Closed Deals</button>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <input class="search-input" id="dealsSearch" placeholder="Search deal name / external id...">
          <button class="btn btn-outline btn-sm" id="exportDealsBtn">&#8595; Export</button>
          <button class="btn btn-gold btn-sm" id="addDealBtn">+ New Deal</button>
        </div>
        <div class="table-scroll"><table class="data" id="dealsTable"></table></div>
      </div>`;

    App.filters.renderBar(App.utils.qs('#dealsFilterBar'), draw);
    App.utils.qs('#addDealBtn').addEventListener('click', () => openDealWizard(null));
    App.utils.qs('#exportDealsBtn').addEventListener('click', async () => {
      try { await App.exportData.exportSection('deals'); } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
    });
    App.utils.qs('#dealsSearch').addEventListener('input', App.utils.debounce((e) => {
      App.state.filters.search = e.target.value; draw();
    }, 250));
    App.utils.qsa('[data-status-tab]', pane).forEach((btn) => btn.addEventListener('click', () => {
      statusTab = btn.dataset.statusTab;
      App.utils.qsa('[data-status-tab]', pane).forEach((b) => b.classList.toggle('active', b === btn));
      draw();
    }));

    async function draw() {
      const [deals, metrics] = await Promise.all([App.api.listDeals(), App.api.listDealMetrics()]);
      const metricsById = {}; metrics.forEach((m) => { metricsById[m.deal_id] = m; });
      let list = App.filters.apply(deals);
      if (statusTab === 'active') list = list.filter((d) => d.status === 'ACTIVE');
      else if (statusTab === 'closed') list = list.filter((d) => d.status !== 'ACTIVE');
      list.sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (va === null || va === undefined) va = typeof vb === 'number' ? -Infinity : '';
        if (vb === null || vb === undefined) vb = typeof va === 'number' ? -Infinity : '';
        if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortDir === 'asc' ? va - vb : vb - va;
      });

      const cols = [
        ['deal_name', 'Deal'], ['external_deal_id', 'External Deal ID'], ['investment_type', 'Type'], ['invested_amount', 'Invested'],
        ['annual_roi', 'ROI'], ['payment_frequency', 'Frequency'], ['status', 'Status'], ['maturity_date', 'Maturity'],
      ];
      const thead = `<thead><tr>${cols.map(([k, l]) => `<th data-sort="${k}">${l}${sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('')}<th>Reliability</th><th>Actions</th></tr></thead>`;
      const body = list.map((d) => {
        const m = metricsById[d.id] || {};
        return `<tr>
          <td>${App.utils.escapeHtml(d.deal_name)}</td>
          <td>${App.utils.escapeHtml(d.external_deal_id || '—')}</td>
          <td>${App.utils.escapeHtml(d.investment_type)}</td>
          <td>${App.utils.fmtMoney(d.invested_amount)}</td>
          <td>${App.utils.fmtPct(d.annual_roi)}</td>
          <td>${d.payment_frequency}</td>
          <td><span class="badge ${App.utils.statusBadgeClass(d.status)}">${d.status}</span></td>
          <td>${App.utils.fmtDate(d.maturity_date)}</td>
          <td>${App.utils.fmtPct(m.payout_reliability, 0)}</td>
          <td class="row-actions">
            <button class="icon-btn" data-view="${d.id}" title="View">&#128065;</button>
            <button class="icon-btn" data-edit="${d.id}" title="Edit">&#9998;</button>
            <button class="icon-btn" data-schedule="${d.id}" title="Regenerate schedule">&#128260;</button>
            <button class="icon-btn del" data-delete="${d.id}" title="Delete">&#128465;</button>
          </td>
        </tr>`;
      }).join('');
      const table = App.utils.qs('#dealsTable');
      table.innerHTML = thead + `<tbody>${body || `<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:24px">No deals yet.</td></tr>`}</tbody>`;

      App.utils.qsa('th[data-sort]', table).forEach((th) => th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDir = sortDir === 'asc' ? 'desc' : 'asc'; else { sortKey = k; sortDir = 'asc'; }
        draw();
      }));
      App.utils.qsa('[data-view]', table).forEach((b) => b.addEventListener('click', () => openDealDetail(Number(b.dataset.view))));
      App.utils.qsa('[data-edit]', table).forEach((b) => b.addEventListener('click', () => {
        const deal = deals.find((d) => d.id === Number(b.dataset.edit));
        openDealWizard(deal);
      }));
      App.utils.qsa('[data-schedule]', table).forEach((b) => b.addEventListener('click', async () => {
        try { const n = await App.api.generateSchedule(Number(b.dataset.schedule)); App.utils.toast(`Schedule regenerated (${n} rows)`); draw(); }
        catch (e) { App.utils.toast('Could not generate schedule: ' + (e.message || e), 'err'); }
      }));
      App.utils.qsa('[data-delete]', table).forEach((b) => b.addEventListener('click', () => {
        const deal = deals.find((d) => d.id === Number(b.dataset.delete));
        openDeleteDealModal(deal, () => draw());
      }));
    }

    await draw();
  }

  App.router.register('deals', renderDealsView);
  App.dealsView = { openDealWizard, openDealDetail };
})();
