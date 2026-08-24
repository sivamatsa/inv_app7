/* Supabase connection + auth session management. Mirrors the "paste your
   project URL/anon key" pattern from the reference dashboard, extended to
   be mandatory (this build has no local-only mode - Supabase is the
   authoritative store per spec Section 53). */
window.App = window.App || {};

App.auth = (function () {
  const CONFIG_KEY = 'investmentAppSupabaseConfig';

  // The app's own, real Supabase project - baked in so every user lands
  // straight on Sign In / Create Account instead of a "paste your project
  // URL/key" screen that only ever made sense during development. This is
  // safe to hardcode client-side (same as the README has said from the
  // start): the anon/publishable key has no elevated privilege, RLS is the
  // actual security boundary, not keeping this value out of the bundle.
  //
  // To point the WHOLE APP at a different Supabase project later (for
  // every user, not just your own browser), change these two values and
  // redeploy - that's the one and only place this default lives. An admin
  // can also override just their OWN browser's connection from Settings ->
  // Supabase Connection, without touching this file - see saveConfig()
  // below - but that only affects the browser that clicked it, not anyone
  // else, which is why changing it for everyone means editing this file.
  const DEFAULT_CONFIG = {
    url: 'https://ursmdccpbwvaincqumgm.supabase.co',
    anonKey: 'sb_publishable_JSyxn0ohlvsRMT6eCpSALg_vXAz0h3w',
  };

  let client = null;
  let currentUser = null;
  let currentSession = null;
  let demoMode = false;
  const listeners = [];

  function getConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
      return saved || DEFAULT_CONFIG;
    } catch (e) { return DEFAULT_CONFIG; }
  }

  function isConfigured() {
    return !!getConfig();
  }

  // True only when a browser has explicitly saved its OWN override
  // (Settings -> Supabase Connection) - used to decide whether "Reset to
  // the app's default connection" has anything to actually reset.
  function hasCustomConfig() {
    try { return !!JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); }
    catch (e) { return false; }
  }

  function saveConfig(url, anonKey) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, anonKey }));
    client = null;
    return init();
  }

  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
    client = null;
    currentUser = null;
    currentSession = null;
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  // The auth event name is now passed through as a 3rd argument (previously
  // discarded) so a listener can tell a real sign-in apart from a
  // PASSWORD_RECOVERY session - Supabase issues the visitor a real,
  // logged-in-looking session the moment they click a password-reset email
  // link, but app.js needs to show a "Set New Password" screen instead of
  // silently entering the app for that one event.
  function notify(event) {
    listeners.forEach((fn) => {
      try { fn(currentUser, currentSession, event); } catch (e) { console.error(e); }
    });
  }

  function init() {
    const cfg = getConfig();
    if (!cfg || !window.supabase) return null;
    if (client) return client;
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    client.auth.getSession().then(({ data }) => {
      const session = data && data.session || null;
      // A signIn()/signUp() can complete (via onAuthStateChange, below)
      // before this initial check resolves. Only apply this result if it
      // reports a real session, or if nothing more recent already signed
      // someone in - otherwise a slow, now-stale "no session" answer would
      // clobber a sign-in that has already succeeded.
      if (session || !currentUser) {
        currentSession = session;
        currentUser = session ? session.user : null;
        notify();
      }
    });
    client.auth.onAuthStateChange((event, session) => {
      currentSession = session || null;
      currentUser = session ? session.user : null;
      notify(event);
    });
    return client;
  }

  function getClient() {
    return client || init();
  }

  function getUser() {
    return currentUser;
  }

  function isDemoMode() {
    return demoMode;
  }

  // Demo Mode: an in-browser sample-data sandbox (js/lib/demoData.js) so the
  // whole app can be explored with zero setup. Deliberately bypasses
  // getConfig()/localStorage entirely - it neither reads nor overwrites a
  // real saved Supabase connection, so switching back to a real project
  // afterward (exitDemoMode) picks up exactly where that was left.
  function enterDemoMode() {
    demoMode = true;
    client = App.demo.createClient();
    App.demo.seed();
    currentUser = App.demo.DEMO_USER;
    currentSession = { user: currentUser };
    notify();
  }

  function exitDemoMode() {
    demoMode = false;
    client = null;
    currentUser = null;
    currentSession = null;
    notify();
  }

  async function signUp(email, password, fullName) {
    const c = getClient();
    if (!c) throw new Error('Supabase is not configured yet.');
    const { data, error } = await c.auth.signUp({
      email, password, options: { data: { full_name: fullName || email } },
    });
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    const c = getClient();
    if (!c) throw new Error('Supabase is not configured yet.');
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  // Real Supabase password reset - the preferred first action for "I forgot
  // my password" (spec section 5), not a support ticket. redirectTo points
  // back at this same app; supabase-js's detectSessionInUrl (already on)
  // picks up the recovery token from the URL automatically and fires
  // onAuthStateChange with event 'PASSWORD_RECOVERY', which app.js watches
  // for to show a "Set New Password" screen instead of entering the app.
  async function requestPasswordReset(email) {
    const c = getClient();
    if (!c) throw new Error('Supabase is not configured yet.');
    const { error } = await c.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) throw error;
  }

  async function updatePassword(newPassword) {
    const c = getClient();
    if (!c) throw new Error('Supabase is not configured yet.');
    const { error } = await c.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  async function signOut() {
    if (demoMode) { exitDemoMode(); return; }
    const c = getClient();
    if (!c) return;
    await c.auth.signOut();
    currentUser = null;
    currentSession = null;
  }

  return {
    isConfigured, hasCustomConfig, saveConfig, clearConfig, getConfig, init, getClient, getUser, onChange,
    signUp, signIn, signOut, isDemoMode, enterDemoMode, exitDemoMode, requestPasswordReset, updatePassword,
  };
})();
