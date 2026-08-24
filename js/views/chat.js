/* Private/Group Chat (spec addendum Sections 10-16, 22, 30-32, 40) -
   deliberately separate from Community Discussion (community.js, one
   shared open room) and Write to Us (support.js) - nothing here reads or
   writes either of those tables.

   Threads open as a modal (App.ui) rather than a second-level route, same
   interaction model as every detail view elsewhere in this app. Realtime
   subscriptions are torn down both by the modal's own Close button AND via
   App.router.onLeave (belt-and-suspenders, same pattern support.js's
   ticket detail already uses) since the shared modal has no generic
   on-close hook of its own. */
window.App = window.App || {};

(function () {
  const QUICK_EMOJI = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F64F}', '\u{1F62E}'];
  const MUTE_OPTIONS = [
    { label: '1 hour', ms: 3600000 }, { label: '8 hours', ms: 8 * 3600000 },
    { label: '1 week', ms: 7 * 86400000 }, { label: 'Always', ms: null },
  ];
  const HISTORY_OPTIONS = [
    { label: 'No history', cutoff: () => new Date().toISOString() },
    { label: 'Past hour', cutoff: () => new Date(Date.now() - 3600000).toISOString() },
    { label: 'Today', cutoff: () => new Date(new Date().setHours(0, 0, 0, 0)).toISOString() },
    { label: 'Past week', cutoff: () => new Date(Date.now() - 7 * 86400000).toISOString() },
    { label: 'All', cutoff: () => null },
  ];

  function initials(name) {
    const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '')[0] || '?') + ((parts[1] || '')[0] || '');
  }

  // Contacts hold the human-readable name for a linked_user_id; profiles
  // RLS otherwise only exposes your own row. Cached per render pass.
  async function nameForUser(userId, contactsByLinkedUser) {
    const c = contactsByLinkedUser[userId];
    if (c) return c.display_name || c.full_name;
    const map = await App.api.getDisplayNames([userId]).catch(() => ({}));
    return map[userId] || 'User';
  }

  async function conversationTitle(conv, contactsByLinkedUser) {
    if (conv.type === 'GROUP') return conv.name || 'Group';
    const members = await App.api.listConversationMembers(conv.conversation_id || conv.id);
    const other = members.find((m) => m.user_id !== App.auth.getUser().id);
    return other ? await nameForUser(other.user_id, contactsByLinkedUser) : 'Direct message';
  }

  // ---- Inbox ----
  let inboxFilter = 'All';
  let activeCleanup = null;

  async function renderChatView() {
    const pane = App.utils.qs('#pane-chat');
    pane.innerHTML = `
      <div class="section-title">Chat <div class="line"></div><small>private messages - separate from Community &amp; Write to Us</small></div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <div class="chip-row" id="chatFilterChips">${['All', 'Unread', 'Groups', 'Favorites', 'Archived'].map((f) => `<div class="chip ${inboxFilter === f ? 'active' : ''}" data-inbox-filter="${f}">${f}</div>`).join('')}</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" id="newGroupBtn">+ New Group</button>
            <button class="btn btn-gold btn-sm" id="newChatBtn">+ New Chat</button>
          </div>
        </div>
        <div id="chatInboxList"></div>
      </div>`;

    App.utils.qs('#newChatBtn', pane).addEventListener('click', openNewChatModal);
    App.utils.qs('#newGroupBtn', pane).addEventListener('click', openNewGroupModal);
    App.utils.qsa('[data-inbox-filter]', pane).forEach((chip) => chip.addEventListener('click', () => {
      inboxFilter = chip.dataset.inboxFilter;
      App.utils.qsa('[data-inbox-filter]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      draw();
    }));

    async function draw() {
      const [convs, contacts] = await Promise.all([App.api.listConversations(), App.api.listContacts()]);
      const contactsByLinkedUser = {};
      contacts.forEach((c) => { if (c.linked_user_id) contactsByLinkedUser[c.linked_user_id] = c; });

      let list = convs.filter((c) => c.type); // drop any row whose conversation failed to load
      if (inboxFilter === 'Unread') list = list.filter((c) => c.unread_count > 0);
      else if (inboxFilter === 'Groups') list = list.filter((c) => c.type === 'GROUP');
      else if (inboxFilter === 'Favorites') list = list.filter((c) => c.pinned);
      else if (inboxFilter === 'Archived') list = list.filter((c) => c.archived);
      else list = list.filter((c) => !c.archived);

      list.sort((a, b) => (b.pinned - a.pinned) || (new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)));

      const titles = await Promise.all(list.map((c) => conversationTitle(c, contactsByLinkedUser)));
      const host = App.utils.qs('#chatInboxList', pane);
      host.innerHTML = list.map((c, i) => `
        <div class="risk-item" style="cursor:pointer" data-open-conv="${c.conversation_id}">
          <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold2));color:var(--on-gold);display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${initials(titles[i])}</div>
          <div style="flex:1;min-width:0">
            <div class="risk-name">${c.pinned ? '&#128204; ' : ''}${App.utils.escapeHtml(titles[i])}${c.type === 'GROUP' ? ' <span class="badge st-upcoming">Group</span>' : ''}</div>
            <div class="risk-desc">${c.last_message_at ? App.utils.fmtDateTime(c.last_message_at) : 'No messages yet'}${c.muted_until && new Date(c.muted_until) > new Date() ? ' &middot; Muted' : ''}</div>
          </div>
          ${c.unread_count ? `<span class="nav-badge" style="position:static">${c.unread_count}</span>` : ''}
        </div>`).join('') || '<div class="empty-note">No conversations yet - start one from Contacts or the button above.</div>';

      App.utils.qsa('[data-open-conv]', host).forEach((el) => el.addEventListener('click', () => openConversation(Number(el.dataset.openConv))));
    }

    await draw();
  }

  // ---- New chat / New group ----
  async function pickablePortfolioContacts() {
    const contacts = await App.api.listContacts();
    return contacts.filter((c) => c.linked_user_id);
  }

  async function openNewChatModal() {
    const contacts = await pickablePortfolioContacts();
    if (!contacts.length) { App.utils.toast('No contacts are linked to a registered portfolio user yet - use "Find on Portfolio" from a contact\'s profile first.', 'err'); return; }
    App.ui.open({
      title: 'New Chat',
      bodyHtml: `<div class="field"><label>Contact</label><select id="newChatContact">${contacts.map((c) => `<option value="${c.linked_user_id}">${App.utils.escapeHtml(c.display_name || c.full_name)}</option>`).join('')}</select></div>`,
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Start Chat', className: 'btn-gold', onClick: async () => {
          const userId = App.utils.qs('#newChatContact').value;
          try { const conv = await App.api.startDirectConversation(userId); App.ui.close(); openConversation(conv.id); }
          catch (e) { App.utils.toast('Could not start chat: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  async function openNewGroupModal() {
    const contacts = await pickablePortfolioContacts();
    App.ui.open({
      title: 'New Group',
      bodyHtml: `
        <div class="field" style="margin-bottom:10px"><label>Group Name</label><input id="newGroupName" placeholder="e.g. Investment Friends"></div>
        <div class="field"><label>Members</label>
        ${contacts.length ? contacts.map((c) => `<div><label style="display:flex;align-items:center;gap:8px;padding:4px 0"><input type="checkbox" data-member-check="${c.linked_user_id}"> ${App.utils.escapeHtml(c.display_name || c.full_name)}</label></div>`).join('')
          : '<div class="hint">No contacts are linked to registered portfolio users yet.</div>'}</div>`,
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Create Group', className: 'btn-gold', onClick: async () => {
          const name = App.utils.qs('#newGroupName').value.trim();
          const memberIds = App.utils.qsa('[data-member-check]').filter((c) => c.checked).map((c) => c.dataset.memberCheck);
          if (!name) { App.utils.toast('Enter a group name', 'err'); return; }
          try { const conv = await App.api.createGroupConversation(name, memberIds, null); App.ui.close(); openConversation(conv.id); }
          catch (e) { App.utils.toast('Could not create group: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  async function openAddPeopleModal(conversationId) {
    const contacts = await pickablePortfolioContacts();
    const existingMembers = await App.api.listConversationMembers(conversationId);
    const existingIds = new Set(existingMembers.map((m) => m.user_id));
    const pickable = contacts.filter((c) => !existingIds.has(c.linked_user_id));
    App.ui.open({
      title: 'Add People',
      bodyHtml: `
        <div class="hint" style="margin-bottom:10px">Adding someone to a one-to-one chat creates a brand new group instead of exposing your existing private history.</div>
        <div class="field" style="margin-bottom:10px"><label>People to add</label>
        ${pickable.length ? pickable.map((c) => `<div><label style="display:flex;align-items:center;gap:8px;padding:4px 0"><input type="checkbox" data-add-member="${c.linked_user_id}"> ${App.utils.escapeHtml(c.display_name || c.full_name)}</label></div>`).join('') : '<div class="hint">Everyone in your contacts is already here.</div>'}</div>
        <div class="field"><label>History they can see</label><select id="historyCutoff">${HISTORY_OPTIONS.map((h) => `<option value="${h.label}">${h.label}</option>`).join('')}</select></div>`,
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Add', className: 'btn-gold', onClick: async () => {
          const toAdd = App.utils.qsa('[data-add-member]').filter((c) => c.checked).map((c) => c.dataset.addMember);
          const cutoffLabel = App.utils.qs('#historyCutoff').value;
          const cutoffFn = (HISTORY_OPTIONS.find((h) => h.label === cutoffLabel) || HISTORY_OPTIONS[0]).cutoff;
          if (!toAdd.length) { App.utils.toast('Pick at least one person', 'err'); return; }
          try {
            const conv = await App.api.getConversation(conversationId);
            let targetConvId = conversationId;
            if (conv.type === 'DIRECT') {
              // Spec Section 14: never add a third person into an existing
              // 1:1 - spin up a brand new GROUP with the same members instead.
              const members = await App.api.listConversationMembers(conversationId);
              const newGroup = await App.api.createGroupConversation(
                conv.name || 'Group Chat',
                members.map((m) => m.user_id).filter((u) => u !== App.auth.getUser().id).concat(toAdd),
                cutoffFn(),
              );
              targetConvId = newGroup.id;
            } else {
              for (const uid of toAdd) await App.api.addConversationMember({ conversation_id: conversationId, user_id: uid, role: 'MEMBER', history_visible_from: cutoffFn() });
            }
            App.utils.toast('People added');
            App.ui.close();
            openConversation(targetConvId);
          } catch (e) { App.utils.toast('Could not add people: ' + (e.message || e), 'err'); }
        } },
      ],
    });
  }

  // ---- Group settings: rename, change photo, remove members, leave ----
  async function openGroupSettingsModal(conversationId, conv, members, myMembership, contactsByLinkedUser, isAdmin) {
    const myId = App.auth.getUser().id;
    const names = {};
    for (const m of members) names[m.user_id] = await nameForUser(m.user_id, contactsByLinkedUser);
    App.ui.open({
      title: 'Group Settings',
      bodyHtml: `
        <div class="field" style="margin-bottom:10px"><label>Group Name</label><input id="groupNameInput" value="${App.utils.escapeHtml(conv.name || '')}" ${isAdmin ? '' : 'disabled'}></div>
        <div class="field" style="margin-bottom:10px"><label>Description</label><textarea id="groupDescInput" rows="2" ${isAdmin ? '' : 'disabled'}>${App.utils.escapeHtml(conv.description || '')}</textarea></div>
        ${isAdmin ? '<button class="btn btn-outline btn-sm" id="saveGroupBtn" style="margin-bottom:14px">Save Changes</button>' : ''}
        <div class="section-title" style="font-size:13px;margin-bottom:8px">Members <div class="line"></div></div>
        <div style="max-height:180px;overflow-y:auto;margin-bottom:14px">${members.map((m) => `
          <div class="risk-item"><div style="flex:1"><div class="risk-name">${App.utils.escapeHtml(names[m.user_id])}${m.user_id === myId ? ' (you)' : ''}</div><div class="risk-desc">${m.role}</div></div>
          ${isAdmin && m.user_id !== myId ? `<button class="icon-btn del" data-remove-member="${m.id}" title="Remove">&#10005;</button>` : ''}</div>`).join('')}</div>
        <button class="btn btn-danger" id="leaveGroupBtn">Leave Group</button>`,
      actions: [{ label: 'Close', className: 'btn-gold', onClick: App.ui.close }],
      onMount: (body) => {
        const saveBtn = App.utils.qs('#saveGroupBtn', body);
        if (saveBtn) saveBtn.addEventListener('click', async () => {
          await App.api.updateConversation(conversationId, {
            name: App.utils.qs('#groupNameInput', body).value.trim(),
            description: App.utils.qs('#groupDescInput', body).value.trim(),
          });
          App.utils.toast('Group updated');
          App.ui.close();
          openConversation(conversationId);
        });
        App.utils.qsa('[data-remove-member]', body).forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Remove this member from the group?')) return;
          await App.api.updateConversationMember(Number(b.dataset.removeMember), { left_at: new Date().toISOString() });
          App.utils.toast('Member removed');
          App.ui.close();
          openConversation(conversationId);
        }));
        App.utils.qs('#leaveGroupBtn', body).addEventListener('click', async () => {
          if (!confirm('Leave this group? You will stop receiving its messages.')) return;
          await App.api.updateConversationMember(myMembership.id, { left_at: new Date().toISOString() });
          App.utils.toast('You left the group');
          App.ui.close();
          App.router.refreshCurrent();
        });
      },
    });
  }

  // ---- Share messages (Section 13/40) ----
  async function openShareMessagesModal(sourceConversationId, preselectedMessageIds) {
    const convs = await App.api.listConversations();
    const targets = convs.filter((c) => c.conversation_id !== sourceConversationId);
    const DATE_RANGES = ['All', 'Past Hour', 'Today', 'Past 24 Hours', 'Yesterday', 'Past Week', 'Past Month', 'Custom Date Range', 'Selected Messages'];
    App.ui.open({
      title: 'Share Messages',
      bodyHtml: `
        <div class="field" style="margin-bottom:10px"><label>Share to</label>
          <select id="shareTarget">${targets.map((c) => `<option value="${c.conversation_id}">${App.utils.escapeHtml(c.name || 'Direct message #' + c.conversation_id)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:10px"><label>Which messages</label>
          <select id="shareRange">${DATE_RANGES.map((r) => `<option value="${r}" ${r === (preselectedMessageIds ? 'Selected Messages' : 'All') ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
        <div id="shareCustomRange" style="display:none" class="grid-2">
          <div class="field"><label>From</label><input type="date" id="shareFrom"></div>
          <div class="field"><label>To</label><input type="date" id="shareTo"></div>
        </div>
        <div id="sharePreview" class="hint">Pick a range to preview what will be shared.</div>`,
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Preview', className: 'btn-outline', onClick: () => previewShare(sourceConversationId, preselectedMessageIds) },
        { label: 'Confirm & Share', className: 'btn-gold', onClick: async () => {
          const targetId = Number(App.utils.qs('#shareTarget').value);
          const ids = await resolveShareMessageIds(sourceConversationId, preselectedMessageIds);
          if (!ids.length) { App.utils.toast('No messages match that range', 'err'); return; }
          try {
            await App.api.shareMessages(sourceConversationId, targetId, ids);
            App.utils.toast(`Shared ${ids.length} message(s)`);
            App.ui.close();
          } catch (e) { App.utils.toast('Could not share: ' + (e.message || e), 'err'); }
        } },
      ],
      onMount: () => {
        App.utils.qs('#shareRange').addEventListener('change', (e) => {
          App.utils.qs('#shareCustomRange').style.display = e.target.value === 'Custom Date Range' ? 'grid' : 'none';
        });
      },
    });
  }

  async function resolveShareMessageIds(conversationId, preselectedMessageIds) {
    const range = App.utils.qs('#shareRange').value;
    if (range === 'Selected Messages' && preselectedMessageIds) return preselectedMessageIds;
    const all = await App.api.listMessages({ eq: { conversation_id: conversationId } });
    const now = Date.now();
    const bounds = {
      All: [0, now],
      'Past Hour': [now - 3600000, now],
      Today: [new Date().setHours(0, 0, 0, 0), now],
      'Past 24 Hours': [now - 86400000, now],
      Yesterday: [new Date().setHours(0, 0, 0, 0) - 86400000, new Date().setHours(0, 0, 0, 0)],
      'Past Week': [now - 7 * 86400000, now],
      'Past Month': [now - 30 * 86400000, now],
    };
    if (range === 'Custom Date Range') {
      const from = App.utils.qs('#shareFrom').value, to = App.utils.qs('#shareTo').value;
      bounds['Custom Date Range'] = [from ? new Date(from).getTime() : 0, to ? new Date(to).getTime() + 86400000 : now];
    }
    const [from, to] = bounds[range] || bounds.All;
    return all.filter((m) => { const t = new Date(m.created_at).getTime(); return t >= from && t <= to && !m.deleted_at; }).map((m) => m.id);
  }

  async function previewShare(conversationId, preselectedMessageIds) {
    const ids = await resolveShareMessageIds(conversationId, preselectedMessageIds);
    const msgs = ids.length ? await App.api.listMessages({ eq: { conversation_id: conversationId } }) : [];
    const matched = msgs.filter((m) => ids.includes(m.id));
    const attachmentCounts = await Promise.all(matched.map((m) => App.api.listMessageAttachments(m.id)));
    const totalAttachments = attachmentCounts.reduce((a, arr) => a + arr.length, 0);
    const dates = matched.map((m) => m.created_at).sort();
    App.utils.qs('#sharePreview').innerHTML = matched.length
      ? `<b>${matched.length}</b> message(s)${dates.length ? `, from ${App.utils.fmtDate(dates[0])} to ${App.utils.fmtDate(dates[dates.length - 1])}` : ''}, ${totalAttachments} attachment(s).`
      : 'No messages match that range.';
  }

  // ---- Thread view ----
  async function openConversation(conversationId) {
    if (activeCleanup) { activeCleanup(); activeCleanup = null; }
    const [conv, members, messages, contacts] = await Promise.all([
      App.api.getConversation(conversationId), App.api.listConversationMembers(conversationId),
      App.api.listMessages({ eq: { conversation_id: conversationId } }), App.api.listContacts(),
    ]);
    const contactsByLinkedUser = {};
    contacts.forEach((c) => { if (c.linked_user_id) contactsByLinkedUser[c.linked_user_id] = c; });
    const myId = App.auth.getUser().id;
    const myMembership = members.find((m) => m.user_id === myId) || {};
    const isAdmin = myMembership.role === 'ADMIN' || myMembership.role === 'OWNER';
    const title = await conversationTitle(conv.type ? conv : Object.assign({ conversation_id: conversationId }, conv), contactsByLinkedUser);
    const otherMember = conv.type === 'DIRECT' ? members.find((m) => m.user_id !== myId) : null;
    const otherContact = otherMember ? contactsByLinkedUser[otherMember.user_id] : null;
    if (otherContact) {
      // webrtc.js's failure/fallback UI needs a raw phone number, not a
      // fresh DB round-trip at that point - resolved once up front here.
      const otherPhones = await App.api.listContactPhones(otherContact.id).catch(() => []);
      const primaryPhone = otherPhones.find((p) => p.is_primary) || otherPhones[0];
      otherContact._callPhone = primaryPhone ? primaryPhone.phone_number.replace(/[^\d+]/g, '') : null;
    }

    let selectedForShare = new Set();
    let selectMode = false;

    function messageRow(m, senderName) {
      const mine = m.sender_id === myId;
      if (m.deleted_at) {
        return `<div style="text-align:${mine ? 'right' : 'left'};margin-bottom:10px"><div style="display:inline-block;padding:8px 12px;border-radius:10px;font-size:12px;font-style:italic;color:var(--text3);border:1px solid var(--border2)">This message was deleted</div></div>`;
      }
      return `<div style="margin-bottom:10px;text-align:${mine ? 'right' : 'left'}" data-message-row="${m.id}">
        <div style="font-size:10.5px;color:var(--text3);margin-bottom:2px">
          ${selectMode ? `<input type="checkbox" data-select-msg="${m.id}" style="margin-right:6px">` : ''}
          ${conv.type === 'GROUP' && !mine ? App.utils.escapeHtml(senderName) + ' &middot; ' : ''}${App.utils.fmtDateTime(m.created_at)}${m.edited_at ? ' &middot; Edited' : ''}${m.forwarded_from_message_id ? ' &middot; Forwarded' : ''}
        </div>
        <div style="display:inline-block;max-width:75%;padding:8px 12px;border-radius:10px;font-size:12.5px;text-align:left;background:${mine ? 'rgba(201,168,76,0.15)' : 'rgba(76,155,232,0.15)'};border:1px solid var(--border2)">
          ${App.utils.escapeHtml(m.content || '')}
        </div>
        <div class="row-actions" style="margin-top:2px;${mine ? 'justify-content:flex-end' : ''}">
          <button class="icon-btn" data-react-msg="${m.id}" title="React">&#128512;</button>
          <button class="icon-btn" data-reply-msg="${m.id}" title="Reply">&#8617;</button>
          <button class="icon-btn" data-share-msg="${m.id}" title="Share">&#8594;</button>
          ${mine ? `<button class="icon-btn" data-edit-msg="${m.id}" title="Edit">&#9998;</button>` : ''}
          <button class="icon-btn del" data-hide-msg="${m.id}" title="Delete for me">&#128465;</button>
          ${mine ? `<button class="icon-btn del" data-delete-msg="${m.id}" title="Delete for everyone">&#10005;</button>` : ''}
        </div>
      </div>`;
    }

    async function renderThreadBody() {
      const [freshMessages, hidden] = await Promise.all([
        App.api.listMessages({ eq: { conversation_id: conversationId } }),
        App.api.listHiddenForMe({ eq: { user_id: myId } }),
      ]);
      const hiddenIds = new Set(hidden.map((h) => h.message_id));
      const visible = freshMessages.filter((m) => !hiddenIds.has(m.id));
      const uniqueSenderIds = [...new Set(visible.map((m) => m.sender_id))];
      const resolvedNames = await Promise.all(uniqueSenderIds.map((id) => nameForUser(id, contactsByLinkedUser)));
      const names = {};
      uniqueSenderIds.forEach((id, i) => { names[id] = resolvedNames[i]; });
      return visible.map((m) => messageRow(m, names[m.sender_id])).join('') || '<div class="empty-note">No messages yet - say hello.</div>';
    }

    const bodyHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="hint" style="margin:0">${conv.type === 'GROUP' ? `${members.length} member(s)` : 'Direct message'}</div>
        <div style="display:flex;gap:6px">
          ${conv.type === 'DIRECT' && otherMember ? `<button class="icon-btn" id="voiceCallBtn" title="Voice call">&#128222;</button><button class="icon-btn" id="videoCallBtn" title="Video call">&#128249;</button>` : ''}
          <button class="icon-btn" id="pinConvBtn" title="Pin">&#128204;</button>
          <button class="icon-btn" id="muteConvBtn" title="Mute">&#128263;</button>
          <button class="icon-btn" id="archiveConvBtn" title="Archive">&#128230;</button>
          ${conv.type === 'GROUP' ? '<button class="icon-btn" id="addPeopleBtn" title="Add People">&#128101;</button>' : ''}
          ${conv.type === 'GROUP' ? '<button class="icon-btn" id="groupSettingsBtn" title="Group Settings">&#9881;</button>' : ''}
          <button class="icon-btn" id="selectModeBtn" title="Select messages to share">&#9776;</button>
        </div>
      </div>
      <div id="chatThread" style="height:340px;overflow-y:auto;padding:8px;margin-bottom:10px;border:1px solid var(--border2);border-radius:10px">Loading…</div>
      <div id="replyPreview" style="display:none;margin-bottom:6px" class="hint"></div>
      <div style="display:flex;gap:6px;margin-bottom:8px">${QUICK_EMOJI.map((em) => `<button class="icon-btn" data-quick-emoji="${em}">${em}</button>`).join('')}
        <button class="icon-btn" id="attachBtn" title="Attach a file">&#128206;</button>
        <input type="file" id="attachInput" style="display:none">
      </div>
      <div style="display:flex;gap:8px">
        <input class="search-input" id="chatComposer" placeholder="Type a message..." style="flex:1">
        <button class="btn btn-gold" id="chatSendBtn">Send</button>
      </div>`;

    let replyToId = null;
    let channel = null;

    App.ui.open({
      title, bodyHtml,
      actions: [
        { label: 'Share Selected', className: 'btn-outline', id: 'shareSelectedBtn', onClick: () => {
          if (!selectedForShare.size) { App.utils.toast('Select at least one message first', 'err'); return; }
          openShareMessagesModal(conversationId, Array.from(selectedForShare));
        } },
        { label: 'Close', className: 'btn-gold', onClick: () => { if (channel) App.api.unsubscribe(channel); App.ui.close(); } },
      ],
      onMount: async (body) => {
        const thread = App.utils.qs('#chatThread', body);
        const scrollBottom = () => { thread.scrollTop = thread.scrollHeight; };

        async function redraw() {
          thread.innerHTML = await renderThreadBody();
          wireMessageActions();
          scrollBottom();
        }

        function wireMessageActions() {
          App.utils.qsa('[data-select-msg]', thread).forEach((cb) => cb.addEventListener('change', () => {
            const id = Number(cb.dataset.selectMsg);
            if (cb.checked) selectedForShare.add(id); else selectedForShare.delete(id);
          }));
          App.utils.qsa('[data-reply-msg]', thread).forEach((b) => b.addEventListener('click', () => {
            replyToId = Number(b.dataset.replyMsg);
            const preview = App.utils.qs('#replyPreview', body);
            preview.style.display = 'block';
            preview.innerHTML = `Replying to a message &middot; <a href="#" id="cancelReply" style="color:var(--gold)">Cancel</a>`;
            App.utils.qs('#cancelReply', preview).addEventListener('click', (e) => { e.preventDefault(); replyToId = null; preview.style.display = 'none'; });
          }));
          App.utils.qsa('[data-share-msg]', thread).forEach((b) => b.addEventListener('click', () => openShareMessagesModal(conversationId, [Number(b.dataset.shareMsg)])));
          App.utils.qsa('[data-edit-msg]', thread).forEach((b) => b.addEventListener('click', async () => {
            const id = Number(b.dataset.editMsg);
            const msg = (await App.api.listMessages({ eq: { conversation_id: conversationId } })).find((m) => m.id === id);
            const next = prompt('Edit message:', msg ? msg.content : '');
            if (next === null || !next.trim()) return;
            await App.api.updateMessage(id, { content: next.trim() });
            redraw();
          }));
          App.utils.qsa('[data-hide-msg]', thread).forEach((b) => b.addEventListener('click', async () => {
            await App.api.hideMessageForMe(Number(b.dataset.hideMsg));
            redraw();
          }));
          App.utils.qsa('[data-delete-msg]', thread).forEach((b) => b.addEventListener('click', async () => {
            if (!confirm('Delete this message for everyone?')) return;
            await App.api.softDeleteMessage(Number(b.dataset.deleteMsg));
            redraw();
          }));
          App.utils.qsa('[data-react-msg]', thread).forEach((b) => b.addEventListener('click', () => {
            const menu = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F64F}', '\u{1F62E}'];
            const choice = prompt('React with: ' + menu.join(' '));
            if (!choice) return;
            App.api.setMessageReaction(Number(b.dataset.reactMsg), choice.trim()).then(redraw);
          }));
        }

        // Wire every button BEFORE awaiting the first redraw() - the modal's
        // HTML (including the Send button) is already visible and clickable
        // the instant onMount starts, so any listener attached only after
        // an await silently drops clicks that land in that gap. Only the
        // thread's message *content* is allowed to lag behind.
        App.utils.qs('#selectModeBtn', body).addEventListener('click', () => {
          selectMode = !selectMode;
          selectedForShare.clear();
          redraw();
        });
        App.utils.qsa('[data-quick-emoji]', body).forEach((b) => b.addEventListener('click', () => {
          const input = App.utils.qs('#chatComposer', body);
          input.value += b.dataset.quickEmoji;
          input.focus();
        }));
        App.utils.qs('#attachBtn', body).addEventListener('click', () => App.utils.qs('#attachInput', body).click());
        App.utils.qs('#attachInput', body).addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const msg = await App.api.sendMessage({ conversation_id: conversationId, message_type: file.type.startsWith('image/') ? 'IMAGE' : 'DOCUMENT', content: file.name, reply_to_message_id: replyToId });
            await App.api.uploadChatAttachment(file, conversationId, msg.id);
            await App.api.updateConversation(conversationId, { last_message_at: new Date().toISOString() });
            replyToId = null;
            App.utils.qs('#replyPreview', body).style.display = 'none';
            redraw();
          } catch (err) { App.utils.toast('Could not send attachment: ' + (err.message || err), 'err'); }
        });

        async function send() {
          const input = App.utils.qs('#chatComposer', body);
          const text = input.value.trim();
          if (!text) return;
          input.value = '';
          try {
            await App.api.sendMessage({ conversation_id: conversationId, content: text, reply_to_message_id: replyToId });
            await App.api.updateConversation(conversationId, { last_message_at: new Date().toISOString() });
            replyToId = null;
            App.utils.qs('#replyPreview', body).style.display = 'none';
          } catch (e) { App.utils.toast('Could not send: ' + (e.message || e), 'err'); }
        }
        App.utils.qs('#chatSendBtn', body).addEventListener('click', send);
        App.utils.qs('#chatComposer', body).addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

        App.utils.qs('#pinConvBtn', body).addEventListener('click', async () => {
          await App.api.updateConversationMember(myMembership.id, { pinned: !myMembership.pinned });
          App.utils.toast(myMembership.pinned ? 'Unpinned' : 'Pinned'); myMembership.pinned = !myMembership.pinned;
        });
        App.utils.qs('#archiveConvBtn', body).addEventListener('click', async () => {
          await App.api.updateConversationMember(myMembership.id, { archived: !myMembership.archived });
          App.utils.toast(myMembership.archived ? 'Unarchived' : 'Archived'); myMembership.archived = !myMembership.archived;
        });
        App.utils.qs('#muteConvBtn', body).addEventListener('click', () => {
          const choice = prompt('Mute for: ' + MUTE_OPTIONS.map((o) => o.label).join(' / '));
          const opt = MUTE_OPTIONS.find((o) => o.label.toLowerCase() === (choice || '').toLowerCase());
          if (!opt) return;
          App.api.updateConversationMember(myMembership.id, { muted_until: opt.ms ? new Date(Date.now() + opt.ms).toISOString() : new Date('2100-01-01').toISOString() })
            .then(() => App.utils.toast('Muted'));
        });
        const addPeopleBtn = App.utils.qs('#addPeopleBtn', body);
        if (addPeopleBtn) addPeopleBtn.addEventListener('click', () => { App.ui.close(); openAddPeopleModal(conversationId); });
        const groupSettingsBtn = App.utils.qs('#groupSettingsBtn', body);
        if (groupSettingsBtn) groupSettingsBtn.addEventListener('click', () => { App.ui.close(); openGroupSettingsModal(conversationId, conv, members, myMembership, contactsByLinkedUser, isAdmin); });
        const voiceBtn = App.utils.qs('#voiceCallBtn', body);
        if (voiceBtn && otherMember) voiceBtn.addEventListener('click', () => App.callingView && App.callingView.startCall(otherMember.user_id, 'VOICE', conversationId, otherContact));
        const videoBtn = App.utils.qs('#videoCallBtn', body);
        if (videoBtn && otherMember) videoBtn.addEventListener('click', () => App.callingView && App.callingView.startCall(otherMember.user_id, 'VIDEO', conversationId, otherContact));

        channel = App.api.subscribeToMessages(conversationId, () => redraw());
        App.router.onLeave(() => { if (channel) App.api.unsubscribe(channel); });

        await redraw();
      },
    });

    // Mark the latest message read on open (best-effort, non-blocking).
    if (messages.length) {
      const last = messages[messages.length - 1];
      App.api.markMessageRead(last.id).catch(() => {});
      App.api.updateConversationMember(myMembership.id, { last_read_message_id: last.id }).catch(() => {});
    }
  }

  App.router.register('chat', renderChatView);
  App.chatView = { openConversation, openShareMessagesModal, openNewChatModal, openNewGroupModal };
})();
