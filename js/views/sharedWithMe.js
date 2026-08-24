/* Shared With Me (024_portfolio_sharing_admin_users.sql) - a lightweight,
   read-only page for a Viewer on someone else's shared portfolio. Reuses
   admin.js's existing openUserDetailModal almost verbatim rather than
   retrofitting Deals/Recurring/Gold/etc. to support "viewing as someone
   else" - that would touch nearly every module for something this page
   already fully answers: "let me see a specific person's portfolio."
   Nav item only appears (see app.js's currentNavStructure()) when the
   signed-in user is actually a member of at least one active shared
   portfolio - nothing to see otherwise. */
window.App = window.App || {};

(function () {
  async function renderSharedWithMeView() {
    const pane = App.utils.qs('#pane-sharedWithMe');
    pane.innerHTML = `
      <div class="section-title">Shared With Me <div class="line"></div><small>portfolios someone has given you view access to</small></div>
      <div class="panel"><div id="sharedWithMeList"></div></div>`;

    const myId = App.state.profile && App.state.profile.id;
    const portfolios = (await App.api.listPortfoliosSharedWithMe()).filter((p) => p.owner_user_id !== myId);
    if (!portfolios.length) {
      App.utils.qs('#sharedWithMeList', pane).innerHTML = '<div class="empty-note">No one has shared a portfolio with you (yet).</div>';
      return;
    }
    const names = await App.api.getDisplayNames(portfolios.map((p) => p.owner_user_id));
    App.utils.qs('#sharedWithMeList', pane).innerHTML = portfolios.map((p) => `
      <div class="risk-item">
        <div style="font-size:18px;width:24px;text-align:center">&#128101;</div>
        <div style="flex:1"><div class="risk-name">${App.utils.escapeHtml(names[p.owner_user_id] || 'User')}</div><div class="risk-desc">${App.utils.escapeHtml(p.name)} - view only</div></div>
        <button class="btn btn-outline btn-sm" data-view-owner="${p.owner_user_id}">View Portfolio</button>
      </div>`).join('');

    App.utils.qsa('[data-view-owner]', pane).forEach((b) => b.addEventListener('click', () => {
      App.adminView.openUserDetailModal({ id: b.dataset.viewOwner, full_name: names[b.dataset.viewOwner] });
    }));
  }

  App.router.register('sharedWithMe', renderSharedWithMeView);
})();
