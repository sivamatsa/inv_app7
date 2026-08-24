/* Blog / Knowledge Sharing (028_blog.sql) - open to every signed-in user,
   same visibility model as Community Discussion: anyone can post, anyone
   can read, own-or-admin can edit/delete. Deliberately plain text/light-
   weight (no WYSIWYG, no image uploads) - same simplicity level as Notes
   and Community already in this app, not a new authoring paradigm. */
window.App = window.App || {};

(function () {
  const POST_FIELDS = [
    { key: 'title', label: 'Title', required: true, span: 2 },
    { key: 'category', label: 'Category', placeholder: 'e.g. Gold, Fixed Income, Taxes' },
    { key: 'tagsText', label: 'Tags (comma-separated)', placeholder: 'fd, strategy' },
    { key: 'content', label: 'Content', type: 'textarea', rows: 8, required: true, span: 2 },
  ];

  function openPostEditor(existing, onDone) {
    const values = existing ? Object.assign({}, existing, { tagsText: (existing.tags || []).join(', ') }) : {};
    App.ui.open({
      title: existing ? 'Edit Post' : 'New Post',
      bodyHtml: `<div id="postFormHost"></div><div class="auth-error" id="postFormError"></div>`,
      onMount: (body) => { App.utils.qs('#postFormHost', body).innerHTML = App.ui.renderForm(POST_FIELDS, values); },
      actions: [
        { label: existing ? 'Save Changes' : 'Publish', className: 'btn-gold', onClick: async () => {
          const { values: v, errors } = App.ui.readForm(POST_FIELDS);
          if (errors.length) { App.utils.qs('#postFormError').textContent = 'Title and content are required.'; return; }
          const tags = (v.tagsText || '').split(',').map((s) => s.trim()).filter(Boolean);
          const payload = { title: v.title, content: v.content, category: v.category || null, tags };
          try {
            if (existing) await App.api.updateBlogPost(existing.id, payload);
            else await App.api.createBlogPost(payload);
            App.utils.toast(existing ? 'Post updated' : 'Post published');
            App.ui.close();
            if (onDone) onDone();
          } catch (e) { App.utils.qs('#postFormError').textContent = 'Could not save: ' + (e.message || e); }
        } },
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });
  }

  async function openPostDetail(post, onDone) {
    const isAdmin = App.state.profile && App.state.profile.is_admin;
    const isMine = App.state.profile && App.state.profile.id === post.author_user_id;
    const names = await App.api.getDisplayNames([post.author_user_id]);

    async function draw() {
      const comments = await App.api.listBlogComments(post.id);
      const commentAuthorIds = comments.map((c) => c.author_user_id);
      const commentNames = commentAuthorIds.length ? await App.api.getDisplayNames(commentAuthorIds) : {};
      App.ui.open({
        title: post.title,
        bodyHtml: `
          <div class="hint" style="margin-bottom:10px">${App.utils.escapeHtml(names[post.author_user_id] || 'User')} &middot; ${App.utils.fmtDate(post.created_at)}${post.category ? ' &middot; ' + App.utils.escapeHtml(post.category) : ''}</div>
          <div style="white-space:pre-wrap;font-size:13.5px;line-height:1.6;margin-bottom:14px">${App.utils.escapeHtml(post.content)}</div>
          ${(post.tags || []).length ? `<div style="margin-bottom:16px">${post.tags.map((t) => `<span class="badge" style="margin-right:6px">${App.utils.escapeHtml(t)}</span>`).join('')}</div>` : ''}
          <div style="border-top:1px solid var(--border2);padding-top:14px">
            <div class="chart-title" style="font-size:13px;margin-bottom:8px">Comments</div>
            <div id="postComments">${comments.map((c) => `
              <div class="risk-item">
                <div style="flex:1"><div class="risk-name">${App.utils.escapeHtml(commentNames[c.author_user_id] || 'User')}</div><div class="risk-desc">${App.utils.escapeHtml(c.content)}</div></div>
                ${(c.author_user_id === (App.state.profile && App.state.profile.id) || isAdmin) ? `<button class="icon-btn del" data-del-comment="${c.id}">&#128465;</button>` : ''}
              </div>`).join('') || '<div class="empty-note">No comments yet.</div>'}</div>
            <div style="display:flex;gap:8px;margin-top:10px">
              <input class="search-input" id="newCommentInput" placeholder="Add a comment..." style="flex:1">
              <button class="btn btn-gold btn-sm" id="postCommentBtn">Post</button>
            </div>
          </div>`,
        actions: [
          ...(isMine || isAdmin ? [
            { label: 'Edit', className: 'btn-outline', onClick: () => { App.ui.close(); openPostEditor(post, onDone); } },
            { label: 'Delete', className: 'btn-outline', onClick: async () => {
              if (!confirm('Delete this post and all its comments?')) return;
              try { await App.api.deleteBlogPost(post.id); App.utils.toast('Post deleted'); App.ui.close(); if (onDone) onDone(); }
              catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
            } },
          ] : []),
          { label: 'Close', className: 'btn-gold', onClick: App.ui.close },
        ],
        onMount: (body) => {
          App.utils.qs('#postCommentBtn', body).addEventListener('click', async () => {
            const content = App.utils.qs('#newCommentInput', body).value.trim();
            if (!content) return;
            try { await App.api.createBlogComment({ post_id: post.id, content }); await draw(); }
            catch (e) { App.utils.toast('Could not post comment: ' + (e.message || e), 'err'); }
          });
          App.utils.qsa('[data-del-comment]', body).forEach((b) => b.addEventListener('click', async () => {
            try { await App.api.deleteBlogComment(Number(b.dataset.delComment)); await draw(); }
            catch (e) { App.utils.toast('Could not delete comment: ' + (e.message || e), 'err'); }
          }));
        },
      });
    }
    draw();
  }

  async function renderBlogView() {
    const pane = App.utils.qs('#pane-blog');
    pane.innerHTML = `
      <div class="section-title">Blog <div class="line"></div><small>share knowledge - open to every signed-in user</small></div>
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <input class="search-input" id="blogSearch" placeholder="Search posts...">
          <button class="btn btn-gold btn-sm" id="newPostBtn">+ New Post</button>
        </div>
        <div id="blogList" class="card-row" style="flex-wrap:wrap"></div>
      </div>`;

    App.utils.qs('#newPostBtn', pane).addEventListener('click', () => openPostEditor(null, draw));
    App.utils.qs('#blogSearch', pane).addEventListener('input', App.utils.debounce(draw, 250));

    async function draw() {
      const search = (App.utils.qs('#blogSearch', pane).value || '').toLowerCase();
      const posts = await App.api.listBlogPosts();
      const filtered = search ? posts.filter((p) => (p.title + ' ' + p.content + ' ' + (p.category || '')).toLowerCase().includes(search)) : posts;
      const sorted = [...filtered].sort((a, b) => (b.pinned - a.pinned) || b.created_at.localeCompare(a.created_at));
      const names = await App.api.getDisplayNames(sorted.map((p) => p.author_user_id));

      App.utils.qs('#blogList', pane).innerHTML = sorted.map((p) => `
        <div class="integration-card" style="min-width:280px;max-width:340px;cursor:pointer" data-post="${p.id}">
          ${p.pinned ? '<div class="badge st-active" style="margin-bottom:6px">Pinned</div>' : ''}
          <div class="name">${App.utils.escapeHtml(p.title)}</div>
          <div class="hint" style="margin:4px 0">${App.utils.escapeHtml((p.content || '').slice(0, 100))}${p.content && p.content.length > 100 ? '...' : ''}</div>
          <div class="hint" style="margin:0;font-size:10.5px">${App.utils.escapeHtml(names[p.author_user_id] || 'User')} &middot; ${App.utils.fmtDate(p.created_at)}${p.category ? ' &middot; ' + App.utils.escapeHtml(p.category) : ''}</div>
        </div>`).join('') || '<div class="empty-note">No posts yet - be the first to share something.</div>';

      App.utils.qsa('[data-post]', pane).forEach((el) => el.addEventListener('click', () => {
        const post = sorted.find((p) => p.id === Number(el.dataset.post));
        openPostDetail(post, draw);
      }));
    }

    await draw();
  }

  App.router.register('blog', renderBlogView);
})();
