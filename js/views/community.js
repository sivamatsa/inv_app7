/* Community messaging - one shared room, open to every signed-in user
   (spec ask: "anyone can join and ask doubts"). Deliberately the one place
   in this app where messages are visible across users by design, not a
   gap - see community_messages' RLS in 014_community_notes_tickets.sql.
   Realtime via Supabase Postgres Changes: new messages appear for everyone
   currently on this view without a reload or poll. */
window.App = window.App || {};

(function () {
  let cachedMessages = [];
  let nameCache = {};

  function scrollToBottom(container) {
    container.scrollTop = container.scrollHeight;
  }

  function renderMessages(container) {
    container.innerHTML = cachedMessages.map((m) => {
      const mine = m.user_id === App.auth.getUser().id;
      const name = mine ? 'You' : (nameCache[m.user_id] || 'User');
      return `<div style="margin-bottom:10px;text-align:${mine ? 'right' : 'left'}">
        <div style="font-size:10.5px;color:var(--text3);margin-bottom:2px">${App.utils.escapeHtml(name)} &middot; ${App.utils.fmtDateTime(m.created_at)}</div>
        <div style="display:inline-block;max-width:70%;padding:8px 12px;border-radius:10px;font-size:12.5px;text-align:left;
          background:${mine ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.04)'};border:1px solid var(--border2)">${App.utils.escapeHtml(m.message)}</div>
      </div>`;
    }).join('') || '<div class="empty-note">No messages yet - say hello.</div>';
    scrollToBottom(container);
  }

  async function renderCommunityView() {
    const pane = App.utils.qs('#pane-community');
    pane.innerHTML = `
      <div class="section-title">Community <div class="line"></div><small>one shared room - anyone signed in can read and post</small></div>
      <div class="panel">
        <div id="communityMessages" style="height:420px;overflow-y:auto;padding:8px;margin-bottom:12px;border:1px solid var(--border2);border-radius:10px"></div>
        <div style="display:flex;gap:8px">
          <input class="search-input" id="communityInput" placeholder="Ask a question..." style="flex:1">
          <button class="btn btn-gold" id="communitySendBtn">Send</button>
        </div>
      </div>`;

    const container = App.utils.qs('#communityMessages', pane);

    async function loadAll() {
      cachedMessages = await App.api.listCommunityMessages();
      const ids = [...new Set(cachedMessages.map((m) => m.user_id))].filter((id) => id !== App.auth.getUser().id);
      if (ids.length) {
        try { nameCache = Object.assign(nameCache, await App.api.getDisplayNames(ids)); } catch (e) { /* names are a nicety */ }
      }
      renderMessages(container);
    }

    async function send() {
      const input = App.utils.qs('#communityInput', pane);
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await App.api.postCommunityMessage(text);
        // The realtime callback below will also append this once it comes
        // back through the subscription; append optimistically too so
        // sending feels instant even if the realtime round-trip is slow.
      } catch (e) { App.utils.toast('Could not send: ' + (e.message || e), 'err'); }
    }

    App.utils.qs('#communitySendBtn', pane).addEventListener('click', send);
    App.utils.qs('#communityInput', pane).addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    const channel = App.api.subscribeToCommunityMessages(async (row) => {
      if (cachedMessages.some((m) => m.id === row.id)) return;
      cachedMessages.push(row);
      if (row.user_id !== App.auth.getUser().id && !nameCache[row.user_id]) {
        try { nameCache = Object.assign(nameCache, await App.api.getDisplayNames([row.user_id])); } catch (e) { /* nicety */ }
      }
      renderMessages(App.utils.qs('#communityMessages'));
    });
    App.router.onLeave(() => App.api.unsubscribe(channel));

    await loadAll();
  }

  App.router.register('community', renderCommunityView);
})();
