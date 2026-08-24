/* The only file that talks to Supabase for data. Every view goes through
   here rather than calling supabase-js directly, so the data access pattern
   stays in one place. */
window.App = window.App || {};

App.api = (function () {
  function client() {
    const c = App.auth.getClient();
    if (!c) throw new Error('Supabase is not connected.');
    return c;
  }

  function uid() {
    const u = App.auth.getUser();
    if (!u) throw new Error('Not signed in.');
    return u.id;
  }

  // Live Cross-Device Portfolio Sync's echo suppression (subscribeToPortfolioChanges
  // below): a realtime event arriving within this many ms of a write this
  // same session just made is treated as that write's own echo (Postgres
  // Changes broadcasts to every matching subscriber, including the tab that
  // made the change) and doesn't get its own "updated elsewhere" toast - the
  // soft-refresh still happens regardless, since a redundant refresh is
  // harmless while a redundant toast is annoying. A single timestamp rather
  // than per-row tracking deliberately: several of the 7 synced tables are
  // mutated through RPCs (fn_record_payment, fn_confirm_recurring_occurrence,
  // ...) as often as through plain insert/update/delete, and a coarse
  // "I just did something" window covers every mutation path uniformly
  // instead of only the ones going through insertRow/updateRow/deleteRow.
  const LOCAL_WRITE_ECHO_WINDOW_MS = 5000;
  let lastLocalWriteAt = 0;
  function markLocalWrite() { lastLocalWriteAt = Date.now(); }
  function isRecentLocalWrite() { return Date.now() - lastLocalWriteAt < LOCAL_WRITE_ECHO_WINDOW_MS; }

  function check(error) {
    if (error) throw error;
  }

  // Tables where "own portfolio" views (Deals, Payments, Dashboard,
  // Recurring, etc.) must ALWAYS scope to the signed-in user, even for an
  // admin account. Admin's read-across-all-users RLS bypass
  // (013_admin_role.sql) exists for the dedicated, explicitly-labeled Admin
  // page's oversight views - not so every other page silently mixes every
  // registered user's rows into admin's own portfolio the moment RLS stops
  // filtering for them. A caller that genuinely wants every user's rows
  // (the Admin page's own aggregation queries) passes `allUsers: true` to
  // opt out row-by-row; a caller that already supplies an explicit
  // `eq.user_id` (e.g. admin drilling into one specific other user) is
  // never overridden either way.
  // support_tickets/ticket_messages are deliberately NOT here - admin
  // replying to and resolving other users' tickets is the one place
  // cross-user access is the whole point, not an accident (see README).
  const SELF_SCOPED_TABLES = new Set([
    'platforms', 'deals', 'payment_schedule', 'payments', 'reinvestments',
    'notifications', 'notification_preferences', 'documents', 'imports', 'audit_logs',
    'portfolio_goals', 'cash_transactions', 'bank_transactions', 'payment_matches',
    'tax_records', 'ai_insights', 'scenario_simulations', 'integration_configs',
    'recurring_items', 'recurring_occurrences', 'recurring_amount_history',
    'recurring_schedule_history', 'recurring_pauses',
    // security_invoker views over the tables above inherit the exact same
    // admin-bypass leak (they're not filtered to the caller internally,
    // unlike v_portfolio_summary/v_my_conversations which already are).
    'v_deal_metrics', 'v_recurring_summary', 'v_recurring_consistency',
    // Gold Intelligence (019_gold_intelligence.sql) - gold_purchases and
    // gold_alerts are personal portfolio data with the same is_admin() RLS
    // shape as deals/recurring_items; v_gold_scheme_holdings is a
    // security_invoker join over recurring_items/recurring_occurrences,
    // same leak class as v_deal_metrics above. gold_providers/gold_settings/
    // gold_price_observations are deliberately NOT here - they're shared
    // infrastructure config and shared market data, not per-user portfolio
    // data, so every user (including admin) is meant to see the same rows.
    'gold_purchases', 'gold_alerts', 'v_gold_scheme_holdings',
    // Expense & Project Cost Management (031_expense_projects.sql) - same
    // owner+admin+Viewer RLS shape as deals/recurring_items, same leak
    // class to guard against. expense_transaction_custom_values is
    // deliberately NOT here - it has no user_id column of its own
    // (ownership is derived through its parent transaction), so there's
    // no eq.user_id filter that would even make sense to auto-inject.
    'expense_projects', 'expense_categories', 'expense_vendors', 'expense_advances',
    'expense_transactions', 'expense_recurring_templates', 'expense_project_custom_fields',
    'v_expense_project_summary', 'v_expense_category_summary', 'v_expense_vendor_summary',
    // Accounts & Liabilities, and Net Worth (035_accounts_liabilities_net_worth.sql) -
    // same owner+admin+Viewer RLS shape as deals/gold_purchases/expense_projects.
    'accounts', 'liabilities', 'net_worth_snapshots',
    // Automation Center (037) - RLS is already fully owner-only here (no
    // admin/Viewer bypass exists to leak from), so this entry isn't closing
    // a leak - it's just so a plain listAutomationRules() call never needs
    // its own explicit eq filter, consistent with every other table here.
    'automation_rules',
  ]);

  async function selectAll(table, opts) {
    opts = opts || {};
    let eq = opts.eq;
    if (SELF_SCOPED_TABLES.has(table) && !opts.allUsers && (!eq || eq.user_id === undefined)) {
      eq = Object.assign({ user_id: uid() }, eq);
    }
    let q = client().from(table).select(opts.select || '*');
    if (eq) Object.entries(eq).forEach(([k, v]) => { q = q.eq(k, v); });
    if (opts.in) Object.entries(opts.in).forEach(([k, v]) => { q = q.in(k, v); });
    if (opts.gte) Object.entries(opts.gte).forEach(([k, v]) => { q = q.gte(k, v); });
    if (opts.lte) Object.entries(opts.lte).forEach(([k, v]) => { q = q.lte(k, v); });
    if (opts.order) q = q.order(opts.order.column, { ascending: opts.order.ascending !== false });
    if (opts.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    check(error);
    return data || [];
  }

  async function insertRow(table, row, opts) {
    // Omit null/undefined keys rather than sending them explicitly: several
    // columns are `not null default '...'` (status, confirmation_method,
    // source, ...), and Postgres only applies a column default when it's
    // left out of the insert entirely - an explicit NULL still violates
    // NOT NULL. A form field the user left blank should mean "use the
    // database default", not "store NULL".
    const cleaned = {};
    Object.entries(row || {}).forEach(([k, v]) => { if (v !== null && v !== undefined) cleaned[k] = v; });
    // Almost every table's owner column is user_id - ticket_messages is the
    // one exception (sender_id, since admin posts messages on tickets they
    // don't own, so "owner" and "sender" are genuinely different concepts
    // there). opts.ownerCol lets a caller override which column gets the
    // current user's id.
    const ownerCol = (opts && opts.ownerCol) || 'user_id';
    const payload = Object.assign({ [ownerCol]: uid() }, cleaned);
    let q = client().from(table).insert(payload).select();
    const { data, error } = (opts && opts.many) ? await q : await q.single();
    check(error);
    markLocalWrite();
    return data;
  }

  // Backup & Disaster Recovery's ONLY write mechanism (restoreData.js) - a
  // thin passthrough to insertRow with zero business-logic side effects
  // (no auto schedule/occurrence generation, no fn_record_payment RPC), and
  // the exported row's own `id` stripped so Postgres assigns a fresh one
  // (every restored table uses `generated always as identity`, which
  // rejects an explicit id without OVERRIDING SYSTEM VALUE) - the restore
  // driver is the one place in this app that deliberately wants a manual-
  // entry side effect to NOT re-run, since the exported row already carries
  // whatever that side effect produced the first time, for real, in the past.
  async function restoreInsertRow(table, row, opts) {
    const { id, ...rest } = row || {};
    return insertRow(table, rest, opts);
  }

  async function updateRow(table, id, patch, idCol) {
    const { data, error } = await client().from(table).update(patch).eq(idCol || 'id', id).select().single();
    check(error);
    markLocalWrite();
    return data;
  }

  async function deleteRow(table, id, idCol) {
    const { error } = await client().from(table).delete().eq(idCol || 'id', id);
    check(error);
    markLocalWrite();
  }

  // ---- profiles ----
  async function getProfile() {
    const { data, error } = await client().from('profiles').select('*').eq('id', uid()).maybeSingle();
    check(error);
    return data;
  }
  async function updateProfile(patch) {
    return updateRow('profiles', uid(), patch, 'id');
  }
  // Only returns more than the caller's own row if private.is_admin() says
  // so server-side (013_admin_role.sql) - RLS decides this, not the client.
  async function listAllProfiles() {
    return selectAll('profiles', { order: { column: 'created_at' } });
  }

  // ---- platforms ----
  const listPlatforms = () => selectAll('platforms', { order: { column: 'name' } });
  const createPlatform = (row) => insertRow('platforms', row);
  const updatePlatform = (id, patch) => updateRow('platforms', id, patch);
  const deletePlatform = (id) => deleteRow('platforms', id);

  // ---- lookups ----
  const listCategories = () => selectAll('investment_categories', { order: { column: 'category' } });
  const createCategory = (row) => insertRow('investment_categories', row);
  const listRiskRatings = () => selectAll('risk_ratings', { order: { column: 'sort_order' } });
  const createRiskRating = (row) => insertRow('risk_ratings', row);

  // ---- deals ----
  const listDeals = (opts) => selectAll('deals', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  async function getDeal(id) {
    // Deliberately scoped to the caller's own deals only, same as listDeals
    // - nothing in this app's UI opens a deal detail modal for an id that
    // didn't come from the caller's own (already self-scoped) list, so this
    // is defense in depth rather than a change in behavior: it just makes
    // that assumption a real guarantee instead of an incidental one.
    const { data, error } = await client().from('deals').select('*').eq('id', id).eq('user_id', uid()).single();
    check(error);
    return data;
  }
  const createDeal = (row) => insertRow('deals', row);
  const updateDeal = (id, patch) => updateRow('deals', id, patch);
  const deleteDeal = (id) => deleteRow('deals', id);
  const listDealMetrics = (opts) => selectAll('v_deal_metrics', opts);
  async function getPortfolioSummary(forUserId) {
    const { data, error } = await client().from('v_portfolio_summary').select('*').eq('user_id', forUserId || uid()).maybeSingle();
    check(error);
    return data;
  }

  // ---- payment_schedule ----
  const listSchedule = (opts) => selectAll('payment_schedule', Object.assign({ order: { column: 'scheduled_date' } }, opts));
  const createScheduleRow = (row) => insertRow('payment_schedule', row);
  const updateScheduleRow = (id, patch) => updateRow('payment_schedule', id, patch);
  const deleteScheduleRow = (id) => deleteRow('payment_schedule', id);
  async function generateSchedule(dealId) {
    const { data, error } = await client().rpc('fn_generate_payment_schedule', { p_deal_id: dealId });
    check(error);
    markLocalWrite();
    return data;
  }

  // ---- payments ----
  const listPayments = (opts) => selectAll('payments', Object.assign({ order: { column: 'transaction_date', ascending: false } }, opts));
  async function recordPayment(p) {
    const { data, error } = await client().rpc('fn_record_payment', {
      p_deal_id: p.dealId,
      p_transaction_date: p.transactionDate,
      p_amount: p.amount,
      p_interest_amount: p.interestAmount ?? null,
      p_principal_amount: p.principalAmount ?? null,
      p_fee_amount: p.feeAmount ?? 0,
      p_tax_amount: p.taxAmount ?? 0,
      p_payment_reference: p.paymentReference ?? null,
      p_payment_mode: p.paymentMode ?? null,
      p_confirmation_method: p.confirmationMethod ?? 'Manual',
      p_notes: p.notes ?? null,
      p_scheduled_payment_id: p.scheduledPaymentId ?? null,
    });
    check(error);
    markLocalWrite();
    return data;
  }
  const voidPayment = (id, reason) => updateRow('payments', id, { is_voided: true, voided_at: new Date().toISOString(), voided_reason: reason || null });

  // ---- reinvestments ----
  const listReinvestments = (opts) => selectAll('reinvestments', Object.assign({ order: { column: 'returned_date', ascending: false } }, opts));
  const updateReinvestment = (id, patch) => updateRow('reinvestments', id, patch);

  // ---- notifications ----
  const listNotifications = (opts) => selectAll('notifications', Object.assign({ order: { column: 'scheduled_at', ascending: false } }, opts));
  const markNotificationRead = (id) => updateRow('notifications', id, { read_at: new Date().toISOString(), status: 'Read' });
  async function markAllNotificationsRead() {
    const { error } = await client().from('notifications').update({ read_at: new Date().toISOString(), status: 'Read' })
      .eq('user_id', uid()).is('read_at', null);
    check(error);
  }
  async function getPreferences() {
    const { data, error } = await client().from('notification_preferences').select('*').eq('user_id', uid()).maybeSingle();
    check(error);
    return data;
  }
  async function upsertPreferences(patch) {
    const { data, error } = await client().from('notification_preferences')
      .upsert(Object.assign({ user_id: uid() }, patch), { onConflict: 'user_id' }).select().single();
    check(error);
    return data;
  }
  // Invokes send-notification-emails directly from the caller's own signed-
  // in session (no service-role key on this path - that only ever lives
  // inside the function itself). One call sweeps every opted-in user, so
  // the Settings UI gates this button to admin only, same reasoning as
  // Admin's "Run Automation Now". Works in Demo Mode via demoData.js's own
  // functions.invoke stub, same pattern as refreshGoldPrice().
  async function sendPendingNotificationEmails() {
    const { data, error } = await client().functions.invoke('send-notification-emails');
    check(error);
    return data;
  }
  // Sweeps every opted-in user's pending push notifications immediately -
  // same admin-only "test the pipeline without waiting for the schedule"
  // role as sendPendingNotificationEmails() above.
  async function sendPendingWebPush() {
    const { data, error } = await client().functions.invoke('send-web-push');
    check(error);
    return data;
  }

  // ---- calendar_events (manual events/birthdays/anniversaries/reminders/
  // countdowns) - personal data, no admin RLS bypass, same category as
  // Notes/Contacts, so unlike gold_purchases/deals this never needs
  // SELF_SCOPED_TABLES: there is no admin-bypass leak to guard against. ----
  const listCalendarEvents = (opts) => selectAll('calendar_events', Object.assign({ order: { column: 'event_date' } }, opts));
  const createCalendarEvent = (row) => insertRow('calendar_events', row);
  const updateCalendarEvent = (id, patch) => updateRow('calendar_events', id, patch);
  const deleteCalendarEvent = (id) => deleteRow('calendar_events', id);

  // ---- app_settings (admin-only global toggles, e.g. Audit History) ----
  async function getAppSettings() {
    const { data, error } = await client().from('app_settings').select('*').eq('id', 1).maybeSingle();
    check(error);
    return data;
  }
  async function updateAppSettings(patch) {
    const { data, error } = await client().from('app_settings').update(patch).eq('id', 1).select().single();
    check(error);
    return data;
  }

  // ---- documents (Supabase Storage + metadata row) ----
  const listDocuments = (opts) => selectAll('documents', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  async function uploadDocument(file, meta) {
    const path = `${uid()}/${meta.dealId || 'general'}/${Date.now()}_${file.name}`;
    const { error: upErr } = await client().storage.from('documents').upload(path, file);
    check(upErr);
    return insertRow('documents', {
      deal_id: meta.dealId || null,
      payment_id: meta.paymentId || null,
      document_type: meta.documentType,
      document_reference: meta.documentReference || null,
      document_date: meta.documentDate || null,
      notes: meta.notes || null,
      storage_path: path,
      file_name: file.name,
      file_size_bytes: file.size,
      mime_type: file.type,
    });
  }
  async function getDocumentUrl(storagePath) {
    const { data, error } = await client().storage.from('documents').createSignedUrl(storagePath, 300);
    check(error);
    return data.signedUrl;
  }
  async function deleteDocument(id, storagePath) {
    await client().storage.from('documents').remove([storagePath]);
    return deleteRow('documents', id);
  }

  // ---- audit / imports ----
  const listAuditLogs = (opts) => selectAll('audit_logs', Object.assign({ order: { column: 'changed_at', ascending: false }, limit: 500 }, opts));
  const listImports = (opts) => selectAll('imports', Object.assign({ order: { column: 'imported_at', ascending: false } }, opts));
  const createImport = (row) => insertRow('imports', row);
  const updateImport = (id, patch) => updateRow('imports', id, patch);

  // ---- goals / cash / tax ----
  const listGoals = (opts) => selectAll('portfolio_goals', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  const createGoal = (row) => insertRow('portfolio_goals', row);
  const updateGoal = (id, patch) => updateRow('portfolio_goals', id, patch);
  const listCashTransactions = (opts) => selectAll('cash_transactions', Object.assign({ order: { column: 'transaction_date', ascending: false } }, opts));
  const createCashTransaction = (row) => insertRow('cash_transactions', row);
  const listTaxRecords = (opts) => selectAll('tax_records', Object.assign({ order: { column: 'financial_year', ascending: false } }, opts));
  const createTaxRecord = (row) => insertRow('tax_records', row);
  const updateTaxRecord = (id, patch) => updateRow('tax_records', id, patch);

  // ---- ai insights / what-if ----
  const listInsights = (opts) => selectAll('ai_insights', Object.assign({ order: { column: 'generated_at', ascending: false }, eq: { is_dismissed: false } }, opts));
  const dismissInsight = (id) => updateRow('ai_insights', id, { is_dismissed: true });
  const listScenarios = () => selectAll('scenario_simulations', { order: { column: 'created_at', ascending: false } });
  const saveScenario = (row) => insertRow('scenario_simulations', row);
  const deleteScenario = (id) => deleteRow('scenario_simulations', id);

  // ---- integrations ----
  const listIntegrations = () => selectAll('integration_configs');
  async function upsertIntegration(integrationType, patch) {
    const { data, error } = await client().from('integration_configs')
      .upsert(Object.assign({ user_id: uid(), integration_type: integrationType }, patch), { onConflict: 'user_id,integration_type' })
      .select().single();
    check(error);
    return data;
  }

  // ---- reconciliation ----
  const listBankTransactions = (opts) => selectAll('bank_transactions', Object.assign({ order: { column: 'transaction_date', ascending: false } }, opts));
  const createBankTransaction = (row) => insertRow('bank_transactions', row);
  const markBankTransactionMatched = (id) => updateRow('bank_transactions', id, { matched: true });
  const listPaymentMatches = (opts) => selectAll('payment_matches', opts);
  const createPaymentMatch = (row) => insertRow('payment_matches', row);
  const updatePaymentMatch = (id, patch) => updateRow('payment_matches', id, patch);

  // ---- community messaging ----
  const listCommunityMessages = (opts) => selectAll('community_messages', Object.assign({ order: { column: 'created_at' } }, opts));
  const postCommunityMessage = (message) => insertRow('community_messages', { message });
  function subscribeToCommunityMessages(onInsert) {
    return client().channel('community_messages_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_messages' }, (payload) => onInsert(payload.new))
      .subscribe();
  }

  // ---- notes ----
  const listNotes = (opts) => selectAll('notes', Object.assign({ order: { column: 'updated_at', ascending: false } }, opts));
  const createNote = (row) => insertRow('notes', row);
  const updateNote = (id, patch) => updateRow('notes', id, patch);
  const deleteNote = (id) => deleteRow('notes', id);

  // ---- support tickets ----
  const listTickets = (opts) => selectAll('support_tickets', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  async function getTicket(id) {
    const { data, error } = await client().from('support_tickets').select('*').eq('id', id).single();
    check(error);
    return data;
  }
  const createTicket = (row) => insertRow('support_tickets', row);
  const updateTicketStatus = (id, status) => updateRow('support_tickets', id, {
    status, resolved_at: (status === 'Resolved' || status === 'Closed') ? new Date().toISOString() : null,
  });
  const listTicketMessages = (ticketId) => selectAll('ticket_messages', { eq: { ticket_id: ticketId }, order: { column: 'created_at' } });
  const postTicketMessage = (ticketId, message, isAdminReply) => insertRow('ticket_messages', {
    ticket_id: ticketId, message, is_admin_reply: !!isAdminReply,
  }, { ownerCol: 'sender_id' });
  function subscribeToTicketMessages(ticketId, onInsert) {
    return client().channel('ticket_messages_' + ticketId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ticket_messages', filter: `ticket_id=eq.${ticketId}` }, (payload) => onInsert(payload.new))
      .subscribe();
  }
  const updateTicketCategory = (id, category) => updateRow('support_tickets', id, { category });
  const updateTicketPriority = (id, priority) => updateRow('support_tickets', id, { priority });
  const updateTicketAssignment = (id, assignedTo) => updateRow('support_tickets', id, { assigned_to: assignedTo });
  const rateTicketResolution = (id, rating, comment) => updateRow('support_tickets', id, { resolution_rating: rating, resolution_comment: comment || null });
  // ----034: pre-login guest ticket submission - the ONLY door, a SECURITY
  // DEFINER function rather than a raw table insert (see the migration's own
  // header comment for why). Returns just the generated ticket_number. ----
  async function submitGuestTicket(category, guestName, guestEmail, guestMessage, accountEmail) {
    const { data, error } = await client().rpc('fn_submit_guest_ticket', {
      p_category: category, p_guest_name: guestName, p_guest_email: guestEmail,
      p_guest_message: guestMessage, p_account_email: accountEmail || null,
    });
    check(error);
    return data;
  }
  // ---- 034: ticket internal notes - admin-only both directions (RLS
  // enforces this; a ticket's own owner never gets a row back). ----
  const listTicketInternalNotes = (ticketId) => selectAll('ticket_internal_notes', { eq: { ticket_id: ticketId }, order: { column: 'created_at' } });
  const createTicketInternalNote = (ticketId, note) => insertRow('ticket_internal_notes', { ticket_id: ticketId, note }, { ownerCol: 'admin_user_id' });

  // ---- 034: Feature Suggestions - deliberately separate from support
  // tickets, readable by every authenticated user (RLS `using (true)`) so
  // voting/roadmap works. ----
  const listFeatureSuggestions = (opts) => selectAll('feature_suggestions', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  async function getFeatureSuggestion(id) {
    const { data, error } = await client().from('feature_suggestions').select('*').eq('id', id).single();
    check(error);
    return data;
  }
  const createFeatureSuggestion = (row) => insertRow('feature_suggestions', row);
  const updateFeatureSuggestion = (id, patch) => updateRow('feature_suggestions', id, patch);
  const listSuggestionInternalNotes = (suggestionId) => selectAll('suggestion_internal_notes', { eq: { suggestion_id: suggestionId }, order: { column: 'created_at' } });
  const createSuggestionInternalNote = (suggestionId, note) => insertRow('suggestion_internal_notes', { suggestion_id: suggestionId, note }, { ownerCol: 'admin_user_id' });
  const listSuggestionVoteCounts = () => selectAll('v_suggestion_vote_counts');
  const listMyVotes = () => selectAll('suggestion_votes', { eq: { user_id: uid() } });
  async function voteSuggestion(suggestionId) {
    return insertRow('suggestion_votes', { suggestion_id: suggestionId });
  }
  async function unvoteSuggestion(suggestionId) {
    const { error } = await client().from('suggestion_votes').delete().eq('suggestion_id', suggestionId).eq('user_id', uid());
    check(error);
  }

  // ---- display names (community/tickets only need id + full_name of others) ----
  async function getDisplayNames(userIds) {
    if (!userIds.length) return {};
    const { data, error } = await client().rpc('get_display_names', { p_user_ids: [...new Set(userIds)] });
    check(error);
    const map = {};
    (data || []).forEach((r) => { map[r.id] = r.full_name; });
    return map;
  }

  // ---- realtime notifications (instant push instead of the 60s poll) ----
  function subscribeToNotifications(onInsert) {
    return client().channel('notifications_changes_' + uid())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid()}` }, (payload) => onInsert(payload.new))
      .subscribe();
  }
  function unsubscribe(channel) {
    if (channel) client().removeChannel(channel);
  }

  // ---- Live Cross-Device Portfolio Sync - nothing in this app has ever
  // subscribed to postgres_changes on a user's own financial data before
  // (existing Realtime usage is all social: chat, notifications, calls,
  // community/ticket messages). Edit a deal on your phone, your laptop's
  // already-open dashboard/deals list updates within a second or two with
  // no manual reload - one channel, one .on('postgres_changes', ...) call
  // per table, each filtered to the caller's own rows exactly like
  // subscribeToNotifications above. onChange receives {table, eventType,
  // row} for every change from ANY session (including this one - the
  // isEcho flag lets the caller decide whether to mention it, but the
  // caller should still treat the data as needing a refresh either way). ----
  const PORTFOLIO_SYNC_TABLES = ['deals', 'payment_schedule', 'payments', 'recurring_items', 'recurring_occurrences', 'gold_purchases', 'expense_transactions'];
  function subscribeToPortfolioChanges(onChange) {
    let channel = client().channel('portfolio_changes_' + uid());
    PORTFOLIO_SYNC_TABLES.forEach((table) => {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${uid()}` }, (payload) => {
        onChange({ table, eventType: payload.eventType, row: payload.new || payload.old, isEcho: isRecentLocalWrite() });
      });
    });
    return channel.subscribe();
  }

  // ---- admin on-demand automation ----
  async function runAutomationNow() {
    const { data, error } = await client().rpc('fn_admin_run_automation');
    check(error);
    return data;
  }

  // ---- recurring investments & commitments (separate from deals - a
  // recurring item is a repeated obligation the user must explicitly
  // confirm each period, never a capital deployment with a return) ----
  const listRecurringItems = (opts) => selectAll('recurring_items', Object.assign({ order: { column: 'next_due_date' } }, opts));
  async function getRecurringItem(id) {
    // Same defense-in-depth self-scoping as getDeal above.
    const { data, error } = await client().from('recurring_items').select('*').eq('id', id).eq('user_id', uid()).single();
    check(error);
    return data;
  }
  async function createRecurringItem(row) {
    const item = await insertRow('recurring_items', row);
    await generateRecurringOccurrences(item.id);
    return item;
  }
  const updateRecurringItem = (id, patch) => updateRow('recurring_items', id, patch);
  const deleteRecurringItem = (id) => deleteRow('recurring_items', id);

  const listRecurringOccurrences = (opts) => selectAll('recurring_occurrences', Object.assign({ order: { column: 'scheduled_date' } }, opts));
  // Direct row insert for historical-occurrence import (Section 69/70) -
  // unlike fn_confirm_recurring_occurrence (which only updates an EXISTING
  // row), an imported history row is a brand-new occurrence with its
  // resolved status already known. The unique(recurring_item_id,
  // scheduled_date) constraint is what makes repeated imports idempotent.
  const createRecurringOccurrence = (row) => insertRow('recurring_occurrences', row);
  const updateRecurringOccurrence = (id, patch) => updateRow('recurring_occurrences', id, patch);
  async function generateRecurringOccurrences(recurringItemId) {
    const { data, error } = await client().rpc('fn_generate_recurring_occurrences', { p_recurring_item_id: recurringItemId });
    check(error);
    markLocalWrite();
    return data;
  }
  async function confirmRecurringOccurrence(p) {
    const { data, error } = await client().rpc('fn_confirm_recurring_occurrence', {
      p_occurrence_id: p.occurrenceId,
      p_actual_amount: p.actualAmount,
      p_paid_date: p.paidDate,
      p_status: p.status,
      p_payment_reference: p.paymentReference ?? null,
      p_payment_method: p.paymentMethod ?? null,
      p_notes: p.notes ?? null,
      p_actual_units: p.actualUnits ?? null,
      p_actual_nav: p.actualNav ?? null,
    });
    check(error);
    markLocalWrite();
    return data;
  }
  const skipRecurringOccurrence = (occurrenceId, reason) => confirmRecurringOccurrence({
    occurrenceId, actualAmount: 0, paidDate: new Date().toISOString().slice(0, 10), status: 'SKIPPED', notes: reason,
  });
  async function pauseRecurringItem(recurringItemId, pausedFrom, reason) {
    const { error } = await client().rpc('fn_pause_recurring_item', {
      p_recurring_item_id: recurringItemId, p_paused_from: pausedFrom || null, p_reason: reason || null,
    });
    check(error);
    markLocalWrite();
  }
  async function resumeRecurringItem(recurringItemId, resumeDate) {
    const { error } = await client().rpc('fn_resume_recurring_item', {
      p_recurring_item_id: recurringItemId, p_resume_date: resumeDate || null,
    });
    check(error);
    markLocalWrite();
  }

  async function getRecurringSummary(forUserId) {
    const { data, error } = await client().from('v_recurring_summary').select('*').eq('user_id', forUserId || uid()).maybeSingle();
    check(error);
    return data;
  }
  const listRecurringConsistency = (opts) => selectAll('v_recurring_consistency', opts);

  const listRecurringAmountHistory = (recurringItemId) => selectAll('recurring_amount_history', { eq: { recurring_item_id: recurringItemId }, order: { column: 'changed_at' } });
  const listRecurringScheduleHistory = (recurringItemId) => selectAll('recurring_schedule_history', { eq: { recurring_item_id: recurringItemId }, order: { column: 'changed_at' } });
  const listRecurringPauses = (recurringItemId) => selectAll('recurring_pauses', { eq: { recurring_item_id: recurringItemId }, order: { column: 'paused_from', ascending: false } });

  // ---- Contacts (deliberately separate from Deals/Recurring/Community/
  // Support - a personal address book, never portfolio data) ----
  const listContacts = (opts) => selectAll('contacts', Object.assign({ order: { column: 'display_name' } }, opts));
  async function getContact(id) {
    const { data, error } = await client().from('contacts').select('*').eq('id', id).single();
    check(error);
    return data;
  }
  const createContact = (row) => insertRow('contacts', row, { ownerCol: 'owner_user_id' });
  const updateContact = (id, patch) => updateRow('contacts', id, patch);
  const deleteContact = (id) => deleteRow('contacts', id);

  const listContactPhones = (contactId) => selectAll('contact_phones', { eq: { contact_id: contactId } });
  const createContactPhone = (row) => insertRow('contact_phones', row);
  const updateContactPhone = (id, patch) => updateRow('contact_phones', id, patch);
  const deleteContactPhone = (id) => deleteRow('contact_phones', id);

  const listContactEmails = (contactId) => selectAll('contact_emails', { eq: { contact_id: contactId } });
  const createContactEmail = (row) => insertRow('contact_emails', row);
  const updateContactEmail = (id, patch) => updateRow('contact_emails', id, patch);
  const deleteContactEmail = (id) => deleteRow('contact_emails', id);

  const listContactAddresses = (contactId) => selectAll('contact_addresses', { eq: { contact_id: contactId } });
  const createContactAddress = (row) => insertRow('contact_addresses', row);
  const updateContactAddress = (id, patch) => updateRow('contact_addresses', id, patch);
  const deleteContactAddress = (id) => deleteRow('contact_addresses', id);

  const listContactGroups = () => selectAll('contact_groups', { order: { column: 'name' } });
  const createContactGroup = (row) => insertRow('contact_groups', row);
  const updateContactGroup = (id, patch) => updateRow('contact_groups', id, patch);
  const deleteContactGroup = (id) => deleteRow('contact_groups', id);
  const listContactGroupMembers = (opts) => selectAll('contact_group_members', opts);
  const addContactToGroup = (groupId, contactId) => insertRow('contact_group_members', { group_id: groupId, contact_id: contactId });
  const removeContactFromGroup = (id) => deleteRow('contact_group_members', id);

  const listContactImportantDates = (contactId) => selectAll('contact_important_dates', { eq: { contact_id: contactId }, order: { column: 'date' } });
  const createContactImportantDate = (row) => insertRow('contact_important_dates', row);
  const updateContactImportantDate = (id, patch) => updateRow('contact_important_dates', id, patch);
  const deleteContactImportantDate = (id) => deleteRow('contact_important_dates', id);

  const listContactNotes = (contactId) => selectAll('contact_notes', { eq: { contact_id: contactId }, order: { column: 'created_at', ascending: false } });
  const createContactNote = (row) => insertRow('contact_notes', row);
  const deleteContactNote = (id) => deleteRow('contact_notes', id);

  const listContactReminders = (opts) => selectAll('contact_reminders', Object.assign({ order: { column: 'remind_at' } }, opts));
  const createContactReminder = (row) => insertRow('contact_reminders', row);
  const updateContactReminder = (id, patch) => updateRow('contact_reminders', id, patch);
  const deleteContactReminder = (id) => deleteRow('contact_reminders', id);

  async function getPrivacySettings() {
    const { data, error } = await client().from('user_privacy_settings').select('*').eq('user_id', uid()).maybeSingle();
    check(error);
    return data;
  }
  async function upsertPrivacySettings(patch) {
    const { data, error } = await client().from('user_privacy_settings')
      .upsert(Object.assign({ user_id: uid() }, patch), { onConflict: 'user_id' }).select().single();
    check(error);
    return data;
  }
  async function updateUsername(username) {
    return updateRow('profiles', uid(), { username }, 'id');
  }
  // Returns [] rather than a single result - a query might loosely match
  // nothing, and the RPC itself already returns zero rows whenever the
  // target's privacy settings prohibit discovery (see 016_contacts.sql).
  async function findPortfolioUser(query) {
    const { data, error } = await client().rpc('find_portfolio_user', { p_query: query });
    check(error);
    return (data && data[0]) || null;
  }

  const blockUser = (blockedId, reason) => insertRow('blocked_users', { blocked_id: blockedId, reason: reason || null }, { ownerCol: 'blocker_id' });
  const unblockUser = (id) => deleteRow('blocked_users', id);
  const listBlockedUsers = () => selectAll('blocked_users');
  const reportUser = (reportedId, reason, details) => insertRow('reported_users', { reported_id: reportedId, reason, details: details || null }, { ownerCol: 'reporter_id' });

  // ---- Private/Group Chat (deliberately separate from Community/Support) ----
  const listConversations = (opts) => selectAll('v_my_conversations', Object.assign({ order: { column: 'last_message_at', ascending: false } }, opts));
  async function getConversation(id) {
    const { data, error } = await client().from('conversations').select('*').eq('id', id).single();
    check(error);
    return data;
  }
  const listConversationMembers = (conversationId) => selectAll('conversation_members', { eq: { conversation_id: conversationId } });
  async function createConversation(row) {
    return insertRow('conversations', row, { ownerCol: 'created_by' });
  }
  const updateConversation = (id, patch) => updateRow('conversations', id, patch);
  const addConversationMember = (row) => insertRow('conversation_members', row);
  const updateConversationMember = (id, patch) => updateRow('conversation_members', id, patch);

  async function startDirectConversation(otherUserId) {
    // Reuse an existing DIRECT thread rather than creating a new one every
    // time "Message" is clicked - checked both ways (their membership rows,
    // then confirming I'm also on that same conversation) so this is
    // correct under real RLS and in the demo mock alike, rather than
    // relying on RLS to do the filtering for us.
    const theirRows = await selectAll('conversation_members', { eq: { user_id: otherUserId } });
    for (const row of theirRows) {
      const myRows = await selectAll('conversation_members', { eq: { conversation_id: row.conversation_id, user_id: uid() } });
      if (!myRows.length) continue;
      const conv = await getConversation(row.conversation_id).catch(() => null);
      if (conv && conv.type === 'DIRECT') return conv;
    }

    const conv = await createConversation({ type: 'DIRECT' });
    await addConversationMember({ conversation_id: conv.id, user_id: uid(), role: 'OWNER', history_visible_from: null });
    await addConversationMember({ conversation_id: conv.id, user_id: otherUserId, role: 'MEMBER', history_visible_from: null });
    return conv;
  }
  async function createGroupConversation(name, memberUserIds, historyVisibleFrom) {
    const conv = await createConversation({ type: 'GROUP', name });
    await addConversationMember({ conversation_id: conv.id, user_id: uid(), role: 'OWNER', history_visible_from: null });
    for (const otherId of memberUserIds) {
      await addConversationMember({ conversation_id: conv.id, user_id: otherId, role: 'MEMBER', history_visible_from: historyVisibleFrom ?? new Date().toISOString() });
    }
    return conv;
  }

  const listMessages = (opts) => selectAll('messages', Object.assign({ order: { column: 'created_at' } }, opts));
  async function sendMessage(row) {
    return insertRow('messages', row, { ownerCol: 'sender_id' });
  }
  const updateMessage = (id, patch) => updateRow('messages', id, patch);
  const softDeleteMessage = (id) => updateRow('messages', id, { deleted_at: new Date().toISOString(), status: 'DELETED' });
  const hideMessageForMe = (messageId) => insertRow('message_hidden_for_me', { message_id: messageId });
  const listHiddenForMe = (opts) => selectAll('message_hidden_for_me', opts);

  const listMessageAttachments = (messageId) => selectAll('message_attachments', { eq: { message_id: messageId } });
  const createMessageAttachment = (row) => insertRow('message_attachments', row);
  async function uploadChatAttachment(file, conversationId, messageId) {
    const path = `${conversationId}/${messageId}/${Date.now()}_${file.name}`;
    const { error: upErr } = await client().storage.from('chat-attachments').upload(path, file);
    check(upErr);
    return createMessageAttachment({
      message_id: messageId, storage_path: path, file_name: file.name, file_size_bytes: file.size, mime_type: file.type,
    });
  }
  async function getChatAttachmentUrl(storagePath) {
    const { data, error } = await client().storage.from('chat-attachments').createSignedUrl(storagePath, 300);
    check(error);
    return data.signedUrl;
  }

  const listMessageReactions = (messageId) => selectAll('message_reactions', { eq: { message_id: messageId } });
  async function setMessageReaction(messageId, reaction) {
    const { data, error } = await client().from('message_reactions')
      .upsert({ message_id: messageId, user_id: uid(), reaction }, { onConflict: 'message_id,user_id' }).select().single();
    check(error);
    return data;
  }
  const removeMessageReaction = (messageId) => client().from('message_reactions').delete().eq('message_id', messageId).eq('user_id', uid());

  const listMessageEdits = (messageId) => selectAll('message_edits', { eq: { message_id: messageId }, order: { column: 'edited_at' } });
  const markMessageRead = (messageId) => insertRow('message_reads', { message_id: messageId });
  const listMessageReads = (messageId) => selectAll('message_reads', { eq: { message_id: messageId } });

  async function shareMessages(sourceConversationId, targetConversationId, messageIds) {
    const { data, error } = await client().rpc('fn_share_messages', {
      p_source_conversation_id: sourceConversationId, p_target_conversation_id: targetConversationId, p_message_ids: messageIds,
    });
    check(error);
    return data || [];
  }

  function subscribeToMessages(conversationId, onInsert) {
    return client().channel('messages_' + conversationId)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, (payload) => onInsert(payload.new))
      .subscribe();
  }
  function subscribeToReactions(messageId, onChange) {
    return client().channel('reactions_' + messageId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions', filter: `message_id=eq.${messageId}` }, (payload) => onChange(payload))
      .subscribe();
  }

  // ---- Calling (1:1 only, best-effort WebRTC - see webrtc.js) ----
  async function initiateCall(receiverId, callType, conversationId) {
    return insertRow('calls', { receiver_id: receiverId, call_type: callType, conversation_id: conversationId || null, status: 'CALLING' }, { ownerCol: 'caller_id' });
  }
  const updateCall = (id, patch) => updateRow('calls', id, patch);
  const listCalls = (opts) => selectAll('calls', Object.assign({ order: { column: 'started_at', ascending: false } }, opts));
  function subscribeToIncomingCalls(onInsert) {
    return client().channel('incoming_calls_' + uid())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls', filter: `receiver_id=eq.${uid()}` }, (payload) => onInsert(payload.new))
      .subscribe();
  }
  function subscribeToCallUpdates(callId, onUpdate) {
    return client().channel('call_updates_' + callId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => onUpdate(payload.new))
      .subscribe();
  }
  // Ephemeral SDP/ICE signaling - never persisted, a plain broadcast channel
  // keyed by call id (see 018_calls_privacy.sql's header comment).
  function callSignalChannel(callId) {
    return client().channel('call_signal_' + callId, { config: { broadcast: { self: false } } });
  }

  // ---- Gold Intelligence (019_gold_intelligence.sql) - gold_providers/
  // gold_settings are global shared config (no user_id column at all, not
  // per-user), so they bypass insertRow/updateRow's owner-column injection
  // entirely via plain client() calls. gold_purchases/gold_alerts are
  // ordinary owner-only portfolio data and already in SELF_SCOPED_TABLES
  // above. ----
  const listGoldProviders = () => selectAll('gold_providers', { order: { column: 'display_name' } });
  async function createGoldProvider(row) {
    const { data, error } = await client().from('gold_providers').insert(row).select().single();
    check(error);
    return data;
  }
  async function updateGoldProvider(key, patch) {
    const { data, error } = await client().from('gold_providers').update(patch).eq('key', key).select().single();
    check(error);
    return data;
  }
  async function deleteGoldProvider(key) {
    const { error } = await client().from('gold_providers').delete().eq('key', key);
    check(error);
  }
  async function getGoldSettings() {
    const { data, error } = await client().from('gold_settings').select('*').eq('id', 1).maybeSingle();
    check(error);
    return data;
  }
  async function updateGoldSettings(patch) {
    const { data, error } = await client().from('gold_settings').update(patch).eq('id', 1).select().single();
    check(error);
    return data;
  }
  // refreshGoldPrice() invokes the gold-price-fetch Edge Function directly
  // from the signed-in user's own session - no service-role key involved on
  // this path at all, that only lives inside the function itself. Works
  // identically in Demo Mode via demoData.js's own `functions.invoke` stub.
  async function refreshGoldPrice() {
    const { data, error } = await client().functions.invoke('gold-price-fetch');
    check(error);
    return data;
  }
  const listGoldPriceObservations = (opts) => selectAll('gold_price_observations', Object.assign({ order: { column: 'observed_at', ascending: false } }, opts));
  async function getLatestGoldPrice(purity) {
    const rows = await selectAll('gold_price_observations', { eq: { purity }, order: { column: 'observed_at', ascending: false }, limit: 1 });
    return rows[0] || null;
  }
  const listGoldSchemeHoldings = (opts) => selectAll('v_gold_scheme_holdings', opts);
  const listGoldPurchases = (opts) => selectAll('gold_purchases', Object.assign({ order: { column: 'purchase_date', ascending: false } }, opts));
  const createGoldPurchase = (row) => insertRow('gold_purchases', row);
  const updateGoldPurchase = (id, patch) => updateRow('gold_purchases', id, patch);
  const deleteGoldPurchase = (id) => deleteRow('gold_purchases', id);
  const listGoldAlerts = (opts) => selectAll('gold_alerts', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  const createGoldAlert = (row) => insertRow('gold_alerts', row);
  const updateGoldAlert = (id, patch) => updateRow('gold_alerts', id, patch);
  const deleteGoldAlert = (id) => deleteRow('gold_alerts', id);

  // Automation Center (037) - notify-only user-configured rules.
  const listAutomationRules = (opts) => selectAll('automation_rules', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  const createAutomationRule = (row) => insertRow('automation_rules', row);
  const updateAutomationRule = (id, patch) => updateRow('automation_rules', id, patch);
  const deleteAutomationRule = (id) => deleteRow('automation_rules', id);

  // AI Portfolio Copilot (038) - context is assembled client-side (Net
  // Worth/Cash Flow have no server-side equivalent to call instead - see
  // aiCopilot.js) and sent alongside the question; the Edge Function never
  // queries anything itself beyond the usage-cap check.
  async function askCopilot(question, context) {
    const { data, error } = await client().functions.invoke('ai-copilot', { body: { question, context } });
    check(error);
    if (data && data.ok === false) throw Object.assign(new Error(data.error), { requestsUsed: data.requestsUsed, dailyLimit: data.dailyLimit });
    return data;
  }

  // AI Copilot provider selection (039) - mirrors gold_providers/gold_settings
  // exactly: global shared config (no user_id column), so plain client()
  // calls rather than insertRow/updateRow's owner-column injection.
  const listAiProviders = () => selectAll('ai_providers', { order: { column: 'display_name' } });
  async function createAiProvider(row) {
    const { data, error } = await client().from('ai_providers').insert(row).select().single();
    check(error);
    return data;
  }
  async function updateAiProvider(key, patch) {
    const { data, error } = await client().from('ai_providers').update(patch).eq('key', key).select().single();
    check(error);
    return data;
  }
  async function deleteAiProvider(key) {
    const { error } = await client().from('ai_providers').delete().eq('key', key);
    check(error);
  }
  async function getAiSettings() {
    const { data, error } = await client().from('ai_settings').select('*').eq('id', 1).maybeSingle();
    check(error);
    return data;
  }
  async function updateAiSettings(patch) {
    const { data, error } = await client().from('ai_settings').update(patch).eq('id', 1).select().single();
    check(error);
    return data;
  }

  // Accounts & Liabilities, and Net Worth (035_accounts_liabilities_net_worth.sql)
  const listAccounts = (opts) => selectAll('accounts', Object.assign({ order: { column: 'account_name', ascending: true } }, opts));
  const createAccount = (row) => insertRow('accounts', row);
  const updateAccount = (id, patch) => updateRow('accounts', id, patch);
  const deleteAccount = (id) => deleteRow('accounts', id);
  const listLiabilities = (opts) => selectAll('liabilities', Object.assign({ order: { column: 'liability_name', ascending: true } }, opts));
  const createLiability = (row) => insertRow('liabilities', row);
  const updateLiability = (id, patch) => updateRow('liabilities', id, patch);
  const deleteLiability = (id) => deleteRow('liabilities', id);
  const listNetWorthSnapshots = (opts) => selectAll('net_worth_snapshots', Object.assign({ order: { column: 'snapshot_date', ascending: true } }, opts));
  // Upsert-on-(user_id, snapshot_date) - the client always writes "today's"
  // snapshot, so a plain onConflict upsert (rather than a select-then-insert-
  // or-update round trip) is both simpler and race-free.
  async function upsertNetWorthSnapshot(row) {
    const cleaned = Object.assign({ user_id: uid() }, row);
    const { data, error } = await client().from('net_worth_snapshots').upsert(cleaned, { onConflict: 'user_id,snapshot_date' }).select().single();
    check(error);
    return data;
  }

  // ---- Web Push (023_web_push.sql) ----
  const listPushSubscriptions = () => selectAll('push_subscriptions', { eq: { user_id: uid() } });
  async function savePushSubscription(sub) {
    // A resubscribe on the same device reuses the same endpoint - upsert on
    // it rather than insert, so re-enabling push after disabling it doesn't
    // pile up dead rows for the same browser.
    const { data, error } = await client().from('push_subscriptions')
      .upsert({ user_id: uid(), endpoint: sub.endpoint, p256dh: sub.p256dh, auth_key: sub.authKey, user_agent: navigator.userAgent }, { onConflict: 'endpoint' })
      .select().single();
    check(error);
    return data;
  }
  const deletePushSubscriptionByEndpoint = (endpoint) => client().from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', uid());

  // ---- Admin user management (024) - one Edge Function, one invoke
  // wrapper per action. The service-role key never touches the browser;
  // this just forwards the admin's own session token, which the function
  // re-verifies itself before doing anything privileged. ----
  async function adminCreateUser(email, fullName) {
    const { data, error } = await client().functions.invoke('admin-user-management', { body: { action: 'create', email, fullName } });
    check(error);
    if (data && data.ok === false) throw new Error(data.error);
    return data;
  }
  async function adminSetUserActive(userId, active) {
    const { data, error } = await client().functions.invoke('admin-user-management', { body: { action: active ? 'reactivate' : 'deactivate', userId } });
    check(error);
    if (data && data.ok === false) throw new Error(data.error);
    return data;
  }
  async function adminDeleteUser(userId, confirmEmail) {
    const { data, error } = await client().functions.invoke('admin-user-management', { body: { action: 'delete', userId, confirmEmail } });
    check(error);
    if (data && data.ok === false) throw new Error(data.error);
    return data;
  }

  // ---- Database Health (025) ----
  async function getAdminTableStats() {
    const { data, error } = await client().rpc('fn_admin_table_stats');
    check(error);
    return data || [];
  }

  // ---- Shared portfolios / peer viewing (024) - shared_portfolios isn't
  // (and shouldn't be) in SELF_SCOPED_TABLES: its own RLS select policy
  // already returns exactly the right set with no client-side filter at
  // all ("owns it" OR "is a member of it" OR "is admin") - unlike
  // deals/recurring_items, there's no scenario where an unfiltered query
  // here leaks a different user's rows into "my own" view, since ownership/
  // membership IS the visibility rule, not an approximation of it. Admin
  // manages these directly on any owner's behalf; a regular owner only
  // ever manages their own - both paths are the same table, RLS decides
  // which rows a given call can actually touch. ----
  const listSharedPortfolios = (opts) => selectAll('shared_portfolios', Object.assign({ order: { column: 'created_at' } }, opts));
  const createSharedPortfolio = (row) => client().from('shared_portfolios').insert(row).select().single().then(({ data, error }) => { check(error); return data; });
  const updateSharedPortfolio = (id, patch) => updateRow('shared_portfolios', id, patch);
  const deleteSharedPortfolio = (id) => deleteRow('shared_portfolios', id);
  const listPortfolioMembers = (portfolioId) => selectAll('portfolio_members', { eq: { portfolio_id: portfolioId } });
  const addPortfolioMember = (row) => client().from('portfolio_members').insert(row).select().single().then(({ data, error }) => { check(error); return data; });
  const removePortfolioMember = (id) => deleteRow('portfolio_members', id);
  // "Shared With Me" - portfolios I'm a member of and are currently
  // switched on; same "RLS already returns exactly the right set" reasoning
  // as above.
  const listPortfoliosSharedWithMe = () => selectAll('shared_portfolios').then((rows) => rows.filter((p) => p.is_active));

  // ---- Benchmark Comparison (026) ----
  const listBenchmarkObservations = (symbol) => selectAll('benchmark_observations', { eq: { symbol }, order: { column: 'observed_date' } });
  async function refreshBenchmarkData() {
    const { data, error } = await client().functions.invoke('benchmark-fetch');
    check(error);
    return data;
  }

  // ---- Login analytics (027) - login_events has no SELECT policy for a
  // regular user at all (027's own RLS), so this simply returns nothing for
  // anyone but admin - no client-side filter needed or possible. logLogin()
  // is called once per sign-in from app.js, after consent is already
  // decided. ----
  const listLoginEvents = (opts) => selectAll('login_events', Object.assign({ order: { column: 'occurred_at', ascending: false } }, opts));
  async function logLogin(consent) {
    const { data, error } = await client().functions.invoke('log-login', { body: { consent, userAgent: navigator.userAgent } });
    check(error);
    return data;
  }

  // ---- Notification type preferences (032) - one row per (user, type),
  // only ever written the first time a user flips a channel off for that
  // type; absence of a row means every channel stays enabled (see the
  // migration's own header comment). SELF_SCOPED_TABLES doesn't need this
  // table - its RLS is plain owner-only with no admin bypass to guard
  // against, same shape as notification_preferences itself. ----
  const listNotificationTypePreferences = () => selectAll('notification_type_preferences');
  async function upsertNotificationTypePreference(type, patch) {
    const { data, error } = await client().from('notification_type_preferences')
      .upsert(Object.assign({ user_id: uid(), type }, patch), { onConflict: 'user_id,type' }).select().single();
    check(error);
    return data;
  }

  // ---- Clear My Data / Clear All Portfolio Data (032) ----
  // Storage objects (documents.storage_path) are never removed by SQL - the
  // migration's own DELETE cascade only removes the metadata rows. This
  // recursively lists everything under the caller's own folder (Storage's
  // `.list()` returns one level at a time, folders showing up as entries
  // with `id: null`, so nested paths like `{uid}/expense/{projectId}/file`
  // need walking down) and removes it. Best-effort: the metadata rows are
  // already gone either way, so a Storage failure here is swallowed rather
  // than left as a scary error after the actual data-clearing already
  // succeeded.
  async function listStorageFilesRecursive(bucket, prefix) {
    const { data, error } = await client().storage.from(bucket).list(prefix);
    if (error || !data) return [];
    let files = [];
    for (const entry of data) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) files = files.concat(await listStorageFilesRecursive(bucket, fullPath));
      else files.push(fullPath);
    }
    return files;
  }
  async function clearMyData() {
    const { error } = await client().rpc('fn_clear_my_data');
    check(error);
    try {
      const files = await listStorageFilesRecursive('documents', uid());
      if (files.length) await client().storage.from('documents').remove(files);
    } catch (e) { /* metadata is already gone either way - a Storage cleanup failure isn't worth surfacing as an error here */ }
  }
  async function adminClearAllData() {
    const { error } = await client().rpc('fn_admin_clear_all_data');
    check(error);
  }

  // ---- Blog / Knowledge Sharing (028) ----
  const listBlogPosts = (opts) => selectAll('blog_posts', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  const getBlogPost = (id) => client().from('blog_posts').select('*').eq('id', id).single().then(({ data, error }) => { check(error); return data; });
  const createBlogPost = (row) => insertRow('blog_posts', row, { ownerCol: 'author_user_id' });
  const updateBlogPost = (id, patch) => updateRow('blog_posts', id, patch);
  const deleteBlogPost = (id) => deleteRow('blog_posts', id);
  const listBlogComments = (postId) => selectAll('blog_comments', { eq: { post_id: postId }, order: { column: 'created_at' } });
  const createBlogComment = (row) => insertRow('blog_comments', row, { ownerCol: 'author_user_id' });
  const deleteBlogComment = (id) => deleteRow('blog_comments', id);

  // ---- Expense & Project Cost Management (031_expense_projects.sql) -
  // a generic Project -> Category -> Budget -> Transaction -> Vendor
  // engine, not a "Home Expenses" tab; Home Construction is just the
  // first project a user happens to create. ----
  const listExpenseProjects = (opts) => selectAll('expense_projects', Object.assign({ order: { column: 'created_at', ascending: false } }, opts));
  const getExpenseProject = (id) => client().from('expense_projects').select('*').eq('id', id).single().then(({ data, error }) => { check(error); return data; });
  const createExpenseProject = (row) => insertRow('expense_projects', row);
  const updateExpenseProject = (id, patch) => updateRow('expense_projects', id, patch);
  const deleteExpenseProject = (id) => deleteRow('expense_projects', id);

  const listExpenseCategories = (projectId) => selectAll('expense_categories', { eq: { project_id: projectId }, order: { column: 'sort_order' } });
  const createExpenseCategory = (row) => insertRow('expense_categories', row);
  const updateExpenseCategory = (id, patch) => updateRow('expense_categories', id, patch);
  const deleteExpenseCategory = (id) => deleteRow('expense_categories', id);

  const listExpenseVendors = (opts) => selectAll('expense_vendors', Object.assign({ order: { column: 'name' } }, opts));
  const getExpenseVendor = (id) => client().from('expense_vendors').select('*').eq('id', id).single().then(({ data, error }) => { check(error); return data; });
  const createExpenseVendor = (row) => insertRow('expense_vendors', row);
  const updateExpenseVendor = (id, patch) => updateRow('expense_vendors', id, patch);
  const deleteExpenseVendor = (id) => deleteRow('expense_vendors', id);

  const listExpenseAdvances = (opts) => selectAll('expense_advances', Object.assign({ order: { column: 'date_paid', ascending: false } }, opts));
  const createExpenseAdvance = (row) => insertRow('expense_advances', row);
  const updateExpenseAdvance = (id, patch) => updateRow('expense_advances', id, patch);
  const deleteExpenseAdvance = (id) => deleteRow('expense_advances', id);

  const listExpenseTransactions = (opts) => selectAll('expense_transactions', Object.assign({ order: { column: 'transaction_date', ascending: false } }, opts));
  const getExpenseTransaction = (id) => client().from('expense_transactions').select('*').eq('id', id).single().then(({ data, error }) => { check(error); return data; });
  const createExpenseTransaction = (row) => insertRow('expense_transactions', row);
  const updateExpenseTransaction = (id, patch) => updateRow('expense_transactions', id, patch);
  const deleteExpenseTransaction = (id) => deleteRow('expense_transactions', id);

  // Purely a saved-values template for one-click quick-entry - no
  // generation function, no cron involvement (see the plan's resolved
  // scope decision: recurring BILLS stay in the Recurring Investments
  // module, this is only for a project's own repeated line items).
  const listExpenseRecurringTemplates = (projectId) => selectAll('expense_recurring_templates', { eq: { project_id: projectId } });
  const createExpenseRecurringTemplate = (row) => insertRow('expense_recurring_templates', row);
  const deleteExpenseRecurringTemplate = (id) => deleteRow('expense_recurring_templates', id);

  const listExpenseCustomFields = (projectId) => selectAll('expense_project_custom_fields', { eq: { project_id: projectId }, order: { column: 'sort_order' } });
  const createExpenseCustomField = (row) => insertRow('expense_project_custom_fields', row);
  const updateExpenseCustomField = (id, patch) => updateRow('expense_project_custom_fields', id, patch);
  const deleteExpenseCustomField = (id) => deleteRow('expense_project_custom_fields', id);

  // expense_transaction_custom_values has no user_id of its own (ownership
  // is derived through its parent transaction, per the RLS policy) - a
  // plain client().from() call, not selectAll/insertRow's owner-injection.
  const listExpenseCustomValues = (transactionId) => client().from('expense_transaction_custom_values').select('*').eq('transaction_id', transactionId).then(({ data, error }) => { check(error); return data || []; });
  async function upsertExpenseCustomValue(transactionId, customFieldId, value) {
    const { data, error } = await client().from('expense_transaction_custom_values')
      .upsert({ transaction_id: transactionId, custom_field_id: customFieldId, value }, { onConflict: 'transaction_id,custom_field_id' })
      .select().single();
    check(error);
    return data;
  }

  async function getExpenseProjectSummary(projectId) {
    const { data, error } = await client().from('v_expense_project_summary').select('*').eq('project_id', projectId).maybeSingle();
    check(error);
    return data;
  }
  const listExpenseCategorySummary = (projectId) => selectAll('v_expense_category_summary', { eq: { project_id: projectId } });
  const listExpenseVendorSummary = (opts) => selectAll('v_expense_vendor_summary', opts);

  // Reuses the existing `documents` table/bucket/RLS as-is (011_storage.sql)
  // - not a new parallel attachment system - just a different owning FK
  // and folder-path segment.
  async function uploadExpenseAttachment(file, meta) {
    const path = `${uid()}/expense/${meta.projectId || 'general'}/${Date.now()}_${file.name}`;
    const { error: upErr } = await client().storage.from('documents').upload(path, file);
    check(upErr);
    return insertRow('documents', {
      expense_transaction_id: meta.transactionId || null,
      document_type: meta.documentType || 'Other',
      document_reference: meta.documentReference || null,
      document_date: meta.documentDate || null,
      notes: meta.notes || null,
      storage_path: path,
      file_name: file.name,
      file_size_bytes: file.size,
      mime_type: file.type,
    });
  }

  return {
    getProfile, updateProfile, listAllProfiles,
    listPlatforms, createPlatform, updatePlatform, deletePlatform,
    listCategories, createCategory, listRiskRatings, createRiskRating,
    listDeals, getDeal, createDeal, updateDeal, deleteDeal, listDealMetrics, getPortfolioSummary,
    listSchedule, createScheduleRow, updateScheduleRow, deleteScheduleRow, generateSchedule,
    listPayments, recordPayment, voidPayment,
    listReinvestments, updateReinvestment,
    listNotifications, markNotificationRead, markAllNotificationsRead, getPreferences, upsertPreferences,
    sendPendingNotificationEmails, sendPendingWebPush,
    listCalendarEvents, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent,
    getAppSettings, updateAppSettings,
    listDocuments, uploadDocument, getDocumentUrl, deleteDocument,
    listAuditLogs, listImports, createImport, updateImport,
    listGoals, createGoal, updateGoal, listCashTransactions, createCashTransaction,
    listTaxRecords, createTaxRecord, updateTaxRecord,
    listInsights, dismissInsight, listScenarios, saveScenario, deleteScenario,
    listIntegrations, upsertIntegration,
    listBankTransactions, createBankTransaction, markBankTransactionMatched,
    listPaymentMatches, createPaymentMatch, updatePaymentMatch,
    listCommunityMessages, postCommunityMessage, subscribeToCommunityMessages,
    listNotes, createNote, updateNote, deleteNote,
    listTickets, getTicket, createTicket, updateTicketStatus, listTicketMessages, postTicketMessage, subscribeToTicketMessages,
    updateTicketCategory, updateTicketPriority, updateTicketAssignment, rateTicketResolution, submitGuestTicket,
    listTicketInternalNotes, createTicketInternalNote,
    listFeatureSuggestions, getFeatureSuggestion, createFeatureSuggestion, updateFeatureSuggestion,
    listSuggestionInternalNotes, createSuggestionInternalNote, listSuggestionVoteCounts, listMyVotes,
    voteSuggestion, unvoteSuggestion,
    getDisplayNames, subscribeToNotifications, unsubscribe, runAutomationNow, subscribeToPortfolioChanges,
    listRecurringItems, getRecurringItem, createRecurringItem, updateRecurringItem, deleteRecurringItem,
    listRecurringOccurrences, createRecurringOccurrence, updateRecurringOccurrence, generateRecurringOccurrences, confirmRecurringOccurrence, skipRecurringOccurrence,
    pauseRecurringItem, resumeRecurringItem, getRecurringSummary, listRecurringConsistency,
    listRecurringAmountHistory, listRecurringScheduleHistory, listRecurringPauses,
    listContacts, getContact, createContact, updateContact, deleteContact,
    listContactPhones, createContactPhone, updateContactPhone, deleteContactPhone,
    listContactEmails, createContactEmail, updateContactEmail, deleteContactEmail,
    listContactAddresses, createContactAddress, updateContactAddress, deleteContactAddress,
    listContactGroups, createContactGroup, updateContactGroup, deleteContactGroup,
    listContactGroupMembers, addContactToGroup, removeContactFromGroup,
    listContactImportantDates, createContactImportantDate, updateContactImportantDate, deleteContactImportantDate,
    listContactNotes, createContactNote, deleteContactNote,
    listContactReminders, createContactReminder, updateContactReminder, deleteContactReminder,
    getPrivacySettings, upsertPrivacySettings, updateUsername, findPortfolioUser,
    blockUser, unblockUser, listBlockedUsers, reportUser,
    listConversations, getConversation, listConversationMembers, createConversation, updateConversation,
    addConversationMember, updateConversationMember, startDirectConversation, createGroupConversation,
    listMessages, sendMessage, updateMessage, softDeleteMessage, hideMessageForMe, listHiddenForMe,
    listMessageAttachments, createMessageAttachment, uploadChatAttachment, getChatAttachmentUrl,
    listMessageReactions, setMessageReaction, removeMessageReaction,
    listMessageEdits, markMessageRead, listMessageReads, shareMessages,
    subscribeToMessages, subscribeToReactions,
    initiateCall, updateCall, listCalls, subscribeToIncomingCalls, subscribeToCallUpdates, callSignalChannel,
    listGoldProviders, createGoldProvider, updateGoldProvider, deleteGoldProvider,
    getGoldSettings, updateGoldSettings, refreshGoldPrice,
    listGoldPriceObservations, getLatestGoldPrice, listGoldSchemeHoldings,
    listGoldPurchases, createGoldPurchase, updateGoldPurchase, deleteGoldPurchase,
    listGoldAlerts, createGoldAlert, updateGoldAlert, deleteGoldAlert,
    listPushSubscriptions, savePushSubscription, deletePushSubscriptionByEndpoint,
    adminCreateUser, adminSetUserActive, adminDeleteUser, getAdminTableStats,
    listSharedPortfolios, createSharedPortfolio, updateSharedPortfolio, deleteSharedPortfolio,
    listPortfolioMembers, addPortfolioMember, removePortfolioMember, listPortfoliosSharedWithMe,
    listBenchmarkObservations, refreshBenchmarkData,
    listLoginEvents, logLogin,
    listNotificationTypePreferences, upsertNotificationTypePreference,
    clearMyData, adminClearAllData,
    listBlogPosts, getBlogPost, createBlogPost, updateBlogPost, deleteBlogPost,
    listBlogComments, createBlogComment, deleteBlogComment,
    listExpenseProjects, getExpenseProject, createExpenseProject, updateExpenseProject, deleteExpenseProject,
    listExpenseCategories, createExpenseCategory, updateExpenseCategory, deleteExpenseCategory,
    listExpenseVendors, getExpenseVendor, createExpenseVendor, updateExpenseVendor, deleteExpenseVendor,
    listExpenseAdvances, createExpenseAdvance, updateExpenseAdvance, deleteExpenseAdvance,
    listExpenseTransactions, getExpenseTransaction, createExpenseTransaction, updateExpenseTransaction, deleteExpenseTransaction,
    listExpenseRecurringTemplates, createExpenseRecurringTemplate, deleteExpenseRecurringTemplate,
    listExpenseCustomFields, createExpenseCustomField, updateExpenseCustomField, deleteExpenseCustomField,
    listExpenseCustomValues, upsertExpenseCustomValue,
    getExpenseProjectSummary, listExpenseCategorySummary, listExpenseVendorSummary,
    uploadExpenseAttachment,
    listAccounts, createAccount, updateAccount, deleteAccount,
    listLiabilities, createLiability, updateLiability, deleteLiability,
    listNetWorthSnapshots, upsertNetWorthSnapshot,
    restoreInsertRow,
    listAutomationRules, createAutomationRule, updateAutomationRule, deleteAutomationRule,
    askCopilot,
    listAiProviders, createAiProvider, updateAiProvider, deleteAiProvider,
    getAiSettings, updateAiSettings,
  };
})();
