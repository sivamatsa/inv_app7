/* Automation Center (037_automation_center.sql) - a user-configurable
   IF-condition-THEN-notify rules engine, deliberately notify-only (never
   mutates a deal, recurring item, or any other row unsupervised - an
   explicit decision, not a limitation). A fixed catalog of six rule types,
   mirroring Gold Intelligence's own gold_alerts precedent, rather than a
   fully generic query builder - see the migration's own header comment for
   why. Evaluation itself runs cron-side (fn_evaluate_automation_rules,
   folded into the existing 15-minute job) - this page only manages rule
   CRUD and shows what's fired recently. */
window.App = window.App || {};

(function () {
  const RULE_TYPES = [
    { key: 'ACCOUNT_BALANCE_BELOW', label: 'Account Balance Below', desc: 'Alert when a specific (or any) account drops below an amount.' },
    { key: 'LIABILITY_OUTSTANDING_ABOVE', label: 'Liability Rising Above', desc: "Alert when a liability's outstanding balance rises above an amount." },
    { key: 'EXPENSE_BUDGET_PCT', label: 'Expense Budget %', desc: 'Your own budget-used threshold, per project or across all projects.' },
    { key: 'DEAL_RELIABILITY_BELOW', label: 'Deal Payout Reliability Below', desc: "Alert when a deal's payout reliability drops below a %." },
    { key: 'RECURRING_CONSISTENCY_BELOW', label: 'Recurring Consistency Below', desc: "Alert when a recurring item's consistency score drops below a %." },
    { key: 'NET_WORTH_CHANGE_PCT', label: 'Net Worth Change %', desc: 'Alert when Net Worth changes by at least this % since N days ago, based on your saved snapshots.' },
  ];
  const TYPE_LABEL = {}; RULE_TYPES.forEach((t) => { TYPE_LABEL[t.key] = t.label; });

  function conditionText(rule) {
    switch (rule.rule_type) {
      case 'ACCOUNT_BALANCE_BELOW': return `Balance below ${App.utils.fmtMoney(rule.threshold_value)}`;
      case 'LIABILITY_OUTSTANDING_ABOVE': return `Outstanding above ${App.utils.fmtMoney(rule.threshold_value)}`;
      case 'EXPENSE_BUDGET_PCT': return `Budget used &ge; ${rule.threshold_value}%`;
      case 'DEAL_RELIABILITY_BELOW': return `Reliability below ${rule.threshold_value}%`;
      case 'RECURRING_CONSISTENCY_BELOW': return `Consistency below ${rule.threshold_value}%`;
      case 'NET_WORTH_CHANGE_PCT': return `Change &le; ${rule.threshold_value}% over ~${rule.lookback_days || 30}d`;
      default: return '—';
    }
  }

  async function renderAutomationCenterView() {
    const pane = App.utils.qs('#pane-automation');
    pane.innerHTML = `
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Automation Center <div class="line" style="display:inline-block"></div><small>your own IF-condition-THEN-notify rules - never changes your data, only alerts you</small></span>
        <button class="btn btn-gold btn-sm" id="acNewRuleBtn">+ New Rule</button>
      </div>
      <div class="panel" id="acRuleList"></div>
      <div class="panel"><div class="chart-title" style="margin-bottom:8px">Recently Triggered</div><div id="acRecent"></div></div>`;

    async function draw() {
      const rules = await App.api.listAutomationRules();
      App.utils.qs('#acRuleList', pane).innerHTML = `
        <div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Type</th><th>Condition</th><th>Status</th><th>Last Triggered</th><th>Actions</th></tr></thead>
        <tbody>${rules.map((r) => `<tr>
          <td>${App.utils.escapeHtml(r.name)}</td>
          <td>${App.utils.escapeHtml(TYPE_LABEL[r.rule_type] || r.rule_type)}</td>
          <td>${conditionText(r)}</td>
          <td><span class="badge ${r.is_active ? 'st-active' : 'st-cancelled'}">${r.is_active ? 'Active' : 'Paused'}</span></td>
          <td>${r.last_triggered_at ? App.utils.fmtDateTime(r.last_triggered_at) : 'Never'}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm btn-outline" data-toggle-rule="${r.id}" data-active="${r.is_active}">${r.is_active ? 'Pause' : 'Activate'}</button>
            <button class="icon-btn del" data-del-rule="${r.id}">&#128465;</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No rules yet - click "+ New Rule" to create one.</td></tr>'}</tbody></table></div>`;

      App.utils.qsa('[data-toggle-rule]', pane).forEach((b) => b.addEventListener('click', async () => {
        const active = b.dataset.active === 'true';
        await App.api.updateAutomationRule(Number(b.dataset.toggleRule), { is_active: !active });
        draw();
      }));
      App.utils.qsa('[data-del-rule]', pane).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this automation rule?')) return;
        await App.api.deleteAutomationRule(Number(b.dataset.delRule));
        draw();
      }));

      const recent = await App.api.listNotifications({ eq: { type: 'Automation Rule Triggered' }, limit: 20 });
      App.utils.qs('#acRecent', pane).innerHTML = recent.length
        ? recent.map((n) => `<div class="stat-line"><span>${App.utils.escapeHtml(n.title)}</span><span class="v" style="font-size:11px;color:var(--text3)">${App.utils.fmtDateTime(n.scheduled_at)}</span></div>`).join('')
        : '<div class="empty-note">Nothing triggered yet. Rules are evaluated on the same 15-minute automation cycle as every other alert in this app.</div>';
    }

    App.utils.qs('#acNewRuleBtn', pane).addEventListener('click', () => openRuleForm(null, draw));
    await draw();
  }

  async function openRuleForm(existing, onDone) {
    const [projects, accounts, liabilities] = await Promise.all([
      App.api.listExpenseProjects(), App.api.listAccounts(), App.api.listLiabilities(),
    ]);
    const projectOptions = [{ value: '', label: 'All projects' }].concat(projects.map((p) => ({ value: p.id, label: p.name })));
    const accountOptions = [{ value: '', label: 'Any account' }].concat(accounts.map((a) => ({ value: a.id, label: a.account_name })));
    const liabilityOptions = [{ value: '', label: 'Any liability' }].concat(liabilities.map((l) => ({ value: l.id, label: l.liability_name })));

    let ruleType = (existing && existing.rule_type) || RULE_TYPES[0].key;

    function fieldsFor(type) {
      const nameField = { key: 'name', label: 'Rule Name', required: true, span: 2 };
      if (type === 'EXPENSE_BUDGET_PCT') return [nameField,
        { key: 'target_id', label: 'Scope', type: 'select', options: projectOptions },
        { key: 'threshold_value', label: 'Alert when budget used reaches (%)', type: 'number', required: true }];
      if (type === 'DEAL_RELIABILITY_BELOW') return [nameField,
        { key: 'threshold_value', label: 'Alert when payout reliability drops below (%)', type: 'number', required: true }];
      if (type === 'RECURRING_CONSISTENCY_BELOW') return [nameField,
        { key: 'threshold_value', label: 'Alert when consistency drops below (%)', type: 'number', required: true }];
      if (type === 'ACCOUNT_BALANCE_BELOW') return [nameField,
        { key: 'target_id', label: 'Scope', type: 'select', options: accountOptions },
        { key: 'threshold_value', label: 'Alert when balance drops below', type: 'number', required: true }];
      if (type === 'LIABILITY_OUTSTANDING_ABOVE') return [nameField,
        { key: 'target_id', label: 'Scope', type: 'select', options: liabilityOptions },
        { key: 'threshold_value', label: 'Alert when outstanding rises above', type: 'number', required: true }];
      if (type === 'NET_WORTH_CHANGE_PCT') return [nameField,
        { key: 'threshold_value', label: 'Alert when change is at or below (%, e.g. -5)', type: 'number', required: true },
        { key: 'lookback_days', label: 'Compare against how many days ago', type: 'number', required: true }];
      return [nameField];
    }

    function renderBody() {
      const fields = fieldsFor(ruleType);
      const values = existing ? Object.assign({}, existing, { target_id: existing.target_id || '' }) : { lookback_days: 30 };
      return `
        <div class="chip-row" id="acTypeChips" style="margin-bottom:12px">${RULE_TYPES.map((t) => `<div class="chip ${t.key === ruleType ? 'active' : ''}" data-rule-type="${t.key}" title="${App.utils.escapeHtml(t.desc)}">${t.label}</div>`).join('')}</div>
        <div class="hint" style="margin-bottom:10px">${App.utils.escapeHtml((RULE_TYPES.find((t) => t.key === ruleType) || {}).desc || '')}</div>
        <div id="acFieldsHost">${App.ui.renderForm(fields, values)}</div>
        <div class="auth-error" id="acRuleError"></div>`;
    }

    App.ui.open({
      title: existing ? 'Edit Automation Rule' : 'New Automation Rule',
      bodyHtml: renderBody(),
      onMount: (body) => {
        // Event delegation, not a per-chip listener - renderBody() replaces
        // body.innerHTML wholesale on every type change, which would
        // detach any listener bound directly to a chip element.
        body.addEventListener('click', (e) => {
          const chip = e.target.closest('[data-rule-type]');
          if (!chip) return;
          ruleType = chip.dataset.ruleType;
          body.innerHTML = renderBody();
        });
      },
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: existing ? 'Save Changes' : 'Create Rule', className: 'btn-gold', onClick: async () => {
          const fields = fieldsFor(ruleType);
          const { values: v, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#acRuleError').textContent = 'Fill in the required fields.'; return; }
          v.rule_type = ruleType;
          v.target_id = v.target_id || null;
          try {
            if (existing) await App.api.updateAutomationRule(existing.id, v); else await App.api.createAutomationRule(v);
            App.ui.close(); App.utils.toast('Rule saved'); if (onDone) onDone();
          } catch (e) { App.utils.qs('#acRuleError').textContent = 'Could not save: ' + (e.message || e); }
        } },
      ],
    });
  }

  App.router.register('automation', renderAutomationCenterView);
})();
