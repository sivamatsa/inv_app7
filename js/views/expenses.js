/* Expenses & Projects (031_expense_projects.sql) - a generic, reusable
   Project -> Category -> Budget -> Transaction -> Vendor -> Documents
   engine, deliberately NOT a "Home Expenses" tab. Home Construction is
   just the first project a user happens to create; Wedding/Travel/
   Education/etc. are configuration (a project type + starter categories +
   custom fields), not new development.

   One nav item, several internal tabs (same pattern gold.js/admin.js
   already use for a module too big for one flat page) - Dashboard is the
   default landing tab per the spec's own explicit "Dashboard First" rule.
   Recurring BILLS (Rent/EMI/Insurance/Subscription/...) deliberately stay
   in the Recurring Investments module - this module's answer to "recurring
   costs" is Duplicate + a lightweight per-project template, not a second
   schedule-generation engine (see the plan's own resolved scope decision). */
window.App = window.App || {};

(function () {
  const PROJECT_TYPES = [
    { key: 'Home Construction', icon: '🏠' }, { key: 'Wedding', icon: '💍' },
    { key: 'Education', icon: '🎓' }, { key: 'Travel', icon: '✈️' },
    { key: 'International Trip', icon: '🌎' }, { key: 'Vehicle', icon: '🚗' },
    { key: 'Electronics', icon: '💻' }, { key: 'Events', icon: '🎉' },
    { key: 'Medical', icon: '🏥' }, { key: 'Renovation', icon: '🛠️' }, { key: 'Other', icon: '📦' },
  ];
  // Purely a client-side convenience offered on project creation - not a
  // DB table. Picking "Custom" (any type not listed here) just starts with
  // zero categories, which is fine - the whole point of this module is
  // that new project types are configuration, not development.
  const STARTER_CATEGORIES = {
    'Home Construction': ['Civil Work', 'Electrical', 'Plumbing', 'Furniture', 'Painting', 'Other'],
    'Wedding': ['Venue', 'Catering', 'Photography', 'Decor', 'Attire', 'Jewelry', 'Other'],
    'Travel': ['Flights', 'Hotel', 'Food', 'Transport', 'Activities', 'Other'],
    'International Trip': ['Flights', 'Hotel', 'Food', 'Transport', 'Visa', 'Shopping', 'Activities', 'Other'],
    'Vehicle': ['Purchase', 'Insurance', 'Service', 'Fuel', 'Accessories', 'Other'],
    'Education': ['Tuition', 'Books', 'Hostel', 'Transport', 'Other'],
    'Medical': ['Consultation', 'Medicines', 'Tests', 'Hospitalization', 'Other'],
    'Renovation': ['Material', 'Labour', 'Furniture', 'Painting', 'Other'],
    'Events': ['Venue', 'Catering', 'Decor', 'Entertainment', 'Other'],
  };
  const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque', 'Other'];
  const PAYMENT_STATUSES = ['Paid', 'Pending', 'Partially Paid', 'Overdue', 'Cancelled'];
  const CREDIT_TYPES = ['Refund', 'Advance Return', 'Discount', 'Received From Someone', 'Material Return', 'Other'];

  const TABS = [
    { key: 'dashboard', label: 'Dashboard' }, { key: 'projects', label: 'Projects' },
    { key: 'transactions', label: 'Transactions' }, { key: 'budgets', label: 'Budgets' },
    { key: 'vendors', label: 'Vendors' },
  ];

  // Reset per view-entry (not persisted across nav away/back) except
  // currentProjectId, which App.expensesView.openProjectDashboard sets
  // deliberately before navigating here.
  let state = { tab: 'dashboard', currentProjectId: null, txnFilters: emptyTxnFilters() };
  function emptyTxnFilters() {
    return { search: '', dateFrom: null, dateTo: null, categoryId: 'All', type: 'All', paymentMethod: 'All', paymentStatus: 'All', vendorId: 'All', amountMin: null, amountMax: null };
  }

  function projectIcon(type) { return (PROJECT_TYPES.find((t) => t.key === type) || {}).icon || '📁'; }

  function flattenCategories(cats) {
    // Renders as "Parent" for top-level, "Parent > Child" for a
    // sub-category, in a flat list suitable for one <select>.
    const byParent = {};
    cats.forEach((c) => { const k = c.parent_category_id || 'root'; (byParent[k] = byParent[k] || []).push(c); });
    const out = [];
    (byParent.root || []).sort((a, b) => a.sort_order - b.sort_order).forEach((top) => {
      out.push({ id: top.id, label: top.name });
      (byParent[top.id] || []).sort((a, b) => a.sort_order - b.sort_order).forEach((sub) => out.push({ id: sub.id, label: `${top.name} > ${sub.name}` }));
    });
    return out;
  }

  async function renderExpensesView() {
    const pane = App.utils.qs('#pane-expenses');
    pane.innerHTML = `
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Expenses &amp; Projects <div class="line" style="display:inline-block"></div><small>a reusable Project -> Category -> Budget -> Transaction engine</small></span>
        <button class="btn btn-outline btn-sm" id="expensesSuggestImprovementBtn">💡 Suggest Improvement</button>
      </div>
      <div class="chip-row" id="expensesTabRow" style="margin-bottom:16px">${TABS.map((t) => `<div class="chip ${t.key === state.tab ? 'active' : ''}" data-exp-tab="${t.key}">${t.label}</div>`).join('')}</div>
      <div id="expensesTabHost"></div>`;

    App.utils.qs('#expensesSuggestImprovementBtn', pane).addEventListener('click', () => {
      if (App.supportView) App.supportView.openNewSuggestionModal('Existing Feature Improvement', 'Expenses & Projects');
    });

    App.utils.qsa('[data-exp-tab]', pane).forEach((chip) => chip.addEventListener('click', () => {
      state.tab = chip.dataset.expTab;
      App.utils.qsa('[data-exp-tab]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      drawTab();
    }));

    async function drawTab() {
      const host = App.utils.qs('#expensesTabHost', pane);
      if (state.tab === 'dashboard') await drawDashboardTab(host);
      else if (state.tab === 'projects') await drawProjectsTab(host);
      else if (state.tab === 'transactions') await drawTransactionsTab(host);
      else if (state.tab === 'budgets') await drawBudgetsTab(host);
      else if (state.tab === 'vendors') await drawVendorsTab(host);
    }
    await drawTab();
  }

  // ================= Dashboard =================
  async function drawDashboardTab(host) {
    const projects = await App.api.listExpenseProjects();
    if (!projects.length) {
      host.innerHTML = `<div class="panel"><div class="empty-note">No projects yet. Create one in the Projects tab to get started.</div></div>`;
      return;
    }
    if (!state.currentProjectId || !projects.find((p) => p.id === state.currentProjectId)) {
      state.currentProjectId = projects[0].id;
    }

    const summaries = await Promise.all(projects.map((p) => App.api.getExpenseProjectSummary(p.id)));
    host.innerHTML = `
      <div class="chip-row" id="expProjectPicker" style="margin-bottom:14px">${projects.map((p) => `<div class="chip ${p.id === state.currentProjectId ? 'active' : ''}" data-pick-project="${p.id}">${projectIcon(p.project_type)} ${App.utils.escapeHtml(p.name)}</div>`).join('')}</div>
      <div id="expProjectDashboard"></div>
      ${projects.length > 1 ? `<div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Project Comparison</div>
        <div class="table-scroll"><table class="data"><thead><tr><th>Project</th><th>Budget</th><th>Actual</th><th>Remaining</th></tr></thead>
          <tbody>${projects.map((p) => {
            const s = summaries.find((x) => x && x.project_id === p.id) || {};
            return `<tr><td>${projectIcon(p.project_type)} ${App.utils.escapeHtml(p.name)}</td><td>${App.utils.fmtMoney(p.budget_total)}</td><td>${App.utils.fmtMoney(s.net_expense)}</td>
              <td style="color:${(s.budget_remaining || 0) < 0 ? 'var(--red)' : 'inherit'}">${s.budget_remaining != null ? App.utils.fmtMoney(s.budget_remaining) : '—'}</td></tr>`;
          }).join('')}</tbody></table></div>
      </div>` : ''}`;

    App.utils.qsa('[data-pick-project]', host).forEach((chip) => chip.addEventListener('click', () => {
      state.currentProjectId = Number(chip.dataset.pickProject);
      App.utils.qsa('[data-pick-project]', host).forEach((c) => c.classList.toggle('active', c === chip));
      drawProjectDashboard(App.utils.qs('#expProjectDashboard', host), projects.find((p) => p.id === state.currentProjectId));
    }));
    await drawProjectDashboard(App.utils.qs('#expProjectDashboard', host), projects.find((p) => p.id === state.currentProjectId));
  }

  async function drawProjectDashboard(el, project) {
    if (!project) return;
    const [summary, categorySummary, transactions] = await Promise.all([
      App.api.getExpenseProjectSummary(project.id),
      App.api.listExpenseCategorySummary(project.id),
      App.api.listExpenseTransactions({ eq: { project_id: project.id } }),
    ]);
    const s = summary || {};

    el.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi c-red"><div class="kpi-label">Total Debit</div><div class="kpi-value">${App.utils.fmtMoney(s.total_debit)}</div></div>
        <div class="kpi c-teal"><div class="kpi-label">Total Credit</div><div class="kpi-value">${App.utils.fmtMoney(s.total_credit)}</div></div>
        <div class="kpi c-gold"><div class="kpi-label">Net Expense</div><div class="kpi-value">${App.utils.fmtMoney(s.net_expense)}</div></div>
        <div class="kpi c-blue"><div class="kpi-label">Paid</div><div class="kpi-value">${App.utils.fmtMoney(s.total_paid)}</div></div>
        <div class="kpi c-purple"><div class="kpi-label">Pending</div><div class="kpi-value">${App.utils.fmtMoney(s.total_pending)}</div></div>
      </div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">This Month</div><div class="kpi-value">${App.utils.fmtMoney(s.this_month_total)}</div></div>
        <div class="kpi"><div class="kpi-label">This Year</div><div class="kpi-value">${App.utils.fmtMoney(s.this_year_total)}</div></div>
        <div class="kpi"><div class="kpi-label">Budget</div><div class="kpi-value">${App.utils.fmtMoney(project.budget_total)}</div></div>
        <div class="kpi"><div class="kpi-label">Remaining</div><div class="kpi-value" style="color:${(s.budget_remaining || 0) < 0 ? 'var(--red)' : 'inherit'}">${s.budget_remaining != null ? App.utils.fmtMoney(s.budget_remaining) : '—'}</div></div>
      </div>
      <div id="expOverrunBanners"></div>
      <div class="grid-2">
        <div class="chart-card"><div class="chart-header"><div class="chart-title">Category Distribution</div></div><div class="chart-wrap"><canvas id="chExpCategory"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div class="chart-title">Debit vs Credit</div></div><div class="chart-wrap"><canvas id="chExpDebitCredit"></canvas></div></div>
      </div>
      <div class="grid-2">
        <div class="chart-card"><div class="chart-header"><div class="chart-title">Monthly Spending</div></div><div class="chart-wrap"><canvas id="chExpMonthly"></canvas></div></div>
        <div class="chart-card"><div class="chart-header"><div class="chart-title">Budget vs Actual (by category)</div></div><div class="chart-wrap"><canvas id="chExpBudget"></canvas></div></div>
      </div>
      <div class="panel"><div class="chart-title" style="margin-bottom:8px">Expense Analytics</div><div id="expAnalytics"></div></div>`;

    // Overrun banners (client-side mirror of fn_generate_expense_budget_alerts' thresholds)
    const overruns = categorySummary.filter((c) => c.pct_used != null && c.pct_used >= 90);
    App.utils.qs('#expOverrunBanners', el).innerHTML = overruns.map((c) => c.pct_used >= 100
      ? `<div class="hint" style="color:var(--red);margin-bottom:6px">🔴 ${App.utils.escapeHtml(c.name)} budget exceeded by ${App.utils.fmtMoney(c.actual_spent - c.budget_amount)}.</div>`
      : `<div class="hint" style="color:var(--gold);margin-bottom:6px">⚠️ ${App.utils.escapeHtml(c.name)} has reached ${c.pct_used}% of its allocated budget.</div>`
    ).join('');

    const topLevelCats = categorySummary.filter((c) => !c.parent_category_id);
    App.charts.doughnut('chExpCategory', topLevelCats.map((c) => c.name), topLevelCats.map((c) => c.actual_spent));

    App.charts.bar('chExpDebitCredit', ['Debit', 'Credit'], [{ label: '₹', data: [s.total_debit || 0, s.total_credit || 0] }], { plugins: { legend: { display: false } } });

    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
    const monthLabels = months.map((m) => m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
    const monthlyData = months.map((m) => transactions.filter((t) => t.transaction_type === 'Debit' && new Date(t.transaction_date).getFullYear() === m.getFullYear() && new Date(t.transaction_date).getMonth() === m.getMonth()).reduce((a, t) => a + t.amount, 0));
    App.charts.bar('chExpMonthly', monthLabels, [{ label: 'Spent', data: monthlyData }], { plugins: { legend: { display: false } } });

    App.charts.bar('chExpBudget', topLevelCats.map((c) => c.name),
      [{ label: 'Budget', data: topLevelCats.map((c) => c.budget_amount || 0) }, { label: 'Actual', data: topLevelCats.map((c) => c.actual_spent) }]);

    const debits = transactions.filter((t) => t.transaction_type === 'Debit');
    const days = project.start_date ? Math.max(1, App.utils.daysBetween(project.start_date, App.utils.todayISO())) : 1;
    const avgDaily = debits.reduce((a, t) => a + t.amount, 0) / days;
    const monthsActive = Math.max(1, monthlyData.filter((v) => v > 0).length);
    const avgMonthly = monthlyData.reduce((a, v) => a + v, 0) / monthsActive;
    const highest = debits.reduce((max, t) => (t.amount > (max ? max.amount : 0) ? t : max), null);
    const largestCat = topLevelCats.reduce((max, c) => (c.actual_spent > (max ? max.actual_spent : 0) ? c : max), null);
    const cashTotal = debits.filter((t) => t.payment_method === 'Cash').reduce((a, t) => a + t.amount, 0);
    const digitalTotal = debits.filter((t) => t.payment_method && t.payment_method !== 'Cash').reduce((a, t) => a + t.amount, 0);
    App.utils.qs('#expAnalytics', el).innerHTML = `
      <div class="grid-3">
        <div class="stat-line"><span>Average Daily Expense</span><span class="v">${App.utils.fmtMoney(avgDaily)}</span></div>
        <div class="stat-line"><span>Average Monthly Expense</span><span class="v">${App.utils.fmtMoney(avgMonthly)}</span></div>
        <div class="stat-line"><span>Highest Expense</span><span class="v">${highest ? App.utils.fmtMoney(highest.amount) + ' (' + App.utils.escapeHtml(highest.item) + ')' : '—'}</span></div>
        <div class="stat-line"><span>Largest Category</span><span class="v">${largestCat ? App.utils.escapeHtml(largestCat.name) : '—'}</span></div>
        <div class="stat-line"><span>Cash Spending</span><span class="v">${App.utils.fmtMoney(cashTotal)}</span></div>
        <div class="stat-line"><span>Digital Spending</span><span class="v">${App.utils.fmtMoney(digitalTotal)}</span></div>
      </div>`;
  }

  // ================= Projects =================
  function openProjectWizard(existing, onDone) {
    const fields = [
      { key: 'name', label: 'Project Name', required: true, span: 2 },
      { key: 'project_type', label: 'Type', type: 'select', options: PROJECT_TYPES.map((t) => t.key), required: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Completed', 'On Hold', 'Cancelled'] },
      { key: 'start_date', label: 'Start Date', type: 'date' },
      { key: 'end_date', label: 'End Date', type: 'date' },
      { key: 'budget_total', label: 'Total Budget', type: 'number' },
      { key: 'currency', label: 'Currency', placeholder: 'INR' },
      { key: 'description', label: 'Description', type: 'textarea', span: 2 },
    ];
    const values = Object.assign({ project_type: 'Other', status: 'Active', currency: 'INR' }, existing || {});
    App.ui.open({
      title: existing ? 'Edit Project' : 'New Project',
      bodyHtml: `<div id="projectFormHost"></div>
        ${!existing ? `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-top:10px;cursor:pointer"><input type="checkbox" id="seedStarterCats" checked> Add starter categories for this project type</label>` : ''}
        <div class="auth-error" id="projectFormError"></div>`,
      onMount: (body) => { App.utils.qs('#projectFormHost', body).innerHTML = App.ui.renderForm(fields, values); },
      actions: [
        { label: existing ? 'Save Changes' : 'Create Project', className: 'btn-gold', onClick: async () => {
          const { values: v, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#projectFormError').textContent = 'Name and type are required.'; return; }
          try {
            if (existing) { await App.api.updateExpenseProject(existing.id, v); App.utils.toast('Project updated'); }
            else {
              const project = await App.api.createExpenseProject(v);
              const seedCheckbox = App.utils.qs('#seedStarterCats');
              if (seedCheckbox && seedCheckbox.checked && STARTER_CATEGORIES[v.project_type]) {
                await Promise.all(STARTER_CATEGORIES[v.project_type].map((name, i) => App.api.createExpenseCategory({ project_id: project.id, name, sort_order: i })));
              }
              state.currentProjectId = project.id;
              App.utils.toast('Project created');
            }
            App.ui.close();
            if (onDone) onDone();
          } catch (e) { App.utils.qs('#projectFormError').textContent = 'Could not save: ' + (e.message || e); }
        } },
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });
  }

  async function drawProjectsTab(host) {
    host.innerHTML = `<div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="chart-title">My Projects</div>
        <button class="btn btn-gold btn-sm" id="newProjectBtn">+ New Project</button>
      </div>
      <div id="projectsList" class="card-row" style="flex-wrap:wrap"></div>
    </div>`;
    App.utils.qs('#newProjectBtn', host).addEventListener('click', () => openProjectWizard(null, () => drawProjectsTab(host)));

    async function draw() {
      const projects = await App.api.listExpenseProjects();
      const summaries = await Promise.all(projects.map((p) => App.api.getExpenseProjectSummary(p.id)));
      App.utils.qs('#projectsList', host).innerHTML = projects.map((p) => {
        const s = summaries.find((x) => x && x.project_id === p.id) || {};
        return `<div class="integration-card" style="min-width:260px;max-width:320px">
          <div class="name">${projectIcon(p.project_type)} ${App.utils.escapeHtml(p.name)}</div>
          <div class="hint" style="margin:4px 0">${App.utils.escapeHtml(p.project_type)} &middot; <span class="badge ${p.status === 'Active' ? 'st-active' : 'st-cancelled'}">${p.status}</span></div>
          <div class="stat-line" style="margin-top:6px"><span>Spent</span><span class="v">${App.utils.fmtMoney(s.net_expense)}</span></div>
          <div class="stat-line"><span>Budget</span><span class="v">${App.utils.fmtMoney(p.budget_total)}</span></div>
          <div style="display:flex;gap:6px;margin-top:10px">
            <button class="btn btn-outline btn-sm" data-open-project="${p.id}">Open</button>
            <button class="btn btn-outline btn-sm" data-edit-project="${p.id}">Edit</button>
            <button class="icon-btn del" data-del-project="${p.id}">&#128465;</button>
          </div>
        </div>`;
      }).join('') || '<div class="empty-note">No projects yet.</div>';

      App.utils.qsa('[data-open-project]', host).forEach((b) => b.addEventListener('click', () => {
        state.currentProjectId = Number(b.dataset.openProject); state.tab = 'dashboard';
        App.utils.qsa('[data-exp-tab]').forEach((c) => c.classList.toggle('active', c.dataset.expTab === 'dashboard'));
        drawDashboardTab(App.utils.qs('#expensesTabHost'));
      }));
      App.utils.qsa('[data-edit-project]', host).forEach((b) => b.addEventListener('click', () => {
        const project = projects.find((p) => p.id === Number(b.dataset.editProject));
        openProjectWizard(project, draw);
      }));
      App.utils.qsa('[data-del-project]', host).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this project and every transaction/category in it? This cannot be undone.')) return;
        try { await App.api.deleteExpenseProject(Number(b.dataset.delProject)); App.utils.toast('Project deleted'); draw(); }
        catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
      }));
    }
    await draw();
  }

  // ================= Transactions =================
  function openTransactionForm(existing, project, categories, vendors, customFields, existingValues, onDone, advances) {
    const catOptions = flattenCategories(categories);
    const vendorById = {}; vendors.forEach((v) => { vendorById[v.id] = v; });
    const fields = [
      { key: 'transaction_date', label: 'Date', type: 'date', required: true },
      { key: 'item', label: 'Item', required: true },
      { key: 'category_id', label: 'Category', type: 'select', numeric: true, options: catOptions.map((c) => ({ value: c.id, label: c.label })) },
      { key: 'amount', label: 'Amount', type: 'number', required: true },
      { key: 'transaction_type', label: 'Debit / Credit', type: 'select', options: ['Debit', 'Credit'], required: true },
      { key: 'credit_type', label: 'Credit Reason (if Credit)', type: 'select', options: CREDIT_TYPES },
      { key: 'payment_method', label: 'Payment Method', type: 'select', options: PAYMENT_METHODS },
      { key: 'account_source', label: 'Account / Source', placeholder: 'e.g. HDFC Savings' },
      { key: 'vendor_id', label: 'Vendor / Payee', type: 'select', numeric: true, options: vendors.map((v) => ({ value: v.id, label: v.name })) },
      ...((advances && advances.length) ? [{ key: 'advance_id', label: 'Apply to Advance (optional)', type: 'select', numeric: true, options: advances.map((a) => ({ value: a.id, label: `${(vendorById[a.vendor_id] || {}).name || 'Vendor'} - ${App.utils.fmtDate(a.date_paid)} - ${App.utils.fmtMoney(a.amount_paid)} paid` })) }] : []),
      { key: 'invoice_number', label: 'Invoice / Receipt No.' },
      { key: 'payment_status', label: 'Payment Status', type: 'select', options: PAYMENT_STATUSES },
      { key: 'amount_paid', label: 'Amount Paid So Far (if Partial)', type: 'number' },
      { key: 'due_date', label: 'Due Date (if Pending)', type: 'date' },
      { key: 'description', label: 'Description', type: 'textarea', span: 2 },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ];
    const values = Object.assign({ transaction_date: App.utils.todayISO(), transaction_type: 'Debit', payment_status: 'Paid' }, existing || {});
    const showForeignFields = !!(existing && existing.foreign_currency);

    App.ui.open({
      title: existing ? 'Edit Transaction' : 'Add Expense',
      bodyHtml: `<div id="txnFormHost"></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin:10px 0;cursor:pointer"><input type="checkbox" id="foreignToggle" ${showForeignFields ? 'checked' : ''}> This was paid in a foreign currency</label>
        <div id="foreignFieldsHost" style="display:${showForeignFields ? 'block' : 'none'}"></div>
        <div id="customFieldsHost" style="margin-top:10px"></div>
        ${existing ? '<div id="attachmentsHost" style="margin-top:10px"></div>' : ''}
        <div class="auth-error" id="txnFormError"></div>`,
      onMount: (body) => {
        App.utils.qs('#txnFormHost', body).innerHTML = App.ui.renderForm(fields, values);
        if (existing) drawAttachments(body, existing.id, project.id);
        const foreignFields = [
          { key: 'foreign_currency', label: 'Foreign Currency', placeholder: 'e.g. SGD, USD' },
          { key: 'foreign_amount', label: 'Foreign Amount', type: 'number' },
          { key: 'exchange_rate', label: 'Exchange Rate (to INR)', type: 'number' },
        ];
        App.utils.qs('#foreignFieldsHost', body).innerHTML = App.ui.renderForm(foreignFields, values);
        App.utils.qs('#foreignToggle', body).addEventListener('change', (e) => { App.utils.qs('#foreignFieldsHost', body).style.display = e.target.checked ? 'block' : 'none'; });
        // Auto-compute base amount from foreign amount x rate, editable after.
        ['fld_foreign_amount', 'fld_exchange_rate'].forEach((id) => {
          const el = App.utils.qs('#' + id, body);
          if (el) el.addEventListener('change', () => {
            const fa = App.utils.parseNum(App.utils.qs('#fld_foreign_amount', body).value);
            const rate = App.utils.parseNum(App.utils.qs('#fld_exchange_rate', body).value);
            if (fa && rate) App.utils.qs('#fld_amount', body).value = Math.round(fa * rate * 100) / 100;
          });
        });
        if (customFields.length) {
          const cfFields = customFields.map((f) => ({ key: 'cf_' + f.id, label: f.field_name, type: f.field_type === 'select' ? 'select' : (f.field_type === 'number' ? 'number' : (f.field_type === 'date' ? 'date' : 'text')), options: f.field_options || [] }));
          const cfValues = {};
          customFields.forEach((f) => { const existingVal = (existingValues || []).find((v) => v.custom_field_id === f.id); if (existingVal) cfValues['cf_' + f.id] = existingVal.value; });
          App.utils.qs('#customFieldsHost', body).innerHTML = `<div class="hint" style="margin-bottom:6px">${App.utils.escapeHtml(project.name)} custom fields</div>` + App.ui.renderForm(cfFields, cfValues);
        }
      },
      actions: [
        { label: existing ? 'Save Changes' : 'Save', className: 'btn-gold', onClick: () => submitTxn(false) },
        ...(!existing ? [{ label: 'Save & Add Another', className: 'btn-outline', onClick: () => submitTxn(true) }] : []),
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });

    async function drawAttachments(body, txnId, projectId) {
      const host = App.utils.qs('#attachmentsHost', body);
      async function draw() {
        const docs = await App.api.listDocuments({ eq: { expense_transaction_id: txnId } });
        host.innerHTML = `<div class="hint" style="margin-bottom:6px">Bills & Receipts</div>
          ${docs.map((d) => `<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:4px">
            <span>📎 ${App.utils.escapeHtml(d.file_name)}</span>
            <a href="#" data-att-view="${d.id}" data-path="${App.utils.escapeHtml(d.storage_path)}">View</a>
            <a href="#" data-att-del="${d.id}" data-path="${App.utils.escapeHtml(d.storage_path)}" style="color:var(--danger,#e55)">Remove</a>
          </div>`).join('') || '<div class="hint">No attachments yet.</div>'}
          <input type="file" id="attFileInput" style="margin-top:6px;font-size:12px">`;
        App.utils.qsa('[data-att-view]', host).forEach((a) => a.addEventListener('click', async (e) => {
          e.preventDefault();
          try { const url = await App.api.getDocumentUrl(a.dataset.path); window.open(url, '_blank'); }
          catch (err) { App.utils.toast('Could not open: ' + (err.message || err), 'err'); }
        }));
        App.utils.qsa('[data-att-del]', host).forEach((a) => a.addEventListener('click', async (e) => {
          e.preventDefault();
          if (!confirm('Remove this attachment?')) return;
          try { await App.api.deleteDocument(Number(a.dataset.attDel), a.dataset.path); draw(); }
          catch (err) { App.utils.toast('Could not remove: ' + (err.message || err), 'err'); }
        }));
        App.utils.qs('#attFileInput', host).addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try { await App.api.uploadExpenseAttachment(file, { transactionId: txnId, projectId }); App.utils.toast('Attachment uploaded'); draw(); }
          catch (err) { App.utils.toast('Upload failed: ' + (err.message || err), 'err'); }
        });
      }
      await draw();
    }

    async function submitTxn(addAnother) {
      const { values: v, errors } = App.ui.readForm(fields);
      if (errors.length) { App.utils.qs('#txnFormError').textContent = 'Date, item, and amount are required.'; return; }
      const foreignOn = App.utils.qs('#foreignToggle').checked;
      const foreignFields = [{ key: 'foreign_currency' }, { key: 'foreign_amount', type: 'number' }, { key: 'exchange_rate', type: 'number' }];
      const { values: fv } = App.ui.readForm(foreignFields);
      const payload = Object.assign({}, v, { project_id: project.id }, foreignOn ? Object.assign({ currency: fv.foreign_currency || 'INR' }, fv) : { foreign_currency: null, foreign_amount: null, exchange_rate: null, currency: 'INR' });
      try {
        let txnId;
        if (existing) { await App.api.updateExpenseTransaction(existing.id, payload); txnId = existing.id; App.utils.toast('Transaction updated'); }
        else { const created = await App.api.createExpenseTransaction(payload); txnId = created.id; App.utils.toast('Expense saved'); }
        if (customFields.length) {
          const cfFields = customFields.map((f) => ({ key: 'cf_' + f.id }));
          const { values: cfv } = App.ui.readForm(cfFields);
          await Promise.all(customFields.map((f) => cfv['cf_' + f.id] != null ? App.api.upsertExpenseCustomValue(txnId, f.id, String(cfv['cf_' + f.id])) : Promise.resolve()));
        }
        if (addAnother) { App.ui.close(); openTransactionForm(null, project, categories, vendors, customFields, [], onDone, advances); }
        else { App.ui.close(); if (onDone) onDone(); }
      } catch (e) { App.utils.qs('#txnFormError').textContent = 'Could not save: ' + (e.message || e); }
    }
  }

  async function drawTransactionsTab(host) {
    const projects = await App.api.listExpenseProjects();
    if (!projects.length) { host.innerHTML = '<div class="panel"><div class="empty-note">Create a project first.</div></div>'; return; }
    if (!state.currentProjectId || !projects.find((p) => p.id === state.currentProjectId)) state.currentProjectId = projects[0].id;

    host.innerHTML = `
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:10px">
          <select id="txnProjectSelect" class="search-input">${projects.map((p) => `<option value="${p.id}" ${p.id === state.currentProjectId ? 'selected' : ''}>${projectIcon(p.project_type)} ${App.utils.escapeHtml(p.name)}</option>`).join('')}</select>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" id="exportProjectBtn">&#8595; Export This Project</button>
            <button class="btn btn-gold btn-sm" id="addTxnBtn">+ Add Expense</button>
          </div>
        </div>
        <input class="search-input" id="txnSearch" placeholder="Search item / description / vendor / invoice / category / amount..." style="width:100%;margin-bottom:10px">
        <div class="chip-row" id="txnFilterRow" style="margin-bottom:10px"></div>
        <div class="table-scroll"><table class="data" id="txnTable"></table></div>
      </div>`;

    App.utils.qs('#txnProjectSelect', host).addEventListener('change', (e) => { state.currentProjectId = Number(e.target.value); state.txnFilters = emptyTxnFilters(); drawTransactionsTab(host); });
    App.utils.qs('#txnSearch', host).addEventListener('input', App.utils.debounce((e) => { state.txnFilters.search = e.target.value.toLowerCase(); draw(); }, 250));
    App.utils.qs('#exportProjectBtn', host).addEventListener('click', async () => {
      try {
        const rows = await App.api.listExpenseTransactions({ eq: { project_id: state.currentProjectId } });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Transactions');
        XLSX.writeFile(wb, `expense_transactions_project_${state.currentProjectId}.xlsx`);
      } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
    });

    let categories = [], vendors = [], customFields = [], advances = [];

    async function draw() {
      const project = projects.find((p) => p.id === state.currentProjectId);
      [categories, vendors, customFields, advances] = await Promise.all([
        App.api.listExpenseCategories(project.id), App.api.listExpenseVendors(), App.api.listExpenseCustomFields(project.id),
        App.api.listExpenseAdvances({ eq: { project_id: project.id } }),
      ]);
      const catOptions = flattenCategories(categories);
      const catById = {}; categories.forEach((c) => { catById[c.id] = c; });
      const vendorById = {}; vendors.forEach((v) => { vendorById[v.id] = v; });

      App.utils.qs('#txnFilterRow', host).innerHTML = `
        <select id="fType" class="search-input"><option value="All">All Types</option><option>Debit</option><option>Credit</option></select>
        <select id="fCategory" class="search-input"><option value="All">All Categories</option>${catOptions.map((c) => `<option value="${c.id}">${App.utils.escapeHtml(c.label)}</option>`).join('')}</select>
        <select id="fStatus" class="search-input"><option value="All">All Statuses</option>${PAYMENT_STATUSES.map((s) => `<option>${s}</option>`).join('')}</select>
        <select id="fMethod" class="search-input"><option value="All">All Methods</option>${PAYMENT_METHODS.map((m) => `<option>${m}</option>`).join('')}</select>
        <select id="fVendor" class="search-input"><option value="All">All Vendors</option>${vendors.map((v) => `<option value="${v.id}">${App.utils.escapeHtml(v.name)}</option>`).join('')}</select>
        <input id="fDateFrom" type="date" class="date-mini"><input id="fDateTo" type="date" class="date-mini">`;
      ['fType', 'fCategory', 'fStatus', 'fMethod', 'fVendor', 'fDateFrom', 'fDateTo'].forEach((id) => {
        const el = App.utils.qs('#' + id, host);
        const map = { fType: 'type', fCategory: 'categoryId', fStatus: 'paymentStatus', fMethod: 'paymentMethod', fVendor: 'vendorId', fDateFrom: 'dateFrom', fDateTo: 'dateTo' };
        el.value = state.txnFilters[map[id]] || (id.startsWith('fDate') ? '' : 'All');
        el.addEventListener('change', (e) => { state.txnFilters[map[id]] = e.target.value; drawRows(); });
      });

      let txns = await App.api.listExpenseTransactions({ eq: { project_id: project.id } });
      function drawRows() {
        const f = state.txnFilters;
        let filtered = txns.filter((t) => {
          if (f.type !== 'All' && t.transaction_type !== f.type) return false;
          if (f.categoryId !== 'All' && t.category_id !== Number(f.categoryId)) return false;
          if (f.paymentStatus !== 'All' && t.payment_status !== f.paymentStatus) return false;
          if (f.paymentMethod !== 'All' && t.payment_method !== f.paymentMethod) return false;
          if (f.vendorId !== 'All' && t.vendor_id !== Number(f.vendorId)) return false;
          if (f.dateFrom && t.transaction_date < f.dateFrom) return false;
          if (f.dateTo && t.transaction_date > f.dateTo) return false;
          if (f.search) {
            const vendor = vendorById[t.vendor_id];
            const hay = [t.item, t.description, vendor && vendor.name, t.invoice_number, (catById[t.category_id] || {}).name, String(t.amount), t.transaction_date].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(f.search)) return false;
          }
          return true;
        });
        App.utils.qs('#txnTable', host).innerHTML = `<thead><tr><th>Date</th><th>Item</th><th>Category</th><th>Amount</th><th>Type</th><th>Vendor</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${filtered.map((t) => `<tr>
            <td>${App.utils.fmtDate(t.transaction_date)}</td>
            <td>${App.utils.escapeHtml(t.item)}${t.foreign_currency ? ` <span class="hint" style="margin:0">(${App.utils.fmtNum(t.foreign_amount, 2)} ${App.utils.escapeHtml(t.foreign_currency)})</span>` : ''}</td>
            <td>${App.utils.escapeHtml((catById[t.category_id] || {}).name || '—')}</td>
            <td style="color:${t.transaction_type === 'Credit' ? 'var(--teal)' : 'inherit'}">${t.transaction_type === 'Credit' ? '+' : ''}${App.utils.fmtMoney(t.amount)}${t.payment_status === 'Partially Paid' ? `<div class="hint" style="margin:0">Paid ${App.utils.fmtMoney(t.amount_paid)} &middot; Pending ${App.utils.fmtMoney(t.amount - (t.amount_paid || 0))}</div>` : ''}</td>
            <td>${t.transaction_type}${t.credit_type ? ' (' + App.utils.escapeHtml(t.credit_type) + ')' : ''}</td>
            <td>${App.utils.escapeHtml((vendorById[t.vendor_id] || {}).name || '—')}</td>
            <td><span class="badge ${App.utils.statusBadgeClass(t.payment_status)}">${t.payment_status}</span></td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-outline" data-edit-txn="${t.id}">Edit</button>
              <button class="btn btn-sm btn-outline" data-dup-txn="${t.id}">Duplicate</button>
              <button class="icon-btn del" data-del-txn="${t.id}">&#128465;</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:20px">No transactions match.</td></tr>'}</tbody>`;

        App.utils.qsa('[data-edit-txn]', host).forEach((b) => b.addEventListener('click', async () => {
          const t = txns.find((x) => x.id === Number(b.dataset.editTxn));
          const existingValues = await App.api.listExpenseCustomValues(t.id);
          openTransactionForm(t, project, categories, vendors, customFields, existingValues, () => draw(), advances);
        }));
        App.utils.qsa('[data-dup-txn]', host).forEach((b) => b.addEventListener('click', () => {
          const t = txns.find((x) => x.id === Number(b.dataset.dupTxn));
          const clone = Object.assign({}, t, { id: undefined, transaction_date: App.utils.todayISO(), invoice_number: null });
          openTransactionForm(null, project, categories, vendors, customFields, [], () => draw(), advances);
          // Pre-fill after the modal mounts (openTransactionForm's onMount already ran renderForm with `existing`=null here on purpose - Duplicate re-opens as a NEW entry pre-filled via the clone, not editing the original).
          setTimeout(() => {
            Object.entries(clone).forEach(([k, v]) => { const el = App.utils.qs('#fld_' + k); if (el && v != null) el.value = v; });
            // The foreign-currency fields live in a section that's hidden
            // until #foreignToggle is checked - without this, a duplicated
            // foreign-currency transaction would silently drop its
            // currency/rate on save (submitTxn only reads those fields
            // when the toggle itself is checked).
            if (clone.foreign_currency) {
              const toggle = App.utils.qs('#foreignToggle');
              toggle.checked = true;
              toggle.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, 30);
        }));
        App.utils.qsa('[data-del-txn]', host).forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Delete this transaction?')) return;
          try { await App.api.deleteExpenseTransaction(Number(b.dataset.delTxn)); App.utils.toast('Deleted'); draw(); }
          catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
        }));
      }
      drawRows();

      App.utils.qs('#addTxnBtn', host).onclick = () => openTransactionForm(null, project, categories, vendors, customFields, [], () => draw(), advances);
    }
    await draw();
  }

  // ================= Budgets =================
  async function drawBudgetsTab(host) {
    const projects = await App.api.listExpenseProjects();
    if (!projects.length) { host.innerHTML = '<div class="panel"><div class="empty-note">Create a project first.</div></div>'; return; }
    if (!state.currentProjectId || !projects.find((p) => p.id === state.currentProjectId)) state.currentProjectId = projects[0].id;

    host.innerHTML = `<div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <select id="budgetProjectSelect" class="search-input">${projects.map((p) => `<option value="${p.id}" ${p.id === state.currentProjectId ? 'selected' : ''}>${projectIcon(p.project_type)} ${App.utils.escapeHtml(p.name)}</option>`).join('')}</select>
        <button class="btn btn-outline btn-sm" id="addCategoryBtn">+ Add Category</button>
      </div>
      <div class="table-scroll"><table class="data" id="budgetTable"></table></div>
    </div>`;
    App.utils.qs('#budgetProjectSelect', host).addEventListener('change', (e) => { state.currentProjectId = Number(e.target.value); drawBudgetsTab(host); });
    App.utils.qs('#addCategoryBtn', host).addEventListener('click', async () => {
      const name = prompt('Category name:');
      if (!name) return;
      try { await App.api.createExpenseCategory({ project_id: state.currentProjectId, name }); draw(); }
      catch (e) { App.utils.toast('Could not add: ' + (e.message || e), 'err'); }
    });

    async function draw() {
      const summary = await App.api.listExpenseCategorySummary(state.currentProjectId);
      const topLevel = summary.filter((c) => !c.parent_category_id);
      const totalBudget = topLevel.reduce((a, c) => a + (c.budget_amount || 0), 0);
      const totalActual = topLevel.reduce((a, c) => a + c.actual_spent, 0);
      App.utils.qs('#budgetTable', host).innerHTML = `<thead><tr><th>Category</th><th>Budgeted</th><th>Actual</th><th>Remaining</th><th>%</th><th></th></tr></thead>
        <tbody>${topLevel.map((c) => `<tr ${c.pct_used >= 100 ? 'style="color:var(--red)"' : ''}>
          <td>${App.utils.escapeHtml(c.name)}</td>
          <td><input type="number" class="search-input" style="width:110px" data-budget-cat="${c.category_id}" value="${c.budget_amount ?? ''}"></td>
          <td>${App.utils.fmtMoney(c.actual_spent)}</td>
          <td>${c.remaining != null ? App.utils.fmtMoney(c.remaining) : '—'}</td>
          <td>${c.pct_used != null ? c.pct_used + '%' : '—'}</td>
          <td><button class="icon-btn del" data-del-cat="${c.category_id}">&#128465;</button></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No categories yet.</td></tr>'}
        ${topLevel.length ? `<tr style="font-weight:700;border-top:2px solid var(--border2)"><td>Total</td><td>${App.utils.fmtMoney(totalBudget)}</td><td>${App.utils.fmtMoney(totalActual)}</td><td>${App.utils.fmtMoney(totalBudget - totalActual)}</td><td></td><td></td></tr>` : ''}
        </tbody>`;
      App.utils.qsa('[data-budget-cat]', host).forEach((input) => input.addEventListener('change', async (e) => {
        try { await App.api.updateExpenseCategory(Number(e.target.dataset.budgetCat), { budget_amount: App.utils.parseNum(e.target.value) }); draw(); }
        catch (err) { App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
      }));
      App.utils.qsa('[data-del-cat]', host).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this category? Its transactions keep their history but lose the category link.')) return;
        try { await App.api.deleteExpenseCategory(Number(b.dataset.delCat)); draw(); }
        catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
      }));
    }
    await draw();
  }

  // ================= Vendors =================
  async function openVendorDetail(vendor, onDone) {
    const [summary, advances] = await Promise.all([
      App.api.listExpenseVendorSummary({ eq: { vendor_id: vendor.id } }).then((r) => r[0] || {}),
      App.api.listExpenseAdvances({ eq: { vendor_id: vendor.id } }),
    ]);
    const advancesWithRemaining = await Promise.all(advances.map(async (a) => {
      const txns = await App.api.listExpenseTransactions({ eq: { advance_id: a.id } });
      // "Adjusted" is the full value of expenses drawn against this
      // advance, not each transaction's own separate amount_paid tracking
      // - those are two different concerns (how much of the advance has
      // been used up, vs. how much of one specific expense has been
      // settled) that happen to both exist on the same transaction.
      const adjusted = txns.reduce((sum, t) => sum + (t.amount || 0), 0);
      return Object.assign({}, a, { adjusted, remaining: a.amount_paid - adjusted });
    }));
    App.ui.open({
      title: vendor.name,
      bodyHtml: `
        <div class="grid-2" style="margin-bottom:14px">
          <div class="stat-line"><span>Total Paid</span><span class="v">${App.utils.fmtMoney(summary.total_paid)}</span></div>
          <div class="stat-line"><span>Transactions</span><span class="v">${summary.transaction_count || 0}</span></div>
          <div class="stat-line"><span>Pending</span><span class="v">${App.utils.fmtMoney(summary.pending_amount)}</span></div>
          <div class="stat-line"><span>Phone</span><span class="v">${App.utils.escapeHtml(vendor.phone || '—')}</span></div>
        </div>
        <div class="chart-title" style="font-size:13px;margin-bottom:6px">Advances</div>
        <div id="advancesList">${advancesWithRemaining.map((a) => `
          <div class="stat-line"><span>${App.utils.fmtDate(a.date_paid)} - Paid ${App.utils.fmtMoney(a.amount_paid)}</span><span class="v">Remaining ${App.utils.fmtMoney(a.remaining)}</span></div>
        `).join('') || '<div class="empty-note">No advances recorded.</div>'}</div>
        <div class="modal-actions" style="justify-content:flex-start;margin-top:10px"><button class="btn btn-outline btn-sm" id="addAdvanceBtn">+ Record Advance</button></div>`,
      actions: [{ label: 'Close', className: 'btn-gold', onClick: App.ui.close }],
      onMount: (body) => {
        App.utils.qs('#addAdvanceBtn', body).addEventListener('click', async () => {
          const projects = await App.api.listExpenseProjects();
          const projectId = projects[0] && projects[0].id;
          const amount = App.utils.parseNum(prompt('Advance amount:'));
          if (!amount || !projectId) return;
          try { await App.api.createExpenseAdvance({ project_id: projectId, vendor_id: vendor.id, amount_paid: amount }); App.ui.close(); openVendorDetail(vendor, onDone); }
          catch (e) { App.utils.toast('Could not record advance: ' + (e.message || e), 'err'); }
        });
      },
    });
  }

  async function openVendorForm(existing, onDone) {
    const contacts = await App.api.listContacts().catch(() => []);
    const fields = [
      { key: 'name', label: 'Vendor / Payee Name', required: true, span: 2 },
      { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
      { key: 'category', label: 'Category', placeholder: 'e.g. Electrical' },
      { key: 'gst_number', label: 'GST Number' },
      { key: 'bank_upi_reference', label: 'Bank / UPI Reference' },
      { key: 'linked_contact_id', label: 'Link to an Existing Contact (optional)', type: 'select', numeric: true, options: contacts.map((c) => ({ value: c.id, label: c.display_name || c.full_name || c.email })) },
      { key: 'address', label: 'Address', span: 2 },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ];
    App.ui.open({
      title: existing ? 'Edit Vendor' : 'Add Vendor',
      bodyHtml: `<div id="vendorFormHost"></div><div class="auth-error" id="vendorFormError"></div>`,
      onMount: (body) => { App.utils.qs('#vendorFormHost', body).innerHTML = App.ui.renderForm(fields, existing || {}); },
      actions: [
        { label: existing ? 'Save Changes' : 'Add Vendor', className: 'btn-gold', onClick: async () => {
          const { values: v, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#vendorFormError').textContent = 'Name is required.'; return; }
          try {
            if (existing) await App.api.updateExpenseVendor(existing.id, v); else await App.api.createExpenseVendor(v);
            App.utils.toast('Vendor saved'); App.ui.close(); if (onDone) onDone();
          } catch (e) { App.utils.qs('#vendorFormError').textContent = 'Could not save: ' + (e.message || e); }
        } },
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });
  }

  async function drawVendorsTab(host) {
    host.innerHTML = `<div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="chart-title">Vendors</div>
        <button class="btn btn-gold btn-sm" id="addVendorBtn">+ Add Vendor</button>
      </div>
      <div class="table-scroll"><table class="data" id="vendorsTable"></table></div>
    </div>`;
    App.utils.qs('#addVendorBtn', host).addEventListener('click', () => openVendorForm(null, draw));

    async function draw() {
      const [vendors, summary] = await Promise.all([App.api.listExpenseVendors(), App.api.listExpenseVendorSummary()]);
      const summaryById = {}; summary.forEach((s) => { summaryById[s.vendor_id] = s; });
      App.utils.qs('#vendorsTable', host).innerHTML = `<thead><tr><th>Name</th><th>Category</th><th>Total Paid</th><th>Transactions</th><th>Pending</th><th>Actions</th></tr></thead>
        <tbody>${vendors.map((v) => {
          const s = summaryById[v.id] || {};
          return `<tr>
            <td>${App.utils.escapeHtml(v.name)}</td><td>${App.utils.escapeHtml(v.category || '—')}</td>
            <td>${App.utils.fmtMoney(s.total_paid)}</td><td>${s.transaction_count || 0}</td><td>${App.utils.fmtMoney(s.pending_amount)}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-outline" data-view-vendor="${v.id}">View</button>
              <button class="btn btn-sm btn-outline" data-edit-vendor="${v.id}">Edit</button>
              <button class="icon-btn del" data-del-vendor="${v.id}">&#128465;</button>
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No vendors yet.</td></tr>'}</tbody>`;

      App.utils.qsa('[data-view-vendor]', host).forEach((b) => b.addEventListener('click', () => openVendorDetail(vendors.find((v) => v.id === Number(b.dataset.viewVendor)), draw)));
      App.utils.qsa('[data-edit-vendor]', host).forEach((b) => b.addEventListener('click', () => openVendorForm(vendors.find((v) => v.id === Number(b.dataset.editVendor)), draw)));
      App.utils.qsa('[data-del-vendor]', host).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this vendor?')) return;
        try { await App.api.deleteExpenseVendor(Number(b.dataset.delVendor)); draw(); }
        catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
      }));
    }
    await draw();
  }

  App.expensesView = {
    openProjectDashboard(projectId) {
      state.currentProjectId = projectId; state.tab = 'dashboard';
      App.router.navigate('expenses');
    },
  };
  App.router.register('expenses', renderExpensesView);
})();
