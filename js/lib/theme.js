/* Dark/light mode toggle. Purely a client-side, per-browser preference
   (localStorage) - there is no server-side "theme" concept, so "for all
   users" means every user gets their own toggle, not a shared setting.
   The actual light/dark values live in css/app.css as [data-theme="light"]
   overrides of the same custom properties the dark theme already uses;
   this module only flips the attribute and remembers the choice. The
   inline snippet at the top of index.html applies a saved 'light' choice
   before first paint so there's no flash of the wrong theme. */
window.App = window.App || {};

(function () {
  const KEY = 'theme';

  function get() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }

  function iconFor(theme) {
    return theme === 'light' ? '&#9728;&#65039;' : '&#127769;';
  }

  function paintButtons(theme) {
    App.utils.qsa('#themeToggle, #authThemeToggle').forEach((btn) => { btn.innerHTML = iconFor(theme); });
  }

  function apply(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    paintButtons(theme);
  }

  function set(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private browsing etc - theme just won't persist */ }
    apply(theme);
  }

  function toggle() {
    set(get() === 'light' ? 'dark' : 'light');
  }

  function init() {
    apply(get());
    App.utils.qsa('#themeToggle, #authThemeToggle').forEach((btn) => btn.addEventListener('click', toggle));
  }

  App.theme = { get, set, toggle, init };
})();
