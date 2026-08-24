/* Portfolio Goals (spec Section 32). */
window.App = window.App || {};

(function () {
  const FIELDS = [
    { key: 'label', label: 'Label', required: true, placeholder: 'e.g. 2026 Goals' },
    { key: 'target_annual_income', label: 'Target Annual Income', type: 'number' },
    { key: 'target_portfolio_size', label: 'Target Portfolio Size', type: 'number' },
    { key: 'target_monthly_passive_income', label: 'Target Monthly Passive Income', type: 'number' },
    { key: 'target_roi', label: 'Target ROI %', type: 'number' },
    { key: 'target_reinvestment_ratio', label: 'Target Reinvestment Ratio %', type: 'number' },
    { key: 'target_cash_deployment', label: 'Target Cash Deployment Amount', type: 'number' },
  ];

  function openGoalModal(existing) {
    App.ui.open({
      title: existing ? 'Edit Goal' : 'New Goal',
      bodyHtml: App.ui.renderForm(FIELDS, existing || {}),
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Save', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(FIELDS);
          if (errors.length) { App.utils.toast('Enter a label', 'err'); return; }
          try {
            if (existing) await App.api.updateGoal(existing.id, values);
            else await App.api.createGoal(Object.assign({ is_active: true }, values));
            App.utils.toast('Goal saved');
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Could not save goal: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  async function renderGoalsView() {
    const pane = App.utils.qs('#pane-goals');
    pane.innerHTML = `
      <div class="section-title">Portfolio Goals <div class="line"></div><small>current vs target, and the gap between them</small></div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="chart-title">Your Goals</div>
          <button class="btn btn-gold btn-sm" id="newGoalBtn">+ New Goal</button>
        </div>
        <div class="table-scroll"><table class="data" id="goalsTable"></table></div>
      </div>
      <div class="panel"><div class="chart-title" style="margin-bottom:10px">Progress Against Active Goal</div><div id="goalProgress"></div></div>`;

    App.utils.qs('#newGoalBtn', pane).addEventListener('click', () => openGoalModal(null));

    async function draw() {
      const [goals, summary] = await Promise.all([App.api.listGoals(), App.api.getPortfolioSummary()]);
      App.utils.qs('#goalsTable', pane).innerHTML = `<thead><tr><th>Label</th><th>Target Annual Income</th><th>Target Portfolio Size</th><th>Target ROI</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${goals.map((g) => `<tr>
          <td>${App.utils.escapeHtml(g.label)}</td><td>${App.utils.fmtMoney(g.target_annual_income)}</td><td>${App.utils.fmtMoney(g.target_portfolio_size)}</td><td>${App.utils.fmtPct(g.target_roi)}</td>
          <td>${g.is_active ? '<span class="badge st-active">Active</span>' : ''}</td>
          <td class="row-actions"><button class="icon-btn" data-edit="${g.id}">&#9998;</button>${g.is_active ? '' : `<button class="icon-btn" data-activate="${g.id}" title="Make active">&#10003;</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No goals set yet.</td></tr>'}</tbody>`;

      App.utils.qsa('[data-edit]', pane).forEach((b) => b.addEventListener('click', () => openGoalModal(goals.find((g) => g.id === Number(b.dataset.edit)))));
      App.utils.qsa('[data-activate]', pane).forEach((b) => b.addEventListener('click', async () => {
        await Promise.all(goals.filter((g) => g.is_active).map((g) => App.api.updateGoal(g.id, { is_active: false })));
        await App.api.updateGoal(Number(b.dataset.activate), { is_active: true });
        App.router.refreshCurrent();
      }));

      const active = goals.find((g) => g.is_active);
      if (!active) { App.utils.qs('#goalProgress', pane).innerHTML = '<div class="empty-note">No active goal. Create one above.</div>'; return; }
      const s = summary || {};
      const rows = [
        { label: 'Annual Income', current: s.interest_earned, target: active.target_annual_income },
        { label: 'Portfolio Size', current: s.total_invested, target: active.target_portfolio_size },
        { label: 'ROI', current: s.weighted_average_roi, target: active.target_roi, isPct: true },
      ];
      App.utils.qs('#goalProgress', pane).innerHTML = rows.filter((r) => r.target).map((r) => {
        const gap = Math.max(0, r.target - (r.current || 0));
        const pct = r.target ? Math.min(100, (r.current || 0) / r.target * 100) : 0;
        return `<div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
            <span>${r.label}</span><span>${r.isPct ? App.utils.fmtPct(r.current) : App.utils.fmtMoney(r.current)} of ${r.isPct ? App.utils.fmtPct(r.target) : App.utils.fmtMoney(r.target)}</span>
          </div>
          <div class="kpi-bar" style="margin:0"><div class="kpi-bar-fill" style="width:${pct}%;background:var(--gold);height:100%"></div></div>
          <div class="hint" style="margin-top:4px">Gap: ${r.isPct ? App.utils.fmtPct(gap) : App.utils.fmtMoney(gap)}</div>
        </div>`;
      }).join('') || '<div class="empty-note">Active goal has no targets set.</div>';
    }

    await draw();
  }

  App.router.register('goals', renderGoalsView);
})();
