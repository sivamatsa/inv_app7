/* Documents (spec Section 29) - Supabase Storage-backed. */
window.App = window.App || {};

(function () {
  const DOC_TYPES = ['Investment Agreement', 'Payment Receipt', 'Lender Statement', 'Bank Statement', 'Maturity Statement', 'Tax Certificate', 'Screenshot', 'Other'];

  async function openUploadModal(deals) {
    const dealOptions = [{ value: '', label: '(general, not deal-specific)' }].concat(deals.map((d) => ({ value: d.id, label: d.deal_name })));
    const fields = [
      { key: 'deal_id', label: 'Deal', type: 'select', numeric: true, options: dealOptions },
      { key: 'document_type', label: 'Document Type', required: true, type: 'select', options: DOC_TYPES },
      { key: 'document_date', label: 'Document Date', type: 'date' },
      { key: 'document_reference', label: 'Reference' },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ];
    App.ui.open({
      title: 'Upload Document',
      bodyHtml: App.ui.renderForm(fields) + '<div class="field span2" style="margin-top:10px"><label>File <span class="req">*</span></label><input type="file" id="docFileInput" style="display:block"></div>',
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Upload', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          const file = App.utils.qs('#docFileInput').files[0];
          if (errors.length || !file) { App.utils.toast('Choose a document type and a file', 'err'); return; }
          try {
            await App.api.uploadDocument(file, { dealId: values.deal_id || null, documentType: values.document_type, documentReference: values.document_reference, documentDate: values.document_date, notes: values.notes });
            App.utils.toast('Document uploaded');
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Upload failed: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  async function renderDocumentsView() {
    const pane = App.utils.qs('#pane-documents');
    pane.innerHTML = `
      <div class="section-title">Documents <div class="line"></div><small>agreements, receipts, statements — all in one place</small></div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <select class="search-input" id="docTypeFilter"><option value="All">All types</option>${DOC_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
          <button class="btn btn-gold btn-sm" id="uploadDocBtn">+ Upload Document</button>
        </div>
        <div class="table-scroll"><table class="data" id="docsTable"></table></div>
      </div>`;

    const deals = await App.api.listDeals();
    const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
    App.utils.qs('#uploadDocBtn', pane).addEventListener('click', () => openUploadModal(deals));
    App.utils.qs('#docTypeFilter', pane).addEventListener('change', draw);

    async function draw() {
      const filterType = App.utils.qs('#docTypeFilter', pane).value;
      const docs = await App.api.listDocuments(filterType === 'All' ? {} : { eq: { document_type: filterType } });
      App.utils.qs('#docsTable', pane).innerHTML = `<thead><tr><th>File</th><th>Type</th><th>Deal</th><th>Date</th><th>Reference</th><th>Actions</th></tr></thead>
        <tbody>${docs.map((d) => `<tr>
          <td>${App.utils.escapeHtml(d.file_name)}</td>
          <td>${d.document_type}</td>
          <td>${App.utils.escapeHtml(d.deal_id ? (dealsById[d.deal_id] || {}).deal_name || '—' : '—')}</td>
          <td>${App.utils.fmtDate(d.document_date)}</td>
          <td>${App.utils.escapeHtml(d.document_reference || '—')}</td>
          <td class="row-actions">
            <button class="icon-btn" data-download="${d.id}" data-path="${App.utils.escapeHtml(d.storage_path)}" title="Download">&#11015;</button>
            <button class="icon-btn del" data-delete="${d.id}" data-path="${App.utils.escapeHtml(d.storage_path)}" title="Delete">&#128465;</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:24px">No documents yet.</td></tr>'}</tbody>`;

      App.utils.qsa('[data-download]', pane).forEach((b) => b.addEventListener('click', async () => {
        try { const url = await App.api.getDocumentUrl(b.dataset.path); window.open(url, '_blank'); }
        catch (e) { App.utils.toast('Could not generate link: ' + (e.message || e), 'err'); }
      }));
      App.utils.qsa('[data-delete]', pane).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this document? This removes the file permanently.')) return;
        try { await App.api.deleteDocument(Number(b.dataset.delete), b.dataset.path); App.utils.toast('Document deleted'); draw(); }
        catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
      }));
    }

    await draw();
  }

  App.router.register('documents', renderDocumentsView);
})();
