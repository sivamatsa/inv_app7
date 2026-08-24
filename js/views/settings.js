/* Settings (spec Section 46 nav) - profile (Section 3), notification
   preferences (Section 10), platforms, and the Section 50 "future
   integrations" interface stubs. */
window.App = window.App || {};

(function () {
  const PROFILE_FIELDS = [
    { key: 'full_name', label: 'Full Name' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'city', label: 'City' },
    { key: 'country', label: 'Country' },
    { key: 'preferred_currency', label: 'Preferred Currency', placeholder: 'INR' },
    { key: 'timezone', label: 'Timezone', placeholder: 'Asia/Kolkata' },
    { key: 'financial_year_start_month', label: 'FY Start Month (1-12)', type: 'number' },
    { key: 'financial_year_start_day', label: 'FY Start Day', type: 'number' },
  ];

  // 'Email' removed from this not-connected list - real email delivery is
  // now wired up (021_email_notifications.sql + the send-notification-emails
  // Edge Function), with its own toggle in Reminder Preferences below
  // instead of living here as an aspirational card.
  const INTEGRATIONS = ['Lender/Platform API', 'Bank Statement Import', 'Open Banking', 'Email Statement Parsing',
    'SMS Transaction Parsing', 'Telegram', 'WhatsApp', 'Push Notifications', 'Google Calendar', 'Accounting/Tax Software'];

  // The full notifications.type check constraint list (031_expense_projects.sql
  // has the current, authoritative version) - kept in sync by hand since a
  // future migration adding a new type needs a matching row here for it to
  // show up in the matrix below (absence of a row just means "not
  // configurable yet", not an error - App.notifPrefs.isEnabled() defaults
  // any type with no explicit preference to enabled on every channel).
  const NOTIFICATION_TYPES = [
    'Payment Due', 'Payment Overdue', 'Maturity Approaching', 'Maturity Today',
    'Principal Expected', 'Large Payment Expected', 'Missed Payment',
    'Reinvestment Opportunity', 'Deal Closure', 'Document Expiry', 'Tax Reporting',
    'Support Ticket', 'Recurring Reminder', 'Recurring Overdue',
    'Contact Reminder', 'Contact Birthday', 'Contact Important Date',
    'New Message', 'Group Message', 'Mention', 'Incoming Call', 'Missed Call',
    'Gold Target Price', 'Gold Price Drop', 'Gold Price Rise', 'Gold New Low', 'Gold New High',
    'Calendar Reminder', 'Expense Budget Warning', 'Expense Budget Exceeded',
    'Automation Rule Triggered',
  ];

  // Contacts/Chat privacy (spec addendum Section 27). A dedicated panel
  // rather than mixed into Profile, since these are access-control
  // decisions, not identity fields.
  const PRIVACY_FIELDS = [
    { key: 'who_can_find_me', label: 'Who can find me?', type: 'select', options: ['Anyone', 'Contacts', 'Nobody'] },
    { key: 'who_can_message_me', label: 'Who can message me?', type: 'select', options: ['Anyone', 'Contacts', 'Nobody'] },
    { key: 'who_can_call_me', label: 'Who can call me?', type: 'select', options: ['Anyone', 'Contacts', 'Nobody'] },
    { key: 'show_online_status', label: 'Show Online Status', type: 'checkbox' },
    { key: 'show_last_seen', label: 'Show Last Seen', type: 'checkbox' },
    { key: 'show_read_receipts', label: 'Show Read Receipts', type: 'checkbox' },
    { key: 'show_profile_photo', label: 'Show Profile Photo', type: 'checkbox' },
    { key: 'allow_contact_discovery', label: 'Allow Contact Discovery', type: 'checkbox' },
    { key: 'allow_group_invitations', label: 'Allow Group Invitations', type: 'checkbox' },
    { key: 'allow_call_invitations', label: 'Allow Call Invitations', type: 'checkbox' },
  ];

  async function renderSettingsView() {
    const pane = App.utils.qs('#pane-settings');
    const isAdminUser = App.state.profile && App.state.profile.is_admin;
    // Demo Mode's seeded profile is also flagged is_admin (so every admin
    // feature can be exercised in the sandbox) - but showing a real
    // Supabase project URL/reconnect control inside a "nothing here is
    // real" sandbox is exactly the kind of confusing exception this app
    // has avoided everywhere else, so this one panel is hidden there.
    const showConnectionPanel = isAdminUser && !App.auth.isDemoMode();
    pane.innerHTML = `
      <div class="section-title">Settings <div class="line"></div><small>profile, reminders, platforms, integrations</small></div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Profile</div>
        <div id="profileFormHost"></div>
        <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-gold" id="saveProfileBtn">Save Profile</button></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Privacy &amp; Contacts</div>
        <div class="hint" style="margin-bottom:10px">Controls how Contacts discovery, private chat, and calling work - separate from Investment Deals/Recurring Investments/Community/Write to Us, which don't use these settings at all.</div>
        <div class="field span2" style="margin-bottom:10px"><label>Username (for "find by unique ID")</label><input id="usernameInput" placeholder="e.g. yourname"></div>
        <div id="privacyFormHost"></div>
        <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-gold btn-sm" id="savePrivacyBtn">Save Privacy Settings</button></div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border2)">
          <div class="chart-title" style="margin-bottom:6px;font-size:13px">Sign-in Activity Logging</div>
          <div class="hint" style="margin-bottom:8px">Whether approximate location/device is logged with your sign-ins (admin-visible only). Declining still logs that a sign-in happened, never IP/location/device.</div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" id="analyticsConsentToggle"> Log approximate location and device with my sign-ins
          </label>
        </div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:6px">Customize Sidebar</div>
        <div class="hint" style="margin-bottom:10px">Reorder or hide any section (within its own group), or switch to icon-only mode for a narrower sidebar. Hiding a section only removes its link here - nothing it manages is deleted, and it's still reachable via a direct link (e.g. clicking through from a notification).</div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;margin-bottom:12px">
          <input type="checkbox" id="sidebarCompactToggle"> Icon-only (compact) sidebar
        </label>
        <div id="sidebarCustomizeList"></div>
        <div class="modal-actions" style="justify-content:flex-start;margin-top:10px"><button class="btn btn-outline btn-sm" id="resetSidebarBtn">Reset to Default</button></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:10px">Reminder Preferences</div>
        <div class="hint" style="margin-bottom:10px">Default offsets (days relative to a due date; negative = before, positive = overdue): -7, -3, -1, 0, 1, 3, 7, 30 (spec Section 10).</div>
        <div class="field span2"><label>Reminder Offsets (comma-separated days)</label><input class="search-input" id="offsetsInput" style="width:100%"></div>
        <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-gold btn-sm" id="savePrefsBtn">Save Preferences</button></div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border2)">
          <div class="chart-title" style="margin-bottom:6px;font-size:13px">Do Not Disturb</div>
          <div class="hint" style="margin-bottom:8px">Silences your notification bell and toast pop-ups for a while - nothing is lost, everything generated while disabled is still there the moment you turn it back on.</div>
          <div id="snoozeStatus"></div>
          <div id="snoozeControls" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
            <select id="snoozeDuration" class="search-input" style="width:auto">
              <option value="1h">1 Hour</option>
              <option value="4h">4 Hours</option>
              <option value="today">Rest of Today</option>
              <option value="tomorrow">Until Tomorrow Morning</option>
              <option value="week">1 Week</option>
              <option value="indefinite">Until I Turn It Back On</option>
            </select>
            <button class="btn btn-outline btn-sm" id="snoozeBtn">Disable Notifications</button>
          </div>
          <button class="btn btn-gold btn-sm" id="unsnoozeBtn" style="display:none">Enable Notifications Now</button>
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border2)">
          <div class="chart-title" style="margin-bottom:6px;font-size:13px">Email Notifications</div>
          <div class="hint" style="margin-bottom:8px">Sends a digest email (everything new since the last one, in a single message) on whatever cadence you pick below. "Never" turns email off entirely. Respects Do Not Disturb above - nothing is emailed while snoozed, it just waits for the next cycle after you turn it back on.</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select id="emailFrequencySelect" class="search-input" style="width:auto">
              <option value="never">Never</option>
              <option value="1_day">Every 1 Day</option>
              <option value="5_days">Every 5 Days</option>
              <option value="7_days">Every 7 Days</option>
              <option value="10_days">Every 10 Days</option>
              <option value="1_month">Every 1 Month</option>
              <option value="3_months">Every 3 Months</option>
            </select>
          </div>
          <div id="emailLastSentHint" class="hint" style="margin-top:6px"></div>
          ${isAdminUser ? `<div style="margin-top:10px">
            <button class="btn btn-outline btn-sm" id="triggerEmailsNowBtn">&#9993; Trigger Emails Now</button>
            <div class="hint" style="margin-top:6px">Admin-only: invokes the send-notification-emails Edge Function immediately, for every opted-in user (not just you) - the same sweep the Cron Job runs automatically. Use this to test your Resend setup without waiting for the schedule.</div>
          </div>` : ''}
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border2)">
          <div class="chart-title" style="margin-bottom:6px;font-size:13px">Push Notifications</div>
          <div class="hint" style="margin-bottom:8px" id="pushHint">Real, near-instant browser notifications on this device - works even when this tab isn't open (as long as the browser itself is running). A separate on/off per device, since a phone and a laptop are different subscriptions.</div>
          <div id="pushControls"></div>
          ${isAdminUser ? `<div style="margin-top:10px">
            <button class="btn btn-outline btn-sm" id="triggerPushNowBtn">&#128276; Trigger Push Now</button>
            <div class="hint" style="margin-top:6px">Admin-only: invokes the send-web-push Edge Function immediately, for every opted-in, subscribed device (not just yours) - the same sweep the Cron Job runs automatically. <code>sent</code> means it reached a subscription, <code>skipped</code> means that user/device isn't opted in or subscribed, <code>failed</code> means it reached a subscription but delivery itself failed (e.g. VAPID keys not set, or a dead subscription).</div>
            <div id="pushLastResultHint" class="hint" style="margin-top:6px"></div>
          </div>` : ''}
        </div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:6px">Notification Delivery, by Type</div>
        <div class="hint" style="margin-bottom:10px">Choose exactly which channels each kind of notification is allowed to reach. Unchecking every box for a type means it generates nothing on any channel - the record still exists (visible to admin in Audit History), it just never reaches you.</div>
        <div class="table-scroll" style="max-height:360px"><table class="data" id="notifTypeMatrix"></table></div>
      </div>
      ${isAdminUser ? `<div class="panel">
        <div class="chart-title" style="margin-bottom:6px">Audit History <span style="color:var(--text3);font-weight:400;font-size:12px">(Admin Only)</span></div>
        <div class="hint" style="margin-bottom:10px">Every change to Deals/Payments/Payment Schedule/Reinvestments/Recurring Items/Recurring Occurrences is logged to <code>audit_logs</code> for traceability. Disabling this stops FUTURE rows from being written (reduces ongoing database growth) - it does not delete history already recorded.</div>
        <div id="auditHistoryStatus" class="hint" style="margin-bottom:8px"></div>
        <button class="btn btn-outline btn-sm" id="toggleAuditHistoryBtn"></button>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border2)">
          <div class="chart-title" style="margin-bottom:6px;font-size:13px">Benchmark Reference Rate</div>
          <div class="hint" style="margin-bottom:8px">The flat comparison line on Analytics &rarr; Benchmark Comparison. A manual assumption, not a live rate - there's no clean free API for one.</div>
          <div style="display:flex;gap:8px;align-items:center"><input id="fdReferenceRateInput" type="number" step="0.1" class="search-input" style="width:100px"> <span class="hint" style="margin:0">% per year (FD reference)</span> <button class="btn btn-outline btn-sm" id="saveFdRateBtn">Save</button></div>
        </div>
      </div>` : ''}
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="chart-title">Backup &amp; Disaster Recovery</div>
          <button class="btn btn-outline btn-sm" id="exportAllBtn">&#8595; Export All My Data</button>
        </div>
        <div class="hint">Downloads every section you have access to as one Excel workbook (one sheet per section) - Platforms, Deals, Payment Schedule, Payments, Recurring Items/Occurrences, Contacts, Gold Purchases, Accounts, Liabilities, Expense Projects/Transactions/Vendors, Notes, Documents, Goals, Tax Records, Audit History, and Import History. Individual sections also have their own Export button on their own page.</div>
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border2)">
          <div class="chart-title" style="margin-bottom:8px">Restore from Backup</div>
          <div class="hint" style="margin-bottom:10px">Restore is <b>additive only</b> - it adds new rows from a previous "Export All" workbook, it never updates or deletes anything already in your account. Only use this to rebuild an empty or damaged project after data loss - running it against a project that still has your data will create duplicates.</div>
          <button class="btn btn-outline btn-sm" id="restoreChooseFileBtn">&#128193; Choose Backup File</button>
          <span class="hint" id="restoreFileNameHint" style="margin-left:8px"></span>
          <input type="file" id="restoreFileInput" accept=".xlsx,.xls" style="display:none">
          <div id="restoreChecklist" style="margin-top:12px"></div>
        </div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:6px;color:var(--red,#e5484d)">Danger Zone</div>
        <div class="hint" style="margin-bottom:10px">Permanently deletes every deal, payment, recurring item, gold purchase, expense, contact, note, document, and notification you own - Community, Blog, Support Tickets, Chat, and any portfolio shared with you or by you are untouched. Your account and sign-in stay intact; this only clears data. There is no undo.</div>
        <button class="btn btn-outline" id="clearMyDataBtn" style="border-color:var(--red,#e5484d);color:var(--red,#e5484d)">Clear My Data</button>
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="chart-title">Platforms</div>
          <button class="btn btn-outline btn-sm" id="addPlatformBtn">+ Add Platform</button>
        </div>
        <div class="table-scroll"><table class="data" id="platformsTable"></table></div>
      </div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div class="chart-title">Gold Price Provider</div>
          <button class="btn btn-outline btn-sm" id="goldRefreshNowBtn">&#8635; Refresh Now</button>
        </div>
        <div class="hint" style="margin-bottom:12px">Powers Gold Intelligence's live price feed. Every provider converts international spot gold to INR - none give a genuine Indian retail rate.</div>
        <div id="goldProviderList"></div>
        <div id="goldAdminHint"></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:4px">AI Model Provider</div>
        <div class="hint" style="margin-bottom:12px">Powers the AI Portfolio Copilot. Pick whichever provider you actually have an API key for - only the active one's secret needs to be set.</div>
        <div id="aiProviderList"></div>
        <div id="aiAdminHint"></div>
      </div>
      <div class="panel">
        <div class="chart-title" style="margin-bottom:4px">Future Integrations</div>
        <div class="hint" style="margin-bottom:12px">Interfaces exist for these (spec Section 50); none call an external service yet since that needs credentials and a server-side secret this build doesn't have. Status shown reflects what's actually wired up, not aspirational.</div>
        <div class="card-row" id="integrationsList"></div>
        <div class="hint" style="margin-top:10px">Note on "WhatsApp" above: that card is specifically about the official WhatsApp Business Platform/API (not connected). Plain click-to-chat WhatsApp links already work today from every Contact's action bar - no integration needed for that part.</div>
      </div>
      ${showConnectionPanel ? `<div class="panel">
        <div class="chart-title" style="margin-bottom:4px">Supabase Connection <span style="color:var(--text3);font-weight:400;font-size:12px">(Admin Only)</span></div>
        <div class="hint" style="margin-bottom:12px">Every user's browser connects to the same project by default, baked into the app itself - nobody sees a "paste your project URL" screen anymore. Saving a new connection here only reconnects <b>this one browser</b>; to change it for every user, edit the <code>DEFAULT_CONFIG</code> values in <code>web/js/lib/supabaseClient.js</code> and redeploy.</div>
        <div class="field span2" style="margin-bottom:10px"><label>This Browser Is Connected To</label><input id="currentSupabaseUrl" readonly></div>
        <div class="field span2" style="margin-bottom:10px"><label>New Project URL</label><input id="newSupabaseUrl" placeholder="https://xxxxxxxxxxxx.supabase.co"></div>
        <div class="field span2" style="margin-bottom:10px"><label>New Publishable / Anon Key</label><input id="newSupabaseKey" placeholder="sb_publishable_... or eyJ..."></div>
        <div class="auth-error" id="connectionError"></div>
        <div class="modal-actions" style="justify-content:flex-start">
          <button class="btn btn-outline btn-sm" id="saveConnectionBtn">Save &amp; Reconnect This Browser</button>
          <button class="btn btn-outline btn-sm" id="resetConnectionBtn" style="display:none">Reset This Browser to App Default</button>
        </div>
      </div>` : ''}`;

    const profile = await App.api.getProfile();
    App.utils.qs('#profileFormHost', pane).innerHTML = App.ui.renderForm(PROFILE_FIELDS, profile || {});
    App.utils.qs('#saveProfileBtn', pane).addEventListener('click', async () => {
      const { values } = App.ui.readForm(PROFILE_FIELDS);
      try { await App.api.updateProfile(values); App.state.profile = await App.api.getProfile(); App.utils.toast('Profile saved'); }
      catch (e) { App.utils.toast('Could not save profile: ' + (e.message || e), 'err'); }
    });

    // ---- Customize Sidebar (032_ui_and_notification_preferences.sql,
    // profiles.ui_preferences) - reorder within a group via up/down (not
    // drag-and-drop - functionally equivalent and far less error-prone to
    // wire correctly), hide/show per leaf item, one compact-mode toggle.
    // Groups themselves are never reordered or hidden, matching
    // renderSidebar()'s own scope in app.js. ----
    async function drawSidebarCustomize() {
      const liveProfile = await App.api.getProfile();
      const uiPrefs = liveProfile.ui_preferences || {};
      App.utils.qs('#sidebarCompactToggle', pane).checked = !!uiPrefs.sidebarCompact;
      const hidden = new Set(uiPrefs.sidebarHidden || []);
      const order = uiPrefs.sidebarOrder || {};
      const groups = App.NAV_STRUCTURE.map((g) => {
        const items = g.items.slice();
        const groupOrder = order[g.group];
        if (groupOrder && groupOrder.length) {
          const idx = new Map(groupOrder.map((k, i) => [k, i]));
          items.sort((a, b) => (idx.has(a.key) ? idx.get(a.key) : 999) - (idx.has(b.key) ? idx.get(b.key) : 999));
        }
        return { group: g.group, items };
      });
      App.utils.qs('#sidebarCustomizeList', pane).innerHTML = groups.map((g) => `
        <div style="margin-bottom:10px">
          <div class="hint" style="font-weight:600;margin-bottom:4px">${App.utils.escapeHtml(g.group)}</div>
          ${g.items.map((it, i) => `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
              <input type="checkbox" data-sidebar-hide="${it.key}" ${hidden.has(it.key) ? '' : 'checked'}>
              <span style="flex:1;font-size:12.5px">${App.utils.escapeHtml(it.label)}</span>
              <button class="icon-btn" data-sidebar-move="${it.key}" data-group="${App.utils.escapeHtml(g.group)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move up">&#8593;</button>
              <button class="icon-btn" data-sidebar-move="${it.key}" data-group="${App.utils.escapeHtml(g.group)}" data-dir="1" ${i === g.items.length - 1 ? 'disabled' : ''} title="Move down">&#8595;</button>
            </div>`).join('')}
        </div>`).join('');

      async function saveUiPrefs(patch) {
        const merged = Object.assign({}, uiPrefs, patch);
        await App.api.updateProfile({ ui_preferences: merged });
        if (App.state.profile) App.state.profile.ui_preferences = merged;
        App.renderSidebar();
      }

      App.utils.qsa('[data-sidebar-hide]', pane).forEach((cb) => cb.addEventListener('change', async (e) => {
        const key = e.target.dataset.sidebarHide;
        const newHidden = new Set(uiPrefs.sidebarHidden || []);
        if (e.target.checked) newHidden.delete(key); else newHidden.add(key);
        try { await saveUiPrefs({ sidebarHidden: [...newHidden] }); await drawSidebarCustomize(); }
        catch (err) { e.target.checked = !e.target.checked; App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
      }));

      App.utils.qsa('[data-sidebar-move]', pane).forEach((b) => b.addEventListener('click', async () => {
        const groupName = b.dataset.group, key = b.dataset.sidebarMove, dir = Number(b.dataset.dir);
        const group = groups.find((g) => g.group === groupName);
        const keys = group.items.map((it) => it.key);
        const i = keys.indexOf(key), j = i + dir;
        if (j < 0 || j >= keys.length) return;
        [keys[i], keys[j]] = [keys[j], keys[i]];
        try { await saveUiPrefs({ sidebarOrder: Object.assign({}, order, { [groupName]: keys }) }); await drawSidebarCustomize(); }
        catch (err) { App.utils.toast('Could not reorder: ' + (err.message || err), 'err'); }
      }));

      App.utils.qs('#sidebarCompactToggle', pane).onchange = async (e) => {
        try { await saveUiPrefs({ sidebarCompact: e.target.checked }); }
        catch (err) { e.target.checked = !e.target.checked; App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
      };
    }
    await drawSidebarCustomize();

    App.utils.qs('#resetSidebarBtn', pane).addEventListener('click', async () => {
      try {
        await App.api.updateProfile({ ui_preferences: null });
        if (App.state.profile) App.state.profile.ui_preferences = null;
        App.renderSidebar();
        await drawSidebarCustomize();
        App.utils.toast('Sidebar reset to default');
      } catch (err) { App.utils.toast('Could not reset: ' + (err.message || err), 'err'); }
    });

    App.utils.qs('#usernameInput', pane).value = (profile && profile.username) || '';
    App.utils.qs('#usernameInput', pane).addEventListener('change', async (e) => {
      const val = e.target.value.trim();
      if (!val) return;
      try { await App.api.updateUsername(val); App.utils.toast('Username saved'); }
      catch (err) { App.utils.toast('Could not save username (it may already be taken): ' + (err.message || err), 'err'); }
    });

    App.utils.qs('#analyticsConsentToggle', pane).checked = !!(profile && profile.analytics_consent);
    App.utils.qs('#analyticsConsentToggle', pane).addEventListener('change', async (e) => {
      try { await App.api.updateProfile({ analytics_consent: e.target.checked }); if (App.state.profile) App.state.profile.analytics_consent = e.target.checked; App.utils.toast('Preference saved'); }
      catch (err) { e.target.checked = !e.target.checked; App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
    });

    const privacy = await App.api.getPrivacySettings();
    const privacyDefaults = { who_can_find_me: 'Contacts', who_can_message_me: 'Contacts', who_can_call_me: 'Contacts', show_online_status: true, show_last_seen: true, show_read_receipts: true, show_profile_photo: true, allow_contact_discovery: true, allow_group_invitations: true, allow_call_invitations: true };
    App.utils.qs('#privacyFormHost', pane).innerHTML = App.ui.renderForm(PRIVACY_FIELDS, Object.assign({}, privacyDefaults, privacy || {}));
    App.utils.qs('#savePrivacyBtn', pane).addEventListener('click', async () => {
      const { values } = App.ui.readForm(PRIVACY_FIELDS);
      try { await App.api.upsertPrivacySettings(values); App.utils.toast('Privacy settings saved'); }
      catch (e) { App.utils.toast('Could not save privacy settings: ' + (e.message || e), 'err'); }
    });

    const prefs = await App.api.getPreferences();
    App.utils.qs('#offsetsInput', pane).value = (prefs && prefs.reminder_offset_days ? prefs.reminder_offset_days : [-7, -3, -1, 0, 1, 3, 7, 30]).join(', ');
    App.utils.qs('#savePrefsBtn', pane).addEventListener('click', async () => {
      const offsets = App.utils.qs('#offsetsInput', pane).value.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      try { await App.api.upsertPreferences({ reminder_offset_days: offsets }); App.utils.toast('Preferences saved'); }
      catch (e) { App.utils.toast('Could not save preferences: ' + (e.message || e), 'err'); }
    });

    // ---- Do Not Disturb (per-user, display-layer notification snooze -
    // see 020_notification_snooze.sql's header comment for why this never
    // touches the many server-side notification generators). ----
    function snoozeTargetFor(duration) {
      const now = new Date();
      if (duration === '1h') return new Date(now.getTime() + 3600000);
      if (duration === '4h') return new Date(now.getTime() + 4 * 3600000);
      if (duration === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      if (duration === 'tomorrow') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
      if (duration === 'week') return new Date(now.getTime() + 7 * 86400000);
      return new Date(now.getFullYear() + 100, now.getMonth(), now.getDate()); // "indefinite"
    }
    function renderSnoozeUi(snoozedUntil) {
      const isSnoozed = snoozedUntil && new Date(snoozedUntil) > new Date();
      App.utils.qs('#snoozeStatus', pane).innerHTML = isSnoozed
        ? `<div class="hint" style="color:var(--gold)">Notifications are disabled until ${App.utils.fmtDateTime(snoozedUntil)}.</div>`
        : '';
      App.utils.qs('#snoozeControls', pane).style.display = isSnoozed ? 'none' : 'flex';
      App.utils.qs('#unsnoozeBtn', pane).style.display = isSnoozed ? 'inline-flex' : 'none';
    }
    renderSnoozeUi(prefs && prefs.snoozed_until);
    App.utils.qs('#snoozeBtn', pane).addEventListener('click', async () => {
      const duration = App.utils.qs('#snoozeDuration', pane).value;
      const until = snoozeTargetFor(duration).toISOString();
      try { await App.api.upsertPreferences({ snoozed_until: until }); renderSnoozeUi(until); App.utils.toast('Notifications disabled'); }
      catch (e) { App.utils.toast('Could not update: ' + (e.message || e), 'err'); }
    });
    App.utils.qs('#unsnoozeBtn', pane).addEventListener('click', async () => {
      try { await App.api.upsertPreferences({ snoozed_until: null }); renderSnoozeUi(null); App.utils.toast('Notifications enabled'); }
      catch (e) { App.utils.toast('Could not update: ' + (e.message || e), 'err'); }
    });

    // ---- Email Notifications (021_email_notifications.sql /
    // 022_calendar_events_email_digest_audit_toggle.sql) - a real digest
    // cadence rather than a plain on/off toggle. ----
    function renderEmailLastSentHint(lastSentIso) {
      App.utils.qs('#emailLastSentHint', pane).textContent = lastSentIso
        ? `Last digest sent: ${App.utils.fmtDateTime(lastSentIso)}.`
        : 'No digest has gone out yet.';
    }
    App.utils.qs('#emailFrequencySelect', pane).value = (prefs && prefs.email_frequency) || '1_day';
    renderEmailLastSentHint(prefs && prefs.last_email_digest_sent_at);
    App.utils.qs('#emailFrequencySelect', pane).addEventListener('change', async (e) => {
      try { await App.api.upsertPreferences({ email_frequency: e.target.value }); App.utils.toast('Email frequency saved'); }
      catch (err) { App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
    });

    // ---- Notification Delivery, by Type (032_ui_and_notification_preferences.sql) ----
    async function drawNotifTypeMatrix() {
      const rows = await App.api.listNotificationTypePreferences();
      const byType = {}; rows.forEach((r) => { byType[r.type] = r; });
      const table = App.utils.qs('#notifTypeMatrix', pane);
      table.innerHTML = `<thead><tr><th>Notification Type</th><th>In-app</th><th>Email</th><th>Push</th></tr></thead>
        <tbody>${NOTIFICATION_TYPES.map((type) => {
          const pref = byType[type] || {};
          const checked = (channel) => pref[channel] !== false ? 'checked' : '';
          return `<tr>
            <td>${App.utils.escapeHtml(type)}</td>
            <td><input type="checkbox" data-notif-type="${App.utils.escapeHtml(type)}" data-notif-channel="in_app" ${checked('in_app')}></td>
            <td><input type="checkbox" data-notif-type="${App.utils.escapeHtml(type)}" data-notif-channel="email" ${checked('email')}></td>
            <td><input type="checkbox" data-notif-type="${App.utils.escapeHtml(type)}" data-notif-channel="push" ${checked('push')}></td>
          </tr>`;
        }).join('')}</tbody>`;
      App.utils.qsa('[data-notif-type]', table).forEach((cb) => cb.addEventListener('change', async (e) => {
        try {
          await App.api.upsertNotificationTypePreference(e.target.dataset.notifType, { [e.target.dataset.notifChannel]: e.target.checked });
          App.state.notificationTypePrefs[e.target.dataset.notifType] = Object.assign(
            { user_id: null, type: e.target.dataset.notifType, in_app: true, email: true, push: true },
            App.state.notificationTypePrefs[e.target.dataset.notifType], { [e.target.dataset.notifChannel]: e.target.checked },
          );
        } catch (err) { e.target.checked = !e.target.checked; App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
      }));
    }
    await drawNotifTypeMatrix();

    if (isAdminUser) {
      App.utils.qs('#triggerEmailsNowBtn', pane).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Sending...';
        try {
          const result = await App.api.sendPendingNotificationEmails();
          App.utils.toast(`Sent ${result.digestsSent} digest(s) (${result.notificationsEmailed} notification(s)), ${result.usersSkipped} skipped, ${result.usersFailed} failed` + (result.errors && result.errors.length ? ' - see console for details' : ''));
          if (result.errors && result.errors.length) console.error('send-notification-emails errors:', result.errors);
          const freshPrefs = await App.api.getPreferences();
          renderEmailLastSentHint(freshPrefs && freshPrefs.last_email_digest_sent_at);
        } catch (err) { App.utils.toast('Could not trigger emails: ' + (err.message || err), 'err'); }
        finally { btn.disabled = false; btn.innerHTML = '&#9993; Trigger Emails Now'; }
      });

      // ---- Audit History enable/disable (022) ----
      async function drawAuditHistoryToggle() {
        const appSettings = await App.api.getAppSettings();
        const enabled = !appSettings || appSettings.audit_history_enabled !== false;
        App.utils.qs('#auditHistoryStatus', pane).innerHTML = enabled
          ? 'Currently <b style="color:var(--teal)">enabled</b> - every change is being logged.'
          : 'Currently <b style="color:var(--gold)">disabled</b> - new changes are not being logged.';
        const btn = App.utils.qs('#toggleAuditHistoryBtn', pane);
        btn.textContent = enabled ? 'Disable Audit History' : 'Enable Audit History';
        btn.onclick = async () => {
          try { await App.api.updateAppSettings({ audit_history_enabled: !enabled }); App.utils.toast(enabled ? 'Audit History disabled' : 'Audit History enabled'); await drawAuditHistoryToggle(); }
          catch (err) { App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
        };
      }
      drawAuditHistoryToggle();

      // ---- Benchmark reference rate (026) ----
      App.api.getAppSettings().then((s) => { App.utils.qs('#fdReferenceRateInput', pane).value = (s && s.fd_reference_rate != null) ? s.fd_reference_rate : 7.0; });
      App.utils.qs('#saveFdRateBtn', pane).addEventListener('click', async () => {
        const rate = App.utils.parseNum(App.utils.qs('#fdReferenceRateInput', pane).value);
        try { await App.api.updateAppSettings({ fd_reference_rate: rate }); App.utils.toast('Reference rate saved'); }
        catch (err) { App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
      });
    }

    // ---- Export All My Data (exportData.js) ----
    App.utils.qs('#exportAllBtn', pane).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Exporting...';
      try { await App.exportData.exportFullPortfolio(); }
      catch (err) { App.utils.toast('Could not export: ' + (err.message || err), 'err'); }
      finally { btn.disabled = false; btn.innerHTML = '&#8595; Export All My Data'; }
    });

    // ---- Restore from Backup (restoreData.js) - additive-only, see the
    // panel's own hint text and the module's own header comment for why. ----
    let restoreWorkbook = null;
    App.utils.qs('#restoreChooseFileBtn', pane).addEventListener('click', () => App.utils.qs('#restoreFileInput', pane).click());
    App.utils.qs('#restoreFileInput', pane).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      App.utils.qs('#restoreFileNameHint', pane).textContent = file.name;
      try {
        const buf = await file.arrayBuffer();
        restoreWorkbook = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
        drawRestoreChecklist();
      } catch (err) { App.utils.toast('Could not read file: ' + (err.message || err), 'err'); }
    });

    function drawRestoreChecklist() {
      const host = App.utils.qs('#restoreChecklist', pane);
      if (!restoreWorkbook) { host.innerHTML = ''; return; }
      const { restorable, excluded } = App.restoreData.inspectWorkbook(restoreWorkbook);
      host.innerHTML = `
        <div class="table-scroll"><table class="data"><thead><tr><th></th><th>Section</th><th>Rows Found</th></tr></thead>
          <tbody>
            ${restorable.map((s) => `<tr>
              <td><input type="checkbox" class="restore-check" value="${s.key}" ${s.found ? 'checked' : 'disabled'}></td>
              <td>${App.utils.escapeHtml(s.label)}</td>
              <td>${s.found ? s.rowCount : '<span class="hint">not found in this file</span>'}</td>
            </tr>`).join('')}
            ${excluded.map((s) => `<tr>
              <td><input type="checkbox" disabled></td>
              <td>${App.utils.escapeHtml(s.label)}</td>
              <td class="hint">${s.found ? s.rowCount + ' row(s) - ' : ''}${App.utils.escapeHtml(s.reason)}</td>
            </tr>`).join('')}
          </tbody></table></div>
        <div class="field span2" style="max-width:320px;margin-top:12px"><label>Type RESTORE MY DATA to confirm</label><input id="confirmRestoreInput" type="text"></div>
        <div class="auth-error" id="restoreError"></div>
        <button class="btn btn-outline btn-sm" id="runRestoreBtn" style="margin-top:8px">Run Restore</button>
        <div id="restoreProgress" style="margin-top:10px"></div>`;

      App.utils.qs('#runRestoreBtn', host).addEventListener('click', async () => {
        const typed = App.utils.qs('#confirmRestoreInput', host).value.trim();
        if (typed !== 'RESTORE MY DATA') { App.utils.qs('#restoreError', host).textContent = 'Phrase does not match - nothing was restored.'; return; }
        const selectedKeys = App.utils.qsa('.restore-check', host).filter((c) => c.checked).map((c) => c.value);
        if (!selectedKeys.length) { App.utils.qs('#restoreError', host).textContent = 'No restorable sections found in this file.'; return; }
        const btn = App.utils.qs('#runRestoreBtn', host);
        btn.disabled = true; btn.textContent = 'Restoring...';
        const progressEl = App.utils.qs('#restoreProgress', host);
        try {
          await App.restoreData.runRestore(restoreWorkbook, selectedKeys, (soFar) => {
            progressEl.innerHTML = soFar.map((r) => `<div class="stat-line"><span>${App.utils.escapeHtml(r.label)}</span><span class="v">${r.found ? `${r.ok} restored${r.failed ? `, ${r.failed} failed` : ''}` : 'not in file'}</span></div>`).join('');
          });
          App.utils.toast('Restore complete');
        } catch (err) { App.utils.qs('#restoreError', host).textContent = 'Restore failed: ' + (err.message || err); }
        finally { btn.disabled = false; btn.textContent = 'Run Restore'; }
      });
    }

    // ---- Clear My Data (032) - deliberately the hardest-to-reach action in
    // Settings: a full-phrase type-to-confirm, not a plain confirm(). ----
    App.utils.qs('#clearMyDataBtn', pane).addEventListener('click', () => {
      App.ui.open({
        title: 'Clear My Data',
        bodyHtml: `
          <div class="hint" style="color:var(--red,#e5484d);margin-bottom:10px">This permanently deletes every deal, payment, recurring item, gold purchase, expense, contact, note, and document you own. Community, Blog, Support Tickets, Chat, and any shared portfolio are untouched. Your account stays intact - only data is cleared. There is no undo.</div>
          <div class="field span2"><label>Type DELETE MY DATA to confirm</label><input id="confirmClearMyData" type="text"></div>
          <div class="auth-error" id="clearMyDataError"></div>`,
        actions: [
          { label: 'Clear My Data', className: 'btn-outline', onClick: async () => {
            const typed = App.utils.qs('#confirmClearMyData').value.trim();
            if (typed !== 'DELETE MY DATA') { App.utils.qs('#clearMyDataError').textContent = 'Phrase does not match - nothing was deleted.'; return; }
            try {
              await App.api.clearMyData();
              App.utils.toast('Your data has been cleared');
              App.ui.close();
              App.router.refreshCurrent();
            } catch (e) { App.utils.qs('#clearMyDataError').textContent = e.message || String(e); }
          } },
          { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
        ],
      });
    });

    // ---- Push Notifications (023_web_push.sql) ----
    async function drawPushControls() {
      if (!App.push.isSupported()) {
        App.utils.qs('#pushControls', pane).innerHTML = '<div class="hint">Not supported in this browser.</div>';
        return;
      }
      const sub = await App.push.getSubscription().catch(() => null);
      App.utils.qs('#pushControls', pane).innerHTML = sub
        ? '<div class="hint" style="color:var(--teal);margin-bottom:8px">Enabled on this device.</div><button class="btn btn-outline btn-sm" id="pushToggleBtn">Disable on This Device</button>'
        : '<button class="btn btn-gold btn-sm" id="pushToggleBtn">Enable on This Device</button>';
      App.utils.qs('#pushToggleBtn', pane).addEventListener('click', async () => {
        try {
          if (sub) { await App.push.unsubscribe(); await App.api.upsertPreferences({ push_enabled: false }); App.utils.toast('Push notifications disabled on this device'); }
          else { await App.push.subscribe(); await App.api.upsertPreferences({ push_enabled: true }); App.utils.toast('Push notifications enabled on this device'); }
          drawPushControls();
        } catch (err) { App.utils.toast('Could not update: ' + (err.message || err), 'err'); }
      });
    }
    drawPushControls();

    if (isAdminUser) {
      App.utils.qs('#triggerPushNowBtn', pane).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Sending...';
        try {
          const result = await App.api.sendPendingWebPush();
          App.utils.qs('#pushLastResultHint', pane).innerHTML = `Last run: <b>${result.sent}</b> sent, <b>${result.skipped}</b> skipped, <b>${result.failed}</b> failed.` + (result.errors && result.errors.length ? ' Errors: ' + App.utils.escapeHtml(JSON.stringify(result.errors)) : '');
          App.utils.toast(`Push: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed`);
        } catch (err) { App.utils.toast('Could not trigger push: ' + (err.message || err), 'err'); }
        finally { btn.disabled = false; btn.innerHTML = '&#128276; Trigger Push Now'; }
      });
    }

    async function drawPlatforms() {
      const platforms = await App.api.listPlatforms();
      App.utils.qs('#platformsTable', pane).innerHTML = `<thead><tr><th>Name</th><th>Account Reference</th><th>Investment Type</th><th>Actions</th></tr></thead>
        <tbody>${platforms.map((p) => `<tr><td>${App.utils.escapeHtml(p.name)}</td><td>${App.utils.escapeHtml(p.account_reference || '—')}</td><td>${App.utils.escapeHtml(p.investment_type || '—')}</td>
          <td><button class="icon-btn del" data-del-platform="${p.id}">&#128465;</button></td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:16px">No platforms yet.</td></tr>'}</tbody>`;
      App.utils.qsa('[data-del-platform]', pane).forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this platform? Deals referencing it will keep their history but show no platform.')) return;
        await App.api.deletePlatform(Number(b.dataset.delPlatform));
        App.state.platforms = await App.api.listPlatforms();
        drawPlatforms();
      }));
    }
    App.utils.qs('#addPlatformBtn', pane).addEventListener('click', async () => {
      const name = prompt('Platform / lender name:');
      if (!name) return;
      await App.api.createPlatform({ name });
      App.state.platforms = await App.api.listPlatforms();
      drawPlatforms();
    });
    await drawPlatforms();

    async function drawIntegrations() {
      const configs = await App.api.listIntegrations();
      const byType = {}; configs.forEach((c) => { byType[c.integration_type] = c; });
      App.utils.qs('#integrationsList', pane).innerHTML = INTEGRATIONS.map((name) => {
        const c = byType[name];
        return `<div class="integration-card"><div class="name">${name}</div><div class="status">${c ? c.status : 'Not Connected'}</div></div>`;
      }).join('');
    }
    await drawIntegrations();

    // ---- Gold Price Provider (Gold Intelligence addendum) - everyone can
    // see current provider + quota; only admin can change the active one
    // or add a custom provider, same read/write split as the underlying
    // gold_providers RLS policies. (isAdminUser is declared once, at the
    // top of renderSettingsView, since the Supabase Connection panel's HTML
    // above also needs it before this point in the file runs.) ----
    async function drawGoldProviders() {
      const [settings, providers] = await Promise.all([App.api.getGoldSettings(), App.api.listGoldProviders()]);
      App.utils.qs('#goldProviderList', pane).innerHTML = providers.map((p) => {
        const active = settings && settings.active_provider_key === p.key;
        const quota = p.requests_limit != null ? `${p.requests_used_this_period} / ${p.requests_limit} requests this period` : 'No fixed limit';
        const statusCls = p.last_fetch_status === 'ok' ? 'st-active' : p.last_fetch_status === 'error' ? 'st-overdue' : 'st-cancelled';
        return `<div class="stat-line">
          <span>${isAdminUser
            ? `<input type="radio" name="goldActiveProvider" data-provider-key="${p.key}" ${active ? 'checked' : ''} style="margin-right:6px">`
            : (active ? '&#9733; ' : '')}${App.utils.escapeHtml(p.display_name)}</span>
          <span class="v" style="font-weight:400;font-size:11.5px"><span class="badge ${statusCls}">${p.last_fetch_status}</span> &middot; ${quota}${p.last_fetch_at ? ' &middot; ' + App.utils.fmtDateTime(p.last_fetch_at) : ''}
            ${isAdminUser && p.kind === 'custom' ? `<button class="icon-btn del" data-del-provider="${p.key}" style="margin-left:8px" title="Remove">&#128465;</button>` : ''}</span>
        </div>`;
      }).join('');
      App.utils.qs('#goldAdminHint', pane).innerHTML = isAdminUser
        ? `<div class="modal-actions" style="justify-content:flex-start;margin-top:10px"><button class="btn btn-outline btn-sm" id="addCustomProviderBtn">+ Add Custom Provider</button></div>`
        : `<div class="hint" style="margin-top:8px">Only an admin account can change the active provider or add a custom one.</div>`;

      if (isAdminUser) {
        App.utils.qsa('[data-provider-key]', pane).forEach((r) => r.addEventListener('change', async () => {
          try { await App.api.updateGoldSettings({ active_provider_key: r.dataset.providerKey }); App.utils.toast('Active gold provider updated'); }
          catch (e) { App.utils.toast('Could not update: ' + (e.message || e), 'err'); drawGoldProviders(); }
        }));
        App.utils.qsa('[data-del-provider]', pane).forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Remove this custom provider?')) return;
          try { await App.api.deleteGoldProvider(b.dataset.delProvider); drawGoldProviders(); }
          catch (e) { App.utils.toast('Could not remove: ' + (e.message || e), 'err'); }
        }));
        const addBtn = App.utils.qs('#addCustomProviderBtn', pane);
        if (addBtn) addBtn.addEventListener('click', openCustomProviderForm);
      }
    }

    function openCustomProviderForm() {
      const fields = [
        { key: 'display_name', label: 'Provider Name', required: true },
        { key: 'base_url', label: 'API Base URL (full endpoint)', required: true, span: 2 },
        { key: 'auth_style', label: 'Where does the API key go?', type: 'select', options: ['header', 'query_param', 'bearer', 'none'], required: true },
        { key: 'auth_key_name', label: 'Header/Param Name (e.g. x-access-token, apikey)' },
        { key: 'auth_secret_name', label: 'Supabase Secret Name (must start with GOLD_CUSTOM_)' },
        { key: 'spot_path', label: 'Dot-path to spot price in the response (e.g. rates.INR)', required: true },
        { key: 'spot_unit', label: 'That price is per', type: 'select', options: [{ value: 'troy_oz', label: 'Troy Ounce' }, { value: 'gram', label: 'Gram' }], required: true },
        { key: 'currency', label: 'Currency of that price', placeholder: 'INR' },
      ];
      App.ui.open({
        title: 'Add Custom Gold Provider',
        bodyHtml: `<div class="hint" style="margin-bottom:10px">You'll still need to set the actual API key yourself via the Supabase CLI (<code>supabase secrets set YOUR_SECRET_NAME=...</code>) - this form only tells the Edge Function how to call the API and where to find that secret. See the README's Gold Intelligence section for the full runbook.</div>${App.ui.renderForm(fields, { auth_style: 'header', spot_unit: 'troy_oz', currency: 'INR' })}`,
        actions: [
          { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
          { label: 'Save', className: 'btn-gold', onClick: async () => {
            const { values, errors } = App.ui.readForm(fields);
            if (errors.length) { App.utils.toast('Fill in the required fields', 'err'); return; }
            if (values.auth_secret_name && !values.auth_secret_name.startsWith('GOLD_CUSTOM_')) {
              App.utils.toast('Secret name must start with GOLD_CUSTOM_', 'err'); return;
            }
            const key = 'custom_' + values.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            const { display_name, base_url, auth_style, auth_key_name, auth_secret_name, spot_path, spot_unit, currency } = values;
            try {
              await App.api.createGoldProvider({
                key, kind: 'custom', display_name,
                custom_config: { base_url, auth_style, auth_key_name, auth_secret_name, spot_path, spot_unit, currency: currency || 'INR' },
              });
              App.ui.close(); App.utils.toast('Custom provider added'); drawGoldProviders();
            } catch (e) { App.utils.toast('Could not save: ' + (e.message || e), 'err'); }
          } },
        ],
      });
    }

    App.utils.qs('#goldRefreshNowBtn', pane).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await App.api.refreshGoldPrice(); App.utils.toast('Gold prices refreshed'); drawGoldProviders(); }
      catch (err) { App.utils.toast('Could not refresh: ' + (err.message || err), 'err'); }
      e.target.disabled = false;
    });
    await drawGoldProviders();

    // ---- AI Model Provider (AI Copilot Multi-Provider addendum) - same
    // read/write split as Gold Price Provider above: everyone sees the
    // active provider + status, only admin can change it or add a custom
    // one. No "Refresh Now" button - unlike gold prices there's nothing to
    // proactively fetch, the Copilot is on-demand only. ----
    async function drawAiProviders() {
      const [settings, providers] = await Promise.all([App.api.getAiSettings(), App.api.listAiProviders()]);
      App.utils.qs('#aiProviderList', pane).innerHTML = providers.map((p) => {
        const active = settings && settings.active_provider_key === p.key;
        const quota = p.requests_limit != null ? `~${p.requests_limit} requests/day free tier (reference only)` : 'No documented free-tier limit';
        const statusCls = p.last_status === 'ok' ? 'st-active' : p.last_status === 'error' ? 'st-overdue' : 'st-cancelled';
        return `<div class="stat-line">
          <span>${isAdminUser
            ? `<input type="radio" name="aiActiveProvider" data-ai-provider-key="${p.key}" ${active ? 'checked' : ''} style="margin-right:6px">`
            : (active ? '&#9733; ' : '')}${App.utils.escapeHtml(p.display_name)} <span style="color:var(--text3);font-weight:400">(${App.utils.escapeHtml(p.model_id)})</span></span>
          <span class="v" style="font-weight:400;font-size:11.5px"><span class="badge ${statusCls}">${p.last_status}</span> &middot; ${quota}${p.last_used_at ? ' &middot; last used ' + App.utils.fmtDateTime(p.last_used_at) : ''}
            ${isAdminUser && p.kind === 'custom' ? `<button class="icon-btn del" data-del-ai-provider="${p.key}" style="margin-left:8px" title="Remove">&#128465;</button>` : ''}</span>
        </div>`;
      }).join('');
      App.utils.qs('#aiAdminHint', pane).innerHTML = isAdminUser
        ? `<div class="modal-actions" style="justify-content:flex-start;margin-top:10px"><button class="btn btn-outline btn-sm" id="addCustomAiProviderBtn">+ Add Custom Provider</button></div>`
        : `<div class="hint" style="margin-top:8px">Only an admin account can change the active provider or add a custom one.</div>`;

      if (isAdminUser) {
        App.utils.qsa('[data-ai-provider-key]', pane).forEach((r) => r.addEventListener('change', async () => {
          try { await App.api.updateAiSettings({ active_provider_key: r.dataset.aiProviderKey }); App.utils.toast('Active AI provider updated'); }
          catch (e) { App.utils.toast('Could not update: ' + (e.message || e), 'err'); drawAiProviders(); }
        }));
        App.utils.qsa('[data-del-ai-provider]', pane).forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Remove this custom provider?')) return;
          try { await App.api.deleteAiProvider(b.dataset.delAiProvider); drawAiProviders(); }
          catch (e) { App.utils.toast('Could not remove: ' + (e.message || e), 'err'); }
        }));
        const addBtn = App.utils.qs('#addCustomAiProviderBtn', pane);
        if (addBtn) addBtn.addEventListener('click', openCustomAiProviderForm);
      }
    }

    function openCustomAiProviderForm() {
      const fields = [
        { key: 'display_name', label: 'Provider Name', required: true },
        { key: 'model_id', label: 'Model ID (e.g. llama-3.3-70b-versatile)', required: true },
        { key: 'base_url', label: 'API Base URL (no trailing /chat/completions)', required: true, span: 2, placeholder: 'https://api.groq.com/openai/v1' },
        { key: 'auth_secret_name', label: 'Supabase Secret Name (must start with COPILOT_CUSTOM_)', span: 2 },
      ];
      App.ui.open({
        title: 'Add Custom AI Provider',
        bodyHtml: `<div class="hint" style="margin-bottom:10px">Assumes an OpenAI-compatible chat-completions API (Groq, OpenRouter, Together, Fireworks, a local Ollama endpoint, etc.) - <code>POST {base_url}/chat/completions</code>. You'll still need to set the actual API key yourself via the Supabase CLI (<code>supabase secrets set YOUR_SECRET_NAME=...</code>) - this form only tells the Edge Function how to call it and where to find that secret.</div>${App.ui.renderForm(fields, {})}`,
        actions: [
          { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
          { label: 'Save', className: 'btn-gold', onClick: async () => {
            const { values, errors } = App.ui.readForm(fields);
            if (errors.length) { App.utils.toast('Fill in the required fields', 'err'); return; }
            if (values.auth_secret_name && !values.auth_secret_name.startsWith('COPILOT_CUSTOM_')) {
              App.utils.toast('Secret name must start with COPILOT_CUSTOM_', 'err'); return;
            }
            const key = 'custom_' + values.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            const { display_name, model_id, base_url, auth_secret_name } = values;
            try {
              await App.api.createAiProvider({
                key, kind: 'custom', display_name, model_id,
                custom_config: { base_url, auth_secret_name },
              });
              App.ui.close(); App.utils.toast('Custom provider added'); drawAiProviders();
            } catch (e) { App.utils.toast('Could not save: ' + (e.message || e), 'err'); }
          } },
        ],
      });
    }

    await drawAiProviders();

    // ---- Supabase Connection (admin only) - see supabaseClient.js's
    // DEFAULT_CONFIG comment: this changes only the browser that clicks
    // Save, never every user at once. ----
    if (showConnectionPanel) {
      const cfg = App.auth.getConfig();
      App.utils.qs('#currentSupabaseUrl', pane).value = (cfg && cfg.url) || '';
      App.utils.qs('#resetConnectionBtn', pane).style.display = App.auth.hasCustomConfig() ? 'inline-flex' : 'none';
      App.utils.qs('#saveConnectionBtn', pane).addEventListener('click', () => {
        const url = App.utils.qs('#newSupabaseUrl', pane).value.trim().replace(/\/$/, '');
        const key = App.utils.qs('#newSupabaseKey', pane).value.trim();
        const errEl = App.utils.qs('#connectionError', pane);
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) {
          errEl.textContent = 'Enter a valid Supabase Project URL and publishable/anon key.';
          return;
        }
        errEl.textContent = '';
        if (!confirm('This signs you out of THIS BROWSER and reconnects it to the new project. Other users/browsers are unaffected. Continue?')) return;
        App.auth.saveConfig(url, key);
        location.reload();
      });
      App.utils.qs('#resetConnectionBtn', pane).addEventListener('click', () => {
        if (!confirm("Reset this browser back to the app's built-in default Supabase project?")) return;
        App.auth.clearConfig();
        location.reload();
      });
    }
  }

  App.router.register('settings', renderSettingsView);
})();
