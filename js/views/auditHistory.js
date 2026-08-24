/* Audit History (spec Section 30) - read-only view over audit_logs, which
   is populated exclusively by the audit_row_change() trigger (see
   006_audit_imports.sql) - nothing in this app writes to it directly. */
window.App = window.App || {};

(function () {
  async function renderAuditView() {
    const pane = App.utils.qs('#pane-audit');
    pane.innerHTML = `
      <div class="section-title">Audit History <div class="line"></div><small>every change to deals, payments, schedules and reinvestments</small></div>
      <div class="panel">
        <div class="filterbar">
          <div class="filter-group"><label>Table</label>
            <select class="search-input" id="auditTableFilter"><option value="All">All</option><option value="deals">deals</option><option value="payments">payments</option><option value="payment_schedule">payment_schedule</option><option value="reinvestments">reinvestments</option></select>
          </div>
          <div class="filter-group"><label>Action</label>
            <select class="search-input" id="auditActionFilter"><option value="All">All</option><option>INSERT</option><option>UPDATE</option><option>DELETE</option></select>
          </div>
          <div class="filter-group"><label>Search field/value</label><input class="search-input" id="auditSearch"></div>
        </div>
        <div class="table-scroll"><table class="data" id="auditTable"></table></div>
      </div>`;

    App.utils.qs('#auditTableFilter', pane).addEventListener('change', draw);
    App.utils.qs('#auditActionFilter', pane).addEventListener('change', draw);
    App.utils.qs('#auditSearch', pane).addEventListener('input', App.utils.debounce(draw, 250));

    async function draw() {
      const tableFilter = App.utils.qs('#auditTableFilter', pane).value;
      const actionFilter = App.utils.qs('#auditActionFilter', pane).value;
      const search = App.utils.qs('#auditSearch', pane).value.toLowerCase();
      const opts = {};
      if (tableFilter !== 'All') opts.eq = Object.assign({}, opts.eq, { table_name: tableFilter });
      if (actionFilter !== 'All') opts.eq = Object.assign({}, opts.eq, { action: actionFilter });
      let logs = await App.api.listAuditLogs(opts);
      if (search) logs = logs.filter((l) => (String(l.field_name || '') + ' ' + String(l.old_value || '') + ' ' + String(l.new_value || '')).toLowerCase().includes(search));

      App.utils.qs('#auditTable', pane).innerHTML = `<thead><tr><th>When</th><th>Table</th><th>Record</th><th>Action</th><th>Field</th><th>Old Value</th><th>New Value</th><th>Source</th></tr></thead>
        <tbody>${logs.map((l) => `<tr>
          <td>${App.utils.fmtDateTime(l.changed_at)}</td>
          <td>${l.table_name}</td>
          <td>#${l.record_id}</td>
          <td><span class="badge ${l.action === 'INSERT' ? 'st-active' : l.action === 'DELETE' ? 'st-missed' : 'st-pending'}">${l.action}</span></td>
          <td>${App.utils.escapeHtml(l.field_name || '—')}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${App.utils.escapeHtml((l.old_value || '').slice(0, 120))}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${App.utils.escapeHtml((l.new_value || '').slice(0, 120))}</td>
          <td>${l.source}</td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:24px">No audit entries match.</td></tr>'}</tbody>`;
    }

    await draw();
  }

  App.router.register('audit', renderAuditView);
})();
