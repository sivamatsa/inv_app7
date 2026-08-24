/* Payment Schedule + Payment/Receipt Tracking + Reconciliation (spec
   Sections 6, 7, 8, 9, 23, 24), as tabs of one view. */
window.App = window.App || {};

(function () {
  // Same investment-vs-bill classification recurring.js's own confirm modal
  // uses (its INVESTMENT_TYPES set) - duplicated here rather than exported,
  // matching this app's existing small-local-constant convention (e.g.
  // dashboard.js's own confirmedStatuses) - only used to pick a
  // type-appropriate default status when a bank-statement match resolves to
  // a Recurring occurrence instead of a Deal schedule row.
  const RECURRING_INVESTMENT_TYPES = new Set(['SIP', 'Mutual Fund', 'Gold Scheme', 'Gold Savings', 'Stocks / Shares', 'ETF', 'Recurring Deposit', 'NPS', 'Pension']);
  let activeTab = 'sched';
  const RECORD_FIELDS = [
    { key: 'transaction_date', label: 'Transaction Date', type: 'date', required: true },
    { key: 'amount', label: 'Amount', type: 'number', required: true },
    { key: 'interest_amount', label: 'Interest Component', type: 'number' },
    { key: 'principal_amount', label: 'Principal Component', type: 'number' },
    { key: 'fee_amount', label: 'Fee', type: 'number' },
    { key: 'tax_amount', label: 'Tax', type: 'number' },
    { key: 'payment_reference', label: 'Payment Reference' },
    { key: 'payment_mode', label: 'Payment Mode', placeholder: 'Bank Transfer / UPI / ...' },
    { key: 'confirmation_method', label: 'Confirmation Method', type: 'select',
      options: ['Manual', 'Excel Import', 'CSV Import', 'Bank Statement', 'API', 'Webhook', 'Platform Statement', 'Automatic Reconciliation'] },
    { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
  ];

  async function openRecordPaymentModal(deals, presetDealId, presetSchedule) {
    const dealOptions = deals.map((d) => ({ value: d.id, label: `${d.deal_name} (${App.utils.fmtMoney(d.invested_amount)})` }));
    const dealField = { key: 'deal_id', label: 'Deal', required: true, type: 'select', numeric: true, options: dealOptions, span: 2 };
    const values = Object.assign({ deal_id: presetDealId || null, transaction_date: App.utils.todayISO() },
      presetSchedule ? { amount: presetSchedule.expected_total, interest_amount: presetSchedule.expected_interest, principal_amount: presetSchedule.expected_principal } : {});

    App.ui.open({
      title: 'Record Payment', small: false,
      bodyHtml: App.ui.renderForm([dealField], values) + App.ui.renderForm(RECORD_FIELDS, values)
        + '<div class="hint">Recording a payment never assumes the schedule date equals the received date - spec Section 44: a payment only exists once it is actually confirmed here.</div>',
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        {
          label: 'Record Payment', className: 'btn-gold',
          onClick: async () => {
            const { values: v1 } = App.ui.readForm([dealField]);
            const { values: v2, errors } = App.ui.readForm(RECORD_FIELDS);
            if (!v1.deal_id || errors.length) { App.utils.toast('Fill in deal, date and amount', 'err'); return; }
            try {
              await App.api.recordPayment({
                dealId: v1.deal_id, transactionDate: v2.transaction_date, amount: v2.amount,
                interestAmount: v2.interest_amount, principalAmount: v2.principal_amount,
                feeAmount: v2.fee_amount || 0, taxAmount: v2.tax_amount || 0,
                paymentReference: v2.payment_reference, paymentMode: v2.payment_mode,
                confirmationMethod: v2.confirmation_method || 'Manual', notes: v2.notes,
                scheduledPaymentId: presetSchedule ? presetSchedule.id : null,
              });
              App.utils.toast('Payment recorded');
              App.ui.close();
              App.router.refreshCurrent();
            } catch (e) {
              if (String(e.message || '').includes('duplicate') || e.code === '23505') {
                App.utils.toast('This exact payment (same deal/date/amount/reference) is already recorded.', 'err');
              } else {
                App.utils.toast('Could not record payment: ' + (e.message || e), 'err');
              }
            }
          },
        },
      ],
    });
  }

  // Local to this view, deliberately NOT App.state.filters - that object is
  // deal-shaped (platform/investment-type/risk/ROI) and shared globally with
  // Deals/Dashboard; a Payments-only month/year filter has no business
  // mutating it or rendering irrelevant controls. Same `.filterbar`/
  // `.filter-group` visual classes, own local state and own render function.
  //
  // Each call site creates its OWN filter-state object (never a shared
  // module-level singleton) - Schedule and Ledger are rendered upfront
  // together, not lazily on tab click, so a single shared object would leak
  // one tab's filter selection into the other's displayed data the moment
  // either tab's own draw() next ran. Two independent filter bars, two
  // independent states, deliberately.
  //
  // Also deliberately no element `id`s in the markup below - since both
  // tabs' bars exist in the DOM at once, an id-based lookup would collide
  // (duplicate IDs, invalid HTML, and a real risk of silently querying the
  // wrong tab's control) - every lookup here is scoped to `container` via a
  // data attribute instead.
  function renderDateFilterBar(container, filterState, onChange) {
    const years = new Set();
    const currentYear = new Date().getFullYear();
    for (let y = currentYear - 5; y <= currentYear + 2; y++) years.add(y);
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    container.innerHTML = `
      <div class="filterbar">
        <div class="filter-group"><label>Month</label>
          <select class="search-input" data-pf-month>
            <option value="">All</option>
            ${months.map((m, i) => `<option value="${i + 1}" ${filterState.month === String(i + 1) ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="filter-group"><label>Year</label>
          <select class="search-input" data-pf-year>
            <option value="">All</option>
            ${[...years].map((y) => `<option value="${y}" ${filterState.year === String(y) ? 'selected' : ''}>${y}</option>`).join('')}
          </select>
        </div>
        <div class="filter-group"><label>&nbsp;</label><button class="btn btn-outline btn-sm" data-pf-reset>↺ Reset</button></div>
      </div>`;
    container.querySelector('[data-pf-month]').addEventListener('change', (e) => { filterState.month = e.target.value; onChange(); });
    container.querySelector('[data-pf-year]').addEventListener('change', (e) => { filterState.year = e.target.value; onChange(); });
    container.querySelector('[data-pf-reset]').addEventListener('click', () => { filterState.month = ''; filterState.year = ''; renderDateFilterBar(container, filterState, onChange); onChange(); });
  }

  function matchesDateFilter(filterState, dateStr) {
    if (!dateStr) return !filterState.month && !filterState.year;
    if (filterState.month && Number(dateStr.slice(5, 7)) !== Number(filterState.month)) return false;
    if (filterState.year && Number(dateStr.slice(0, 4)) !== Number(filterState.year)) return false;
    return true;
  }

  async function renderScheduleTab(container, deals) {
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    const allSchedule = await App.api.listSchedule({ in: { status: ['UPCOMING', 'DUE_TODAY', 'OVERDUE', 'PARTIALLY_RECEIVED'] } });
    allSchedule.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
    container.innerHTML = `<div id="scheduleFilterBar"></div><div id="scheduleTableHost"></div>`;
    const filterHost = App.utils.qs('#scheduleFilterBar', container);
    const tableHost = App.utils.qs('#scheduleTableHost', container);
    const filterState = { month: '', year: '' };

    function draw() {
      const schedule = allSchedule.filter((s) => matchesDateFilter(filterState, s.scheduled_date));
      tableHost.innerHTML = `
        <div class="table-scroll"><table class="data">
          <thead><tr><th>Scheduled Date</th><th>Deal</th><th>External Deal ID</th><th>Expected Interest</th><th>Expected Principal</th><th>Expected Total</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${schedule.map((s) => `
            <tr>
              <td>${App.utils.fmtDate(s.scheduled_date)}</td>
              <td>${App.utils.escapeHtml((dealsById[s.deal_id] || {}).deal_name || '—')}</td>
              <td>${App.utils.escapeHtml((dealsById[s.deal_id] || {}).external_deal_id || '—')}</td>
              <td>${App.utils.fmtMoney(s.expected_interest)}</td>
              <td>${App.utils.fmtMoney(s.expected_principal)}</td>
              <td>${App.utils.fmtMoney(s.expected_total)}</td>
              <td><span class="badge ${App.utils.statusBadgeClass(s.status)}">${s.status}</span></td>
              <td><button class="btn btn-sm btn-gold" data-record="${s.id}">Record</button></td>
            </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:24px">Nothing pending.</td></tr>'}</tbody>
        </table></div>`;
      App.utils.qsa('[data-record]', tableHost).forEach((b) => b.addEventListener('click', () => {
        const s = allSchedule.find((x) => x.id === Number(b.dataset.record));
        openRecordPaymentModal(deals, s.deal_id, s);
      }));
    }
    renderDateFilterBar(filterHost, filterState, draw);
    draw();
  }

  async function renderLedgerTab(container, deals) {
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    const allPayments = await App.api.listPayments();
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:10px;margin-bottom:10px">
        <div id="ledgerFilterBar" style="flex:1"></div>
        <button class="btn btn-gold btn-sm" id="adhocRecordBtn">+ Record Payment</button>
      </div>
      <div id="ledgerTableHost"></div>`;
    const filterHost = App.utils.qs('#ledgerFilterBar', container);
    const tableHost = App.utils.qs('#ledgerTableHost', container);
    const filterState = { month: '', year: '' };

    function draw() {
      const payments = allPayments.filter((p) => matchesDateFilter(filterState, p.transaction_date));
      tableHost.innerHTML = `
        <div class="table-scroll"><table class="data">
          <thead><tr><th>Date</th><th>Deal</th><th>External Deal ID</th><th>Amount</th><th>Interest</th><th>Principal</th><th>Reference</th><th>Method</th><th></th><th>Actions</th></tr></thead>
          <tbody>${payments.map((p) => `
            <tr style="${p.is_voided ? 'opacity:.45' : ''}">
              <td>${App.utils.fmtDate(p.transaction_date)}</td>
              <td>${App.utils.escapeHtml((dealsById[p.deal_id] || {}).deal_name || '—')}</td>
              <td>${App.utils.escapeHtml((dealsById[p.deal_id] || {}).external_deal_id || '—')}</td>
              <td>${App.utils.fmtMoney(p.amount)}</td>
              <td>${App.utils.fmtMoney(p.interest_amount)}</td>
              <td>${App.utils.fmtMoney(p.principal_amount)}</td>
              <td>${App.utils.escapeHtml(p.payment_reference || '—')}</td>
              <td>${p.confirmation_method}</td>
              <td>${p.is_voided ? '<span class="badge st-missed">Voided</span>' : ''}</td>
              <td>${p.is_voided ? '' : `<button class="icon-btn del" data-void="${p.id}" title="Void">&#128465;</button>`}</td>
            </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:24px">No payments recorded yet.</td></tr>'}</tbody>
        </table></div>`;
      App.utils.qsa('[data-void]', tableHost).forEach((b) => b.addEventListener('click', async () => {
        const reason = prompt('Reason for voiding this payment (kept in the audit trail; the payment is never deleted):');
        if (reason === null) return;
        try { await App.api.voidPayment(Number(b.dataset.void), reason); App.utils.toast('Payment voided'); App.router.refreshCurrent(); }
        catch (e) { App.utils.toast('Could not void payment: ' + (e.message || e), 'err'); }
      }));
    }
    renderDateFilterBar(filterHost, filterState, draw);
    draw();
    App.utils.qs('#adhocRecordBtn', container).addEventListener('click', () => openRecordPaymentModal(deals, null, null));
  }

  async function renderReconciliationTab(container, deals) {
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    const [bankTx, schedule, recurringOcc, recurringItemsAll] = await Promise.all([
      App.api.listBankTransactions(),
      App.api.listSchedule({ in: { status: ['UPCOMING', 'DUE_TODAY', 'OVERDUE', 'PARTIALLY_RECEIVED'] } }),
      App.api.listRecurringOccurrences({ in: { status: ['UPCOMING', 'DUE', 'OVERDUE'] } }),
      App.api.listRecurringItems(),
    ]);
    const recurringItemsById = {}; recurringItemsAll.forEach((i) => { recurringItemsById[i.id] = i; });

    // Generalized to score across BOTH Deal schedule rows and Recurring
    // occurrences (the Reconciliation Center addendum's "Payments/Recurring"
    // scope) - same amount-tolerance + day-diff scoring formula either way,
    // just against two candidate pools instead of one, tagged with which
    // pool the winner came from so the Confirm handler can branch correctly.
    function suggestMatch(tx) {
      let best = null, bestScore = -1, bestSource = null;
      schedule.forEach((s) => {
        if (s.expected_total == null) return;
        const amountDiff = Math.abs(s.expected_total - tx.amount);
        const dayDiff = Math.abs(App.utils.daysBetween(s.scheduled_date, tx.transaction_date));
        if (amountDiff > Math.max(50, s.expected_total * 0.02)) return;
        const score = 100 - dayDiff - amountDiff / 10;
        if (score > bestScore) { bestScore = score; best = s; bestSource = 'schedule'; }
      });
      recurringOcc.forEach((o) => {
        if (o.expected_amount == null) return;
        const amountDiff = Math.abs(o.expected_amount - tx.amount);
        const dayDiff = Math.abs(App.utils.daysBetween(o.due_date, tx.transaction_date));
        if (amountDiff > Math.max(50, o.expected_amount * 0.02)) return;
        const score = 100 - dayDiff - amountDiff / 10;
        if (score > bestScore) { bestScore = score; best = o; bestSource = 'recurring'; }
      });
      return best ? { row: best, source: bestSource } : null;
    }

    container.innerHTML = `
      <div class="dropzone" id="bankDropzone">
        <div class="dropzone-icon">&#128179;</div>
        <div class="dropzone-title">Drop a bank statement Excel/CSV here, or click to browse</div>
        <div class="dropzone-sub">Columns expected: Date, Amount, Description, Reference (header names are matched loosely).</div>
      </div>
      <input type="file" id="bankFileInput" accept=".xlsx,.xls,.csv">
      <div class="table-scroll" style="margin-top:16px"><table class="data">
        <thead><tr><th>Bank Date</th><th>Amount</th><th>Description</th><th>Suggested Match</th><th>Actions</th></tr></thead>
        <tbody>${bankTx.filter((t) => !t.matched).map((t) => {
          const m = suggestMatch(t);
          let matchLabel = 'No confident match';
          if (m && m.source === 'schedule') {
            const dealName = (dealsById[m.row.deal_id] || {}).deal_name;
            matchLabel = `${App.utils.escapeHtml(dealName)} · expected ${App.utils.fmtMoney(m.row.expected_total)} on ${App.utils.fmtDate(m.row.scheduled_date)}`;
          } else if (m && m.source === 'recurring') {
            const item = recurringItemsById[m.row.recurring_item_id] || {};
            matchLabel = `${App.utils.escapeHtml(item.item_name)} (Recurring) · expected ${App.utils.fmtMoney(m.row.expected_amount)} on ${App.utils.fmtDate(m.row.due_date)}`;
          }
          return `<tr>
            <td>${App.utils.fmtDate(t.transaction_date)}</td>
            <td>${App.utils.fmtMoney(t.amount)}</td>
            <td>${App.utils.escapeHtml(t.description || '—')}</td>
            <td>${matchLabel}</td>
            <td class="row-actions">
              ${m ? `<button class="btn btn-sm btn-teal" data-confirm="${t.id}" data-source="${m.source}" data-row="${m.row.id}" ${m.source === 'schedule' ? `data-deal="${m.row.deal_id}"` : `data-item="${m.row.recurring_item_id}"`}>Confirm</button>` : ''}
              <button class="btn btn-sm btn-outline" data-unidentified="${t.id}">Mark Unidentified</button>
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:24px">No unresolved bank transactions.</td></tr>'}</tbody>
      </table></div>`;

    const dz = App.utils.qs('#bankDropzone', container);
    const input = App.utils.qs('#bankFileInput', container);
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => { if (e.target.files[0]) handleBankFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleBankFile(f); });

    function handleBankFile(file) {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
          // Prefer a sheet actually named for bank/reconciliation data - a
          // plain bank-statement export is just one sheet so falling back to
          // the first is still correct there, but a multi-sheet workbook
          // (e.g. the combined import template, which leads with an
          // Instructions sheet) would otherwise silently read the wrong one.
          const sheetName = wb.SheetNames.find((n) => /bank|reconcil/i.test(n)) || wb.SheetNames[0];
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
          let added = 0;
          for (const row of rows) {
            const dateVal = row.Date || row.date || row['Transaction Date'];
            const amountVal = row.Amount || row.amount;
            if (!dateVal || !amountVal) continue;
            await App.api.createBankTransaction({
              transaction_date: App.utils.toISO(App.utils.parseDate(dateVal)),
              amount: App.utils.parseNum(amountVal),
              description: row.Description || row.description || row.Narration || null,
              reference: row.Reference || row.reference || null,
            });
            added++;
          }
          App.utils.toast(`${added} bank transaction(s) imported`);
          App.router.refreshCurrent();
        } catch (err) { App.utils.toast('Could not parse file: ' + (err.message || err), 'err'); }
      };
      reader.readAsArrayBuffer(file);
    }

    App.utils.qsa('[data-confirm]', container).forEach((b) => b.addEventListener('click', async () => {
      const txId = Number(b.dataset.confirm), source = b.dataset.source, rowId = Number(b.dataset.row);
      const tx = bankTx.find((t) => t.id === txId);
      try {
        if (source === 'schedule') {
          const dealId = Number(b.dataset.deal);
          await App.api.recordPayment({
            dealId, transactionDate: tx.transaction_date, amount: tx.amount,
            paymentReference: tx.reference, confirmationMethod: 'Bank Statement', scheduledPaymentId: rowId,
          });
          await App.api.createPaymentMatch({ bank_transaction_id: txId, deal_id: dealId, match_percentage: 100, status: 'Confirmed' });
        } else {
          const item = recurringItemsById[Number(b.dataset.item)] || {};
          const status = RECURRING_INVESTMENT_TYPES.has(item.item_type) ? 'INVESTED' : 'PAID';
          await App.api.confirmRecurringOccurrence({
            occurrenceId: rowId, actualAmount: tx.amount, paidDate: tx.transaction_date,
            status, paymentReference: tx.reference,
          });
          await App.api.createPaymentMatch({ bank_transaction_id: txId, recurring_occurrence_id: rowId, match_percentage: 100, status: 'Confirmed' });
        }
        await App.api.markBankTransactionMatched(txId);
        App.utils.toast('Match confirmed');
        App.router.refreshCurrent();
      } catch (e) { App.utils.toast('Could not confirm match: ' + (e.message || e), 'err'); }
    }));
    App.utils.qsa('[data-unidentified]', container).forEach((b) => b.addEventListener('click', async () => {
      const txId = Number(b.dataset.unidentified);
      try {
        await App.api.createPaymentMatch({ bank_transaction_id: txId, status: 'Unidentified' });
        await App.api.markBankTransactionMatched(txId);
        App.utils.toast('Marked unidentified');
        App.router.refreshCurrent();
      } catch (e) { App.utils.toast('Could not update: ' + (e.message || e), 'err'); }
    }));
  }

  async function renderPaymentsView() {
    const pane = App.utils.qs('#pane-payments');
    pane.innerHTML = `
      <div class="section-title">Payments <div class="line"></div><small>expected schedule, actual ledger, and reconciliation</small></div>
      <div class="panel">
        <div class="tabbar">
          <button class="tab-btn ${activeTab === 'sched' ? 'active' : ''}" data-tab="sched">Payment Schedule</button>
          <button class="tab-btn ${activeTab === 'ledger' ? 'active' : ''}" data-tab="ledger">Receipt Ledger</button>
          <button class="tab-btn ${activeTab === 'recon' ? 'active' : ''}" data-tab="recon">Bank Reconciliation</button>
        </div>
        <div class="tab-pane ${activeTab === 'sched' ? 'active' : ''}" data-pane="sched" id="scheduleTabBody"></div>
        <div class="tab-pane ${activeTab === 'ledger' ? 'active' : ''}" data-pane="ledger" id="ledgerTabBody"></div>
        <div class="tab-pane ${activeTab === 'recon' ? 'active' : ''}" data-pane="recon" id="reconTabBody"></div>
      </div>`;

    App.utils.qsa('.tab-btn', pane).forEach((btn) => btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      App.utils.qsa('.tab-btn', pane).forEach((b) => b.classList.toggle('active', b === btn));
      App.utils.qsa('.tab-pane', pane).forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
    }));

    const deals = await App.api.listDeals();
    await renderScheduleTab(App.utils.qs('#scheduleTabBody', pane), deals);
    await renderLedgerTab(App.utils.qs('#ledgerTabBody', pane), deals);
    await renderReconciliationTab(App.utils.qs('#reconTabBody', pane), deals);
  }

  App.router.register('payments', renderPaymentsView);
  App.paymentsView = {
    openRecordPaymentModal,
    openReconciliationTab() { activeTab = 'recon'; App.router.navigate('payments'); },
  };
})();
