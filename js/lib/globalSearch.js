/* Global search (topbar) - searches across Deals, Recurring Investments,
   Contacts, Chat (conversation names), Gold Intelligence (purchases),
   Notes, Message to Us tickets, Platforms, and - admin only - every
   registered user's profile (deep-linking into the Admin oversight page).
   Each query goes through the SAME App.api functions every view already
   uses, so it's automatically subject to the exact same RLS/self-scoping
   rules as everywhere else - there's no separate, wider-reaching search
   backend to keep in sync with the real permission model.

   Deliberately does NOT search message content or call history - that
   would mean paging through every conversation's own history_visible_from
   window per query, a meaningfully bigger feature on its own; conversation
   names and Contacts already cover "who do I need to talk to." */
window.App = window.App || {};

App.globalSearch = (function () {
  function esc(s) { return App.utils.escapeHtml(s == null ? '' : String(s)); }
  const matches = (q, ...fields) => fields.some((f) => f && String(f).toLowerCase().includes(q));

  async function runSearch(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const isAdmin = App.state.profile && App.state.profile.is_admin;

    const tasks = [
      App.api.listDeals().then((rows) => rows
        .filter((d) => matches(q, d.deal_name, d.external_deal_id, d.notes, d.category))
        .slice(0, 6)
        .map((d) => ({
          group: 'Deals', icon: '&#128188;', title: d.deal_name,
          sub: `${d.investment_type || ''} · ${App.utils.fmtMoney(d.invested_amount)}`,
          action: () => { App.router.navigate('deals'); setTimeout(() => App.dealsView.openDealDetail(d.id), 80); },
        }))).catch(() => []),

      App.api.listRecurringItems().then((rows) => rows
        .filter((r) => matches(q, r.item_name, r.provider, r.notes, r.category))
        .slice(0, 6)
        .map((r) => ({
          group: 'Recurring Investments', icon: '&#128257;', title: r.item_name, sub: r.item_type,
          action: () => { App.router.navigate('recurring'); setTimeout(() => App.recurringView.openItemDetail(r.id), 80); },
        }))).catch(() => []),

      App.api.listContacts().then((rows) => rows
        .filter((c) => matches(q, c.full_name, c.display_name, c.company, c.job_title, (c.tags || []).join(' ')))
        .slice(0, 6)
        .map((c) => ({
          group: 'Contacts', icon: '&#128101;', title: c.display_name || c.full_name || '(unnamed)', sub: c.company || '',
          action: () => { App.router.navigate('contacts'); setTimeout(() => App.contactsView.openContactDetail(c.id), 80); },
        }))).catch(() => []),

      App.api.listConversations().then((rows) => rows
        .filter((c) => matches(q, c.name))
        .slice(0, 6)
        .map((c) => ({
          group: 'Chat', icon: '&#128488;', title: c.name, sub: c.type === 'GROUP' ? 'Group' : 'Direct message',
          action: () => { App.router.navigate('chat'); setTimeout(() => App.chatView.openConversation(c.conversation_id), 80); },
        }))).catch(() => []),

      App.api.listGoldPurchases().then((rows) => rows
        .filter((p) => matches(q, p.source, p.notes, p.purity))
        .slice(0, 6)
        .map((p) => ({
          group: 'Gold Intelligence', icon: '&#129689;', title: `${p.purity} purchase · ${App.utils.fmtDate(p.purchase_date)}`,
          sub: p.source || '', action: () => App.router.navigate('gold'),
        }))).catch(() => []),

      App.api.listNotes().then((rows) => rows
        .filter((n) => matches(q, n.title, n.content))
        .slice(0, 6)
        .map((n) => ({
          group: 'Notes', icon: '&#128221;', title: n.title || '(untitled)', sub: (n.content || '').slice(0, 70),
          action: () => App.router.navigate('notes'),
        }))).catch(() => []),

      App.api.listTickets().then((rows) => rows
        .filter((t) => matches(q, t.subject, t.ticket_number))
        .slice(0, 6)
        .map((t) => ({
          group: 'Message to Us', icon: '&#127991;', title: t.subject, sub: t.ticket_number,
          action: () => App.router.navigate('support'),
        }))).catch(() => []),

      App.api.listPlatforms().then((rows) => rows
        .filter((p) => matches(q, p.name, p.investment_type))
        .slice(0, 4)
        .map((p) => ({
          group: 'Platforms', icon: '&#127974;', title: p.name, sub: p.investment_type || '',
          action: () => App.router.navigate('settings'),
        }))).catch(() => []),
    ];

    if (isAdmin) {
      tasks.push(App.api.listAllProfiles().then((rows) => rows
        .filter((u) => matches(q, u.full_name, u.email))
        .slice(0, 6)
        .map((u) => ({
          group: 'Admin — Users', icon: '&#128081;', title: u.full_name || u.email, sub: u.email,
          action: () => { App.router.navigate('admin'); setTimeout(() => App.adminView.openUserDetailModal(u), 80); },
        }))).catch(() => []));
    }

    return (await Promise.all(tasks)).flat();
  }

  // Light, contextual "you might also want" links per result type found -
  // not a separate recommendation engine, just obvious next steps.
  function recommendationsFor(results) {
    const groups = new Set(results.map((r) => r.group));
    const recs = [];
    if (groups.has('Deals')) recs.push({ label: 'View all Deals', action: () => App.router.navigate('deals') });
    if (groups.has('Recurring Investments')) recs.push({ label: 'Open Recurring Investments', action: () => App.router.navigate('recurring') });
    if (groups.has('Contacts')) recs.push({ label: 'Open Contacts', action: () => App.router.navigate('contacts') });
    if (groups.has('Chat')) recs.push({ label: 'Open Chat', action: () => App.router.navigate('chat') });
    if (groups.has('Gold Intelligence')) recs.push({ label: 'Open Gold Intelligence', action: () => App.router.navigate('gold') });
    return recs;
  }

  function hide(container, input) {
    container.style.display = 'none';
    container.innerHTML = '';
  }

  function render(container, results, query) {
    if (!results.length) {
      container.innerHTML = `<div class="empty-note" style="padding:16px">No matches for "${esc(query)}".</div>`;
      container.style.display = 'block';
      return;
    }
    const byGroup = {};
    results.forEach((r) => { (byGroup[r.group] = byGroup[r.group] || []).push(r); });
    const recs = recommendationsFor(results);

    container.innerHTML = Object.keys(byGroup).map((g) => `
      <div style="padding:10px 14px 4px;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--text3);text-transform:uppercase">${esc(g)} (${byGroup[g].length})</div>
      ${byGroup[g].map((r, i) => `<div class="risk-item" data-search-group="${esc(g)}" data-search-index="${i}" style="cursor:pointer;padding:8px 14px;margin:0">
        <div style="font-size:16px;width:20px;text-align:center">${r.icon}</div>
        <div><div class="risk-name">${esc(r.title)}</div>${r.sub ? `<div class="risk-desc">${esc(r.sub)}</div>` : ''}</div>
      </div>`).join('')}
    `).join('') + (recs.length ? `<div style="border-top:1px solid var(--border2);padding:10px 14px;display:flex;gap:8px;flex-wrap:wrap">
      ${recs.map((r, i) => `<button class="btn btn-outline btn-sm" data-search-rec="${i}">${esc(r.label)}</button>`).join('')}
    </div>` : '');
    container.style.display = 'block';

    App.utils.qsa('[data-search-group]', container).forEach((el) => {
      const g = el.dataset.searchGroup, i = Number(el.dataset.searchIndex);
      el.addEventListener('click', () => { byGroup[g][i].action(); hide(container); });
    });
    App.utils.qsa('[data-search-rec]', container).forEach((el) => {
      const i = Number(el.dataset.searchRec);
      el.addEventListener('click', () => { recs[i].action(); hide(container); });
    });
  }

  function wire() {
    const input = App.utils.qs('#globalSearchInput');
    const container = App.utils.qs('#globalSearchResults');
    if (!input || !container) return;

    const runAndRender = App.utils.debounce(async () => {
      const q = input.value;
      if (!q || q.trim().length < 2) { hide(container, input); return; }
      try {
        const results = await runSearch(q);
        render(container, results, q);
      } catch (e) { /* non-fatal - search staying closed is fine */ }
    }, 250);

    input.addEventListener('input', runAndRender);
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) runAndRender(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; hide(container, input); input.blur(); }
    });
    document.addEventListener('click', (e) => {
      if (e.target !== input && !container.contains(e.target)) hide(container, input);
    });
  }

  return { wire };
})();
