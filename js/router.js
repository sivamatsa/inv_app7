/* Minimal hash router - no framework. Each view module registers a render
   function; the router shows/hides panes and calls render on navigation. */
window.App = window.App || {};

App.router = (function () {
  const views = {};
  let current = null;
  let currentCleanup = null;
  let initialized = false;

  function register(name, renderFn) {
    views[name] = renderFn;
  }

  // A view that opens a realtime subscription (community.js, a ticket
  // detail view, ...) calls this during its render with a teardown
  // function, so navigating away - not just re-entering the same view -
  // actually closes it instead of leaking subscriptions silently.
  function onLeave(cleanupFn) {
    currentCleanup = cleanupFn;
  }

  function currentName() {
    return (location.hash || '#dashboard').slice(1).split('?')[0];
  }

  async function show(name) {
    if (currentCleanup) { try { currentCleanup(); } catch (e) { console.error(e); } currentCleanup = null; }
    if (!views[name]) name = 'dashboard';
    App.utils.qsa('.view-pane').forEach((p) => p.classList.toggle('active', p.dataset.view === name));
    App.utils.qsa('.nav-link').forEach((l) => l.classList.toggle('active', l.dataset.nav === name));
    const titleEl = App.utils.qs('#topbarTitle');
    const link = App.utils.qs(`.nav-link[data-nav="${name}"]`);
    if (titleEl && link) titleEl.textContent = link.dataset.label || name;
    current = name;
    try {
      await views[name]();
    } catch (e) {
      console.error('View render failed:', name, e);
      App.utils.toast('Could not load this view: ' + (e.message || e), 'err');
    }
  }

  function navigate(name) {
    if (location.hash.slice(1).split('?')[0] === name) { show(name); return; }
    location.hash = '#' + name;
  }

  function refreshCurrent() {
    if (current) show(current);
  }

  function init() {
    // App.auth's onAuthStateChange fires enterApp() (which calls this)
    // more than once per session by design - not just on sign-in, but also
    // on an extra INITIAL_SESSION event and on every periodic
    // TOKEN_REFRESHED. Without this guard, every extra call added another
    // permanent 'hashchange' listener AND re-ran the current view's render
    // function again. Since each render is async and attaches its own
    // button listeners only after several awaits, N overlapping renders
    // of the same view could all end up attaching their own click
    // listener to the SAME final button (the last render's DOM), so one
    // click fired N times - the reported "Export All downloaded 3x/12x"
    // bug. Once the app shell is showing the right view, a re-fired
    // enterApp() needs no action here at all - refreshCurrent() is the
    // real, explicit way to force a reload of the current view's data.
    if (initialized) return;
    initialized = true;
    window.addEventListener('hashchange', () => show(currentName()));
    show(currentName());
  }

  return { register, navigate, init, refreshCurrent, onLeave, currentName: () => current };
})();
