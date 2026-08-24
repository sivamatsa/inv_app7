/* Personal Notes - a private scratchpad, not shared with anyone (not even
   admin - see 014_community_notes_tickets.sql's RLS comment for why). */
window.App = window.App || {};

(function () {
  function openNoteModal(existing) {
    const fields = [
      { key: 'title', label: 'Title', required: true, span: 2 },
      { key: 'content', label: 'Note', type: 'textarea', rows: 8, span: 2 },
    ];
    App.ui.open({
      title: existing ? 'Edit Note' : 'New Note',
      bodyHtml: App.ui.renderForm(fields, existing || {}),
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Save', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.toast('Give the note a title', 'err'); return; }
          try {
            if (existing) await App.api.updateNote(existing.id, values);
            else await App.api.createNote(values);
            App.utils.toast('Note saved');
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.toast('Could not save note: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  async function renderNotesView() {
    const pane = App.utils.qs('#pane-notes');
    pane.innerHTML = `
      <div class="section-title">Notes <div class="line"></div><small>your own private scratchpad - not visible to anyone else, not even admin</small></div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <input class="search-input" id="notesSearch" placeholder="Search notes...">
          <button class="btn btn-outline btn-sm" id="exportNotesBtn">&#8595; Export</button>
          <button class="btn btn-gold btn-sm" id="newNoteBtn">+ New Note</button>
        </div>
        <div id="notesList" class="card-row" style="flex-wrap:wrap"></div>
      </div>`;

    App.utils.qs('#newNoteBtn', pane).addEventListener('click', () => openNoteModal(null));
    App.utils.qs('#exportNotesBtn', pane).addEventListener('click', async () => {
      try { await App.exportData.exportSection('notes'); } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
    });

    async function draw() {
      const search = (App.utils.qs('#notesSearch', pane).value || '').toLowerCase();
      const notes = await App.api.listNotes();
      const filtered = search ? notes.filter((n) => (n.title + ' ' + (n.content || '')).toLowerCase().includes(search)) : notes;
      App.utils.qs('#notesList', pane).innerHTML = filtered.map((n) => `
        <div class="integration-card" style="min-width:260px;max-width:320px;cursor:pointer" data-note="${n.id}">
          <div class="name">${App.utils.escapeHtml(n.title)}</div>
          <div class="status" style="margin-bottom:8px;white-space:pre-wrap;max-height:80px;overflow:hidden">${App.utils.escapeHtml((n.content || '').slice(0, 200))}</div>
          <div class="status">${App.utils.fmtDateTime(n.updated_at)}</div>
          <div class="row-actions" style="margin-top:8px">
            <button class="icon-btn" data-edit-note="${n.id}">&#9998;</button>
            <button class="icon-btn del" data-delete-note="${n.id}">&#128465;</button>
          </div>
        </div>`).join('') || '<div class="empty-note">No notes yet - click + New Note to add one.</div>';

      App.utils.qsa('[data-edit-note]', pane).forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        openNoteModal(notes.find((n) => n.id === Number(b.dataset.editNote)));
      }));
      App.utils.qsa('[data-delete-note]', pane).forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this note?')) return;
        await App.api.deleteNote(Number(b.dataset.deleteNote));
        draw();
      }));
      App.utils.qsa('[data-note]', pane).forEach((card) => card.addEventListener('click', () => {
        openNoteModal(notes.find((n) => n.id === Number(card.dataset.note)));
      }));
    }

    App.utils.qs('#notesSearch', pane).addEventListener('input', App.utils.debounce(draw, 200));
    await draw();
  }

  App.router.register('notes', renderNotesView);
})();
