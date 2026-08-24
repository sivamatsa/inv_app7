/* Shared app state: current profile, cached lookups, and the global filter
   set (spec Section 38 - "All dashboard calculations must respond to
   filters"). Applied by the Dashboard, Deals, and Analytics views, the
   three places filtering genuinely changes what's shown. */
window.App = window.App || {};

App.state = {
  profile: null,
  platforms: [],
  categories: [],
  riskRatings: [],
  // How many active shared portfolios the signed-in user is a Viewer on
  // (024_portfolio_sharing_admin_users.sql) - drives whether the "Shared
  // With Me" nav item shows at all (app.js's currentNavStructure()).
  sharedWithMeCount: 0,
  // Per-(user, notification type) channel toggles (032_ui_and_notification_preferences.sql),
  // keyed by type - App.notifPrefs.isEnabled() below is the only thing that
  // should ever read this directly. Loaded once in App.lookups.loadAll();
  // absence of a key for a given type means every channel defaults to
  // enabled (see the migration's own header comment).
  notificationTypePrefs: {},
  filters: {
    platformId: 'All',
    investmentType: 'All',
    status: 'All',
    risk: 'All',
    paymentFrequency: 'All',
    dateFrom: null,
    dateTo: null,
    roiMin: null,
    roiMax: null,
    search: '',
  },
};

App.filters = (function () {
  function reset() {
    Object.assign(App.state.filters, {
      platformId: 'All', investmentType: 'All', status: 'All', risk: 'All', paymentFrequency: 'All',
      dateFrom: null, dateTo: null, roiMin: null, roiMax: null, search: '',
    });
  }

  function apply(deals) {
    const f = App.state.filters;
    return deals.filter((d) => {
      if (f.platformId !== 'All' && String(d.platform_id) !== String(f.platformId)) return false;
      if (f.investmentType !== 'All' && d.investment_type !== f.investmentType) return false;
      if (f.status !== 'All' && d.status !== f.status) return false;
      if (f.risk !== 'All' && d.risk_rating !== f.risk) return false;
      if (f.paymentFrequency !== 'All' && d.payment_frequency !== f.paymentFrequency) return false;
      if (f.dateFrom && d.start_date && d.start_date < f.dateFrom) return false;
      if (f.dateTo && d.start_date && d.start_date > f.dateTo) return false;
      if (f.roiMin !== null && (d.annual_roi === null || d.annual_roi < f.roiMin)) return false;
      if (f.roiMax !== null && (d.annual_roi === null || d.annual_roi > f.roiMax)) return false;
      if (f.search) {
        const s = f.search.toLowerCase();
        const hay = (String(d.deal_name || '') + ' ' + String(d.external_deal_id || '')).toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }

  function renderBar(container, onChange) {
    const f = App.state.filters;
    const platformOpts = ['All'].concat(App.state.platforms.map((p) => String(p.id)));
    const platformLabels = { All: 'All' };
    App.state.platforms.forEach((p) => { platformLabels[String(p.id)] = p.name; });
    const statuses = ['All', 'ACTIVE', 'MATURED', 'CLOSED', 'DEFAULTED', 'PARTIALLY_RECOVERED', 'WRITTEN_OFF', 'CANCELLED', 'ON_HOLD'];
    const freqs = ['All', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'At Maturity', 'Irregular', 'Custom'];
    const risks = ['All'].concat([...new Set(App.state.riskRatings.map((r) => r.code))]);
    const types = ['All'].concat([...new Set(App.state.categories.map((c) => c.investment_type))]);

    container.innerHTML = `
      <div class="filterbar">
        <div class="filter-group"><label>Platform</label>
          <select class="search-input" id="fPlatform">${platformOpts.map((o) => `<option value="${o}" ${f.platformId === o ? 'selected' : ''}>${App.utils.escapeHtml(platformLabels[o] || o)}</option>`).join('')}</select>
        </div>
        <div class="filter-group"><label>Investment Type</label>
          <select class="search-input" id="fType">${types.map((o) => `<option ${f.investmentType === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        </div>
        <div class="filter-group"><label>Status</label>
          <select class="search-input" id="fStatus">${statuses.map((o) => `<option ${f.status === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        </div>
        <div class="filter-group"><label>Risk</label>
          <select class="search-input" id="fRisk">${risks.map((o) => `<option ${f.risk === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        </div>
        <div class="filter-group"><label>Payment Frequency</label>
          <select class="search-input" id="fFreq">${freqs.map((o) => `<option ${f.paymentFrequency === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        </div>
        <div class="filter-group"><label>Start Date From</label><input type="date" class="date-mini" id="fFrom" value="${f.dateFrom || ''}"></div>
        <div class="filter-group"><label>Start Date To</label><input type="date" class="date-mini" id="fTo" value="${f.dateTo || ''}"></div>
        <div class="filter-group"><label>Search</label><input class="search-input" id="fSearch" placeholder="Deal name / external id" value="${App.utils.escapeHtml(f.search)}"></div>
        <div class="filter-group"><label>&nbsp;</label><button class="btn btn-outline btn-sm" id="fReset">↺ Reset filters</button></div>
      </div>`;

    const bind = (id, key, transform) => {
      App.utils.qs('#' + id, container).addEventListener('change', (e) => {
        f[key] = transform ? transform(e.target.value) : e.target.value;
        onChange();
      });
    };
    bind('fPlatform', 'platformId');
    bind('fType', 'investmentType');
    bind('fStatus', 'status');
    bind('fRisk', 'risk');
    bind('fFreq', 'paymentFrequency');
    bind('fFrom', 'dateFrom', (v) => v || null);
    bind('fTo', 'dateTo', (v) => v || null);
    App.utils.qs('#fSearch', container).addEventListener('input', App.utils.debounce((e) => {
      f.search = e.target.value; onChange();
    }, 250));
    App.utils.qs('#fReset', container).addEventListener('click', () => { reset(); onChange(); App.router.refreshCurrent(); });
  }

  return { reset, apply, renderBar };
})();

App.lookups = (function () {
  async function loadAll() {
    const [platforms, categories, riskRatings, profile, sharedWithMe, typePrefs] = await Promise.all([
      App.api.listPlatforms(), App.api.listCategories(), App.api.listRiskRatings(), App.api.getProfile(),
      App.api.listPortfoliosSharedWithMe().catch(() => []),
      App.api.listNotificationTypePreferences().catch(() => []),
    ]);
    App.state.platforms = platforms;
    App.state.categories = categories;
    App.state.riskRatings = riskRatings;
    App.state.profile = profile;
    // Excludes a portfolio the user happens to own themselves - "Shared
    // With Me" means someone ELSE'S portfolio, not a reflection of your own.
    App.state.sharedWithMeCount = sharedWithMe.filter((p) => p.owner_user_id !== (profile && profile.id)).length;
    const typePrefsByType = {};
    typePrefs.forEach((p) => { typePrefsByType[p.type] = p; });
    App.state.notificationTypePrefs = typePrefsByType;
  }
  function platformName(id) {
    const p = App.state.platforms.find((x) => x.id === id);
    return p ? p.name : '—';
  }
  return { loadAll, platformName };
})();

// Single source of truth for "is this notification type allowed to reach
// this channel" client-side - the badge counter, the notification panel,
// and the realtime toast callback (app.js) all call this instead of each
// re-deriving the same check, specifically so a muted type can never slip
// through one call site while correctly suppressed in another. Absence of a
// row for a type means every channel defaults to enabled (today's actual
// behavior, unchanged) - see 032_ui_and_notification_preferences.sql.
App.notifPrefs = {
  isEnabled(type, channel) {
    const pref = App.state.notificationTypePrefs[type];
    if (!pref) return true;
    return pref[channel] !== false;
  },
};
