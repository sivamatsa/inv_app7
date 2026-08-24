/* Help & Support (formerly "Message to Us") - a structured entry point
   (Get Help), the user's own ticket history (My Requests), their own
   submitted ideas (My Suggestions), and a shared, votable roadmap of every
   suggestion (Roadmap). Admin's OWN ticket/suggestion management (status,
   assignment, priority, internal notes) now lives in two dedicated Admin
   panels (034_help_support_suggestions.sql) - this view is deliberately the
   same experience for every user, admin included, when it's THEIR OWN
   requests/ideas being looked at. */
window.App = window.App || {};

(function () {
  const TICKET_STATUS_OPTIONS = ['New', 'Acknowledged', 'In Progress', 'Waiting for User', 'Waiting for Admin', 'Resolved', 'Closed', 'Rejected', 'Reopened'];
  const SUGGESTION_STATUS_OPTIONS = ['Submitted', 'Under Review', 'Accepted', 'Planned', 'In Development', 'Testing', 'Released', 'Rejected', 'Duplicate', 'Archived'];
  const SUGGESTION_CATEGORIES = ['New Feature', 'Existing Feature Improvement', 'UI/UX', 'AI Suggestion', 'Integration', 'Other'];

  // Section 2's structured entry grid - each option is either a Support
  // ticket (kind: 'ticket') or a Feature Suggestion (kind: 'suggestion'),
  // deliberately routed to two completely separate forms/tables rather than
  // one generic form with a type dropdown, per the spec's own instruction.
  const HELP_CATEGORIES = [
    { group: 'Account & Login', items: [
      { icon: '🆕', label: 'Cannot create account', category: 'Cannot Create Account', kind: 'ticket' },
      { icon: '🔐', label: 'Forgot password', category: 'Forgot Password', kind: 'ticket' },
      { icon: '📧', label: 'Email verification issue', category: 'Email Verification Issue', kind: 'ticket' },
      { icon: '🚫', label: 'Account locked/disabled', category: 'Account Locked', kind: 'ticket' },
      { icon: '🔑', label: 'Cannot log in', category: 'Cannot Log In', kind: 'ticket' },
      { icon: '📱', label: 'Other account issue', category: 'Other Account Issue', kind: 'ticket' },
    ] },
    { group: 'Portfolio Support', items: [
      { icon: '💰', label: 'Investment/deal issue', category: 'Investment/Deal Issue', kind: 'ticket' },
      { icon: '📊', label: 'Dashboard issue', category: 'Dashboard Issue', kind: 'ticket' },
      { icon: '📥', label: 'Excel/import issue', category: 'Excel/Import Issue', kind: 'ticket' },
      { icon: '🔔', label: 'Notification/reminder issue', category: 'Notification/Reminder Issue', kind: 'ticket' },
      { icon: '🥇', label: 'Gold Intelligence issue', category: 'Gold Intelligence Issue', kind: 'ticket' },
      { icon: '📄', label: 'Document issue', category: 'Document Issue', kind: 'ticket' },
      { icon: '💬', label: 'Chat/contact issue', category: 'Chat/Contact Issue', kind: 'ticket' },
      { icon: '🐛', label: 'Report a problem', category: 'Report a Problem', kind: 'ticket' },
      { icon: '🚨', label: 'Security report', category: 'Security Report', kind: 'ticket' },
    ] },
    { group: 'Suggestions & Ideas', items: [
      { icon: '💡', label: 'Suggest new feature', category: 'New Feature', kind: 'suggestion' },
      { icon: '🚀', label: 'Improve existing feature', category: 'Existing Feature Improvement', kind: 'suggestion' },
      { icon: '🎨', label: 'UI/UX suggestion', category: 'UI/UX', kind: 'suggestion' },
      { icon: '🤖', label: 'AI feature suggestion', category: 'AI Suggestion', kind: 'suggestion' },
      { icon: '🔗', label: 'Integration suggestion', category: 'Integration', kind: 'suggestion' },
      { icon: '💬', label: 'General feedback', category: 'Other', kind: 'suggestion' },
    ] },
    { group: 'Other', items: [
      { icon: '✍️', label: 'Ask a question', category: 'General Question', kind: 'ticket' },
      { icon: '📩', label: 'Contact administrator', category: 'Contact Administrator', kind: 'ticket' },
    ] },
  ];

  // Section 29's "search knowledge base first" step - deliberately a simple
  // keyword search over existing Blog posts, not a conversational AI (this
  // app's established "rule-based, not a live model call" precedent). Shows
  // matches with a Yes/No branch; either answer leads to onProceed(), the
  // ticket/suggestion form is never skipped, just possibly avoided.
  async function searchBlogThenAct(searchLabel, onProceed) {
    let posts = [];
    try { posts = await App.api.listBlogPosts(); } catch (e) { /* Blog is optional context, not a hard dependency */ }
    const words = searchLabel.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const matches = posts.filter((p) => {
      const haystack = `${p.title} ${p.content || ''}`.toLowerCase();
      return words.some((w) => haystack.includes(w));
    }).slice(0, 3);

    if (!matches.length) { onProceed(); return; }

    App.ui.open({
      title: '🤖 A few things that might help',
      bodyHtml: `<div class="hint" style="margin-bottom:10px">Found ${matches.length} related post(s) in the Blog:</div>
        ${matches.map((p) => `<div class="integration-card" style="margin-bottom:8px"><div class="name">${App.utils.escapeHtml(p.title)}</div>
          <div class="status">${App.utils.escapeHtml((p.content || '').slice(0, 120))}...</div></div>`).join('')}
        <div class="hint" style="margin-top:10px">Did this answer your question?</div>`,
      actions: [
        { label: 'Yes, thanks!', className: 'btn-teal', onClick: App.ui.close },
        { label: 'No, I still need help', className: 'btn-gold', onClick: () => { App.ui.close(); onProceed(); } },
      ],
    });
  }

  function openNewTicketModal(prefillCategory) {
    const fields = [
      { key: 'category', label: 'Category', type: 'select', required: true, options: HELP_CATEGORIES.flatMap((g) => g.items.filter((i) => i.kind === 'ticket').map((i) => i.category)).filter((v, i, a) => a.indexOf(v) === i), span: 2 },
      { key: 'subject', label: 'Subject', required: true, span: 2 },
      { key: 'message', label: 'Describe your issue', type: 'textarea', rows: 5, span: 2, required: true },
    ];
    const values = { category: prefillCategory || 'General Question' };
    App.ui.open({
      title: 'New Support Ticket',
      bodyHtml: App.ui.renderForm(fields, values) + '<div class="auth-error" id="newTicketError"></div>',
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Submit', className: 'btn-gold', onClick: async () => {
          const { values: v, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#newTicketError').textContent = 'Fill in category, subject, and message'; return; }
          try {
            const ticket = await App.api.createTicket({ subject: v.subject, category: v.category });
            await App.api.postTicketMessage(ticket.id, v.message, false);
            App.utils.toast(`Ticket ${ticket.ticket_number} created`);
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.qs('#newTicketError').textContent = 'Could not create ticket: ' + (e.message || e); }
        } },
      ],
    });
  }

  // Section 24's duplicate-detection: a simple client-side keyword-overlap
  // search over already-fetched suggestion titles, not a new Postgres
  // extension or an AI call - matches this app's "rule-based, not AI"
  // precedent (AI Insights, the Interest Calculator's portfolio comparison).
  async function findSimilarSuggestions(title) {
    if (!title || title.trim().length < 4) return [];
    const all = await App.api.listFeatureSuggestions().catch(() => []);
    const words = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) return [];
    return all.filter((s) => {
      const haystack = s.title.toLowerCase();
      return words.filter((w) => haystack.includes(w)).length >= Math.min(2, words.length);
    }).slice(0, 3);
  }

  function openNewSuggestionModal(prefillCategory, prefillRelatedFeature) {
    const fields = [
      { key: 'title', label: 'Suggestion Title', required: true, span: 2 },
      { key: 'category', label: 'Category', type: 'select', required: true, options: SUGGESTION_CATEGORIES },
      { key: 'priority', label: 'Priority', type: 'select', options: ['Critical', 'High', 'Medium', 'Low'] },
      { key: 'related_feature', label: 'Related Feature (optional)' },
      { key: 'description', label: 'Description', type: 'textarea', rows: 3, span: 2 },
      { key: 'problem_being_solved', label: 'Problem Being Solved', type: 'textarea', rows: 2, span: 2 },
      { key: 'suggested_solution', label: 'Suggested Solution', type: 'textarea', rows: 2, span: 2 },
      { key: 'expected_benefit', label: 'Expected Benefit', type: 'textarea', rows: 2, span: 2 },
      { key: 'notify_on_implement', label: 'Notify me if this feature is implemented?', type: 'checkbox' },
    ];
    const values = {
      category: prefillCategory || 'New Feature', priority: 'Medium',
      related_feature: prefillRelatedFeature || '', notify_on_implement: true,
    };
    App.ui.open({
      title: 'New Suggestion',
      bodyHtml: `<div id="suggFormHost"></div><div id="similarSuggHost"></div><div class="auth-error" id="newSuggError"></div>`,
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Submit', className: 'btn-gold', onClick: async () => {
          const { values: v, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.qs('#newSuggError').textContent = 'Title and category are required.'; return; }
          try {
            const created = await App.api.createFeatureSuggestion({
              title: v.title, category: v.category, priority: v.priority || 'Medium',
              related_feature: v.related_feature || null, description: v.description || null,
              problem_being_solved: v.problem_being_solved || null, suggested_solution: v.suggested_solution || null,
              expected_benefit: v.expected_benefit || null, notify_on_implement: v.notify_on_implement !== false,
            });
            App.utils.toast(`Suggestion ${created.suggestion_number} submitted`);
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.qs('#newSuggError').textContent = 'Could not submit suggestion: ' + (e.message || e); }
        } },
      ],
      onMount: (body) => {
        App.utils.qs('#suggFormHost', body).innerHTML = App.ui.renderForm(fields, values);
        let debounceTimer = null;
        App.utils.qs('#fld_title', body).addEventListener('input', (e) => {
          clearTimeout(debounceTimer);
          const title = e.target.value;
          debounceTimer = setTimeout(async () => {
            const similar = await findSimilarSuggestions(title);
            const host = App.utils.qs('#similarSuggHost', body);
            host.innerHTML = similar.length ? `<div class="hint" style="color:var(--gold);margin:8px 0">A similar suggestion already exists:</div>
              ${similar.map((s) => `<div class="integration-card" style="margin-bottom:6px"><div class="name">${App.utils.escapeHtml(s.title)}</div>
                <div class="status">Status: ${s.status} &middot; <a href="#" data-vote-instead="${s.id}">Support this idea instead &rarr;</a></div></div>`).join('')}` : '';
            App.utils.qsa('[data-vote-instead]', host).forEach((a) => a.addEventListener('click', async (e2) => {
              e2.preventDefault();
              try { await App.api.voteSuggestion(Number(a.dataset.voteInstead)); App.utils.toast('Vote added - thanks!'); App.ui.close(); App.router.navigate('support'); }
              catch (err) { App.utils.toast('Could not vote: ' + (err.message || err), 'err'); }
            }));
          }, 400);
        });
      },
    });
  }

  async function openTicketDetail(ticket) {
    const messages = await App.api.listTicketMessages(ticket.id);
    const myId = App.auth.getUser().id;

    function messageHtml(m) {
      const fromAdmin = m.is_admin_reply;
      return `<div style="margin-bottom:10px;text-align:${fromAdmin ? 'left' : 'right'}">
        <div style="font-size:10.5px;color:var(--text3);margin-bottom:2px">${fromAdmin ? 'Support' : 'You'} &middot; ${App.utils.fmtDateTime(m.created_at)}</div>
        <div style="display:inline-block;max-width:75%;padding:8px 12px;border-radius:10px;font-size:12.5px;text-align:left;
          background:${fromAdmin ? 'rgba(76,155,232,0.15)' : 'rgba(201,168,76,0.15)'};border:1px solid var(--border2)">${App.utils.escapeHtml(m.message)}</div>
      </div>`;
    }

    const bodyHtml = `
      <div class="hint" style="margin-bottom:6px">${App.utils.escapeHtml(ticket.subject)} - opened ${App.utils.fmtDateTime(ticket.created_at)}</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <span class="badge ${App.utils.statusBadgeClass(ticket.status)}">${ticket.status}</span>
        <span class="hint" style="margin:0">${App.utils.escapeHtml(ticket.category || 'General Question')}</span>
      </div>
      <div id="ticketThread" style="height:320px;overflow-y:auto;padding:8px;margin-bottom:12px;border:1px solid var(--border2);border-radius:10px">
        ${messages.map(messageHtml).join('') || '<div class="empty-note">No messages yet.</div>'}
      </div>
      ${ticket.status !== 'Closed' && ticket.status !== 'Rejected' ? `<div style="display:flex;gap:8px">
        <input class="search-input" id="ticketReplyInput" placeholder="Type a reply..." style="flex:1">
        <button class="btn btn-gold" id="ticketReplyBtn">Reply</button>
      </div>` : '<div class="hint">This ticket is closed.</div>'}
      ${ticket.status === 'Resolved' && !ticket.resolution_rating && ticket.user_id === myId ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border2)">
          <div class="hint" style="margin-bottom:6px">Was your issue resolved?</div>
          <div id="ratingStars" style="font-size:22px;cursor:pointer;letter-spacing:4px">☆☆☆☆☆</div>
          <input class="search-input" id="resolutionComment" placeholder="Additional feedback (optional)" style="margin-top:8px;width:100%">
          <button class="btn btn-outline btn-sm" id="submitRatingBtn" style="margin-top:8px">Submit Feedback</button>
        </div>` : ''}`;

    let channel = null;
    App.ui.open({
      title: ticket.ticket_number,
      bodyHtml,
      actions: [{ label: 'Close', className: 'btn-outline', onClick: () => { App.api.unsubscribe(channel); App.ui.close(); } }],
      onMount: (body) => {
        const thread = App.utils.qs('#ticketThread', body);
        const scrollBottom = () => { thread.scrollTop = thread.scrollHeight; };
        scrollBottom();

        async function reply() {
          const input = App.utils.qs('#ticketReplyInput', body);
          if (!input) return;
          const text = input.value.trim();
          if (!text) return;
          input.value = '';
          try { await App.api.postTicketMessage(ticket.id, text, false); }
          catch (e) { App.utils.toast('Could not send reply: ' + (e.message || e), 'err'); }
        }
        const replyBtn = App.utils.qs('#ticketReplyBtn', body);
        if (replyBtn) {
          replyBtn.addEventListener('click', reply);
          App.utils.qs('#ticketReplyInput', body).addEventListener('keydown', (e) => { if (e.key === 'Enter') reply(); });
        }

        let rating = 0;
        const starsEl = App.utils.qs('#ratingStars', body);
        if (starsEl) {
          starsEl.addEventListener('click', (e) => {
            const rect = starsEl.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            rating = Math.max(1, Math.min(5, Math.ceil(pct * 5)));
            starsEl.textContent = '★'.repeat(rating) + '☆'.repeat(5 - rating);
          });
          App.utils.qs('#submitRatingBtn', body).addEventListener('click', async () => {
            if (!rating) { App.utils.toast('Pick a star rating first', 'err'); return; }
            try {
              await App.api.rateTicketResolution(ticket.id, rating, App.utils.qs('#resolutionComment', body).value.trim() || null);
              App.utils.toast('Thanks for the feedback!');
              App.ui.close();
            } catch (e) { App.utils.toast('Could not save feedback: ' + (e.message || e), 'err'); }
          });
        }

        channel = App.api.subscribeToTicketMessages(ticket.id, (row) => {
          thread.insertAdjacentHTML('beforeend', messageHtml(row));
          scrollBottom();
        });
        App.router.onLeave(() => App.api.unsubscribe(channel));
      },
    });
  }

  async function drawGetHelpTab(container) {
    container.innerHTML = HELP_CATEGORIES.map((g) => `
      <div class="hint" style="font-weight:600;margin:14px 0 8px">${g.group}</div>
      <div class="card-row">${g.items.map((it) => `
        <div class="integration-card" data-help-cat="${App.utils.escapeHtml(it.category)}" data-help-kind="${it.kind}" style="cursor:pointer;min-width:160px">
          <div class="name">${it.icon} ${App.utils.escapeHtml(it.label)}</div>
        </div>`).join('')}</div>`).join('');

    App.utils.qsa('[data-help-cat]', container).forEach((el) => el.addEventListener('click', () => {
      const category = el.dataset.helpCat, kind = el.dataset.helpKind;
      searchBlogThenAct(el.textContent, () => {
        if (kind === 'suggestion') openNewSuggestionModal(category);
        else openNewTicketModal(category);
      });
    }));
  }

  async function drawMyRequestsTab(container) {
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="chip-row" id="ticketStatusFilter">${['All', ...TICKET_STATUS_OPTIONS].map((s) => `<div class="chip ${s === 'All' ? 'active' : ''}" data-status-filter="${s}">${s}</div>`).join('')}</div>
        <button class="btn btn-gold btn-sm" id="newTicketBtn">+ New Ticket</button>
      </div>
      <div class="table-scroll"><table class="data" id="ticketsTable"></table></div>`;

    App.utils.qs('#newTicketBtn', container).addEventListener('click', () => openNewTicketModal());

    let statusFilter = 'All';
    async function draw() {
      const tickets = await App.api.listTickets({ eq: { user_id: App.auth.getUser().id } });
      const filtered = statusFilter === 'All' ? tickets : tickets.filter((t) => t.status === statusFilter);

      App.utils.qs('#ticketsTable', container).innerHTML = `<thead><tr><th>Ticket</th><th>Category</th><th>Subject</th><th>Status</th><th>Opened</th><th></th></tr></thead>
        <tbody>${filtered.map((t) => `<tr>
          <td>${t.ticket_number}</td>
          <td>${App.utils.escapeHtml(t.category || '—')}</td>
          <td>${App.utils.escapeHtml(t.subject)}</td>
          <td><span class="badge ${App.utils.statusBadgeClass(t.status)}">${t.status}</span></td>
          <td>${App.utils.fmtDate(t.created_at)}</td>
          <td><button class="btn btn-sm btn-outline" data-open-ticket="${t.id}">Open</button></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">No tickets.</td></tr>'}</tbody>`;

      App.utils.qsa('[data-open-ticket]', container).forEach((b) => b.addEventListener('click', () => {
        openTicketDetail(filtered.find((t) => t.id === Number(b.dataset.openTicket)));
      }));
    }

    App.utils.qsa('[data-status-filter]', container).forEach((chip) => chip.addEventListener('click', () => {
      statusFilter = chip.dataset.statusFilter;
      App.utils.qsa('[data-status-filter]', container).forEach((c) => c.classList.toggle('active', c === chip));
      draw();
    }));

    await draw();
  }

  function suggestionCardHtml(s, voteCount, hasVoted, showVoteBtn) {
    return `<div class="panel" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-weight:600;font-size:13.5px">${App.utils.escapeHtml(s.title)}</div>
          <div class="hint" style="margin:2px 0">${s.suggestion_number} &middot; ${App.utils.escapeHtml(s.category)}</div>
        </div>
        <span class="badge ${App.utils.statusBadgeClass(s.status)}">${s.status}</span>
      </div>
      ${s.description ? `<div class="hint" style="margin-top:6px">${App.utils.escapeHtml(s.description)}</div>` : ''}
      ${showVoteBtn ? `<button class="btn btn-sm ${hasVoted ? 'btn-teal' : 'btn-outline'}" data-vote-suggestion="${s.id}" style="margin-top:8px">&#128077; ${voteCount || 0}${hasVoted ? ' (voted)' : ''}</button>` : `<div class="hint" style="margin-top:8px">&#128077; ${voteCount || 0} vote(s)</div>`}
    </div>`;
  }

  async function drawMySuggestionsTab(container) {
    const [mySuggestions, voteCounts] = await Promise.all([
      App.api.listFeatureSuggestions({ eq: { user_id: App.auth.getUser().id } }),
      App.api.listSuggestionVoteCounts(),
    ]);
    const votesBySuggestion = {}; voteCounts.forEach((v) => { votesBySuggestion[v.suggestion_id] = v.vote_count; });
    container.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px"><button class="btn btn-gold btn-sm" id="newSuggBtnMine">+ New Suggestion</button></div>
      ${mySuggestions.map((s) => suggestionCardHtml(s, votesBySuggestion[s.id], false, false)).join('') || '<div class="empty-note">You haven\'t submitted any suggestions yet.</div>'}`;
    App.utils.qs('#newSuggBtnMine', container).addEventListener('click', () => openNewSuggestionModal());
  }

  async function drawRoadmapTab(container) {
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="chip-row" id="suggStatusFilter">${['All', ...SUGGESTION_STATUS_OPTIONS].map((s) => `<div class="chip ${s === 'All' ? 'active' : ''}" data-sugg-status-filter="${s}">${s}</div>`).join('')}</div>
        <button class="btn btn-gold btn-sm" id="newSuggBtnRoadmap">+ New Suggestion</button>
      </div>
      <div id="roadmapList"></div>`;
    App.utils.qs('#newSuggBtnRoadmap', container).addEventListener('click', () => openNewSuggestionModal());

    let statusFilter = 'All';
    async function draw() {
      const [all, voteCounts, myVotes] = await Promise.all([
        App.api.listFeatureSuggestions(), App.api.listSuggestionVoteCounts(), App.api.listMyVotes(),
      ]);
      const votesBySuggestion = {}; voteCounts.forEach((v) => { votesBySuggestion[v.suggestion_id] = v.vote_count; });
      const myVoteIds = new Set(myVotes.map((v) => v.suggestion_id));
      let filtered = statusFilter === 'All' ? all : all.filter((s) => s.status === statusFilter);
      filtered = filtered.slice().sort((a, b) => (votesBySuggestion[b.id] || 0) - (votesBySuggestion[a.id] || 0));

      App.utils.qs('#roadmapList', container).innerHTML = filtered.map((s) => suggestionCardHtml(s, votesBySuggestion[s.id], myVoteIds.has(s.id), true)).join('')
        || '<div class="empty-note">No suggestions yet - be the first!</div>';

      App.utils.qsa('[data-vote-suggestion]', container).forEach((b) => b.addEventListener('click', async () => {
        const id = Number(b.dataset.voteSuggestion);
        try {
          if (myVoteIds.has(id)) await App.api.unvoteSuggestion(id); else await App.api.voteSuggestion(id);
          draw();
        } catch (e) { App.utils.toast('Could not update vote: ' + (e.message || e), 'err'); }
      }));
    }

    App.utils.qsa('[data-sugg-status-filter]', container).forEach((chip) => chip.addEventListener('click', () => {
      statusFilter = chip.dataset.suggStatusFilter;
      App.utils.qsa('[data-sugg-status-filter]', container).forEach((c) => c.classList.toggle('active', c === chip));
      draw();
    }));

    await draw();
  }

  const TABS = [
    { key: 'help', label: 'Get Help', draw: drawGetHelpTab },
    { key: 'requests', label: 'My Requests', draw: drawMyRequestsTab },
    { key: 'suggestions', label: 'My Suggestions', draw: drawMySuggestionsTab },
    { key: 'roadmap', label: 'Roadmap', draw: drawRoadmapTab },
  ];

  async function renderSupportView() {
    const pane = App.utils.qs('#pane-support');
    pane.innerHTML = `
      <div class="section-title">Help &amp; Support <div class="line"></div><small>get help, raise a request, or suggest an idea</small></div>
      <div class="panel">
        <div class="tabbar" id="helpTabs">${TABS.map((t, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}</div>
        ${TABS.map((t, i) => `<div class="tab-pane ${i === 0 ? 'active' : ''}" data-pane="${t.key}" id="supportTab-${t.key}"></div>`).join('')}
      </div>`;

    App.utils.qsa('.tab-btn', pane).forEach((btn) => btn.addEventListener('click', async () => {
      App.utils.qsa('.tab-btn', pane).forEach((b) => b.classList.toggle('active', b === btn));
      App.utils.qsa('.tab-pane', pane).forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
      const tab = TABS.find((t) => t.key === btn.dataset.tab);
      await tab.draw(App.utils.qs(`#supportTab-${tab.key}`, pane));
    }));

    await TABS[0].draw(App.utils.qs(`#supportTab-${TABS[0].key}`, pane));
  }

  App.router.register('support', renderSupportView);
  App.supportView = { openNewSuggestionModal, openNewTicketModal };
})();
