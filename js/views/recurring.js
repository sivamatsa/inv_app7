/* Recurring Investments & Commitments (spec addendum Sections 56-93) - a
   deliberately SEPARATE module from Deals (deals.js): a recurring item is a
   repeated obligation/investment the user must explicitly confirm each
   period, never a capital deployment with a return. Nothing here ever feeds
   deal ROI/interest math (see dashboard.js's own separate panel for this
   module, and 015_recurring.sql's header comment for the full rationale).

   A due date arriving never auto-confirms anything (Section 62, 68) - only
   the explicit Confirm action does (fn_confirm_recurring_occurrence via
   App.api.confirmRecurringOccurrence). */
window.App = window.App || {};

(function () {
  const ITEM_TYPES = [
    'SIP', 'Mutual Fund', 'Gold Scheme', 'Gold Savings', 'Stocks / Shares', 'ETF',
    'Insurance', 'Term Insurance', 'Health Insurance', 'Life Insurance',
    'Recurring Deposit', 'NPS', 'Pension', 'Loan / EMI', 'Credit Card Bill', 'Rent',
    'Education Fee', 'Subscription', 'Membership', 'Savings Contribution',
    'Tax Payment', 'Other', 'Custom',
  ];
  const INVESTMENT_TYPES = new Set(['SIP', 'Mutual Fund', 'Gold Scheme', 'Gold Savings', 'Stocks / Shares', 'ETF', 'Recurring Deposit', 'NPS', 'Pension']);
  const INSURANCE_TYPES = new Set(['Insurance', 'Term Insurance', 'Health Insurance', 'Life Insurance']);
  const CONFIRMED_STATUSES = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];
  const PENDING_STATUSES = ['UPCOMING', 'DUE', 'OVERDUE'];

  function bucketFor(itemType) {
    if (INVESTMENT_TYPES.has(itemType)) return 'investment';
    if (INSURANCE_TYPES.has(itemType)) return 'insurance';
    return null;
  }

  // ---- Add / Edit wizard (Section 71) - one field list, type-conditional
  // visibility rather than a dozen bespoke per-type forms (Section 57 "only
  // display relevant fields for the selected item type"). ----
  const ITEM_FIELDS = [
    { key: 'item_type', label: 'Item Type', required: true, step: 1, type: 'select', options: ITEM_TYPES },
    { key: 'custom_type_label', label: 'Custom Type Label', step: 1, onlyCustom: true, placeholder: 'Only used when Item Type is Custom' },
    { key: 'item_name', label: 'Item Name', required: true, step: 1, span: 2 },
    { key: 'provider', label: 'Provider / Platform', step: 1 },
    { key: 'account_reference', label: 'Account / Reference Number', step: 1 },
    { key: 'category', label: 'Category', step: 1 },
    { key: 'sub_category', label: 'Sub Category', step: 1 },
    { key: 'notes', label: 'Notes', step: 1, type: 'textarea', span: 2 },

    { key: 'expected_amount', label: 'Expected Amount', required: true, type: 'number', step: 2 },
    { key: 'amount_type', label: 'Amount Type', step: 2, type: 'select', options: ['Fixed', 'Variable', 'Range', 'User Entered Each Period'] },
    { key: 'minimum_amount', label: 'Minimum Amount', type: 'number', step: 2 },
    { key: 'maximum_amount', label: 'Maximum Amount', type: 'number', step: 2 },
    { key: 'currency', label: 'Currency', step: 2, placeholder: 'INR' },
    { key: 'frequency', label: 'Frequency', required: true, step: 2, type: 'select', options: ['Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Custom'] },
    { key: 'payment_day', label: 'Day of Month (if applicable)', type: 'number', step: 2 },
    { key: 'start_date', label: 'Start Date', required: true, type: 'date', step: 2 },
    { key: 'first_due_date', label: 'First Due Date', type: 'date', step: 2 },
    { key: 'end_date', label: 'End Date', type: 'date', step: 2 },
    { key: 'number_of_occurrences', label: 'Total Number of Occurrences', type: 'number', step: 2 },
    { key: 'reminder_enabled', label: 'Reminders Enabled', step: 2, type: 'checkbox' },
    { key: 'reminder_days_before_text', label: 'Reminder Days Before (comma-separated)', step: 2, placeholder: '7,3,1,0' },
    { key: 'overdue_reminder_enabled', label: 'Overdue Escalation Enabled', step: 2, type: 'checkbox' },
    { key: 'escalation_days_text', label: 'Overdue Escalation Days (comma-separated)', step: 2, placeholder: '1,3,7' },

    { key: 'scheme_name', label: 'Scheme / Fund Name', step: 3, relevantTypes: 'investment' },
    { key: 'folio_number', label: 'Folio Number', step: 3, relevantTypes: 'investment' },
    { key: 'units_expected', label: 'Units Expected', type: 'number', step: 3, relevantTypes: 'investment' },
    { key: 'reference_price', label: 'NAV / Reference Price', type: 'number', step: 3, relevantTypes: 'investment' },
    { key: 'expected_return', label: 'Expected Return Amount', type: 'number', step: 3, relevantTypes: 'investment' },
    { key: 'expected_roi', label: 'Expected ROI %', type: 'number', step: 3, relevantTypes: 'investment' },
    { key: 'policy_number', label: 'Policy Number', step: 3, relevantTypes: 'insurance' },
    { key: 'beneficiary', label: 'Beneficiary', step: 3, relevantTypes: 'insurance' },
    { key: 'maturity_date', label: 'Maturity / Expiry Date', type: 'date', step: 3, relevantTypes: 'both' },
  ];

  function resolvedFields(step, itemType) {
    const bucket = bucketFor(itemType);
    return ITEM_FIELDS.filter((f) => f.step === step)
      .filter((f) => !f.onlyCustom || itemType === 'Custom')
      .filter((f) => {
        if (!f.relevantTypes) return true;
        if (f.relevantTypes === 'both') return bucket === 'investment' || bucket === 'insurance';
        return f.relevantTypes === bucket;
      })
      .map((f) => Object.assign({}, f, { options: typeof f.options === 'function' ? f.options() : f.options }));
  }

  function parseCsvInts(text) {
    return String(text || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  }

  let wizardStep = 1;

  function stepperHtml() {
    const labels = ['1. Identity & Type', '2. Amount & Schedule', '3. Investment Details'];
    return `<div class="wizard-steps">${labels.map((l, i) => `<div class="wizard-step ${wizardStep === i + 1 ? 'active' : wizardStep > i + 1 ? 'done' : ''}">${l}</div>`).join('')}</div>`;
  }

  // Custom frequency (Section 59) is one flexible custom_rule object, not a
  // real form field - rendered/wired by hand alongside the generic fields.
  function customRuleFieldsHtml(collected) {
    if (collected.frequency !== 'Custom') return '';
    const rule = collected.custom_rule || {};
    const type = rule.type || 'day_of_month';
    return `
      <div class="field"><label>Custom Rule Type</label>
        <select id="fld_custom_rule_type">
          <option value="day_of_month" ${type === 'day_of_month' ? 'selected' : ''}>Specific day each month</option>
          <option value="every_n_months" ${type === 'every_n_months' ? 'selected' : ''}>Every N months on a day</option>
          <option value="weekday" ${type === 'weekday' ? 'selected' : ''}>A specific weekday</option>
          <option value="explicit_dates" ${type === 'explicit_dates' ? 'selected' : ''}>Explicit list of dates</option>
        </select></div>
      ${type === 'day_of_month' ? `<div class="field"><label>Day of Month</label><input type="number" id="fld_custom_rule_day" value="${rule.day || ''}"></div>` : ''}
      ${type === 'every_n_months' ? `<div class="field"><label>Every N Months</label><input type="number" id="fld_custom_rule_n" value="${rule.n || ''}"></div>
         <div class="field"><label>Day of Month</label><input type="number" id="fld_custom_rule_day" value="${rule.day || ''}"></div>` : ''}
      ${type === 'weekday' ? `<div class="field"><label>Weekday</label>
         <select id="fld_custom_rule_weekday">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => `<option value="${i + 1}" ${(rule.weekday || 1) === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></div>` : ''}
      ${type === 'explicit_dates' ? `<div class="field span2"><label>Explicit Dates (comma-separated, YYYY-MM-DD)</label><textarea id="fld_custom_rule_dates" rows="2">${(rule.dates || []).join(', ')}</textarea></div>` : ''}
    `;
  }

  function openItemWizard(existing) {
    wizardStep = 1;
    const collected = Object.assign({
      status: 'ACTIVE', amount_type: 'Fixed', currency: 'INR', source: 'Manual',
      reminder_enabled: true, overdue_reminder_enabled: true,
      reminder_days_before: [7, 3, 1, 0], escalation_days: [1, 3, 7],
    }, existing || {});
    collected.reminder_days_before_text = (collected.reminder_days_before || [7, 3, 1, 0]).join(',');
    collected.escalation_days_text = (collected.escalation_days || [1, 3, 7]).join(',');

    function renderWizardBody() {
      const fields = resolvedFields(wizardStep, collected.item_type);
      const fieldsHtml = fields.map((f) => App.ui.fieldHtml(f, collected[f.key])).join('');
      const extra = wizardStep === 2 ? customRuleFieldsHtml(collected) : '';
      const empty = wizardStep === 3 && !fields.length
        ? '<div class="hint">No additional investment/insurance details apply to this item type.</div>' : '';
      return `${stepperHtml()}<div id="wizardFieldsHost">${empty}<div class="form-grid">${fieldsHtml}${extra}</div></div>`;
    }

    function captureCustomRule() {
      const type = (App.utils.qs('#fld_custom_rule_type') || {}).value || 'day_of_month';
      const rule = { type };
      const dayEl = App.utils.qs('#fld_custom_rule_day');
      if (dayEl && dayEl.value) rule.day = App.utils.parseNum(dayEl.value);
      const nEl = App.utils.qs('#fld_custom_rule_n');
      if (nEl && nEl.value) rule.n = App.utils.parseNum(nEl.value);
      const weekdayEl = App.utils.qs('#fld_custom_rule_weekday');
      if (weekdayEl) rule.weekday = App.utils.parseNum(weekdayEl.value);
      const datesEl = App.utils.qs('#fld_custom_rule_dates');
      if (datesEl && datesEl.value) rule.dates = datesEl.value.split(',').map((s) => s.trim()).filter(Boolean);
      collected.custom_rule = rule;
    }

    function wireCustomRuleFields() {
      const typeSel = App.utils.qs('#fld_custom_rule_type');
      if (typeSel) typeSel.addEventListener('change', () => {
        collected.custom_rule = Object.assign({}, collected.custom_rule, { type: typeSel.value });
        renderStep();
      });
      ['fld_custom_rule_day', 'fld_custom_rule_n', 'fld_custom_rule_weekday', 'fld_custom_rule_dates'].forEach((id) => {
        const elx = App.utils.qs('#' + id);
        if (elx) elx.addEventListener('change', captureCustomRule);
      });
    }

    function wireStepFields() {
      resolvedFields(wizardStep, collected.item_type).forEach((f) => {
        const elx = App.utils.qs('#fld_' + f.key);
        if (!elx) return;
        elx.addEventListener('change', () => {
          const { values } = App.ui.readForm([f]);
          Object.assign(collected, values);
          if (f.key === 'item_type' || f.key === 'frequency') renderStep();
        });
      });
      if (wizardStep === 2 && collected.frequency === 'Custom') wireCustomRuleFields();
    }

    function renderStep() {
      App.utils.qs('#sharedModalBody').innerHTML = renderWizardBody();
      wireStepFields();
    }

    function captureStep() {
      const fields = resolvedFields(wizardStep, collected.item_type);
      const { values, errors } = App.ui.readForm(fields);
      Object.assign(collected, values);
      if (wizardStep === 2) {
        if (collected.frequency === 'Custom') captureCustomRule();
        collected.reminder_days_before = parseCsvInts(collected.reminder_days_before_text);
        collected.escalation_days = parseCsvInts(collected.escalation_days_text);
      }
      if (errors.length) { App.utils.toast('Fill in the required fields before continuing', 'err'); return false; }
      return true;
    }

    function actionsForStep() {
      const actions = [];
      if (wizardStep > 1) actions.push({ label: '&larr; Back', className: 'btn-outline', onClick: () => { captureStep(); wizardStep--; renderStep(); refreshActions(); } });
      if (wizardStep < 3) actions.push({ label: 'Next &rarr;', className: 'btn-gold', onClick: () => { if (captureStep()) { wizardStep++; renderStep(); refreshActions(); } } });
      else actions.push({ label: existing ? 'Save Changes' : 'Create Recurring Item', className: 'btn-gold', onClick: submitWizard });
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

    async function submitWizard() {
      if (!captureStep()) return;
      const payload = Object.assign({}, collected);
      delete payload.reminder_days_before_text;
      delete payload.escalation_days_text;
      if (payload.frequency !== 'Custom') delete payload.custom_rule;
      if (payload.item_type !== 'Custom') payload.custom_type_label = null;
      try {
        if (!existing) {
          await App.api.createRecurringItem(payload);
          App.utils.toast('Recurring item created');
        } else {
          // `collected` was seeded from the whole existing row (Object.assign
          // with `existing` in openItemWizard) so the wizard can show its
          // current values across all 3 steps, not just the fields the form
          // actually edits - strip the system-managed columns that came
          // along for the ride before sending this as an UPDATE patch.
          // `id` in particular isn't just "shouldn't change", Postgres
          // rejects the update outright ("column can only be updated to
          // DEFAULT") since it's a GENERATED ALWAYS AS IDENTITY column -
          // same bug class already fixed for deals.js's edit path.
          delete payload.id;
          delete payload.user_id;
          delete payload.created_at;
          delete payload.updated_at;
          await App.api.updateRecurringItem(existing.id, payload);
          App.utils.toast('Recurring item updated');
        }
        App.ui.close();
        App.router.refreshCurrent();
      } catch (e) {
        App.utils.toast('Could not save recurring item: ' + (e.message || e), 'err');
      }
    }

    App.ui.open({ title: existing ? 'Edit Recurring Item' : 'New Recurring Item', bodyHtml: renderWizardBody(), onMount: () => { wireStepFields(); refreshActions(); } });
  }

  // ---- Confirm & Save (Section 63) - the only path that ever moves an
  // occurrence to a completed state. Status options are type-appropriate
  // (an investment item never shows "PAID", a bill never shows "INVESTED"). ----
  function openConfirmModal(occ, item) {
    const bucket = bucketFor(item.item_type);
    const statusOptions = bucket === 'investment'
      ? ['INVESTED', 'PARTIALLY_PAID', 'SKIPPED', 'FAILED']
      : ['PAID', 'CONFIRMED', 'PARTIALLY_PAID', 'SKIPPED', 'FAILED'];
    const fields = [
      { key: 'actual_amount', label: 'Actual Amount', required: true, type: 'number' },
      { key: 'paid_date', label: 'Date Paid / Invested', required: true, type: 'date' },
      { key: 'status', label: 'Status', required: true, type: 'select', options: statusOptions },
      { key: 'payment_reference', label: 'Payment / Transaction Reference' },
      { key: 'payment_method', label: 'Payment Method' },
    ];
    if (bucket === 'investment') {
      fields.push({ key: 'actual_units', label: 'Units', type: 'number' }, { key: 'actual_nav', label: 'NAV / Price', type: 'number' });
    }
    fields.push({ key: 'notes', label: 'Notes', type: 'textarea', span: 2 });
    const initial = { actual_amount: occ.expected_amount, paid_date: App.utils.todayISO(), status: statusOptions[0] };

    App.ui.open({
      title: `Confirm - ${occ.period_label}`,
      bodyHtml: `<div class="hint" style="margin-bottom:10px">Expected ${App.utils.fmtMoney(occ.expected_amount)} for ${App.utils.escapeHtml(item.item_name)}, due ${App.utils.fmtDate(occ.due_date)}. Confirming here never happens automatically - only this action records completion.</div>${App.ui.renderForm(fields, initial)}`,
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Confirm & Save', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.toast('Fill in the required fields', 'err'); return; }
          try {
            await App.api.confirmRecurringOccurrence({
              occurrenceId: occ.id, actualAmount: values.actual_amount, paidDate: values.paid_date, status: values.status,
              paymentReference: values.payment_reference, paymentMethod: values.payment_method, notes: values.notes,
              actualUnits: values.actual_units, actualNav: values.actual_nav,
            });
            App.utils.toast('Occurrence confirmed');
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Could not confirm: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  // ---- Item detail: Overview / History / Consistency / Manage (pause,
  // resume, skip, change amount, change frequency - Sections 79-84). ----
  function openDeleteRecurringItemModal(item, onDone) {
    App.ui.open({
      title: 'Delete Recurring Item',
      bodyHtml: `
        <div class="hint" style="color:var(--red,#e5484d);margin-bottom:10px">This permanently deletes "${App.utils.escapeHtml(item.item_name)}" and every occurrence, confirmation, and history record for it. There is no undo.</div>
        <div class="field span2"><label>Type the item name to confirm: ${App.utils.escapeHtml(item.item_name)}</label><input id="confirmDeleteItemName" type="text"></div>
        <div class="auth-error" id="deleteItemError"></div>`,
      actions: [
        { label: 'Delete Permanently', className: 'btn-outline', onClick: async () => {
          const typed = App.utils.qs('#confirmDeleteItemName').value.trim();
          if (typed !== item.item_name) { App.utils.qs('#deleteItemError').textContent = 'Name does not match - nothing was deleted.'; return; }
          try {
            await App.api.deleteRecurringItem(item.id);
            App.utils.toast('Recurring item deleted');
            App.ui.close();
            if (onDone) onDone();
          } catch (e) { App.utils.qs('#deleteItemError').textContent = e.message || String(e); }
        } },
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });
  }

  async function openItemDetail(itemId) {
    const [item, occurrences, consistencyAll, pauses] = await Promise.all([
      App.api.getRecurringItem(itemId),
      App.api.listRecurringOccurrences({ eq: { recurring_item_id: itemId } }),
      App.api.listRecurringConsistency({ eq: { recurring_item_id: itemId } }),
      App.api.listRecurringPauses(itemId),
    ]);
    const consistency = consistencyAll[0] || {};
    occurrences.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));

    // Consecutive confirmed streak (Section 80's "optional" stat), computed
    // client-side from the occurrence list we already have rather than as a
    // fragile ordered-window SQL expression (see plan file scope note).
    let streak = 0;
    for (let i = occurrences.length - 1; i >= 0; i--) {
      const st = occurrences[i].status;
      if (CONFIRMED_STATUSES.includes(st)) streak++;
      else if (st === 'UPCOMING' || st === 'DUE') continue;
      else break;
    }

    const bucket = bucketFor(item.item_type);
    const overviewHtml = `
      <div class="grid-2">
        <div>
          <div class="stat-line"><span>Item Type</span><span class="v">${App.utils.escapeHtml(item.item_type === 'Custom' ? (item.custom_type_label || 'Custom') : item.item_type)}</span></div>
          <div class="stat-line"><span>Provider</span><span class="v">${App.utils.escapeHtml(item.provider || '—')}</span></div>
          <div class="stat-line"><span>Expected Amount</span><span class="v">${App.utils.fmtMoney(item.expected_amount)}</span></div>
          <div class="stat-line"><span>Frequency</span><span class="v">${item.frequency}</span></div>
          <div class="stat-line"><span>Next Due</span><span class="v">${App.utils.fmtDate(item.next_due_date)}</span></div>
        </div>
        <div>
          <div class="stat-line"><span>Status</span><span class="badge ${App.utils.statusBadgeClass(item.status)}">${item.status}</span></div>
          <div class="stat-line"><span>Start Date</span><span class="v">${App.utils.fmtDate(item.start_date)}</span></div>
          <div class="stat-line"><span>End Date</span><span class="v">${App.utils.fmtDate(item.end_date)}</span></div>
          ${bucket === 'investment' ? `<div class="stat-line"><span>Folio / Scheme</span><span class="v">${App.utils.escapeHtml(item.folio_number || item.scheme_name || '—')}</span></div>` : ''}
          ${bucket === 'insurance' ? `<div class="stat-line"><span>Policy Number</span><span class="v">${App.utils.escapeHtml(item.policy_number || '—')}</span></div>` : ''}
        </div>
      </div>
      ${item.notes ? `<div class="hint" style="margin-top:10px">${App.utils.escapeHtml(item.notes)}</div>` : ''}`;

    function occRow(o) {
      const canAct = PENDING_STATUSES.includes(o.status);
      return `<tr>
        <td>${App.utils.escapeHtml(o.period_label)}</td>
        <td>${App.utils.fmtDate(o.due_date)}</td>
        <td>${App.utils.fmtMoney(o.expected_amount)}</td>
        <td>${o.actual_amount != null ? App.utils.fmtMoney(o.actual_amount) : '—'}</td>
        <td><span class="badge ${App.utils.statusBadgeClass(o.status)}">${o.status}</span></td>
        <td class="row-actions">${canAct
          ? `<button class="btn btn-sm btn-gold" data-confirm-occ="${o.id}">Confirm</button>
             <button class="btn btn-sm btn-outline" data-skip-occ="${o.id}">Skip</button>`
          : '—'}</td>
      </tr>`;
    }
    const historyHtml = `
      <div class="hint" style="margin-bottom:8px">Current consecutive confirmed streak: <b>${streak}</b></div>
      <div class="table-scroll" style="max-height:320px">
        <table class="data"><thead><tr><th>Period</th><th>Due</th><th>Expected</th><th>Actual</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${occurrences.slice().reverse().map(occRow).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No occurrences yet.</td></tr>'}</tbody></table>
      </div>`;

    const consistencyHtml = `
      <div class="grid-2">
        <div>
          <div class="stat-line"><span>Consistency %</span><span class="v">${App.utils.fmtPct(consistency.consistency_pct)}</span></div>
          <div class="stat-line"><span>Confirmed</span><span class="v">${consistency.confirmed_count || 0}</span></div>
          <div class="stat-line"><span>Skipped (not a failure)</span><span class="v">${consistency.skipped_count || 0}</span></div>
        </div>
        <div>
          <div class="stat-line"><span>Missed / Overdue</span><span class="v">${consistency.missed_count || 0}</span></div>
          <div class="stat-line"><span>Average Delay</span><span class="v">${consistency.avg_delay_days != null ? consistency.avg_delay_days + ' day(s)' : '—'}</span></div>
          <div class="stat-line"><span>Total Expected / Actual</span><span class="v">${App.utils.fmtMoney(consistency.total_expected_amount)} / ${App.utils.fmtMoney(consistency.total_actual_amount)}</span></div>
        </div>
      </div>`;

    const openPause = pauses.find((p) => !p.resumed_at);
    const manageHtml = `
      <div class="hint" style="margin-bottom:10px">Pausing stops new occurrences from being generated (and removes any already-generated future ones) until you resume - it never creates overdue occurrences for the paused window.</div>
      ${openPause
        ? `<div class="stat-line"><span>Paused since</span><span class="v">${App.utils.fmtDate(openPause.paused_from)}</span></div>
           <div class="stat-line"><span>Reason</span><span class="v">${App.utils.escapeHtml(openPause.reason || '—')}</span></div>
           <button class="btn btn-teal" id="resumeItemBtn" style="margin-top:10px">Resume</button>`
        : `<div class="field" style="max-width:280px"><label>Pause reason</label><input id="pauseReasonInput" placeholder="e.g. Temporary cash requirement"></div>
           <button class="btn btn-outline" id="pauseItemBtn" style="margin-top:10px">Pause This Item</button>`}
      <div style="height:1px;background:var(--border2);margin:18px 0"></div>
      <div class="grid-2">
        <div class="field"><label>New Amount (applies from now on, history unchanged)</label>
          <input type="number" step="any" id="changeAmountInput" placeholder="${item.expected_amount}">
          <button class="btn btn-outline btn-sm" id="changeAmountBtn" style="margin-top:8px">Update Amount</button></div>
        <div class="field"><label>New Frequency (applies from now on, history unchanged)</label>
          <select id="changeFrequencyInput">${['Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Custom'].map((f) => `<option ${f === item.frequency ? 'selected' : ''}>${f}</option>`).join('')}</select>
          <button class="btn btn-outline btn-sm" id="changeFrequencyBtn" style="margin-top:8px">Update Frequency</button></div>
      </div>
      <div style="height:1px;background:var(--border2);margin:18px 0"></div>
      <div class="hint" style="color:var(--red,#e5484d);margin-bottom:8px">Danger zone</div>
      <button class="btn btn-outline" id="deleteItemBtn" style="border-color:var(--red,#e5484d);color:var(--red,#e5484d)">Delete This Item</button>`;

    const bodyHtml = `
      <div class="tabbar" id="detailTabs">
        <button class="tab-btn active" data-tab="ov">Overview</button>
        <button class="tab-btn" data-tab="hi">History</button>
        <button class="tab-btn" data-tab="co">Consistency</button>
        <button class="tab-btn" data-tab="mg">Manage</button>
      </div>
      <div class="tab-pane active" data-pane="ov">${overviewHtml}</div>
      <div class="tab-pane" data-pane="hi">${historyHtml}</div>
      <div class="tab-pane" data-pane="co">${consistencyHtml}</div>
      <div class="tab-pane" data-pane="mg">${manageHtml}</div>`;

    App.ui.open({
      title: item.item_name,
      bodyHtml,
      actions: [
        { label: 'Edit', className: 'btn-outline', onClick: () => { App.ui.close(); openItemWizard(item); } },
        { label: 'Close', className: 'btn-gold', onClick: App.ui.close },
      ],
      onMount: (body) => {
        App.utils.qsa('.tab-btn', body.parentElement).forEach((btn) => {
          btn.addEventListener('click', () => {
            App.utils.qsa('.tab-btn', body.parentElement).forEach((b) => b.classList.toggle('active', b === btn));
            App.utils.qsa('.tab-pane', body).forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
          });
        });
        App.utils.qsa('[data-confirm-occ]', body).forEach((b) => b.addEventListener('click', () => {
          const occ = occurrences.find((o) => o.id === Number(b.dataset.confirmOcc));
          App.ui.close();
          openConfirmModal(occ, item);
        }));
        App.utils.qsa('[data-skip-occ]', body).forEach((b) => b.addEventListener('click', async () => {
          try { await App.api.skipRecurringOccurrence(Number(b.dataset.skipOcc), 'Skipped by user'); App.utils.toast('Occurrence skipped'); App.ui.close(); App.router.refreshCurrent(); }
          catch (e) { App.utils.toast('Could not skip: ' + (e.message || e), 'err'); }
        }));
        const pauseBtn = App.utils.qs('#pauseItemBtn', body);
        if (pauseBtn) pauseBtn.addEventListener('click', async () => {
          try {
            const reasonEl = App.utils.qs('#pauseReasonInput', body);
            await App.api.pauseRecurringItem(item.id, App.utils.todayISO(), reasonEl ? reasonEl.value : null);
            App.utils.toast('Item paused'); App.ui.close(); App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Could not pause: ' + (e.message || e), 'err'); }
        });
        const resumeBtn = App.utils.qs('#resumeItemBtn', body);
        if (resumeBtn) resumeBtn.addEventListener('click', async () => {
          try { await App.api.resumeRecurringItem(item.id, App.utils.todayISO()); App.utils.toast('Item resumed'); App.ui.close(); App.router.refreshCurrent(); }
          catch (e) { App.utils.toast('Could not resume: ' + (e.message || e), 'err'); }
        });
        const changeAmountBtn = App.utils.qs('#changeAmountBtn', body);
        if (changeAmountBtn) changeAmountBtn.addEventListener('click', async () => {
          const v = App.utils.parseNum(App.utils.qs('#changeAmountInput', body).value);
          if (!v) { App.utils.toast('Enter a new amount', 'err'); return; }
          try {
            await App.api.updateRecurringItem(item.id, { expected_amount: v });
            await App.api.generateRecurringOccurrences(item.id);
            App.utils.toast('Amount updated for future occurrences'); App.ui.close(); App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Could not update amount: ' + (e.message || e), 'err'); }
        });
        const changeFreqBtn = App.utils.qs('#changeFrequencyBtn', body);
        if (changeFreqBtn) changeFreqBtn.addEventListener('click', async () => {
          const v = App.utils.qs('#changeFrequencyInput', body).value;
          try {
            await App.api.updateRecurringItem(item.id, { frequency: v });
            await App.api.generateRecurringOccurrences(item.id);
            App.utils.toast('Frequency updated for future occurrences'); App.ui.close(); App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Could not update frequency: ' + (e.message || e), 'err'); }
        });
        const deleteBtn = App.utils.qs('#deleteItemBtn', body);
        if (deleteBtn) deleteBtn.addEventListener('click', () => openDeleteRecurringItemModal(item, () => App.router.refreshCurrent()));
      },
    });
  }

  // ---- List + dashboard-style stat cards (Section 73) ----
  let statusTab = 'active';
  let typeFilter = 'All';
  const TYPE_FILTER_GROUPS = {
    All: null,
    Investments: ['SIP', 'Mutual Fund', 'Gold Scheme', 'Gold Savings', 'Stocks / Shares', 'ETF', 'Recurring Deposit', 'NPS', 'Pension'],
    Insurance: ['Insurance', 'Term Insurance', 'Health Insurance', 'Life Insurance'],
    Bills: ['Loan / EMI', 'Credit Card Bill', 'Rent', 'Education Fee', 'Subscription', 'Membership', 'Tax Payment'],
    Other: ['Savings Contribution', 'Other', 'Custom'],
  };

  async function renderRecurringView() {
    const pane = App.utils.qs('#pane-recurring');
    pane.innerHTML = `
      <div class="section-title">Recurring Investments & Commitments <div class="line"></div><small>SIPs, gold schemes, insurance, bills - confirmed by you each period, never assumed</small></div>
      <div class="kpi-grid" id="recurringKpis"></div>
      <div class="panel">
        <div class="tabbar" id="recurringStatusTabs">
          <button class="tab-btn active" data-status-tab="active">Active</button>
          <button class="tab-btn" data-status-tab="paused">Paused</button>
          <button class="tab-btn" data-status-tab="completed">Completed / Cancelled</button>
          <button class="tab-btn" data-status-tab="all">All</button>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <div class="chip-row" id="recurringTypeFilter">${Object.keys(TYPE_FILTER_GROUPS).map((g) => `<div class="chip ${g === 'All' ? 'active' : ''}" data-type-filter="${g}">${g}</div>`).join('')}</div>
          <button class="btn btn-outline btn-sm" id="exportRecurringBtn">&#8595; Export</button>
          <button class="btn btn-gold btn-sm" id="addRecurringBtn">+ Add Recurring Item</button>
        </div>
        <div class="table-scroll"><table class="data" id="recurringTable"></table></div>
      </div>`;

    App.utils.qs('#addRecurringBtn', pane).addEventListener('click', () => openItemWizard(null));
    App.utils.qs('#exportRecurringBtn', pane).addEventListener('click', async () => {
      try { await App.exportData.exportSection('recurring_items'); } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
    });
    App.utils.qsa('[data-status-tab]', pane).forEach((btn) => btn.addEventListener('click', () => {
      statusTab = btn.dataset.statusTab;
      App.utils.qsa('[data-status-tab]', pane).forEach((b) => b.classList.toggle('active', b === btn));
      draw();
    }));
    App.utils.qsa('[data-type-filter]', pane).forEach((chip) => chip.addEventListener('click', () => {
      typeFilter = chip.dataset.typeFilter;
      App.utils.qsa('[data-type-filter]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      draw();
    }));

    async function draw() {
      const [items, occurrences, summary] = await Promise.all([
        App.api.listRecurringItems(), App.api.listRecurringOccurrences(), App.api.getRecurringSummary(),
      ]);
      const s = summary || {};
      const cards = [
        { cls: 'c-gold', icon: '&#128176;', label: 'This Month Expected', value: App.utils.fmtMoney(s.month_expected) },
        { cls: 'c-teal', icon: '&#10003;', label: 'This Month Confirmed', value: App.utils.fmtMoney(s.month_confirmed) },
        { cls: 'c-blue', icon: '&#8987;', label: 'Yet to Confirm', value: s.month_yet_to_confirm_count || 0 },
        { cls: 'c-purple', icon: '&#128260;', label: 'In Progress', value: s.month_in_progress_count || 0 },
        { cls: 'c-red', icon: '&#9888;', label: 'Overdue', value: `${s.month_overdue_count || 0} &middot; ${App.utils.fmtMoney(s.month_overdue_amount)}` },
      ];
      App.utils.qs('#recurringKpis', pane).innerHTML = cards.map((c) => `
        <div class="kpi ${c.cls} fade-up"><div class="kpi-icon">${c.icon}</div><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div></div>`).join('');

      let list = items.slice();
      if (statusTab === 'active') list = list.filter((i) => i.status === 'ACTIVE');
      else if (statusTab === 'paused') list = list.filter((i) => i.status === 'PAUSED');
      else if (statusTab === 'completed') list = list.filter((i) => ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(i.status));
      const typeList = TYPE_FILTER_GROUPS[typeFilter];
      if (typeList) list = list.filter((i) => typeList.includes(i.item_type));

      const nextOccByItem = {};
      occurrences.forEach((o) => {
        if (!PENDING_STATUSES.includes(o.status)) return;
        const cur = nextOccByItem[o.recurring_item_id];
        if (!cur || o.scheduled_date < cur.scheduled_date) nextOccByItem[o.recurring_item_id] = o;
      });

      const thead = `<thead><tr><th>Item</th><th>Type</th><th>Amount</th><th>Frequency</th><th>Next Due</th><th>Status</th><th>Actions</th></tr></thead>`;
      const body = list.map((item) => {
        const next = nextOccByItem[item.id];
        return `<tr>
          <td>${App.utils.escapeHtml(item.item_name)}</td>
          <td>${App.utils.escapeHtml(item.item_type === 'Custom' ? (item.custom_type_label || 'Custom') : item.item_type)}</td>
          <td>${App.utils.fmtMoney(item.expected_amount)}</td>
          <td>${item.frequency}</td>
          <td>${next ? `${App.utils.fmtDate(next.due_date)} <span class="badge ${App.utils.statusBadgeClass(next.status)}">${next.status}</span>` : '—'}</td>
          <td><span class="badge ${App.utils.statusBadgeClass(item.status)}">${item.status}</span></td>
          <td class="row-actions">
            ${next ? `<button class="btn btn-sm btn-gold" data-confirm="${item.id}">Confirm</button>` : ''}
            <button class="icon-btn" data-view="${item.id}" title="View">&#128065;</button>
            <button class="icon-btn del" data-delete="${item.id}" title="Delete">&#128465;</button>
          </td>
        </tr>`;
      }).join('');
      const table = App.utils.qs('#recurringTable', pane);
      table.innerHTML = thead + `<tbody>${body || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:24px">No recurring items yet.</td></tr>'}</tbody>`;

      App.utils.qsa('[data-view]', table).forEach((b) => b.addEventListener('click', () => openItemDetail(Number(b.dataset.view))));
      App.utils.qsa('[data-confirm]', table).forEach((b) => b.addEventListener('click', () => {
        const item = items.find((i) => i.id === Number(b.dataset.confirm));
        const occ = nextOccByItem[item.id];
        if (occ) openConfirmModal(occ, item);
      }));
      App.utils.qsa('[data-delete]', table).forEach((b) => b.addEventListener('click', () => {
        const item = items.find((i) => i.id === Number(b.dataset.delete));
        openDeleteRecurringItemModal(item, () => draw());
      }));
    }

    await draw();
  }

  App.router.register('recurring', renderRecurringView);
  App.recurringView = { openItemDetail, openItemWizard };
})();
