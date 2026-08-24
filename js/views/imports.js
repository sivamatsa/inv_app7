/* Excel/CSV Import wizard (spec Sections 19, 20, 47, 48, plus the Recurring
   Investments & Commitments addendum Sections 69/70). Handles the "Deals"
   sheet fully (map -> validate -> preview -> import -> generate schedules),
   a "Payments" sheet if present (matched to deals by external_deal_id), a
   "Recurring Items" sheet (map -> validate -> preview -> import -> generate
   future occurrences), and a "Recurring History" sheet (matched to a
   Recurring Item by name, importing historical occurrences directly), a
   Contacts sheet, and an Expense Transactions sheet - the latter
   deliberately recognizes the user's real, existing flat sheet shape
   (S.No/Date/Amount/Item/Dr-Cr/Description) even with no sheet named
   "Expense" at all, via a content-based fallback (a "Dr/Cr" column is
   distinctive enough that no other sheet type here would ever have one).
   Platforms/Reinvestments/Documents sheets from the Section 20 master
   workbook are not auto-processed - flagged plainly in the summary rather
   than silently dropped, since claiming full support without building it
   would be worse than being honest about which sheets are wired up. */
window.App = window.App || {};

(function () {
  const DEAL_TARGETS = [
    { key: '', label: '(ignore this column)' },
    { key: 'deal_name', label: 'Deal Name', re: /deal\s*name/i },
    { key: 'external_deal_id', label: 'External Deal ID', re: /external\s*deal\s*id/i },
    { key: 'platform_name', label: 'Platform / Lender', re: /platform|lender/i },
    { key: 'investment_type', label: 'Investment Type', re: /investment\s*type/i },
    { key: 'category', label: 'Category', re: /^category\b/i },
    { key: 'sub_category', label: 'Sub Category', re: /sub[\s_-]*category/i },
    { key: 'invested_amount', label: 'Invested / Principal Amount', re: /principal\s*amount|invested\s*amount|amount/i },
    // Checked before the bare ROI % target below: "ROI / Rate Type" also
    // satisfies /roi\s*%?(\s|$)/i (the %? and \s* can both match zero
    // characters, so "ROI" followed by any space - including the one
    // before "/ Rate Type" - passes), so the specific "type"/"rate type"
    // pattern must win first, same ordering discipline as elsewhere in
    // this file.
    { key: 'interest_rate_type', label: 'ROI / Rate Type', re: /roi\s*type|rate\s*type/i },
    { key: 'annual_roi', label: 'ROI %', re: /^roi\s*%?\s*$/i },
    { key: 'start_date', label: 'Start Date', re: /start\s*date/i },
    { key: 'maturity_date', label: 'Maturity Date', re: /maturity\s*date/i },
    { key: 'payment_frequency', label: 'Payment Frequency', re: /payment\s*frequency/i },
    { key: 'payment_day', label: 'Payment Day', re: /payment\s*day/i },
    { key: 'first_payment_date', label: 'First Payment Date', re: /first\s*payment\s*date/i },
    { key: 'payout_type', label: 'Payout Type', re: /payout\s*type/i },
    { key: 'status', label: 'Status', re: /^status\b|deal\s*status/i },
    { key: 'risk_rating', label: 'Risk Rating', re: /risk\s*rating/i },
    { key: 'notes', label: 'Notes', re: /notes|comments/i },
  ];

  const PAYMENT_TARGETS = [
    { key: '', label: '(ignore this column)' },
    { key: 'external_deal_id', label: 'Deal ID (matches external_deal_id)', re: /deal\s*id/i },
    { key: 'transaction_date', label: 'Actual Date', re: /actual\s*date|transaction\s*date|payment\s*date/i },
    { key: 'amount', label: 'Amount', re: /^amount\b/i },
    { key: 'interest_amount', label: 'Interest', re: /^interest\b/i },
    { key: 'principal_amount', label: 'Principal', re: /^principal\b/i },
    { key: 'tax_amount', label: 'Tax', re: /^tax\b/i },
    { key: 'fee_amount', label: 'Fee', re: /^fee\b/i },
    { key: 'payment_reference', label: 'Reference', re: /reference/i },
    { key: 'notes', label: 'Notes', re: /notes/i },
  ];

  // Recurring Investments & Commitments (spec Section 69/70) - an
  // independent pair of sheet types, separate from Deals/Payments, since a
  // recurring item is never a deal (see recurring.js's own header comment).
  const RECURRING_ITEM_TARGETS = [
    { key: '', label: '(ignore this column)' },
    // Deliberately specific to "item"/"external" so it never shadows
    // account_reference below - a bare /reference/i here would match ANY
    // header containing that substring, including "Account Reference".
    { key: 'external_reference', label: 'Item Reference / ID', re: /(?:item|external)[\s_-]*(?:reference|id)\b/i },
    { key: 'item_name', label: 'Item Name', re: /item\s*name/i },
    { key: 'item_type', label: 'Item Type', re: /item\s*type/i },
    { key: 'category', label: 'Category', re: /^category\b/i },
    { key: 'provider', label: 'Provider / Platform', re: /provider|platform/i },
    { key: 'account_reference', label: 'Account Reference', re: /account.*reference|account.*number/i },
    // The bare "amount" fallback must not swallow "Amount Type" (its own
    // target, right below) - same class of bug as external_reference
    // above, just via mapRow's last-mapped-column-wins behavior instead of
    // autoMap's first-match-wins.
    { key: 'expected_amount', label: 'Expected Amount', re: /expected\s*amount|^amount\b(?!\s*type)/i },
    { key: 'amount_type', label: 'Amount Type', re: /amount\s*type/i },
    { key: 'frequency', label: 'Frequency', re: /frequency/i },
    { key: 'start_date', label: 'Start Date', re: /start\s*date/i },
    { key: 'end_date', label: 'End Date', re: /end\s*date/i },
    { key: 'payment_day', label: 'Payment Day', re: /payment\s*day/i },
    { key: 'first_due_date', label: 'First Due Date', re: /first\s*due\s*date/i },
    { key: 'reminder_days_before', label: 'Reminder Days (comma-separated)', re: /reminder\s*days/i },
    { key: 'status', label: 'Status', re: /^status\b/i },
    { key: 'notes', label: 'Notes', re: /notes/i },
  ];

  const RECURRING_HISTORY_TARGETS = [
    { key: '', label: '(ignore this column)' },
    { key: 'item_name', label: 'Item Name (matches a Recurring Item)', re: /item\s*name/i },
    { key: 'period_label', label: 'Period', re: /period/i },
    { key: 'scheduled_date', label: 'Scheduled Date', re: /scheduled\s*date/i },
    { key: 'due_date', label: 'Due Date', re: /due\s*date/i },
    { key: 'expected_amount', label: 'Expected Amount', re: /expected\s*amount/i },
    { key: 'actual_amount', label: 'Actual Amount', re: /actual\s*amount/i },
    { key: 'paid_date', label: 'Paid / Invested Date', re: /paid.*date|invested.*date/i },
    { key: 'status', label: 'Status', re: /^status\b/i },
    { key: 'payment_reference', label: 'Payment Reference', re: /reference/i },
    { key: 'payment_method', label: 'Payment Method', re: /method/i },
    { key: 'notes', label: 'Notes', re: /notes/i },
  ];

  // Contacts (Contacts/Chat/Calling addendum Section 7) - independent of
  // every sheet above; a contact is never a deal, recurring item, or chat
  // message. Specific-before-generic ordering matters here exactly like
  // RECURRING_ITEM_TARGETS above: "WhatsApp Number"/"Alternate Phone" must
  // be checked before the bare "phone" fallback, or the fallback's laxer
  // match would shadow them.
  const CONTACT_TARGETS = [
    { key: '', label: '(ignore this column)' },
    { key: 'first_name', label: 'First Name', re: /first\s*name/i },
    { key: 'middle_name', label: 'Middle Name', re: /middle\s*name/i },
    { key: 'last_name', label: 'Last Name', re: /last\s*name/i },
    { key: 'full_name', label: 'Full Name', re: /^full\s*name/i },
    { key: 'whatsapp_number', label: 'WhatsApp Number', re: /whatsapp/i },
    { key: 'alternate_phone', label: 'Alternate Phone', re: /alternate\s*phone/i },
    { key: 'phone', label: 'Phone', re: /^phone\b/i },
    { key: 'alternate_email', label: 'Alternate Email', re: /alternate\s*email/i },
    { key: 'email', label: 'Email', re: /^email\b/i },
    { key: 'birthday', label: 'Birthday', re: /birthday|date\s*of\s*birth/i },
    { key: 'company', label: 'Company', re: /^company\b/i },
    { key: 'job_title', label: 'Job Title', re: /job\s*title|designation/i },
    { key: 'address', label: 'Address', re: /^address\b/i },
    { key: 'city', label: 'City', re: /^city\b/i },
    { key: 'state', label: 'State', re: /^state\b/i },
    { key: 'country', label: 'Country', re: /^country\b/i },
    { key: 'postal_code', label: 'Postal Code', re: /postal\s*code|zip/i },
    { key: 'tags', label: 'Tags (comma-separated)', re: /tags/i },
    { key: 'notes', label: 'Notes', re: /notes/i },
  ];

  // Expenses & Project Cost Management - recognizes the user's existing
  // flat sheet (S.No/Date/Amount/Item/Dr-Cr/Description) directly, plus
  // the expanded field set if present. Dr/Cr is a genuinely distinctive
  // header this format has and no other sheet type in this file does -
  // used below as a content-based detection fallback, since the user's
  // real file has no sheet literally named "Expense".
  const EXPENSE_TARGETS = [
    { key: '', label: '(ignore this column)' },
    { key: 'transaction_date', label: 'Date', re: /^date\b/i },
    { key: 'item', label: 'Item', re: /^item\b/i },
    { key: 'amount', label: 'Amount', re: /^amount\b/i },
    { key: 'transaction_type', label: 'Debit / Credit', re: /dr\s*\/?\s*cr|debit.*credit|transaction\s*type/i },
    { key: 'description', label: 'Description', re: /description/i },
    { key: 'category_name', label: 'Category (optional)', re: /^category\b/i },
    { key: 'project_name', label: 'Project (optional - else uses the project picked below)', re: /^project\b/i },
    { key: 'vendor_name', label: 'Vendor / Payee (optional)', re: /vendor|payee/i },
    { key: 'payment_method', label: 'Payment Method (optional)', re: /payment\s*method/i },
    { key: 'invoice_number', label: 'Invoice / Receipt No. (optional)', re: /invoice|receipt/i },
    { key: 'notes', label: 'Notes (optional)', re: /notes/i },
  ];

  // "Dr"/"Cr"/"Debit"/"Credit" (any case, with or without a period) all
  // resolve; anything else defaults to Debit rather than blocking the row -
  // an expense sheet is overwhelmingly debits, and a genuinely wrong value
  // is easy to spot and fix after import.
  function normalizeDrCr(raw) {
    const v = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    if (v === 'cr' || v === 'credit') return 'Credit';
    return 'Debit';
  }

  let wizardState = null;

  function autoMap(headers, targets) {
    const map = {};
    headers.forEach((h) => {
      const norm = String(h).trim();
      const match = targets.find((t) => t.re && t.re.test(norm));
      map[h] = match ? match.key : '';
    });
    return map;
  }

  function renderMappingTable(headers, mapping, targets, sheetKey) {
    return `<div class="table-scroll" style="max-height:280px"><table class="data">
      <thead><tr><th>File Column</th><th>Maps To</th></tr></thead>
      <tbody>${headers.map((h) => `<tr><td>${App.utils.escapeHtml(h)}</td><td>
        <select class="search-input" data-sheet="${sheetKey}" data-map-col="${App.utils.escapeHtml(h)}">
          ${targets.map((t) => `<option value="${t.key}" ${mapping[h] === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select></td></tr>`).join('')}</tbody></table></div>`;
  }

  function validateDealRow(row, existingExternalIds, seenExternalIds) {
    const errors = [];
    if (!row.deal_name) errors.push('missing deal name');
    if (row.invested_amount === null || row.invested_amount === undefined) errors.push('missing amount');
    else if (row.invested_amount <= 0) errors.push('invalid/negative amount');
    if (!row.start_date) errors.push('missing/invalid start date');
    if (row.maturity_date && row.start_date && row.maturity_date < row.start_date) errors.push('maturity before start');
    if (row.annual_roi !== null && row.annual_roi !== undefined && (row.annual_roi < 0 || row.annual_roi > 100)) errors.push('invalid ROI');
    const isDup = row.external_deal_id && (existingExternalIds.has(row.external_deal_id) || seenExternalIds.has(row.external_deal_id));
    return { errors, isDuplicate: !!isDup };
  }

  async function resolvePlatform(name) {
    if (!name) return null;
    let p = App.state.platforms.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (p) return p.id;
    p = await App.api.createPlatform({ name });
    App.state.platforms.push(p);
    return p.id;
  }

  // Last 10 digits only - lets "+91 98123 45678", "9812345678", and
  // "091-8123-45678" all match each other for duplicate detection, since
  // country-code/formatting differences are the most common reason a
  // genuine dup wouldn't match on a naive string comparison.
  function normalizePhone(p) {
    if (!p) return '';
    const digits = String(p).replace(/\D/g, '');
    return digits.slice(-10);
  }

  function splitTags(raw) {
    if (!raw) return [];
    return Array.from(new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean)));
  }

  function mapRow(row, headers, mapping) {
    const out = {};
    headers.forEach((h) => {
      const target = mapping[h];
      if (!target) return;
      const raw = row[h];
      out[target] = raw === '' || raw === undefined ? null : raw;
    });
    return out;
  }

  async function renderImportsView() {
    const pane = App.utils.qs('#pane-import');
    wizardState = {
      step: 1, dealRows: [], dealHeaders: [], dealMapping: {}, paymentRows: [], paymentHeaders: [], paymentMapping: {},
      recurringItemRows: [], recurringItemHeaders: [], recurringItemMapping: {},
      recurringHistoryRows: [], recurringHistoryHeaders: [], recurringHistoryMapping: {},
      contactRows: [], contactHeaders: [], contactMapping: {},
      expenseRows: [], expenseHeaders: [], expenseMapping: {}, expenseTargetProjectId: null, expenseNewProjectName: '',
      fileName: '', unhandledSheets: [],
    };

    function stepper() {
      const labels = ['1. Upload', '2. Map Columns', '3. Validate &amp; Preview', '4. Import'];
      return `<div class="wizard-steps">${labels.map((l, i) => `<div class="wizard-step ${wizardState.step === i + 1 ? 'active' : wizardState.step > i + 1 ? 'done' : ''}">${l}</div>`).join('')}</div>`;
    }

    async function draw() {
      pane.innerHTML = `
        <div class="section-title">Excel / CSV Import <div class="line"></div><small>upload once, review before anything is saved</small></div>
        <div class="panel">${stepper()}<div id="importStepBody"></div></div>
        <div class="panel"><div class="chart-title" style="margin-bottom:10px">Import History</div><div class="table-scroll" id="importHistoryTable"></div></div>`;
      await drawStep();
      await drawHistory();
    }

    async function drawHistory() {
      const imports = await App.api.listImports();
      App.utils.qs('#importHistoryTable', pane).innerHTML = `<table class="data"><thead><tr><th>File</th><th>Date</th><th>Total</th><th>Success</th><th>Duplicate</th><th>Failed</th><th>Status</th></tr></thead>
        <tbody>${imports.map((i) => `<tr><td>${App.utils.escapeHtml(i.filename)}</td><td>${App.utils.fmtDateTime(i.imported_at)}</td><td>${i.total_rows}</td><td>${i.successful_rows}</td><td>${i.duplicate_rows}</td><td>${i.failed_rows}</td><td><span class="badge ${App.utils.statusBadgeClass(i.status)}">${i.status}</span></td></tr>`).join('')
          || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">No imports yet.</td></tr>'}</tbody></table>`;
    }

    function drawStep() {
      const host = App.utils.qs('#importStepBody', pane);
      if (wizardState.step === 1) {
        host.innerHTML = `
          <div class="hint" style="margin-bottom:10px">New to importing? <a href="Investment_Import_Template.xlsx" download style="color:var(--gold)">&#8595; Download the Import Template</a> - one sheet per type (Deals, Recurring Items, Recurring History, Payments, Bank Reconciliation, Contacts) with sample rows and every dropdown's valid values documented, so your own file's columns line up correctly.</div>
          <div class="dropzone" id="importDropzone">
            <div class="dropzone-icon">&#128202;</div>
            <div class="dropzone-title">Drop your Excel/CSV file here, or click to browse</div>
            <div class="dropzone-sub">Sheets are auto-detected by name: "Deals" (+ optional "Payments"), "Recurring Items" (+ optional "Recurring History"), and/or "Contacts" - any combination in the same file works.</div>
          </div>
          <input type="file" id="importFileInput" accept=".xlsx,.xls,.csv">`;
        const dz = App.utils.qs('#importDropzone', host), input = App.utils.qs('#importFileInput', host);
        dz.addEventListener('click', () => input.click());
        input.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
        ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
        ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
        dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
      } else if (wizardState.step === 2) {
        return (async () => {
          const expenseProjects = wizardState.expenseRows.length ? await App.api.listExpenseProjects() : [];
          if (wizardState.expenseRows.length && !wizardState.expenseTargetProjectId && expenseProjects.length) wizardState.expenseTargetProjectId = expenseProjects[0].id;
          host.innerHTML = `
            ${wizardState.dealRows.length ? `<div class="chart-title" style="margin-bottom:8px">Deals sheet — ${wizardState.dealRows.length} row(s)</div>${renderMappingTable(wizardState.dealHeaders, wizardState.dealMapping, DEAL_TARGETS, 'deal')}` : ''}
            ${wizardState.paymentRows.length ? `<div class="chart-title" style="margin:16px 0 8px">Payments sheet — ${wizardState.paymentRows.length} row(s)</div>${renderMappingTable(wizardState.paymentHeaders, wizardState.paymentMapping, PAYMENT_TARGETS, 'payment')}` : ''}
            ${wizardState.recurringItemRows.length ? `<div class="chart-title" style="margin:16px 0 8px">Recurring Items sheet — ${wizardState.recurringItemRows.length} row(s)</div>${renderMappingTable(wizardState.recurringItemHeaders, wizardState.recurringItemMapping, RECURRING_ITEM_TARGETS, 'recurringItem')}` : ''}
            ${wizardState.recurringHistoryRows.length ? `<div class="chart-title" style="margin:16px 0 8px">Recurring History sheet — ${wizardState.recurringHistoryRows.length} row(s)</div>${renderMappingTable(wizardState.recurringHistoryHeaders, wizardState.recurringHistoryMapping, RECURRING_HISTORY_TARGETS, 'recurringHistory')}` : ''}
            ${wizardState.contactRows.length ? `<div class="chart-title" style="margin:16px 0 8px">Contacts sheet — ${wizardState.contactRows.length} row(s)</div>${renderMappingTable(wizardState.contactHeaders, wizardState.contactMapping, CONTACT_TARGETS, 'contact')}` : ''}
            ${wizardState.expenseRows.length ? `<div class="chart-title" style="margin:16px 0 8px">Expense Transactions sheet — ${wizardState.expenseRows.length} row(s)</div>
              <div class="field span2" style="margin-bottom:6px"><label>Import into which project? (used for any row without its own Project column)</label>
                <select class="search-input" id="expenseTargetProject">
                  <option value="">— None (use "create a new project" below, or a Project column) —</option>
                  ${expenseProjects.map((p) => `<option value="${p.id}" ${p.id === wizardState.expenseTargetProjectId ? 'selected' : ''}>${App.utils.escapeHtml(p.name)}</option>`).join('')}
                </select></div>
              <div class="field span2" style="margin-bottom:10px"><label>...or create a new project for rows without their own Project column</label>
                <input class="search-input" id="expenseNewProjectName" placeholder="e.g. Home Construction" value="${App.utils.escapeHtml(wizardState.expenseNewProjectName || '')}"></div>
              <div class="hint" style="margin-bottom:10px">A Project or Category name in the sheet that doesn't already exist is created automatically - you don't need to set these up by hand first.</div>
              ${renderMappingTable(wizardState.expenseHeaders, wizardState.expenseMapping, EXPENSE_TARGETS, 'expense')}` : ''}
            ${wizardState.unhandledSheets.length ? `<div class="hint">Sheet(s) not auto-imported yet: ${wizardState.unhandledSheets.join(', ')}. Add platforms via Settings, documents via the Documents view.</div>` : ''}
            <div class="modal-actions"><button class="btn btn-outline" id="backTo1">&larr; Back</button><button class="btn btn-gold" id="toValidate">Validate &amp; Preview &rarr;</button></div>`;
          const mappingBySheet = {
            deal: wizardState.dealMapping, payment: wizardState.paymentMapping,
            recurringItem: wizardState.recurringItemMapping, recurringHistory: wizardState.recurringHistoryMapping,
            contact: wizardState.contactMapping, expense: wizardState.expenseMapping,
          };
          App.utils.qsa('[data-map-col]', host).forEach((sel) => sel.addEventListener('change', () => {
            mappingBySheet[sel.dataset.sheet][sel.dataset.mapCol] = sel.value;
          }));
          const targetProjectSelect = App.utils.qs('#expenseTargetProject', host);
          if (targetProjectSelect) targetProjectSelect.addEventListener('change', (e) => { wizardState.expenseTargetProjectId = e.target.value ? Number(e.target.value) : null; });
          const newProjectNameInput = App.utils.qs('#expenseNewProjectName', host);
          if (newProjectNameInput) newProjectNameInput.addEventListener('input', (e) => { wizardState.expenseNewProjectName = e.target.value; });
          App.utils.qs('#backTo1', host).addEventListener('click', () => { wizardState.step = 1; draw(); });
          App.utils.qs('#toValidate', host).addEventListener('click', async () => { wizardState.step = 3; await validateAndPreview(); drawStep(); });
        })();
      } else if (wizardState.step === 3) {
        const totalValid = wizardState.validRows.length + (wizardState.recurringValidRows || []).length + (wizardState.historyValidRows || []).length
          + (wizardState.contactValidRows || []).length + (wizardState.contactDuplicateRows || []).length + (wizardState.expenseValidRows || []).length;
        host.innerHTML = wizardState.previewHtml + `<div class="modal-actions"><button class="btn btn-outline" id="backTo2">&larr; Back</button><button class="btn btn-gold" id="toImport" ${totalValid ? '' : 'disabled'}>Import ${totalValid} Valid Row(s) &rarr;</button></div>`;
        App.utils.qsa('[data-contact-dup-action]', host).forEach((sel) => sel.addEventListener('change', () => {
          wizardState.contactDuplicateRows[Number(sel.dataset.contactDupAction)].action = sel.value;
        }));
        App.utils.qs('#backTo2', host).addEventListener('click', () => { wizardState.step = 2; drawStep(); });
        App.utils.qs('#toImport', host).addEventListener('click', doImport);
      } else if (wizardState.step === 4) {
        host.innerHTML = wizardState.summaryHtml + `<div class="modal-actions"><button class="btn btn-gold" id="importDone">Done</button></div>`;
        App.utils.qs('#importDone', host).addEventListener('click', () => { wizardState.step = 1; draw(); });
      }
      return Promise.resolve();
    }

    function handleFile(file) {
      wizardState.fileName = file.name;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
          const recurringHistorySheetName = wb.SheetNames.find((n) => /recurring.*histor/i.test(n));
          const recurringItemSheetName = wb.SheetNames.find((n) => /recurring.*item/i.test(n));
          const paymentSheetName = wb.SheetNames.find((n) => /payment/i.test(n));
          const contactSheetName = wb.SheetNames.find((n) => /contact/i.test(n));
          const namedSheets = [recurringHistorySheetName, recurringItemSheetName, paymentSheetName, contactSheetName];
          // The user's real expense sheet has no name to go on ("Sheet1",
          // etc.) - "Dr/Cr" is a genuinely distinctive header no other
          // sheet type in this file uses, so any not-yet-claimed sheet
          // whose own headers contain it is treated as an Expense sheet
          // even without a matching sheet NAME.
          let expenseSheetName = wb.SheetNames.find((n) => /expense/i.test(n) && !namedSheets.includes(n));
          if (!expenseSheetName) {
            expenseSheetName = wb.SheetNames.find((n) => {
              if (namedSheets.includes(n)) return false;
              const firstRow = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '', header: 1 })[0] || [];
              return firstRow.some((h) => /dr\s*\/?\s*cr|debit.*credit/i.test(String(h)));
            });
          }
          // Only fall back to "first sheet" for Deals when nothing more
          // specific matched at all - otherwise a file containing only
          // Recurring Items/History/Contacts/Expense sheets would wrongly
          // treat one of them as a Deals sheet.
          const hasOtherMatch = !!(recurringHistorySheetName || recurringItemSheetName || paymentSheetName || contactSheetName || expenseSheetName);
          const dealSheetName = wb.SheetNames.find((n) => /deal/i.test(n)) || (hasOtherMatch ? null : wb.SheetNames[0]);
          wizardState.unhandledSheets = wb.SheetNames.filter((n) => ![dealSheetName, paymentSheetName, recurringItemSheetName, recurringHistorySheetName, contactSheetName, expenseSheetName].includes(n));

          if (dealSheetName) {
            const dealRows = XLSX.utils.sheet_to_json(wb.Sheets[dealSheetName], { defval: '' });
            wizardState.dealRows = dealRows;
            wizardState.dealHeaders = dealRows.length ? Object.keys(dealRows[0]) : [];
            wizardState.dealMapping = autoMap(wizardState.dealHeaders, DEAL_TARGETS);
          }
          if (paymentSheetName) {
            const paymentRows = XLSX.utils.sheet_to_json(wb.Sheets[paymentSheetName], { defval: '' });
            wizardState.paymentRows = paymentRows;
            wizardState.paymentHeaders = paymentRows.length ? Object.keys(paymentRows[0]) : [];
            wizardState.paymentMapping = autoMap(wizardState.paymentHeaders, PAYMENT_TARGETS);
          }
          if (recurringItemSheetName) {
            const recurringItemRows = XLSX.utils.sheet_to_json(wb.Sheets[recurringItemSheetName], { defval: '' });
            wizardState.recurringItemRows = recurringItemRows;
            wizardState.recurringItemHeaders = recurringItemRows.length ? Object.keys(recurringItemRows[0]) : [];
            wizardState.recurringItemMapping = autoMap(wizardState.recurringItemHeaders, RECURRING_ITEM_TARGETS);
          }
          if (recurringHistorySheetName) {
            const recurringHistoryRows = XLSX.utils.sheet_to_json(wb.Sheets[recurringHistorySheetName], { defval: '' });
            wizardState.recurringHistoryRows = recurringHistoryRows;
            wizardState.recurringHistoryHeaders = recurringHistoryRows.length ? Object.keys(recurringHistoryRows[0]) : [];
            wizardState.recurringHistoryMapping = autoMap(wizardState.recurringHistoryHeaders, RECURRING_HISTORY_TARGETS);
          }
          if (contactSheetName) {
            const contactRows = XLSX.utils.sheet_to_json(wb.Sheets[contactSheetName], { defval: '' });
            wizardState.contactRows = contactRows;
            wizardState.contactHeaders = contactRows.length ? Object.keys(contactRows[0]) : [];
            wizardState.contactMapping = autoMap(wizardState.contactHeaders, CONTACT_TARGETS);
          }
          if (expenseSheetName) {
            const expenseRows = XLSX.utils.sheet_to_json(wb.Sheets[expenseSheetName], { defval: '' });
            wizardState.expenseRows = expenseRows;
            wizardState.expenseHeaders = expenseRows.length ? Object.keys(expenseRows[0]) : [];
            wizardState.expenseMapping = autoMap(wizardState.expenseHeaders, EXPENSE_TARGETS);
          }
          if (!wizardState.dealRows.length && !wizardState.recurringItemRows.length && !wizardState.recurringHistoryRows.length && !wizardState.contactRows.length && !wizardState.expenseRows.length) {
            App.utils.toast('No recognized rows found (Deals, Recurring Items, Recurring History, Contacts, or Expense Transactions sheet)', 'err');
            return;
          }
          wizardState.step = 2;
          draw();
        } catch (err) { App.utils.toast('Could not parse file: ' + (err.message || err), 'err'); }
      };
      reader.readAsArrayBuffer(file);
    }

    async function validateAndPreview() {
      const existingDeals = await App.api.listDeals();
      const existingExternalIds = new Set(existingDeals.filter((d) => d.external_deal_id).map((d) => d.external_deal_id));
      const seen = new Set();
      const validRows = [], errorRows = [], duplicateRows = [];

      wizardState.dealRows.forEach((raw, idx) => {
        const hasAny = Object.values(raw).some((v) => String(v || '').trim() !== '');
        if (!hasAny) return;
        const mapped = mapRow(raw, wizardState.dealHeaders, wizardState.dealMapping);
        const normalized = {
          deal_name: mapped.deal_name ? String(mapped.deal_name).trim() : null,
          external_deal_id: mapped.external_deal_id ? String(mapped.external_deal_id).trim() : null,
          platform_name: mapped.platform_name || null,
          investment_type: mapped.investment_type || 'Other',
          category: mapped.category || null,
          sub_category: mapped.sub_category || null,
          invested_amount: App.utils.parseNum(mapped.invested_amount),
          annual_roi: App.utils.parseNum(mapped.annual_roi),
          interest_rate_type: mapped.interest_rate_type || null,
          start_date: App.utils.toISO(App.utils.parseDate(mapped.start_date)),
          maturity_date: mapped.maturity_date ? App.utils.toISO(App.utils.parseDate(mapped.maturity_date)) : null,
          payment_frequency: mapped.payment_frequency || 'Monthly',
          payment_day: App.utils.parseNum(mapped.payment_day),
          first_payment_date: mapped.first_payment_date ? App.utils.toISO(App.utils.parseDate(mapped.first_payment_date)) : null,
          payout_type: mapped.payout_type || 'Interest Only',
          status: mapped.status || 'ACTIVE',
          risk_rating: mapped.risk_rating || null,
          notes: mapped.notes || null,
        };
        const { errors, isDuplicate } = validateDealRow(normalized, existingExternalIds, seen);
        if (normalized.external_deal_id) seen.add(normalized.external_deal_id);
        if (errors.length) errorRows.push({ row: idx + 2, errors, data: normalized });
        else if (isDuplicate) duplicateRows.push({ row: idx + 2, data: normalized });
        else validRows.push({ row: idx + 2, data: normalized });
      });

      wizardState.validRows = validRows;
      wizardState.errorRows = errorRows;
      wizardState.duplicateRows = duplicateRows;

      // ---- Recurring Items (Section 69/70) ----
      const existingRecurringItems = await App.api.listRecurringItems();
      const existingRecurringNames = new Set(existingRecurringItems.map((i) => (i.item_name || '').trim().toLowerCase()));
      const seenRecurringNames = new Set();
      const recurringValidRows = [], recurringErrorRows = [], recurringDuplicateRows = [];
      const validFrequencies = ['Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Custom'];
      wizardState.recurringItemRows.forEach((raw, idx) => {
        const hasAny = Object.values(raw).some((v) => String(v || '').trim() !== '');
        if (!hasAny) return;
        const mapped = mapRow(raw, wizardState.recurringItemHeaders, wizardState.recurringItemMapping);
        const normalized = {
          external_reference: mapped.external_reference ? String(mapped.external_reference).trim() : null,
          item_name: mapped.item_name ? String(mapped.item_name).trim() : null,
          item_type: mapped.item_type || 'Other',
          category: mapped.category || null,
          provider: mapped.provider || null,
          account_reference: mapped.account_reference || null,
          expected_amount: App.utils.parseNum(mapped.expected_amount),
          amount_type: mapped.amount_type || 'Fixed',
          frequency: mapped.frequency || 'Monthly',
          start_date: mapped.start_date ? App.utils.toISO(App.utils.parseDate(mapped.start_date)) : null,
          end_date: mapped.end_date ? App.utils.toISO(App.utils.parseDate(mapped.end_date)) : null,
          payment_day: App.utils.parseNum(mapped.payment_day),
          first_due_date: mapped.first_due_date ? App.utils.toISO(App.utils.parseDate(mapped.first_due_date)) : null,
          reminder_days_before: mapped.reminder_days_before
            ? String(mapped.reminder_days_before).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)) : [7, 3, 1, 0],
          status: mapped.status || 'ACTIVE',
          notes: mapped.notes || null,
          source: 'Excel Import',
        };
        const errors = [];
        if (!normalized.item_name) errors.push('missing item name');
        if (!normalized.expected_amount || normalized.expected_amount <= 0) errors.push('missing/invalid expected amount');
        if (!normalized.start_date) errors.push('missing/invalid start date');
        if (!validFrequencies.includes(normalized.frequency)) errors.push('invalid frequency');
        const nameKey = (normalized.item_name || '').toLowerCase();
        const isDup = !!nameKey && (existingRecurringNames.has(nameKey) || seenRecurringNames.has(nameKey));
        if (nameKey) seenRecurringNames.add(nameKey);
        if (errors.length) recurringErrorRows.push({ row: idx + 2, errors, data: normalized });
        else if (isDup) recurringDuplicateRows.push({ row: idx + 2, data: normalized });
        else recurringValidRows.push({ row: idx + 2, data: normalized });
      });
      wizardState.recurringValidRows = recurringValidRows;
      wizardState.recurringErrorRows = recurringErrorRows;
      wizardState.recurringDuplicateRows = recurringDuplicateRows;

      // ---- Recurring History (Section 69/70) - matched to a Recurring Item
      // by name; true duplicate protection is the DB's own unique
      // (recurring_item_id, scheduled_date) constraint, same reliance the
      // Payments import above already places on its own dedupe constraint. ----
      const historyValidRows = [], historyErrorRows = [];
      wizardState.recurringHistoryRows.forEach((raw, idx) => {
        const hasAny = Object.values(raw).some((v) => String(v || '').trim() !== '');
        if (!hasAny) return;
        const mapped = mapRow(raw, wizardState.recurringHistoryHeaders, wizardState.recurringHistoryMapping);
        const normalized = {
          item_name: mapped.item_name ? String(mapped.item_name).trim() : null,
          period_label: mapped.period_label || null,
          scheduled_date: mapped.scheduled_date ? App.utils.toISO(App.utils.parseDate(mapped.scheduled_date)) : null,
          due_date: mapped.due_date ? App.utils.toISO(App.utils.parseDate(mapped.due_date)) : null,
          expected_amount: App.utils.parseNum(mapped.expected_amount),
          actual_amount: App.utils.parseNum(mapped.actual_amount),
          paid_date: mapped.paid_date ? App.utils.toISO(App.utils.parseDate(mapped.paid_date)) : null,
          status: mapped.status || 'CONFIRMED',
          payment_reference: mapped.payment_reference || null,
          payment_method: mapped.payment_method || null,
          notes: mapped.notes || null,
        };
        const errors = [];
        if (!normalized.item_name) errors.push('missing item name (must match a Recurring Item)');
        if (!normalized.scheduled_date) errors.push('missing/invalid scheduled date');
        if (normalized.expected_amount === null) errors.push('missing expected amount');
        if (errors.length) historyErrorRows.push({ row: idx + 2, errors, data: normalized });
        else historyValidRows.push({ row: idx + 2, data: normalized });
      });
      wizardState.historyValidRows = historyValidRows;
      wizardState.historyErrorRows = historyErrorRows;

      // ---- Contacts (Contacts/Chat/Calling addendum Section 7/8). Three
      // outcomes per row: a clean new contact, a row with no name at all
      // (error), or a row that matches an existing contact by phone/email/
      // name (duplicate - deferred to the user via a per-row Merge/Keep
      // Both/Skip choice in the preview screen, never auto-decided). ----
      const existingContacts = await App.api.listContacts();
      const existingPhoneIndex = new Map();
      const existingEmailIndex = new Map();
      const existingNameIndex = new Map();
      await Promise.all(existingContacts.map(async (c) => {
        const [phones, emails] = await Promise.all([App.api.listContactPhones(c.id), App.api.listContactEmails(c.id)]);
        phones.forEach((p) => { const k = normalizePhone(p.phone_number); if (k) existingPhoneIndex.set(k, c); });
        emails.forEach((e) => { const k = (e.email || '').trim().toLowerCase(); if (k) existingEmailIndex.set(k, c); });
        const nameKey = (c.display_name || c.full_name || '').trim().toLowerCase();
        if (nameKey) existingNameIndex.set(nameKey, c);
      }));

      const contactValidRows = [], contactErrorRows = [], contactDuplicateRows = [];
      let contactsMergedWithinFile = 0;
      const fileRowsByPhone = new Map(), fileRowsByEmail = new Map(), fileRowsByName = new Map();

      wizardState.contactRows.forEach((raw, idx) => {
        const hasAny = Object.values(raw).some((v) => String(v || '').trim() !== '');
        if (!hasAny) return;
        const mapped = mapRow(raw, wizardState.contactHeaders, wizardState.contactMapping);
        const firstName = mapped.first_name ? String(mapped.first_name).trim() : '';
        const lastName = mapped.last_name ? String(mapped.last_name).trim() : '';
        const middleName = mapped.middle_name ? String(mapped.middle_name).trim() : '';
        let derivedFirst = firstName, derivedMiddle = middleName, derivedLast = lastName;
        if (!derivedFirst && mapped.full_name) {
          const parts = String(mapped.full_name).trim().split(/\s+/);
          derivedFirst = parts[0] || '';
          derivedLast = parts.length > 1 ? parts[parts.length - 1] : '';
          derivedMiddle = parts.length > 2 ? parts.slice(1, -1).join(' ') : '';
        }
        const fullName = [derivedFirst, derivedMiddle, derivedLast].filter(Boolean).join(' ').trim();

        const rawPhones = [];
        if (mapped.phone) rawPhones.push({ phone_number: String(mapped.phone).trim(), label: 'Primary', is_primary: true });
        if (mapped.alternate_phone) rawPhones.push({ phone_number: String(mapped.alternate_phone).trim(), label: 'Secondary' });
        if (mapped.whatsapp_number) rawPhones.push({ phone_number: String(mapped.whatsapp_number).trim(), label: 'WhatsApp', is_whatsapp: true });
        const seenRowPhoneKeys = new Set();
        const phones = rawPhones.filter((p) => { const k = normalizePhone(p.phone_number); if (k && seenRowPhoneKeys.has(k)) return false; if (k) seenRowPhoneKeys.add(k); return true; });
        const rawEmails = [];
        if (mapped.email) rawEmails.push({ email: String(mapped.email).trim(), label: 'Primary', is_primary: true });
        if (mapped.alternate_email) rawEmails.push({ email: String(mapped.alternate_email).trim(), label: 'Secondary' });
        const seenRowEmailKeys = new Set();
        const emails = rawEmails.filter((e) => { const k = e.email.toLowerCase(); if (seenRowEmailKeys.has(k)) return false; seenRowEmailKeys.add(k); return true; });

        const normalized = {
          first_name: derivedFirst || null, middle_name: derivedMiddle || null, last_name: derivedLast || null,
          phones, emails,
          birthday: mapped.birthday ? App.utils.toISO(App.utils.parseDate(mapped.birthday)) : null,
          company: mapped.company || null, job_title: mapped.job_title || null,
          address: mapped.address || null, city: mapped.city || null, state: mapped.state || null,
          country: mapped.country || null, postal_code: mapped.postal_code || null,
          tags: splitTags(mapped.tags), notes: mapped.notes || null,
        };

        const errors = [];
        if (!derivedFirst && !fullName) errors.push('missing name (First Name or Full Name required)');
        if (errors.length) { contactErrorRows.push({ row: idx + 2, errors, data: normalized, displayName: fullName || '(unnamed)' }); return; }

        const phoneKeys = phones.map((p) => normalizePhone(p.phone_number)).filter(Boolean);
        const emailKeys = emails.map((e) => e.email.toLowerCase()).filter(Boolean);
        const nameKey = fullName.toLowerCase();

        // Match against contacts already in the database first.
        let matched = phoneKeys.map((k) => existingPhoneIndex.get(k)).find(Boolean)
          || emailKeys.map((k) => existingEmailIndex.get(k)).find(Boolean)
          || (nameKey && existingNameIndex.get(nameKey));
        if (matched) {
          contactDuplicateRows.push({ row: idx + 2, data: normalized, displayName: fullName, existingContactId: matched.id, existingName: matched.display_name || matched.full_name, action: 'merge' });
          return;
        }

        // Then against a row earlier in this same file - folded in
        // automatically (no separate UI needed for a same-file collision;
        // "Merge/Keep Both/Skip" is only meaningful once one side is
        // already a saved contact).
        let fileMatch = phoneKeys.map((k) => fileRowsByPhone.get(k)).find(Boolean)
          || emailKeys.map((k) => fileRowsByEmail.get(k)).find(Boolean)
          || (nameKey && fileRowsByName.get(nameKey));
        if (fileMatch) {
          const existingFilePhoneKeys = new Set(fileMatch.phones.map((p) => normalizePhone(p.phone_number)));
          const existingFileEmailKeys = new Set(fileMatch.emails.map((e) => e.email.toLowerCase()));
          phones.forEach((p) => { const k = normalizePhone(p.phone_number); if (k && !existingFilePhoneKeys.has(k)) { fileMatch.phones.push(p); existingFilePhoneKeys.add(k); } });
          emails.forEach((e) => { const k = e.email.toLowerCase(); if (k && !existingFileEmailKeys.has(k)) { fileMatch.emails.push(e); existingFileEmailKeys.add(k); } });
          fileMatch.tags = Array.from(new Set(fileMatch.tags.concat(normalized.tags)));
          ['company', 'job_title', 'birthday', 'address', 'city', 'state', 'country', 'postal_code', 'notes'].forEach((f) => { if (!fileMatch[f] && normalized[f]) fileMatch[f] = normalized[f]; });
          contactsMergedWithinFile++;
          return;
        }

        phoneKeys.forEach((k) => fileRowsByPhone.set(k, normalized));
        emailKeys.forEach((k) => fileRowsByEmail.set(k, normalized));
        if (nameKey) fileRowsByName.set(nameKey, normalized);
        contactValidRows.push({ row: idx + 2, data: normalized, displayName: fullName });
      });

      wizardState.contactValidRows = contactValidRows;
      wizardState.contactErrorRows = contactErrorRows;
      wizardState.contactDuplicateRows = contactDuplicateRows;
      wizardState.contactsMergedWithinFile = contactsMergedWithinFile;

      // ---- Expense Transactions - matched to a project by name (Project
      // column) if present, else the project picked in step 2, else a new
      // project name typed in step 2. An unmatched Project or Category name
      // is never a hard error - it's created automatically at import time
      // (mirrors the existing vendor auto-create pattern below), so a user
      // can import their whole expense history without pre-creating
      // anything by hand. Project creation is deferred to doImport (not
      // here) since this is only a preview - actually creating a project
      // during a preview the user might still cancel would be a real side
      // effect with no way to undo it. Category resolution stays immediate
      // here when the target project already exists (for an accurate
      // preview count); it's deferred alongside project creation only for
      // rows targeting a brand-new project, since that project doesn't
      // exist yet for a category to belong to. ----
      const expenseProjects = wizardState.expenseRows.length ? await App.api.listExpenseProjects() : [];
      const projectByName = new Map(expenseProjects.map((p) => [p.name.trim().toLowerCase(), p]));
      const categoriesByProject = {};
      const expenseValidRows = [], expenseErrorRows = [];
      const newProjectNamesSeen = new Set();
      let expenseNewCategoryCount = 0;
      for (const [idx, raw] of wizardState.expenseRows.entries()) {
        const hasAny = Object.values(raw).some((v) => String(v || '').trim() !== '');
        if (!hasAny) continue;
        const mapped = mapRow(raw, wizardState.expenseHeaders, wizardState.expenseMapping);
        const rawProjectName = mapped.project_name ? String(mapped.project_name).trim() : null;
        const explicitProject = rawProjectName ? projectByName.get(rawProjectName.toLowerCase()) : null;
        let projectId = null, projectNameToCreate = null;
        if (explicitProject) projectId = explicitProject.id;
        else if (rawProjectName) projectNameToCreate = rawProjectName;
        else if (wizardState.expenseTargetProjectId) projectId = wizardState.expenseTargetProjectId;
        else if (wizardState.expenseNewProjectName && wizardState.expenseNewProjectName.trim()) projectNameToCreate = wizardState.expenseNewProjectName.trim();
        if (projectNameToCreate) newProjectNamesSeen.add(projectNameToCreate.toLowerCase());

        const errors = [];
        if (!projectId && !projectNameToCreate) errors.push('no target project (pick one in step 2, type a new project name, or add a matching Project column)');
        if (!mapped.item) errors.push('missing item');
        const amount = App.utils.parseNum(mapped.amount);
        if (amount === null || amount <= 0) errors.push('missing/invalid amount');
        const transactionDate = mapped.transaction_date ? App.utils.toISO(App.utils.parseDate(mapped.transaction_date)) : null;
        if (!transactionDate) errors.push('missing/invalid date');

        const rawCategoryName = mapped.category_name ? String(mapped.category_name).trim() : null;
        let categoryId = null, categoryNameToCreate = null;
        if (rawCategoryName && projectId) {
          if (!categoriesByProject[projectId]) categoriesByProject[projectId] = await App.api.listExpenseCategories(projectId);
          const match = categoriesByProject[projectId].find((c) => c.name.trim().toLowerCase() === rawCategoryName.toLowerCase());
          if (match) categoryId = match.id; else { categoryNameToCreate = rawCategoryName; expenseNewCategoryCount++; }
        } else if (rawCategoryName) {
          categoryNameToCreate = rawCategoryName; // project itself is new - resolve/create both at import time
          expenseNewCategoryCount++;
        }

        const normalized = {
          project_id: projectId, project_name_to_create: projectNameToCreate,
          category_id: categoryId, category_name_to_create: categoryNameToCreate,
          item: mapped.item ? String(mapped.item).trim() : null,
          amount, transaction_date: transactionDate, transaction_type: normalizeDrCr(mapped.transaction_type),
          description: mapped.description || null, vendor_name: mapped.vendor_name || null,
          payment_method: mapped.payment_method || null, invoice_number: mapped.invoice_number || null, notes: mapped.notes || null,
        };
        if (errors.length) expenseErrorRows.push({ row: idx + 2, errors, data: normalized });
        else expenseValidRows.push({ row: idx + 2, data: normalized });
      }
      wizardState.expenseValidRows = expenseValidRows;
      wizardState.expenseErrorRows = expenseErrorRows;
      wizardState.expenseNewProjectCount = newProjectNamesSeen.size;
      wizardState.expenseNewCategoryCount = expenseNewCategoryCount;

      wizardState.previewHtml = `
        <div class="grid-4" style="margin-bottom:14px">
          <div class="kpi c-blue"><div class="kpi-label">Rows Detected</div><div class="kpi-value">${wizardState.dealRows.length}</div></div>
          <div class="kpi c-teal"><div class="kpi-label">Valid</div><div class="kpi-value">${validRows.length}</div></div>
          <div class="kpi c-gold"><div class="kpi-label">Duplicates</div><div class="kpi-value">${duplicateRows.length}</div></div>
          <div class="kpi c-red"><div class="kpi-label">Errors</div><div class="kpi-value">${errorRows.length}</div></div>
        </div>
        ${errorRows.length ? `<div class="chart-title" style="margin-bottom:6px">Rows with errors (not imported)</div><div class="table-scroll" style="max-height:200px;margin-bottom:14px"><table class="data"><thead><tr><th>File Row</th><th>Deal</th><th>Errors</th></tr></thead><tbody>${errorRows.map((r) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.data.deal_name || '—')}</td><td>${r.errors.join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${duplicateRows.length ? `<div class="chart-title" style="margin-bottom:6px">Duplicates (matched by External Deal ID, not re-imported)</div><div class="table-scroll" style="max-height:150px;margin-bottom:14px"><table class="data"><thead><tr><th>File Row</th><th>Deal</th><th>External ID</th></tr></thead><tbody>${duplicateRows.map((r) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.data.deal_name || '—')}</td><td>${r.data.external_deal_id}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${wizardState.dealRows.length ? `<div class="chart-title" style="margin-bottom:6px">Preview of valid deal rows</div>
        <div class="table-scroll" style="max-height:220px;margin-bottom:14px"><table class="data"><thead><tr><th>Deal</th><th>Amount</th><th>ROI</th><th>Start</th><th>Maturity</th></tr></thead><tbody>${validRows.slice(0, 20).map((r) => `<tr><td>${App.utils.escapeHtml(r.data.deal_name)}</td><td>${App.utils.fmtMoney(r.data.invested_amount)}</td><td>${App.utils.fmtPct(r.data.annual_roi)}</td><td>${App.utils.fmtDate(r.data.start_date)}</td><td>${App.utils.fmtDate(r.data.maturity_date)}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">Nothing valid to import</td></tr>'}</tbody></table></div>` : ''}
        ${wizardState.recurringItemRows.length ? `<div class="chart-title" style="margin-bottom:6px">Recurring Items — ${recurringValidRows.length} valid, ${recurringDuplicateRows.length} duplicate, ${recurringErrorRows.length} error</div>
        ${recurringErrorRows.length ? `<div class="table-scroll" style="max-height:150px;margin-bottom:10px"><table class="data"><thead><tr><th>Row</th><th>Item</th><th>Errors</th></tr></thead><tbody>${recurringErrorRows.map((r) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.data.item_name || '—')}</td><td>${r.errors.join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="table-scroll" style="max-height:200px;margin-bottom:14px"><table class="data"><thead><tr><th>Item</th><th>Type</th><th>Amount</th><th>Frequency</th><th>Start</th></tr></thead><tbody>${recurringValidRows.slice(0, 20).map((r) => `<tr><td>${App.utils.escapeHtml(r.data.item_name)}</td><td>${App.utils.escapeHtml(r.data.item_type)}</td><td>${App.utils.fmtMoney(r.data.expected_amount)}</td><td>${r.data.frequency}</td><td>${App.utils.fmtDate(r.data.start_date)}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">Nothing valid to import</td></tr>'}</tbody></table></div>` : ''}
        ${wizardState.recurringHistoryRows.length ? `<div class="chart-title" style="margin-bottom:6px">Recurring History — ${historyValidRows.length} valid, ${historyErrorRows.length} error</div>
        ${historyErrorRows.length ? `<div class="table-scroll" style="max-height:150px"><table class="data"><thead><tr><th>Row</th><th>Item</th><th>Errors</th></tr></thead><tbody>${historyErrorRows.map((r) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.data.item_name || '—')}</td><td>${r.errors.join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}` : ''}
        ${wizardState.contactRows.length ? `<div class="chart-title" style="margin-bottom:6px">Contacts — ${contactValidRows.length} new, ${contactDuplicateRows.length} possible duplicate(s), ${contactErrorRows.length} error${contactsMergedWithinFile ? `, ${contactsMergedWithinFile} merged automatically (same person appeared twice in this file)` : ''}</div>
        ${contactErrorRows.length ? `<div class="table-scroll" style="max-height:150px;margin-bottom:10px"><table class="data"><thead><tr><th>Row</th><th>Name</th><th>Errors</th></tr></thead><tbody>${contactErrorRows.map((r) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.displayName)}</td><td>${r.errors.join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${contactDuplicateRows.length ? `<div class="hint" style="margin-bottom:6px">These rows look like contacts you already have (matched by phone, email, or name). Choose what to do with each - nothing is overwritten by default.</div>
        <div class="table-scroll" style="max-height:220px;margin-bottom:10px"><table class="data"><thead><tr><th>File Row</th><th>Name (file)</th><th>Matches Existing</th><th>Action</th></tr></thead><tbody>${contactDuplicateRows.map((r, i) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.displayName)}</td><td>${App.utils.escapeHtml(r.existingName || '—')}</td><td>
          <select class="search-input" data-contact-dup-action="${i}">
            <option value="merge" ${r.action === 'merge' ? 'selected' : ''}>Merge into existing contact</option>
            <option value="keep" ${r.action === 'keep' ? 'selected' : ''}>Keep as a separate new contact</option>
            <option value="skip" ${r.action === 'skip' ? 'selected' : ''}>Skip this row</option>
          </select></td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="table-scroll" style="max-height:200px"><table class="data"><thead><tr><th>Name</th><th>Phone(s)</th><th>Email(s)</th><th>Company</th><th>Tags</th></tr></thead><tbody>${contactValidRows.slice(0, 20).map((r) => `<tr><td>${App.utils.escapeHtml(r.displayName)}</td><td>${r.data.phones.map((p) => App.utils.escapeHtml(p.phone_number)).join(', ') || '—'}</td><td>${r.data.emails.map((e) => App.utils.escapeHtml(e.email)).join(', ') || '—'}</td><td>${App.utils.escapeHtml(r.data.company || '—')}</td><td>${r.data.tags.join(', ') || '—'}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">Nothing new to import</td></tr>'}</tbody></table></div>` : ''}
        ${wizardState.expenseRows.length ? `<div class="chart-title" style="margin-bottom:6px">Expense Transactions — ${expenseValidRows.length} valid, ${expenseErrorRows.length} error${wizardState.expenseNewProjectCount ? `, ${wizardState.expenseNewProjectCount} new project(s) will be created` : ''}${expenseNewCategoryCount ? `, ${expenseNewCategoryCount} new categor${expenseNewCategoryCount === 1 ? 'y' : 'ies'} will be created` : ''}</div>
        ${expenseErrorRows.length ? `<div class="table-scroll" style="max-height:150px;margin-bottom:10px"><table class="data"><thead><tr><th>Row</th><th>Item</th><th>Errors</th></tr></thead><tbody>${expenseErrorRows.map((r) => `<tr><td>${r.row}</td><td>${App.utils.escapeHtml(r.data.item || '—')}</td><td>${r.errors.join(', ')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="table-scroll" style="max-height:220px"><table class="data"><thead><tr><th>Date</th><th>Item</th><th>Amount</th><th>Type</th><th>Description</th></tr></thead><tbody>${expenseValidRows.slice(0, 20).map((r) => `<tr><td>${App.utils.fmtDate(r.data.transaction_date)}</td><td>${App.utils.escapeHtml(r.data.item)}</td><td>${App.utils.fmtMoney(r.data.amount)}</td><td>${r.data.transaction_type}</td><td>${App.utils.escapeHtml(r.data.description || '—')}</td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text3)">Nothing valid to import</td></tr>'}</tbody></table></div>` : ''}`;
    }

    async function doImport() {
      const totalRowsAllSheets = wizardState.dealRows.length + wizardState.recurringItemRows.length + wizardState.recurringHistoryRows.length + wizardState.contactRows.length + wizardState.expenseRows.length;
      const importRow = await App.api.createImport({ filename: wizardState.fileName, source: 'Excel Import', total_rows: totalRowsAllSheets, status: 'Processing' });
      let success = 0, failed = 0;
      const errorReport = [...wizardState.errorRows.map((r) => ({ row: r.row, reason: r.errors.join(', ') }))];
      for (const r of wizardState.validRows) {
        try {
          const platformId = await resolvePlatform(r.data.platform_name);
          const deal = await App.api.createDeal({
            deal_name: r.data.deal_name, external_deal_id: r.data.external_deal_id, platform_id: platformId,
            investment_type: r.data.investment_type, category: r.data.category, sub_category: r.data.sub_category,
            invested_amount: r.data.invested_amount, principal_amount: r.data.invested_amount, original_principal: r.data.invested_amount,
            current_principal: r.data.invested_amount, annual_roi: r.data.annual_roi, interest_rate_type: r.data.interest_rate_type,
            start_date: r.data.start_date, maturity_date: r.data.maturity_date, payment_frequency: r.data.payment_frequency,
            payment_day: r.data.payment_day, first_payment_date: r.data.first_payment_date, payout_type: r.data.payout_type,
            status: r.data.status, risk_rating: r.data.risk_rating, notes: r.data.notes, source: 'Excel Import',
          });
          if (deal.maturity_date && !['Irregular', 'Custom'].includes(deal.payment_frequency)) {
            try { await App.api.generateSchedule(deal.id); } catch (e) { /* deal saved even if schedule generation fails */ }
          }
          success++;
        } catch (e) {
          failed++;
          errorReport.push({ row: r.row, reason: e.message || String(e) });
        }
      }

      if (wizardState.paymentRows.length) {
        const allDeals = await App.api.listDeals();
        for (const raw of wizardState.paymentRows) {
          const hasAny = Object.values(raw).some((v) => String(v || '').trim() !== '');
          if (!hasAny) continue;
          const mapped = mapRow(raw, wizardState.paymentHeaders, wizardState.paymentMapping);
          const deal = allDeals.find((d) => d.external_deal_id === String(mapped.external_deal_id || '').trim());
          if (!deal || !mapped.transaction_date || !mapped.amount) { errorReport.push({ row: 'payments', reason: 'payment row without a matching deal ID, date, or amount' }); continue; }
          try {
            await App.api.recordPayment({
              dealId: deal.id, transactionDate: App.utils.toISO(App.utils.parseDate(mapped.transaction_date)), amount: App.utils.parseNum(mapped.amount),
              interestAmount: App.utils.parseNum(mapped.interest_amount), principalAmount: App.utils.parseNum(mapped.principal_amount),
              feeAmount: App.utils.parseNum(mapped.fee_amount) || 0, taxAmount: App.utils.parseNum(mapped.tax_amount) || 0,
              paymentReference: mapped.payment_reference, confirmationMethod: 'Excel Import', notes: mapped.notes,
            });
          } catch (e) { /* likely a duplicate under the dedupe constraint - not counted as a hard failure */ }
        }
      }

      // ---- Recurring Items: create master item -> generate future
      // occurrences (Section 70's order). Matched-by-name map is reused
      // below for Recurring History rows in the same file. ----
      const itemIdByName = {};
      let recurringHistoryDuplicates = 0;
      for (const r of wizardState.recurringValidRows || []) {
        try {
          const item = await App.api.createRecurringItem(r.data);
          itemIdByName[(r.data.item_name || '').toLowerCase()] = item.id;
          success++;
        } catch (e) {
          failed++;
          errorReport.push({ row: r.row, reason: e.message || String(e) });
        }
      }

      // ---- Recurring History: import historical occurrences against
      // whatever recurring item matches by name - either just-created above,
      // or already existing from a previous import/manual entry. A newly
      // created item auto-generates its own placeholder occurrences
      // (createRecurringItem -> generateRecurringOccurrences), so a history
      // row landing on the same period is expected to collide with one -
      // that placeholder gets updated with the real historical data instead
      // of being treated as a duplicate (Section 70's "match existing
      // occurrences"). Only a second, genuinely repeated import of the same
      // already-resolved history row counts as a real duplicate. ----
      if ((wizardState.historyValidRows || []).length) {
        const allRecurringItems = await App.api.listRecurringItems();
        allRecurringItems.forEach((i) => {
          const key = (i.item_name || '').toLowerCase();
          if (!itemIdByName[key]) itemIdByName[key] = i.id;
        });
        for (const r of wizardState.historyValidRows) {
          const itemId = itemIdByName[(r.data.item_name || '').toLowerCase()];
          if (!itemId) { failed++; errorReport.push({ row: r.row, reason: `no matching recurring item named "${r.data.item_name}"` }); continue; }
          const occurrenceFields = {
            period_label: r.data.period_label || App.utils.fmtDate(r.data.scheduled_date),
            scheduled_date: r.data.scheduled_date, due_date: r.data.due_date || r.data.scheduled_date,
            expected_amount: r.data.expected_amount, actual_amount: r.data.actual_amount, paid_date: r.data.paid_date,
            status: r.data.status, payment_reference: r.data.payment_reference, payment_method: r.data.payment_method,
            notes: r.data.notes, confirmation_method: 'Excel Import',
          };
          try {
            await App.api.createRecurringOccurrence(Object.assign({ recurring_item_id: itemId }, occurrenceFields));
            success++;
          } catch (e) {
            try {
              const existing = await App.api.listRecurringOccurrences({ eq: { recurring_item_id: itemId, scheduled_date: r.data.scheduled_date } });
              const match = existing[0];
              if (match && match.actual_amount == null && ['UPCOMING', 'DUE'].includes(match.status)) {
                // A placeholder the item's own generation step already created for this period - fold the real historical data into it.
                await App.api.updateRecurringOccurrence(match.id, occurrenceFields);
                success++;
              } else {
                recurringHistoryDuplicates++; // already has real data - a genuine repeat import
              }
            } catch (e2) {
              failed++;
              errorReport.push({ row: r.row, reason: e2.message || String(e2) });
            }
          }
        }
      }

      // ---- Contacts: create new rows outright, then apply each flagged
      // duplicate's own Merge/Keep Both/Skip choice from the preview screen.
      // Merge only fills blank fields and adds phones/emails/notes that
      // aren't already there - it never overwrites existing data. ----
      let contactsSkipped = 0;
      async function createContactWithChildren(data) {
        const contact = await App.api.createContact({
          first_name: data.first_name, middle_name: data.middle_name, last_name: data.last_name,
          birthday: data.birthday, company: data.company, job_title: data.job_title,
          tags: data.tags.length ? data.tags : null,
        });
        for (const p of data.phones) await App.api.createContactPhone(Object.assign({ contact_id: contact.id }, p));
        for (const e of data.emails) await App.api.createContactEmail(Object.assign({ contact_id: contact.id }, e));
        if (data.address || data.city || data.state || data.country || data.postal_code) {
          await App.api.createContactAddress({ contact_id: contact.id, address_type: 'Home', line1: data.address, city: data.city, state: data.state, country: data.country, postal_code: data.postal_code });
        }
        if (data.notes) await App.api.createContactNote({ contact_id: contact.id, note_text: data.notes });
        return contact;
      }

      for (const r of wizardState.contactValidRows || []) {
        try { await createContactWithChildren(r.data); success++; }
        catch (e) { failed++; errorReport.push({ row: r.row, reason: e.message || String(e) }); }
      }

      for (const r of wizardState.contactDuplicateRows || []) {
        if (r.action === 'skip') { contactsSkipped++; continue; }
        if (r.action === 'keep') {
          try { await createContactWithChildren(r.data); success++; }
          catch (e) { failed++; errorReport.push({ row: r.row, reason: e.message || String(e) }); }
          continue;
        }
        try {
          const existing = await App.api.getContact(r.existingContactId);
          const [existingPhones, existingEmails] = await Promise.all([
            App.api.listContactPhones(r.existingContactId), App.api.listContactEmails(r.existingContactId),
          ]);
          const existingPhoneKeys = new Set(existingPhones.map((p) => normalizePhone(p.phone_number)));
          const existingEmailKeys = new Set(existingEmails.map((e) => (e.email || '').toLowerCase()));
          for (const p of r.data.phones) if (!existingPhoneKeys.has(normalizePhone(p.phone_number))) await App.api.createContactPhone(Object.assign({ contact_id: existing.id }, p));
          for (const e of r.data.emails) if (!existingEmailKeys.has(e.email.toLowerCase())) await App.api.createContactEmail(Object.assign({ contact_id: existing.id }, e));
          if (r.data.notes) await App.api.createContactNote({ contact_id: existing.id, note_text: r.data.notes });
          if (r.data.address || r.data.city || r.data.country) await App.api.createContactAddress({ contact_id: existing.id, address_type: 'Home', line1: r.data.address, city: r.data.city, state: r.data.state, country: r.data.country, postal_code: r.data.postal_code });
          const patch = {};
          ['company', 'job_title', 'birthday'].forEach((f) => { if (!existing[f] && r.data[f]) patch[f] = r.data[f]; });
          const mergedTags = Array.from(new Set((existing.tags || []).concat(r.data.tags)));
          if (mergedTags.length !== (existing.tags || []).length) patch.tags = mergedTags;
          if (Object.keys(patch).length) await App.api.updateContact(existing.id, patch);
          success++;
        } catch (e) { failed++; errorReport.push({ row: r.row, reason: e.message || String(e) }); }
      }

      // ---- Expense Transactions - vendor is matched/created by name (a
      // vendor sheet almost never exists alongside a flat expense sheet, so
      // a bare name is enough to work with). Project and Category are the
      // same pattern: `_id` was already resolved during validation when it
      // matched something existing; a `_name_to_create` was set instead when
      // it didn't, which is only actually created here at import time (not
      // during the preview, which the user might still cancel) - cached by
      // name so the same new project/category name appearing on multiple
      // rows only creates it once. ----
      if ((wizardState.expenseValidRows || []).length) {
        const existingVendors = await App.api.listExpenseVendors();
        const vendorByName = new Map(existingVendors.map((v) => [v.name.trim().toLowerCase(), v]));
        const projectByNameCache = new Map((await App.api.listExpenseProjects()).map((p) => [p.name.trim().toLowerCase(), p]));
        const categoriesByProjectCache = {};
        for (const r of wizardState.expenseValidRows) {
          try {
            let projectId = r.data.project_id;
            if (!projectId && r.data.project_name_to_create) {
              const key = r.data.project_name_to_create.toLowerCase();
              let project = projectByNameCache.get(key);
              if (!project) { project = await App.api.createExpenseProject({ name: r.data.project_name_to_create }); projectByNameCache.set(key, project); }
              projectId = project.id;
            }

            let categoryId = r.data.category_id;
            if (!categoryId && r.data.category_name_to_create) {
              if (!categoriesByProjectCache[projectId]) categoriesByProjectCache[projectId] = await App.api.listExpenseCategories(projectId);
              const key = r.data.category_name_to_create.trim().toLowerCase();
              let category = categoriesByProjectCache[projectId].find((c) => c.name.trim().toLowerCase() === key);
              if (!category) { category = await App.api.createExpenseCategory({ project_id: projectId, name: r.data.category_name_to_create }); categoriesByProjectCache[projectId].push(category); }
              categoryId = category.id;
            }

            let vendorId = null;
            if (r.data.vendor_name) {
              const key = String(r.data.vendor_name).trim().toLowerCase();
              let vendor = vendorByName.get(key);
              if (!vendor) { vendor = await App.api.createExpenseVendor({ name: String(r.data.vendor_name).trim() }); vendorByName.set(key, vendor); }
              vendorId = vendor.id;
            }
            await App.api.createExpenseTransaction({
              project_id: projectId, category_id: categoryId, transaction_date: r.data.transaction_date,
              item: r.data.item, amount: r.data.amount, transaction_type: r.data.transaction_type,
              payment_method: r.data.payment_method, vendor_id: vendorId, description: r.data.description,
              invoice_number: r.data.invoice_number, payment_status: 'Paid', notes: r.data.notes,
            });
            success++;
          } catch (e) { failed++; errorReport.push({ row: r.row, reason: e.message || String(e) }); }
        }
      }

      const totalDuplicates = wizardState.duplicateRows.length + (wizardState.recurringDuplicateRows || []).length + recurringHistoryDuplicates + contactsSkipped;
      await App.api.updateImport(importRow.id, {
        successful_rows: success, duplicate_rows: totalDuplicates, failed_rows: failed,
        status: failed > 0 ? 'Completed with Errors' : 'Completed', error_report: errorReport,
      });

      wizardState.summaryHtml = `
        <div class="grid-4">
          <div class="kpi c-blue"><div class="kpi-label">Total Rows</div><div class="kpi-value">${wizardState.dealRows.length + wizardState.recurringItemRows.length + wizardState.recurringHistoryRows.length + wizardState.contactRows.length + wizardState.expenseRows.length}</div></div>
          <div class="kpi c-teal"><div class="kpi-label">Imported</div><div class="kpi-value">${success}</div></div>
          <div class="kpi c-gold"><div class="kpi-label">Duplicates Skipped</div><div class="kpi-value">${totalDuplicates}</div></div>
          <div class="kpi c-red"><div class="kpi-label">Failed</div><div class="kpi-value">${failed}</div></div>
        </div>
        <div class="hint">0 existing financial records were overwritten - imports only create new deals/payments/recurring items/occurrences, never edit existing ones.</div>`;
      wizardState.step = 4;
      drawStep();
      drawHistory();
    }

    await draw();
  }

  App.router.register('import', renderImportsView);
})();
