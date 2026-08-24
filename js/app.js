/* Bootstraps auth, sidebar nav, and the router. Loaded last, after every
   view module has registered itself with App.router. */
window.App = window.App || {};

const NAV_STRUCTURE = [
  { group: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard', icon: '&#9670;' },
  ] },
  { group: 'Financial Engine', items: [
    { key: 'deals', label: 'Deals', icon: '&#128188;' },
    { key: 'payments', label: 'Payments', icon: '&#128179;' },
    { key: 'calendar', label: 'Calendar', icon: '&#128197;' },
  ] },
  { group: 'Recurring', items: [
    { key: 'recurring', label: 'Recurring Investments', icon: '&#128257;' },
  ] },
  { group: 'Gold', items: [
    { key: 'gold', label: 'Gold Intelligence', icon: '&#129689;' },
  ] },
  { group: 'Expenses', items: [
    { key: 'expenses', label: 'Expenses & Projects', icon: '&#128184;' },
  ] },
  { group: 'Contacts & Chat', items: [
    { key: 'contacts', label: 'Contacts', icon: '&#128101;' },
    { key: 'chat', label: 'Chat', icon: '&#128488;' },
  ] },
  { group: 'Planning', items: [
    { key: 'maturity', label: 'Maturity Planner', icon: '&#8987;' },
    { key: 'reinvestments', label: 'Reinvestments', icon: '&#128260;' },
    { key: 'goals', label: 'Goals', icon: '&#127919;' },
    { key: 'whatif', label: 'What-If & Compare', icon: '&#128202;' },
  ] },
  { group: 'Insights', items: [
    { key: 'networth', label: 'Net Worth', icon: '&#128181;' },
    { key: 'cashflow', label: 'Cash Flow', icon: '&#128260;' },
    { key: 'reconciliation', label: 'Reconciliation Center', icon: '&#9989;' },
    { key: 'automation', label: 'Automation Center', icon: '&#9881;' },
    { key: 'aicopilot', label: 'AI Portfolio Copilot', icon: '&#129504;' },
    { key: 'analytics', label: 'Analytics', icon: '&#128200;' },
    { key: 'earnings', label: 'Earnings', icon: '&#128176;' },
    { key: 'risk', label: 'Risk Analysis', icon: '&#9888;' },
    { key: 'reports', label: 'Reports (Tax / FY)', icon: '&#128203;' },
  ] },
  { group: 'Records', items: [
    { key: 'import', label: 'Import', icon: '&#128228;' },
    { key: 'documents', label: 'Documents', icon: '&#128193;' },
    { key: 'audit', label: 'Audit History', icon: '&#128269;' },
  ] },
  { group: 'Personal', items: [
    { key: 'notes', label: 'Notes', icon: '&#128221;' },
    { key: 'calculator', label: 'Calculators', icon: '&#128202;' },
  ] },
  { group: 'Community', items: [
    { key: 'community', label: 'Community', icon: '&#128172;' },
    { key: 'support', label: 'Help & Support', icon: '&#129302;' },
    { key: 'blog', label: 'Blog', icon: '&#128220;' },
  ] },
  { group: 'Account', items: [
    { key: 'settings', label: 'Settings', icon: '&#9881;' },
  ] },
];

// Explicit App.* export, not just the bare top-level const above - settings.js
// (Customize Sidebar panel) needs to read the full leaf-item list to build
// its reorder/hide UI, and it's loaded as a separate <script> tag BEFORE
// app.js in index.html. A bare top-level `const` is still technically
// visible across non-module <script> tags sharing one global scope by the
// time a later function actually runs, but that's a fragile thing to rely
// on implicitly - this makes the dependency explicit and unambiguous.
App.NAV_STRUCTURE = NAV_STRUCTURE;

function currentNavStructure() {
  // Admin is only added to the nav (and only rendered as a working view -
  // see admin.js's own is_admin check) when the signed-in profile is an
  // admin. The real gate is server-side RLS (013_admin_role.sql); this is
  // just so a regular user never even sees a link to a section that
  // wouldn't show them anything anyway. Same reasoning for "Shared With
  // Me" - only shown once App.lookups.loadAll() has confirmed there's
  // actually something to see there (App.state.sharedWithMeCount).
  const isAdmin = App.state.profile && App.state.profile.is_admin;
  let structure = NAV_STRUCTURE;
  if (App.state.sharedWithMeCount > 0) {
    structure = structure.concat([{ group: 'Shared', items: [{ key: 'sharedWithMe', label: 'Shared With Me', icon: '&#128101;' }] }]);
  }
  if (isAdmin) {
    structure = structure.concat([{ group: 'Admin', items: [{ key: 'admin', label: 'Admin', icon: '&#128081;' }] }]);
  }
  return structure;
}

// Tracks the last set of pane keys #viewContainer was built from, so
// renderSidebar() only wipes it when the set genuinely needs to change.
let lastPaneKeys = null;

// Reorders (within a group) and hides individual leaf nav items per the
// signed-in user's own saved preference (profiles.ui_preferences,
// 032_ui_and_notification_preferences.sql) - display-only. This must NEVER
// be applied to the pane-building side of renderSidebar() below: every
// view's pane has to stay reachable by hash regardless of what's hidden
// here, or a deep link (a notification click-through, a bookmark) into a
// hidden section hits a pane that was never built and throws. Groups
// themselves are never reordered or hidden - only their leaf items.
function applySidebarPrefs(structure, prefs) {
  prefs = prefs || {};
  const order = prefs.sidebarOrder || {};
  const hidden = new Set(prefs.sidebarHidden || []);
  return structure
    .map((g) => {
      let items = g.items.filter((it) => !hidden.has(it.key));
      const groupOrder = order[g.group];
      if (groupOrder && groupOrder.length) {
        const idx = new Map(groupOrder.map((k, i) => [k, i]));
        items = items.slice().sort((a, b) => (idx.has(a.key) ? idx.get(a.key) : 999) - (idx.has(b.key) ? idx.get(b.key) : 999));
      }
      return { group: g.group, items };
    })
    .filter((g) => g.items.length);
}

function renderSidebar() {
  const structure = currentNavStructure();
  const prefs = App.state.profile && App.state.profile.ui_preferences;
  const displayStructure = applySidebarPrefs(structure, prefs);
  const nav = App.utils.qs('#sidebarNav');
  const activeKey = App.router.currentName();
  const isCompact = !!(prefs && prefs.sidebarCompact);
  nav.classList.toggle('compact', isCompact);
  // .sidebar/.main-area's actual width comes from body.sidebar-compact
  // overriding --sidebar-w (see app.css) - #sidebarNav.compact above only
  // ever hid label text, it never shrank the sidebar itself.
  document.body.classList.toggle('sidebar-compact', isCompact);
  nav.innerHTML = displayStructure.map((g) => `
    <div class="nav-group-label">${g.group}</div>
    ${g.items.map((it) => `
      <div class="nav-link${it.key === activeKey ? ' active' : ''}" data-nav="${it.key}" data-label="${it.label}" title="${it.label}">
        <span class="ic">${it.icon}</span><span class="nav-label-text">${it.label}</span><span class="nav-badge" id="badge-${it.key}" style="display:none"></span>
      </div>`).join('')}
  `).join('');
  App.utils.qsa('.nav-link', nav).forEach((link) => {
    link.addEventListener('click', () => App.router.navigate(link.dataset.nav));
  });

  // enterApp() calls this every time App.auth's onAuthStateChange fires -
  // not just at sign-in, but on an extra INITIAL_SESSION event and on
  // every periodic TOKEN_REFRESHED for a long-lived session (visible in
  // practice as: switch tabs, minimize the window, come back). Rebuilding
  // #viewContainer unconditionally on every one of those re-fires wiped
  // whatever view was currently showing back to an empty pane - a real,
  // reported "blank/black screen" bug. Only rebuild it when the actual
  // SET of panes needs to change (admin/Shared With Me visibility
  // toggling, or the very first render); otherwise leave existing panes
  // and their already-rendered content alone entirely.
  const paneKeys = structure.flatMap((g) => g.items).map((it) => it.key).join(',');
  if (paneKeys === lastPaneKeys) return;
  lastPaneKeys = paneKeys;
  App.utils.qs('#viewContainer').innerHTML = structure.flatMap((g) => g.items).map((it) =>
    `<div class="view-pane" data-view="${it.key}" id="pane-${it.key}"></div>`).join('');
  // The pane that was showing just got wiped back to empty - on the very
  // first call there's nothing showing yet (App.router.init(), called
  // right after this, handles that first render itself); on a later
  // structural change, whatever was showing needs to be redrawn into its
  // fresh pane.
  if (activeKey) App.router.refreshCurrent();
}
App.renderSidebar = renderSidebar; // called from settings.js after a Customize Sidebar change

// Admin's own notification bell defaults to admin's own notifications only
// (App.api.listNotifications self-scopes 'notifications' for every caller
// now, admin included - see api.js's SELF_SCOPED_TABLES). This toggle is
// the deliberate, admin-only opt-in to also pull every other user's
// notifications into the same bell/panel - a per-browser display
// preference (like dark mode), not a security setting, since RLS already
// allows admin to read them either way.
const ADMIN_NOTIF_PREF_KEY = 'admin_show_all_notifications';
function adminShowsAllNotifications() {
  return App.state.profile && App.state.profile.is_admin && localStorage.getItem(ADMIN_NOTIF_PREF_KEY) === 'true';
}

// Do Not Disturb (020_notification_snooze.sql) - a display-layer mute only.
// Every notification still gets generated and inserted server-side exactly
// as before; this just decides whether the badge count and realtime toast
// show up while snoozed_until is in the future. Cached here (refreshed each
// time refreshNotificationBadge runs, on the same 60s poll/realtime-event
// cadence it already uses) so the realtime toast callback below doesn't
// need its own extra round-trip just to check snooze state.
let notificationsSnoozed = false;

async function refreshNotificationBadge() {
  try {
    const prefs = await App.api.getPreferences();
    notificationsSnoozed = !!(prefs && prefs.snoozed_until && new Date(prefs.snoozed_until) > new Date());
    const scope = adminShowsAllNotifications() ? { allUsers: true } : {};
    const allUnread = notificationsSnoozed ? [] : await App.api.listNotifications(Object.assign({ eq: { status: 'Pending' } }, scope));
    const unread = allUnread.filter((n) => App.notifPrefs.isEnabled(n.type, 'in_app'));
    ['badge-dashboard', 'bellBadge'].forEach((id) => {
      const el = App.utils.qs('#' + id);
      if (!el) return;
      if (unread.length) { el.style.display = 'inline-block'; el.textContent = unread.length > 99 ? '99+' : unread.length; }
      else el.style.display = 'none';
    });
  } catch (e) { /* non-fatal */ }
}

/* Notification center (spec Section 11) - a bell in the topbar rather than
   its own nav item, since it's a cross-cutting inbox, not a distinct
   feature area with its own filters/charts. */
async function openNotificationPanel() {
  const isAdmin = App.state.profile && App.state.profile.is_admin;
  const scope = adminShowsAllNotifications() ? { allUsers: true } : {};
  const allNotifications = await App.api.listNotifications(Object.assign({ limit: 100 }, scope));
  const notifications = allNotifications.filter((n) => App.notifPrefs.isEnabled(n.type, 'in_app'));
  const rowHtml = (n) => `
    <div class="risk-item" style="${n.read_at ? 'opacity:.5' : ''}">
      <div class="risk-dot" style="background:${n.priority === 'Urgent' || n.priority === 'High' ? 'var(--red)' : n.priority === 'Medium' ? 'var(--gold)' : 'var(--blue)'}"></div>
      <div style="flex:1"><div class="risk-name">${App.utils.escapeHtml(n.title)}</div><div class="risk-desc">${App.utils.escapeHtml(n.message)}</div>
        <div class="risk-desc" style="margin-top:2px">${App.utils.fmtDateTime(n.scheduled_at)}</div></div>
      ${n.read_at ? '' : `<button class="icon-btn" data-mark-read="${n.id}" title="Mark read">&#10003;</button>`}
    </div>`;
  App.ui.open({
    title: 'Notifications',
    bodyHtml: `
      ${notificationsSnoozed ? `<div class="hint" style="color:var(--gold);margin-bottom:10px">Do Not Disturb is on - the bell and toast pop-ups are silenced, but everything below is still real and up to date. Turn it off in Settings.</div>` : ''}
      ${isAdmin ? `<label class="hint" style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer">
        <input type="checkbox" id="adminAllNotifsToggle" ${adminShowsAllNotifications() ? 'checked' : ''}>
        Also show other users' notifications here (admin only - off by default so your own deal/recurring alerts don't get lost in everyone else's)
      </label>` : ''}
      <div style="max-height:60vh;overflow:auto">${notifications.map(rowHtml).join('') || '<div class="empty-note">No notifications yet.</div>'}</div>`,
    actions: [
      { label: 'Mark All Read', className: 'btn-outline', onClick: async () => { await App.api.markAllNotificationsRead(); App.ui.close(); refreshNotificationBadge(); } },
      { label: 'Close', className: 'btn-gold', onClick: App.ui.close },
    ],
    onMount: (body) => {
      App.utils.qsa('[data-mark-read]', body).forEach((b) => b.addEventListener('click', async () => {
        await App.api.markNotificationRead(Number(b.dataset.markRead));
        refreshNotificationBadge();
        openNotificationPanel();
      }));
      const toggle = App.utils.qs('#adminAllNotifsToggle', body);
      if (toggle) toggle.addEventListener('change', () => {
        localStorage.setItem(ADMIN_NOTIF_PREF_KEY, toggle.checked ? 'true' : 'false');
        refreshNotificationBadge();
        openNotificationPanel();
      });
    },
  });
}

let notificationChannel = null;
let portfolioChannel = null;

// One-time consent prompt for login/traffic analytics (admin-only visibility,
// 027_login_analytics.sql). Declining is fully respected - see log-login's
// own header comment for the exact scope decision (no IP/device/location
// on a decline, ever, contrary to how this was originally requested).
function showAnalyticsConsentModal() {
  App.ui.open({
    title: 'Sign-in Activity',
    bodyHtml: `<div class="hint">This app can log basic sign-in activity - approximate location (from your IP) and device/browser type - visible only to the admin, to understand who's using the app and from where. Declining still logs that a sign-in happened (so "logins today" stays accurate for admin), but never your IP, location, or device. You can change this later in Settings.</div>`,
    actions: [
      { label: 'Allow', className: 'btn-gold', onClick: async () => {
        try { await App.api.updateProfile({ analytics_consent: true }); App.state.profile.analytics_consent = true; await App.api.logLogin(true); } catch (e) { console.warn('logLogin failed - is the log-login Edge Function deployed?', e); }
        App.ui.close();
      } },
      { label: 'Decline', className: 'btn-outline', onClick: async () => {
        try { await App.api.updateProfile({ analytics_consent: false }); App.state.profile.analytics_consent = false; await App.api.logLogin(false); } catch (e) { console.warn('logLogin failed - is the log-login Edge Function deployed?', e); }
        App.ui.close();
      } },
    ],
  });
}

async function enterApp() {
  App.utils.qs('#authScreen').style.display = 'none';
  App.utils.qs('#appShell').classList.add('active');
  const user = App.auth.getUser();
  const isDemo = App.auth.isDemoMode();
  App.utils.qs('#userChipEmail').textContent = isDemo ? 'Demo Mode' : (user ? user.email : '');
  App.utils.qs('#demoBanner').style.display = isDemo ? 'flex' : 'none';
  App.utils.qs('#signOutBtn').textContent = isDemo ? 'Exit Demo' : 'Sign Out';
  try {
    await App.lookups.loadAll();
  } catch (e) {
    App.utils.toast('Could not load account data: ' + (e.message || e), 'err');
  }
  renderSidebar();
  App.router.init();
  refreshNotificationBadge();
  setInterval(refreshNotificationBadge, 60000);

  // Login analytics consent + logging (027_login_analytics.sql) - never in
  // Demo Mode (nothing real to log), and the consent question is asked at
  // most once per account (profiles.analytics_consent starts null; every
  // sign-in after that just re-logs whichever answer was already given,
  // no modal). A decline still logs the bare fact of a sign-in for admin's
  // "logins today" count - it does not fall back to collecting IP/device
  // anyway, see log-login's own header comment for why.
  if (!isDemo) {
    if (App.state.profile && App.state.profile.analytics_consent === null) {
      showAnalyticsConsentModal();
    } else if (App.state.profile) {
      App.api.logLogin(App.state.profile.analytics_consent === true).catch((e) => console.warn('logLogin failed - is the log-login Edge Function deployed?', e));
    }
  }

  // Realtime push (Supabase Postgres Changes, RLS-scoped to this user - see
  // 014_community_notes_tickets.sql) rather than waiting for the 60s poll
  // above to notice a new row. The poll stays as a backstop in case a
  // websocket drops silently.
  if (notificationChannel) { App.api.unsubscribe(notificationChannel); notificationChannel = null; }
  try {
    notificationChannel = App.api.subscribeToNotifications(async (row) => {
      await refreshNotificationBadge(); // also refreshes the cached snooze state used right below
      if (notificationsSnoozed) return;
      if (!App.notifPrefs.isEnabled(row.type, 'in_app')) return;
      App.utils.toast(row.title, row.priority === 'Urgent' || row.priority === 'High' ? 'err' : 'info');
    });
  } catch (e) { /* realtime is a nice-to-have; polling above still works without it */ }

  // Incoming-call listener (Contacts/Chat/Calling module) - same
  // realtime-on-INSERT idiom as notifications above.
  try { App.callingView.listenForIncomingCalls(); } catch (e) { /* calling is best-effort; app works without it */ }

  // Live Cross-Device Portfolio Sync - a change to deals/payment_schedule/
  // payments/recurring_items/recurring_occurrences/gold_purchases/
  // expense_transactions from ANY session (this one or another device/tab)
  // soft-refreshes whatever view is currently open. The toast is skipped
  // for this session's own recent writes (isEcho, see api.js's
  // isRecentLocalWrite()) so saving a change doesn't show its own toast a
  // second time as if it happened elsewhere - the refresh itself always
  // runs regardless, since a redundant refresh is harmless.
  if (portfolioChannel) { App.api.unsubscribe(portfolioChannel); portfolioChannel = null; }
  try {
    portfolioChannel = App.api.subscribeToPortfolioChanges(({ isEcho }) => {
      App.router.refreshCurrent();
      if (!isEcho) App.utils.toast('Your data was updated elsewhere', 'info');
    });
  } catch (e) { /* realtime is a nice-to-have; the app works fine without cross-device sync */ }
}

function showAuthScreen() {
  if (notificationChannel) { App.api.unsubscribe(notificationChannel); notificationChannel = null; }
  if (portfolioChannel) { App.api.unsubscribe(portfolioChannel); portfolioChannel = null; }
  if (App.callingView) App.callingView.stopListening();
  App.utils.qs('#appShell').classList.remove('active');
  App.utils.qs('#authScreen').style.display = 'flex';
  // Only ever needs to hide the recovery pane this function itself doesn't
  // otherwise know about - #authSetupPane/#authFormsPane's own visibility is
  // wireAuthScreen()'s refreshSetupVisibility() responsibility and doesn't
  // change based on sign-in/out, so it's deliberately left alone here.
  App.utils.qs('#setNewPasswordPane').style.display = 'none';
}

function showSetNewPasswordScreen() {
  App.utils.qs('#appShell').classList.remove('active');
  App.utils.qs('#authScreen').style.display = 'flex';
  App.utils.qs('#authSetupPane').style.display = 'none';
  App.utils.qs('#authFormsPane').style.display = 'none';
  App.utils.qs('#setNewPasswordPane').style.display = 'block';
}

function wireAuthScreen() {
  const setupPane = App.utils.qs('#authSetupPane');
  const formsPane = App.utils.qs('#authFormsPane');

  function refreshSetupVisibility() {
    const configured = App.auth.isConfigured();
    setupPane.style.display = configured ? 'none' : 'block';
    formsPane.style.display = configured ? 'block' : 'none';
    if (configured) App.auth.init();
  }

  App.utils.qs('#saveSupabaseConfig').addEventListener('click', () => {
    const url = App.utils.qs('#cfgUrl').value.trim().replace(/\/$/, '');
    const key = App.utils.qs('#cfgKey').value.trim();
    const errEl = App.utils.qs('#setupError');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) {
      errEl.textContent = 'Enter a valid Supabase Project URL and publishable/anon key.';
      return;
    }
    errEl.textContent = '';
    App.auth.saveConfig(url, key);
    refreshSetupVisibility();
    App.utils.toast('Supabase connection saved');
  });

  App.utils.qs('#authTabSignIn').addEventListener('click', () => switchAuthTab('signin'));
  App.utils.qs('#authTabSignUp').addEventListener('click', () => switchAuthTab('signup'));
  // Changing the Supabase connection is now an admin-only, post-login
  // control (Settings -> Supabase Connection) - see supabaseClient.js's
  // DEFAULT_CONFIG comment for why. There's no pre-login path anymore
  // (isConfigured() is always true once a default exists, and role can't
  // be checked before signing in anyway).
  App.utils.qs('#tryDemoBtn').addEventListener('click', () => App.auth.enterDemoMode());

  function switchAuthTab(tab) {
    App.utils.qs('#authTabSignIn').classList.toggle('active', tab === 'signin');
    App.utils.qs('#authTabSignUp').classList.toggle('active', tab === 'signup');
    App.utils.qs('#signInForm').style.display = tab === 'signin' ? 'block' : 'none';
    App.utils.qs('#signUpForm').style.display = tab === 'signup' ? 'block' : 'none';
  }

  App.utils.qs('#signInBtn').addEventListener('click', async () => {
    const email = App.utils.qs('#signInEmail').value.trim();
    const password = App.utils.qs('#signInPassword').value;
    const errEl = App.utils.qs('#signInError');
    errEl.textContent = '';
    try {
      await App.auth.signIn(email, password);
    } catch (e) { errEl.textContent = e.message || 'Could not sign in.'; }
  });

  App.utils.qs('#signUpBtn').addEventListener('click', async () => {
    const email = App.utils.qs('#signUpEmail').value.trim();
    const password = App.utils.qs('#signUpPassword').value;
    const name = App.utils.qs('#signUpName').value.trim();
    const errEl = App.utils.qs('#signUpError');
    errEl.textContent = '';
    if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
    try {
      const res = await App.auth.signUp(email, password, name);
      if (!res.session) {
        errEl.style.color = 'var(--teal)';
        errEl.textContent = 'Account created. Check your email to confirm it, then sign in.';
      }
    } catch (e) { errEl.textContent = e.message || 'Could not create account.'; }
  });

  App.utils.qs('#needHelpLink').addEventListener('click', (e) => { e.preventDefault(); App.needHelp.openNeedHelpModal(); });

  App.utils.qs('#signOutBtn').addEventListener('click', () => App.auth.signOut());

  App.utils.qs('#setNewPasswordBtn').addEventListener('click', async () => {
    const pw = App.utils.qs('#newPasswordInput').value;
    const confirm = App.utils.qs('#confirmNewPasswordInput').value;
    const errEl = App.utils.qs('#setNewPasswordError');
    errEl.textContent = '';
    if (pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
    if (pw !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
    try {
      await App.auth.updatePassword(pw);
      App.utils.toast('Password updated');
      // updateUser() on an already-valid recovery session doesn't itself
      // fire another onAuthStateChange event - re-check the session
      // directly so enterApp() runs now instead of leaving the visitor
      // stuck on this screen until their next page load.
      const user = App.auth.getUser();
      if (user) enterApp(); else showAuthScreen();
    } catch (e) { errEl.textContent = e.message || 'Could not update password.'; }
  });

  refreshSetupVisibility();
}

document.addEventListener('DOMContentLoaded', () => {
  App.theme.init();
  wireAuthScreen();
  App.utils.qs('#notifBell').addEventListener('click', openNotificationPanel);
  App.globalSearch.wire();
  App.auth.onChange((user, session, event) => {
    // A password-reset email link logs the visitor into a real, valid
    // session (that's how Supabase's recovery flow works) - entering the
    // app straight away would silently skip the "set a new password" step
    // entirely. Show that screen instead for exactly this one event; every
    // other event (including the very next one, once the password is set)
    // falls through to the normal enterApp()/showAuthScreen() branching.
    if (event === 'PASSWORD_RECOVERY') { showSetNewPasswordScreen(); return; }
    if (user) enterApp(); else showAuthScreen();
  });
  if (App.auth.isConfigured()) App.auth.init();
});
