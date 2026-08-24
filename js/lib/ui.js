/* Generic modal + form-field rendering shared by every view that needs a
   create/edit dialog (deals, payments, documents, ...). */
window.App = window.App || {};

App.ui = (function () {
  let backdropEl = null;

  function ensureBackdrop() {
    if (backdropEl) return backdropEl;
    backdropEl = App.utils.el(`
      <div class="modal-backdrop" id="sharedModalBackdrop">
        <div class="modal" id="sharedModal">
          <div class="modal-head">
            <div class="modal-title" id="sharedModalTitle"></div>
            <div class="modal-close" id="sharedModalClose">&#10005;</div>
          </div>
          <div id="sharedModalBody"></div>
          <div class="modal-actions" id="sharedModalActions"></div>
        </div>
      </div>`);
    document.body.appendChild(backdropEl);
    App.utils.qs('#sharedModalClose', backdropEl).addEventListener('click', close);
    backdropEl.addEventListener('click', (e) => { if (e.target === backdropEl) close(); });
    return backdropEl;
  }

  function open(opts) {
    const el = ensureBackdrop();
    App.utils.qs('#sharedModalTitle', el).textContent = opts.title || '';
    App.utils.qs('#sharedModal', el).className = 'modal' + (opts.small ? ' modal-sm' : '');
    App.utils.qs('#sharedModalBody', el).innerHTML = opts.bodyHtml || '';
    const actions = App.utils.qs('#sharedModalActions', el);
    actions.innerHTML = '';
    (opts.actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (a.className || 'btn-outline');
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      actions.appendChild(btn);
    });
    el.classList.add('show');
    if (opts.onMount) opts.onMount(App.utils.qs('#sharedModalBody', el));
  }

  function close() {
    if (backdropEl) backdropEl.classList.remove('show');
  }

  // ---- field rendering, mirrors the reference dashboard's manual-form pattern ----
  function fieldHtml(f, value) {
    const id = 'fld_' + f.key;
    const span = f.span ? ` span${f.span}` : '';
    const label = `<label>${f.label}${f.required ? ' <span class="req">*</span>' : ''}</label>`;
    let input;
    if (f.type === 'select') {
      const opts = (f.options || []).map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? o.label : o;
        return `<option value="${App.utils.escapeHtml(v)}" ${String(value) === String(v) ? 'selected' : ''}>${App.utils.escapeHtml(l)}</option>`;
      }).join('');
      input = `<select id="${id}" ${f.required ? 'required' : ''}><option value="">—</option>${opts}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea id="${id}" rows="${f.rows || 2}">${App.utils.escapeHtml(value || '')}</textarea>`;
    } else if (f.type === 'checkbox') {
      input = `<select id="${id}"><option value="false" ${!value ? 'selected' : ''}>No</option><option value="true" ${value ? 'selected' : ''}>Yes</option></select>`;
    } else {
      const type = f.type || 'text';
      const step = type === 'number' ? ' step="any"' : '';
      input = `<input type="${type}" id="${id}"${step} value="${value === null || value === undefined ? '' : App.utils.escapeHtml(value)}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${App.utils.escapeHtml(f.placeholder)}"` : ''}>`;
    }
    return `<div class="field${span}">${label}${input}<div class="field-error" id="err_${f.key}"></div></div>`;
  }

  function renderForm(fields, values) {
    values = values || {};
    return `<div class="form-grid">${fields.map((f) => fieldHtml(f, values[f.key])).join('')}</div>`;
  }

  function readForm(fields) {
    const out = {};
    const errors = [];
    fields.forEach((f) => {
      const elx = App.utils.qs('#fld_' + f.key);
      const errEl = App.utils.qs('#err_' + f.key);
      if (errEl) errEl.textContent = '';
      if (!elx) return;
      let v = elx.value;
      if (f.type === 'number') v = v === '' ? null : App.utils.parseNum(v);
      else if (f.type === 'checkbox') v = v === 'true';
      // <select> element values are always strings, even when built from
      // numeric ids (options: [{value: someRow.id, label: ...}]) - without
      // this, a field like deal_id/platform_id round-trips as "2" instead
      // of 2, which a strict backend (or a RPC parameter typed bigint) can
      // reject or silently mismatch on.
      else if (f.type === 'select' && f.numeric) v = v === '' ? null : App.utils.parseNum(v);
      else if (v === '') v = null;
      if (f.required && (v === null || v === undefined || v === '')) {
        errors.push(f.key);
        if (errEl) errEl.textContent = 'Required';
      }
      out[f.key] = v;
    });
    return { values: out, errors };
  }

  return { open, close, renderForm, readForm, fieldHtml };
})();
