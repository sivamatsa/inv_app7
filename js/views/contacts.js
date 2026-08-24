/* Contacts (spec addendum "Contacts, Private Chat, Calling & WhatsApp
   Integration", Sections 1-9, 22-27, 33) - a personal address book,
   deliberately separate from Investment Deals, Recurring Investments,
   Community Discussion, and Write to Us. Nothing in this file touches any
   of those tables or views.

   Phones/emails are modeled as fixed named slots (Primary/Secondary/
   WhatsApp/Work/Home for phones; Primary/Secondary/Work/Personal for
   emails) rather than a fully dynamic repeatable-row editor - this matches
   the spec's own section 3 wording exactly (it names these slots directly)
   while keeping the wizard a flat form instead of custom add/remove-row
   JS. Only one address is creatable from the wizard; additional addresses
   can be added from the detail view afterward. */
window.App = window.App || {};

(function () {
  const TAG_OPTIONS = ['Family', 'Friend', 'Colleague', 'Client', 'Investor', 'Business', 'VIP', 'Emergency', 'School', 'College', 'Other'];
  const PHONE_SLOTS = [
    { key: 'primary_phone', label: 'Primary' },
    { key: 'secondary_phone', label: 'Secondary' },
    { key: 'whatsapp_phone', label: 'WhatsApp' },
    { key: 'work_phone', label: 'Work' },
    { key: 'home_phone', label: 'Home' },
  ];
  const EMAIL_SLOTS = [
    { key: 'primary_email', label: 'Primary' },
    { key: 'secondary_email', label: 'Secondary' },
    { key: 'work_email', label: 'Work' },
    { key: 'personal_email', label: 'Personal' },
  ];

  function initials(c) {
    const s = (c.display_name || c.full_name || '?').trim();
    const parts = s.split(/\s+/).filter(Boolean);
    return ((parts[0] || '')[0] || '?') + ((parts[1] || '')[0] || '');
  }

  function e164(phone) {
    return phone ? phone.replace(/[^\d+]/g, '') : '';
  }
  function waLink(phone, message) {
    const digits = e164(phone).replace(/^\+/, '');
    return `https://wa.me/${digits}${message ? '?text=' + encodeURIComponent(message) : ''}`;
  }

  // ---- Identity + Step 1/3 field lists ----
  const IDENTITY_FIELDS = [
    { key: 'first_name', label: 'First Name', required: true, step: 1 },
    { key: 'middle_name', label: 'Middle Name', step: 1 },
    { key: 'last_name', label: 'Last Name', step: 1 },
    { key: 'preferred_name', label: 'Preferred / Display Name', step: 1, span: 2, placeholder: 'Leave blank to use First + Last' },
    { key: 'nickname', label: 'Nickname', step: 1 },
    { key: 'gender', label: 'Gender (optional)', step: 1, type: 'select', options: ['', 'Male', 'Female', 'Non-binary', 'Prefer not to say'] },
    { key: 'birthday', label: 'Birthday', step: 1, type: 'date' },
    { key: 'family_relationship', label: 'Family Relationship', step: 1, placeholder: 'e.g. Brother, Mother, Cousin' },
    { key: 'tagsText', label: 'Tags (comma-separated)', step: 1, span: 2, placeholder: TAG_OPTIONS.join(', ') },
    { key: 'notesForCreate', label: 'Notes', step: 1, type: 'textarea', span: 2, placeholder: 'A note is logged the first time you save' },
  ];
  const PROFESSIONAL_FIELDS = [
    { key: 'company', label: 'Company', step: 3 },
    { key: 'job_title', label: 'Job Title', step: 3 },
    { key: 'department', label: 'Department', step: 3 },
    { key: 'website', label: 'Website', step: 3 },
    { key: 'linkedin_url', label: 'LinkedIn Profile', step: 3 },
    { key: 'work_location', label: 'Work Location', step: 3 },
    { key: 'industry', label: 'Industry', step: 3 },
    { key: 'interestsText', label: 'Interests (comma-separated)', step: 3, span: 2 },
  ];

  function contactInfoFields() {
    const fields = [];
    PHONE_SLOTS.forEach((s) => {
      fields.push({ key: s.key + '_number', label: s.label + ' Phone', step: 2, placeholder: '+91 98765 43210' });
    });
    EMAIL_SLOTS.forEach((s) => {
      fields.push({ key: s.key, label: s.label + ' Email', step: 2, placeholder: 'name@example.com' });
    });
    fields.push(
      { key: 'address_type', label: 'Address Type', step: 2, type: 'select', options: ['Home', 'Work', 'Other'] },
      { key: 'address_line1', label: 'Address Line', step: 2, span: 2 },
      { key: 'address_city', label: 'City', step: 2 },
      { key: 'address_state', label: 'State', step: 2 },
      { key: 'address_country', label: 'Country', step: 2 },
      { key: 'address_postal_code', label: 'Postal Code', step: 2 },
    );
    return fields;
  }

  function resolvedFields(step) {
    const all = step === 2 ? contactInfoFields() : IDENTITY_FIELDS.concat(PROFESSIONAL_FIELDS);
    return all.filter((f) => f.step === step);
  }

  let wizardStep = 1;

  function stepperHtml() {
    const labels = ['1. Identity', '2. Contact Info', '3. Professional'];
    return `<div class="wizard-steps">${labels.map((l, i) => `<div class="wizard-step ${wizardStep === i + 1 ? 'active' : wizardStep > i + 1 ? 'done' : ''}">${l}</div>`).join('')}</div>`;
  }

  function openContactWizard(existing, groups) {
    wizardStep = 1;
    const collected = Object.assign({ tags: [], interests: [], favorite: false }, existing || {});
    collected.tagsText = (collected.tags || []).join(', ');
    collected.interestsText = (collected.interests || []).join(', ');
    const selectedGroupIds = new Set();

    async function preload() {
      if (!existing) return;
      const [phones, emails, addresses, memberships] = await Promise.all([
        App.api.listContactPhones(existing.id), App.api.listContactEmails(existing.id),
        App.api.listContactAddresses(existing.id), App.api.listContactGroupMembers({ eq: { contact_id: existing.id } }),
      ]);
      PHONE_SLOTS.forEach((s) => {
        const p = phones.find((x) => x.label === s.label);
        if (p) { collected[s.key + '_number'] = p.phone_number; }
      });
      EMAIL_SLOTS.forEach((s) => {
        const em = emails.find((x) => x.label === s.label);
        if (em) collected[s.key] = em.email;
      });
      if (addresses[0]) {
        collected.address_type = addresses[0].address_type;
        collected.address_line1 = addresses[0].line1;
        collected.address_city = addresses[0].city;
        collected.address_state = addresses[0].state;
        collected.address_country = addresses[0].country;
        collected.address_postal_code = addresses[0].postal_code;
        collected._existingAddressId = addresses[0].id;
      }
      memberships.forEach((m) => selectedGroupIds.add(m.group_id));
    }

    function groupCheckboxesHtml() {
      if (!groups.length) return '<div class="hint">No groups yet - create one from the Groups filter first, or leave this blank.</div>';
      return `<div class="chip-row">${groups.map((g) => `<div class="chip ${selectedGroupIds.has(g.id) ? 'active' : ''}" data-group-chip="${g.id}">${App.utils.escapeHtml(g.name)}</div>`).join('')}</div>`;
    }

    function renderWizardBody() {
      const fields = resolvedFields(wizardStep);
      const fieldsHtml = fields.map((f) => App.ui.fieldHtml(f, collected[f.key])).join('');
      const extra = wizardStep === 1
        ? `<div class="field span2"><label>Favorite</label><select id="fld_favorite"><option value="false" ${!collected.favorite ? 'selected' : ''}>No</option><option value="true" ${collected.favorite ? 'selected' : ''}>Yes</option></select></div>
           <div class="field span2"><label>Groups</label>${groupCheckboxesHtml()}</div>`
        : '';
      return `${stepperHtml()}<div id="wizardFieldsHost"><div class="form-grid">${fieldsHtml}${extra}</div></div>`;
    }

    function wireStepFields() {
      if (wizardStep === 1) {
        App.utils.qsa('[data-group-chip]').forEach((chip) => chip.addEventListener('click', () => {
          const id = Number(chip.dataset.groupChip);
          if (selectedGroupIds.has(id)) selectedGroupIds.delete(id); else selectedGroupIds.add(id);
          chip.classList.toggle('active');
        }));
      }
    }

    function renderStep() {
      App.utils.qs('#sharedModalBody').innerHTML = renderWizardBody();
      wireStepFields();
    }

    function captureStep() {
      const { values } = App.ui.readForm(resolvedFields(wizardStep));
      Object.assign(collected, values);
      if (wizardStep === 1 && !collected.first_name) {
        App.utils.toast('First name is required', 'err');
        return false;
      }
      return true;
    }

    function actionsForStep() {
      const actions = [];
      if (wizardStep > 1) actions.push({ label: '&larr; Back', className: 'btn-outline', onClick: () => { captureStep(); wizardStep--; renderStep(); refreshActions(); } });
      if (wizardStep < 3) actions.push({ label: 'Next &rarr;', className: 'btn-gold', onClick: () => { if (captureStep()) { wizardStep++; renderStep(); refreshActions(); } } });
      else actions.push({ label: existing ? 'Save Changes' : 'Create Contact', className: 'btn-gold', onClick: submitWizard });
      actions.push({ label: 'Cancel', className: 'btn-outline', onClick: App.ui.close });
      return actions;
    }

    function refreshActions() {
      const el = App.utils.qs('#sharedModalActions');
      el.innerHTML = '';
      actionsForStep().forEach((a) => {
        const btn = document.createElement('button');
        btn.className = 'btn ' + a.className;
        btn.innerHTML = a.label;
        btn.addEventListener('click', a.onClick);
        el.appendChild(btn);
      });
    }

    async function submitWizard() {
      if (!captureStep()) return;
      const tags = collected.tagsText ? collected.tagsText.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const interests = collected.interestsText ? collected.interestsText.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const contactPayload = {
        first_name: collected.first_name, middle_name: collected.middle_name, last_name: collected.last_name,
        preferred_name: collected.preferred_name, nickname: collected.nickname, gender: collected.gender || null,
        birthday: collected.birthday || null, family_relationship: collected.family_relationship, tags, interests,
        favorite: collected.favorite === true || collected.favorite === 'true',
        display_name: collected.preferred_name || null,
        company: collected.company, job_title: collected.job_title, department: collected.department,
        website: collected.website, linkedin_url: collected.linkedin_url, work_location: collected.work_location, industry: collected.industry,
      };
      try {
        let contact;
        if (!existing) {
          contact = await App.api.createContact(contactPayload);
          if (collected.notesForCreate) await App.api.createContactNote({ contact_id: contact.id, note_text: collected.notesForCreate });
        } else {
          contact = await App.api.updateContact(existing.id, contactPayload);
        }

        // Phones/emails: delete-and-reinsert rather than diffing - simple
        // and correct enough at personal-scale contact counts.
        if (existing) {
          const [oldPhones, oldEmails] = await Promise.all([App.api.listContactPhones(existing.id), App.api.listContactEmails(existing.id)]);
          for (const p of oldPhones) await App.api.deleteContactPhone(p.id);
          for (const em of oldEmails) await App.api.deleteContactEmail(em.id);
        }
        for (const s of PHONE_SLOTS) {
          const val = collected[s.key + '_number'];
          if (val) await App.api.createContactPhone({
            contact_id: contact.id, phone_number: val, label: s.label, is_primary: s.key === 'primary_phone', is_whatsapp: s.key === 'whatsapp_phone',
          });
        }
        for (const s of EMAIL_SLOTS) {
          const val = collected[s.key];
          if (val) await App.api.createContactEmail({ contact_id: contact.id, email: val, label: s.label, is_primary: s.key === 'primary_email' });
        }
        if (collected.address_line1 || collected.address_city) {
          const addrPayload = {
            contact_id: contact.id, address_type: collected.address_type || 'Home', line1: collected.address_line1,
            city: collected.address_city, state: collected.address_state, country: collected.address_country, postal_code: collected.address_postal_code,
          };
          if (collected._existingAddressId) await App.api.updateContactAddress(collected._existingAddressId, addrPayload);
          else await App.api.createContactAddress(addrPayload);
        }

        // Groups: delete-and-reinsert membership rows for this contact.
        const currentMemberships = await App.api.listContactGroupMembers({ eq: { contact_id: contact.id } });
        for (const m of currentMemberships) if (!selectedGroupIds.has(m.group_id)) await App.api.removeContactFromGroup(m.id);
        const existingGroupIds = new Set(currentMemberships.map((m) => m.group_id));
        for (const gid of selectedGroupIds) if (!existingGroupIds.has(gid)) await App.api.addContactToGroup(gid, contact.id);

        App.utils.toast(existing ? 'Contact updated' : 'Contact created');
        App.ui.close();
        App.router.refreshCurrent();
      } catch (e) {
        App.utils.toast('Could not save contact: ' + (e.message || e), 'err');
      }
    }

    App.ui.open({
      title: existing ? 'Edit Contact' : 'New Contact', bodyHtml: '<div class="hint">Loading…</div>',
      onMount: async () => {
        await preload();
        renderWizardBody();
        App.utils.qs('#sharedModalBody').innerHTML = renderWizardBody();
        wireStepFields();
        refreshActions();
      },
    });
  }

  // ---- Detail modal ----
  async function openContactDetail(contactId) {
    const [contact, phones, emails, addresses, notes, dates, reminders, groups, allMemberships] = await Promise.all([
      App.api.getContact(contactId), App.api.listContactPhones(contactId), App.api.listContactEmails(contactId),
      App.api.listContactAddresses(contactId), App.api.listContactNotes(contactId), App.api.listContactImportantDates(contactId),
      App.api.listContactReminders({ eq: { contact_id: contactId } }), App.api.listContactGroups(),
      App.api.listContactGroupMembers({ eq: { contact_id: contactId } }),
    ]);
    const myGroups = groups.filter((g) => allMemberships.some((m) => m.group_id === g.id));
    const primaryPhone = phones.find((p) => p.is_primary) || phones[0];
    const primaryEmail = emails.find((e) => e.is_primary) || emails[0];
    const waPhone = phones.find((p) => p.is_whatsapp) || primaryPhone;

    const overviewHtml = `
      <div class="grid-2">
        <div>
          ${phones.map((p) => `<div class="stat-line"><span>${App.utils.escapeHtml(p.label)} Phone</span><span class="v">${App.utils.escapeHtml(p.phone_number)}</span></div>`).join('') || '<div class="stat-line"><span>Phone</span><span class="v">—</span></div>'}
          ${emails.map((e) => `<div class="stat-line"><span>${App.utils.escapeHtml(e.label)} Email</span><span class="v">${App.utils.escapeHtml(e.email)}</span></div>`).join('')}
          <div class="stat-line"><span>Birthday</span><span class="v">${App.utils.fmtDate(contact.birthday)}</span></div>
          <div class="stat-line"><span>Family Relationship</span><span class="v">${App.utils.escapeHtml(contact.family_relationship || '—')}</span></div>
        </div>
        <div>
          <div class="stat-line"><span>Company</span><span class="v">${App.utils.escapeHtml(contact.company || '—')}</span></div>
          <div class="stat-line"><span>Job Title</span><span class="v">${App.utils.escapeHtml(contact.job_title || '—')}</span></div>
          ${addresses.map((a) => `<div class="stat-line"><span>${App.utils.escapeHtml(a.address_type)} Address</span><span class="v">${App.utils.escapeHtml([a.line1, a.city, a.state, a.country, a.postal_code].filter(Boolean).join(', ') || '—')}</span></div>`).join('')}
          <div class="stat-line"><span>Groups</span><span class="v">${myGroups.map((g) => App.utils.escapeHtml(g.name)).join(', ') || '—'}</span></div>
          <div class="stat-line"><span>Tags</span><span class="v">${(contact.tags || []).map((t) => App.utils.escapeHtml(t)).join(', ') || '—'}</span></div>
        </div>
      </div>
      ${contact.linked_user_id ? '<div class="hint" style="margin-top:10px">&#10003; This contact is a registered portfolio user - Message and Call use in-app chat/calling.</div>' : '<div class="hint" style="margin-top:10px">External contact - not a registered portfolio user. Use <b>Find on Portfolio</b> below to check again.</div>'}
      ${!contact.linked_user_id ? '<div class="field" style="max-width:280px;margin-top:8px"><label>Find on Portfolio (phone, email or username)</label><input id="discoverQuery" placeholder="Search..."><button class="btn btn-outline btn-sm" id="discoverBtn" style="margin-top:8px">Search</button><div id="discoverResult" class="hint"></div></div>' : ''}`;

    const notesHtml = `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input class="search-input" id="newNoteInput" placeholder="Add a private note..." style="flex:1">
        <button class="btn btn-gold btn-sm" id="addNoteBtn">Add</button>
      </div>
      <div style="max-height:160px;overflow-y:auto;margin-bottom:16px">${notes.map((n) => `<div class="risk-item"><div><div class="risk-name">${App.utils.escapeHtml(n.note_text)}</div><div class="risk-desc">${App.utils.fmtDateTime(n.created_at)}</div></div></div>`).join('') || '<div class="empty-note">No notes yet.</div>'}</div>
      <div class="section-title" style="font-size:14px;margin-bottom:8px">Follow-up Reminders <div class="line"></div></div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <input class="search-input" id="newReminderMsg" placeholder="e.g. Call about the FD renewal" style="flex:1">
        <input type="datetime-local" id="newReminderAt" class="date-mini">
        <button class="btn btn-gold btn-sm" id="addReminderBtn">Add</button>
      </div>
      <div>${reminders.map((r) => `<div class="risk-item"><div class="risk-dot" style="background:${r.is_done ? 'var(--teal)' : 'var(--gold)'}"></div><div style="flex:1"><div class="risk-name">${App.utils.escapeHtml(r.message)}</div><div class="risk-desc">${App.utils.fmtDateTime(r.remind_at)}</div></div>${!r.is_done ? `<button class="icon-btn" data-done-reminder="${r.id}" title="Mark done">&#10003;</button>` : ''}</div>`).join('') || '<div class="empty-note">No reminders yet.</div>'}</div>`;

    const datesHtml = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn btn-gold btn-sm" id="addImportantDateBtn">+ Add Important Date</button></div>
      <div class="table-scroll"><table class="data"><thead><tr><th>Type</th><th>Date</th><th>Label</th><th>Reminder</th></tr></thead>
      <tbody>${dates.map((d) => `<tr><td>${d.date_type}</td><td>${App.utils.fmtDate(d.date)}</td><td>${App.utils.escapeHtml(d.label || '—')}</td><td>${d.reminder_offset_days != null ? d.reminder_offset_days + ' day(s) before' : '—'}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:20px">No important dates yet.</td></tr>'}</tbody></table></div>`;

    const bodyHtml = `
      <div class="tabbar" id="detailTabs">
        <button class="tab-btn active" data-tab="ov">Overview</button>
        <button class="tab-btn" data-tab="no">Notes & Reminders</button>
        <button class="tab-btn" data-tab="da">Important Dates</button>
      </div>
      <div class="tab-pane active" data-pane="ov">${overviewHtml}</div>
      <div class="tab-pane" data-pane="no">${notesHtml}</div>
      <div class="tab-pane" data-pane="da">${datesHtml}</div>`;

    function actionBar() {
      const actions = [];
      if (primaryPhone) actions.push({ label: '📞 Call', className: 'btn-outline', onClick: () => { window.location.href = 'tel:' + e164(primaryPhone.phone_number); } });
      if (contact.linked_user_id) {
        actions.push({ label: '💬 Message', className: 'btn-outline', onClick: async () => {
          const conv = await App.api.startDirectConversation(contact.linked_user_id);
          App.ui.close();
          App.router.navigate('chat');
          setTimeout(() => App.chatView && App.chatView.openConversation(conv.id), 80);
        } });
      }
      if (waPhone) actions.push({ label: '📱 WhatsApp', className: 'btn-outline', onClick: () => {
        window.open(waLink(waPhone.phone_number, `Hi ${contact.first_name || ''}!`.trim()), '_blank');
      } });
      if (primaryEmail) actions.push({ label: '✉ Email', className: 'btn-outline', onClick: () => { window.location.href = 'mailto:' + primaryEmail.email; } });
      actions.push({ label: contact.favorite ? '★ Favorited' : '☆ Favorite', className: 'btn-outline', onClick: async () => {
        await App.api.updateContact(contact.id, { favorite: !contact.favorite });
        App.ui.close(); App.router.refreshCurrent();
      } });
      actions.push({ label: 'More', className: 'btn-outline', onClick: () => openMoreMenu(contact) });
      actions.push({ label: 'Close', className: 'btn-gold', onClick: App.ui.close });
      return actions;
    }

    App.ui.open({
      title: contact.display_name || contact.full_name || 'Contact',
      bodyHtml,
      actions: actionBar(),
      onMount: (body) => {
        App.utils.qsa('.tab-btn', body.parentElement).forEach((btn) => {
          btn.addEventListener('click', () => {
            App.utils.qsa('.tab-btn', body.parentElement).forEach((b) => b.classList.toggle('active', b === btn));
            App.utils.qsa('.tab-pane', body).forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
          });
        });
        const discoverBtn = App.utils.qs('#discoverBtn', body);
        if (discoverBtn) discoverBtn.addEventListener('click', async () => {
          const q = App.utils.qs('#discoverQuery', body).value.trim();
          const resultEl = App.utils.qs('#discoverResult', body);
          if (!q) return;
          try {
            const match = await App.api.findPortfolioUser(q);
            if (!match) { resultEl.textContent = 'No matching registered user found (or their privacy settings prevent discovery).'; return; }
            resultEl.innerHTML = `Found <b>${App.utils.escapeHtml(match.display_name)}</b>. <button class="btn btn-sm btn-gold" id="linkFoundUser">Link to this contact</button>`;
            App.utils.qs('#linkFoundUser', body).addEventListener('click', async () => {
              await App.api.updateContact(contact.id, { linked_user_id: match.id });
              App.utils.toast('Linked to registered user');
              App.ui.close();
              openContactDetail(contact.id);
            });
          } catch (e) { resultEl.textContent = 'Search failed: ' + (e.message || e); }
        });
        const addNoteBtn = App.utils.qs('#addNoteBtn', body);
        if (addNoteBtn) addNoteBtn.addEventListener('click', async () => {
          const input = App.utils.qs('#newNoteInput', body);
          if (!input.value.trim()) return;
          await App.api.createContactNote({ contact_id: contact.id, note_text: input.value.trim() });
          App.ui.close(); openContactDetail(contact.id);
        });
        const addReminderBtn = App.utils.qs('#addReminderBtn', body);
        if (addReminderBtn) addReminderBtn.addEventListener('click', async () => {
          const msg = App.utils.qs('#newReminderMsg', body).value.trim();
          const at = App.utils.qs('#newReminderAt', body).value;
          if (!msg || !at) { App.utils.toast('Enter a message and time', 'err'); return; }
          await App.api.createContactReminder({ contact_id: contact.id, message: msg, remind_at: new Date(at).toISOString() });
          App.ui.close(); openContactDetail(contact.id);
        });
        App.utils.qsa('[data-done-reminder]', body).forEach((b) => b.addEventListener('click', async () => {
          await App.api.updateContactReminder(Number(b.dataset.doneReminder), { is_done: true });
          App.ui.close(); openContactDetail(contact.id);
        }));
        const addDateBtn = App.utils.qs('#addImportantDateBtn', body);
        if (addDateBtn) addDateBtn.addEventListener('click', () => openImportantDateModal(contact.id));
      },
    });
  }

  function openImportantDateModal(contactId) {
    const fields = [
      { key: 'date_type', label: 'Type', required: true, type: 'select', options: ['Anniversary', 'Joining Date', 'Meeting', 'Renewal', 'Custom'] },
      { key: 'date', label: 'Date', required: true, type: 'date' },
      { key: 'label', label: 'Label' },
      { key: 'reminder_offset_days', label: 'Remind (days before)', type: 'number', placeholder: '0 = on the date' },
      { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
    ];
    App.ui.open({
      title: 'Add Important Date', bodyHtml: App.ui.renderForm(fields),
      actions: [
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        { label: 'Save', className: 'btn-gold', onClick: async () => {
          const { values, errors } = App.ui.readForm(fields);
          if (errors.length) { App.utils.toast('Fill in type and date', 'err'); return; }
          await App.api.createContactImportantDate(Object.assign({ contact_id: contactId }, values));
          App.utils.toast('Important date added');
          App.ui.close();
          openContactDetail(contactId);
        } },
      ],
    });
  }

  function vCardFor(contact, phones, emails) {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${contact.last_name || ''};${contact.first_name || ''};;;`, `FN:${contact.display_name || contact.full_name || ''}`];
    if (contact.company) lines.push(`ORG:${contact.company}`);
    if (contact.job_title) lines.push(`TITLE:${contact.job_title}`);
    phones.forEach((p) => lines.push(`TEL;TYPE=${p.label}:${p.phone_number}`));
    emails.forEach((e) => lines.push(`EMAIL;TYPE=${e.label}:${e.email}`));
    if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }

  async function openMoreMenu(contact) {
    const [phones, emails, allContacts] = await Promise.all([
      App.api.listContactPhones(contact.id), App.api.listContactEmails(contact.id), App.api.listContacts(),
    ]);
    const others = allContacts.filter((c) => c.id !== contact.id);
    const bodyHtml = `
      <div class="card-row" style="flex-direction:column">
        <button class="btn btn-outline" id="moreEdit" style="width:100%;justify-content:flex-start">Edit</button>
        <button class="btn btn-outline" id="moreExportVcard" style="width:100%;justify-content:flex-start">Export vCard</button>
        <div class="field"><label>Merge into another contact</label>
          <select id="mergeTarget"><option value="">Select a contact...</option>${others.map((c) => `<option value="${c.id}">${App.utils.escapeHtml(c.display_name || c.full_name)}</option>`).join('')}</select>
          <button class="btn btn-outline btn-sm" id="moreMerge" style="margin-top:8px">Merge</button></div>
        ${contact.linked_user_id ? `
        <button class="btn btn-outline" id="moreBlock" style="width:100%;justify-content:flex-start">Block User</button>
        <button class="btn btn-outline" id="moreReport" style="width:100%;justify-content:flex-start">Report User</button>` : ''}
        <button class="btn btn-danger" id="moreDelete" style="width:100%;justify-content:flex-start">Delete Contact</button>
      </div>`;
    App.ui.open({
      title: 'More Actions', bodyHtml,
      actions: [{ label: 'Close', className: 'btn-outline', onClick: App.ui.close }],
      onMount: (body) => {
        App.utils.qs('#moreEdit', body).addEventListener('click', async () => { App.ui.close(); const groups = await App.api.listContactGroups(); openContactWizard(contact, groups); });
        App.utils.qs('#moreExportVcard', body).addEventListener('click', () => {
          const blob = new Blob([vCardFor(contact, phones, emails)], { type: 'text/vcard' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = (contact.display_name || 'contact') + '.vcf'; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
        App.utils.qs('#moreMerge', body).addEventListener('click', async () => {
          const targetId = Number(App.utils.qs('#mergeTarget', body).value);
          if (!targetId) { App.utils.toast('Pick a contact to merge into', 'err'); return; }
          if (!confirm('Merge this contact into the selected one? This contact will be deleted; its phones/emails/notes/tags move to the target.')) return;
          try { await mergeContacts(targetId, contact.id); App.utils.toast('Contacts merged'); App.ui.close(); App.router.refreshCurrent(); }
          catch (e) { App.utils.toast('Could not merge: ' + (e.message || e), 'err'); }
        });
        if (contact.linked_user_id) {
          App.utils.qs('#moreBlock', body).addEventListener('click', async () => {
            if (!confirm('Block this user? They will no longer be able to message or call you.')) return;
            await App.api.blockUser(contact.linked_user_id, 'Blocked from Contacts');
            App.utils.toast('User blocked'); App.ui.close();
          });
          App.utils.qs('#moreReport', body).addEventListener('click', async () => {
            const reason = prompt('Reason for reporting this user:');
            if (!reason) return;
            await App.api.reportUser(contact.linked_user_id, reason, null);
            App.utils.toast('Report submitted'); App.ui.close();
          });
        }
        App.utils.qs('#moreDelete', body).addEventListener('click', async () => {
          if (!confirm('Delete this contact? This cannot be undone.')) return;
          await App.api.deleteContact(contact.id);
          App.utils.toast('Contact deleted'); App.ui.close(); App.router.refreshCurrent();
        });
      },
    });
  }

  // Merge (Section 8): re-parent every child row from mergeFromId onto
  // keepId, then delete the now-empty duplicate. Never touches chat/call
  // history since those key off linked_user_id, not the contact row itself.
  async function mergeContacts(keepId, mergeFromId) {
    const [phones, emails, addresses, notes, dates, memberships, mergeFromContact, keepContact] = await Promise.all([
      App.api.listContactPhones(mergeFromId), App.api.listContactEmails(mergeFromId), App.api.listContactAddresses(mergeFromId),
      App.api.listContactNotes(mergeFromId), App.api.listContactImportantDates(mergeFromId),
      App.api.listContactGroupMembers({ eq: { contact_id: mergeFromId } }),
      App.api.getContact(mergeFromId), App.api.getContact(keepId),
    ]);
    for (const p of phones) await App.api.updateContactPhone(p.id, { contact_id: keepId });
    for (const e of emails) await App.api.updateContactEmail(e.id, { contact_id: keepId });
    for (const a of addresses) await App.api.updateContactAddress(a.id, { contact_id: keepId });
    for (const n of notes) await App.api.createContactNote({ contact_id: keepId, note_text: n.note_text });
    for (const d of dates) await App.api.createContactImportantDate({ contact_id: keepId, date_type: d.date_type, date: d.date, label: d.label, reminder_offset_days: d.reminder_offset_days, notes: d.notes });
    for (const m of memberships) { try { await App.api.addContactToGroup(m.group_id, keepId); } catch (e) { /* already a member */ } }
    if (!keepContact.linked_user_id && mergeFromContact.linked_user_id) {
      await App.api.updateContact(keepId, { linked_user_id: mergeFromContact.linked_user_id });
    }
    const mergedTags = Array.from(new Set([...(keepContact.tags || []), ...(mergeFromContact.tags || [])]));
    await App.api.updateContact(keepId, { tags: mergedTags });
    await App.api.deleteContact(mergeFromId);
  }

  // ---- List view ----
  let searchTerm = '';
  let groupFilter = 'All';

  async function renderContactsView() {
    const pane = App.utils.qs('#pane-contacts');
    pane.innerHTML = `
      <div class="section-title">Contacts <div class="line"></div><small>your private address book - separate from portfolio &amp; community</small></div>
      <div class="kpi-grid" id="contactsKpis"></div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <input class="search-input" id="contactsSearch" placeholder="Search name, phone, email, company, tags, notes..." style="min-width:280px">
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline btn-sm" id="manageGroupsBtn">Manage Groups</button>
            <button class="btn btn-outline btn-sm" id="exportContactsBtn">&#8595; Export</button>
            <button class="btn btn-gold btn-sm" id="addContactBtn">+ Add Contact</button>
          </div>
        </div>
        <div class="chip-row" id="contactsGroupFilter" style="margin-bottom:14px"></div>
        <div id="contactsGrid" class="card-row" style="flex-wrap:wrap"></div>
      </div>`;

    App.utils.qs('#contactsSearch', pane).addEventListener('input', App.utils.debounce((e) => { searchTerm = e.target.value.toLowerCase(); draw(); }, 250));
    App.utils.qs('#addContactBtn', pane).addEventListener('click', async () => { const groups = await App.api.listContactGroups(); openContactWizard(null, groups); });
    App.utils.qs('#manageGroupsBtn', pane).addEventListener('click', openManageGroupsModal);
    App.utils.qs('#exportContactsBtn', pane).addEventListener('click', async () => {
      try { await App.exportData.exportSection('contacts'); } catch (e) { App.utils.toast('Could not export: ' + (e.message || e), 'err'); }
    });

    async function draw() {
      const [contacts, groups] = await Promise.all([App.api.listContacts(), App.api.listContactGroups()]);

      // Search needs phone/email/notes text too - fetched once for every
      // contact in parallel and indexed by contact_id (personal-scale data,
      // so this is fine without a server-side search function).
      const phonesByContact = {}, emailsByContact = {}, notesByContact = {};
      const [phoneLists, emailLists, noteLists] = await Promise.all([
        Promise.all(contacts.map((c) => App.api.listContactPhones(c.id))),
        Promise.all(contacts.map((c) => App.api.listContactEmails(c.id))),
        Promise.all(contacts.map((c) => App.api.listContactNotes(c.id))),
      ]);
      contacts.forEach((c, i) => {
        phonesByContact[c.id] = phoneLists[i];
        emailsByContact[c.id] = emailLists[i];
        notesByContact[c.id] = noteLists[i];
      });

      const memberships = await App.api.listContactGroupMembers();
      const groupsByContact = {};
      memberships.forEach((m) => { (groupsByContact[m.contact_id] = groupsByContact[m.contact_id] || []).push(m.group_id); });

      App.utils.qs('#contactsGroupFilter', pane).innerHTML = ['All', 'Favorites', ...groups.map((g) => g.name)].map((g) =>
        `<div class="chip ${groupFilter === g ? 'active' : ''}" data-group-filter="${App.utils.escapeHtml(g)}">${App.utils.escapeHtml(g)}</div>`).join('');
      App.utils.qsa('[data-group-filter]', pane).forEach((chip) => chip.addEventListener('click', () => {
        groupFilter = chip.dataset.groupFilter;
        favoritesOnly = groupFilter === 'Favorites';
        draw();
      }));

      let list = contacts.slice();
      if (groupFilter === 'Favorites') list = list.filter((c) => c.favorite);
      else if (groupFilter !== 'All') {
        const g = groups.find((x) => x.name === groupFilter);
        if (g) list = list.filter((c) => (groupsByContact[c.id] || []).includes(g.id));
      }
      if (searchTerm) {
        list = list.filter((c) => {
          const hay = [
            c.display_name, c.full_name, c.company, c.job_title, ...(c.tags || []),
            ...((phonesByContact[c.id] || []).map((p) => p.phone_number)),
            ...((emailsByContact[c.id] || []).map((e) => e.email)),
            ...((notesByContact[c.id] || []).map((n) => n.note_text)),
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(searchTerm);
        });
      }
      list.sort((a, b) => (b.favorite - a.favorite) || (a.display_name || '').localeCompare(b.display_name || ''));

      const today = App.utils.todayISO().slice(5);
      const upcomingBirthdays = contacts.filter((c) => c.birthday && c.birthday.slice(5) >= today && c.birthday.slice(5) <= App.utils.toISO(new Date(Date.now() + 30 * 86400000)).slice(5)).length;
      const cards = [
        { cls: 'c-gold', icon: '&#128101;', label: 'Contacts', value: contacts.length },
        { cls: 'c-teal', icon: '&#9733;', label: 'Favorites', value: contacts.filter((c) => c.favorite).length },
        { cls: 'c-blue', icon: '&#128272;', label: 'Portfolio Users', value: contacts.filter((c) => c.linked_user_id).length },
        { cls: 'c-purple', icon: '&#127874;', label: 'Upcoming Birthdays (30d)', value: upcomingBirthdays },
      ];
      App.utils.qs('#contactsKpis', pane).innerHTML = cards.map((c) => `
        <div class="kpi ${c.cls} fade-up"><div class="kpi-icon">${c.icon}</div><div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div></div>`).join('');

      App.utils.qs('#contactsGrid', pane).innerHTML = list.map((c) => {
        const p = (phonesByContact[c.id] || []).find((x) => x.is_primary) || (phonesByContact[c.id] || [])[0];
        return `<div class="integration-card" style="min-width:220px;max-width:260px;cursor:pointer" data-open-contact="${c.id}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold2));color:var(--on-gold);display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${initials(c)}</div>
            <div style="flex:1;min-width:0">
              <div class="name" style="display:flex;align-items:center;gap:4px">${c.favorite ? '&#9733; ' : ''}${App.utils.escapeHtml(c.display_name || c.full_name || '(unnamed)')}</div>
              <div class="status">${App.utils.escapeHtml(c.company || (c.tags || []).join(', ') || '')}</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text3)">${p ? App.utils.escapeHtml(p.phone_number) : ''}</div>
          ${c.linked_user_id ? '<div class="hint" style="margin:4px 0 0">&#10003; Portfolio user</div>' : ''}
        </div>`;
      }).join('') || '<div class="empty-note" style="width:100%">No contacts match.</div>';

      App.utils.qsa('[data-open-contact]', pane).forEach((el) => el.addEventListener('click', () => openContactDetail(Number(el.dataset.openContact))));
    }

    await draw();
  }

  function openManageGroupsModal() {
    async function draw() {
      const groups = await App.api.listContactGroups();
      App.ui.open({
        title: 'Manage Groups',
        bodyHtml: `
          <div style="display:flex;gap:8px;margin-bottom:14px">
            <input class="search-input" id="newGroupName" placeholder="New group name..." style="flex:1">
            <button class="btn btn-gold btn-sm" id="addGroupBtn">Add</button>
          </div>
          <div>${groups.map((g) => `<div class="risk-item"><div class="risk-name" style="flex:1">${App.utils.escapeHtml(g.name)}</div><button class="icon-btn del" data-del-group="${g.id}">&#128465;</button></div>`).join('') || '<div class="empty-note">No groups yet.</div>'}</div>`,
        actions: [{ label: 'Close', className: 'btn-gold', onClick: () => { App.ui.close(); App.router.refreshCurrent(); } }],
        onMount: (body) => {
          App.utils.qs('#addGroupBtn', body).addEventListener('click', async () => {
            const input = App.utils.qs('#newGroupName', body);
            if (!input.value.trim()) return;
            await App.api.createContactGroup({ name: input.value.trim() });
            draw();
          });
          App.utils.qsa('[data-del-group]', body).forEach((b) => b.addEventListener('click', async () => {
            if (!confirm('Delete this group? Contacts stay, just no longer grouped this way.')) return;
            await App.api.deleteContactGroup(Number(b.dataset.delGroup));
            draw();
          }));
        },
      });
    }
    draw();
  }

  App.router.register('contacts', renderContactsView);
  App.contactsView = { openContactDetail, openContactWizard, mergeContacts };
})();
