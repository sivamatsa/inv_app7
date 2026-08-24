/* Demo Mode: an in-memory stand-in for Supabase so the whole app can be
   explored with sample data and zero setup - no project, no signup. Entered
   from the auth screen's "Try Demo" link (see app.js); everything here
   resets on reload, and nothing in it is ever real financial data.

   This implements the same subset of the supabase-js surface that
   js/data/api.js calls against (from/select/insert/update/delete/upsert/rpc,
   auth, storage), plus enough Postgres-feature simulation (generated
   columns on reinvestments, the audit trigger) that the views relying on
   them don't look broken in a walkthrough. */
window.App = window.App || {};

App.demo = (function () {
  const DB = {
    profiles: [], platforms: [], deals: [], payment_schedule: [], payments: [], reinvestments: [],
    notifications: [], notification_preferences: [], documents: [], audit_logs: [], imports: [],
    portfolio_goals: [], cash_transactions: [], investment_categories: [], risk_ratings: [],
    bank_transactions: [], payment_matches: [], tax_records: [], ai_insights: [], scenario_simulations: [],
    integration_configs: [], community_messages: [], notes: [], support_tickets: [], ticket_messages: [],
    recurring_items: [], recurring_occurrences: [], recurring_amount_history: [],
    recurring_schedule_history: [], recurring_pauses: [],
    contacts: [], contact_phones: [], contact_emails: [], contact_addresses: [],
    contact_groups: [], contact_group_members: [], contact_important_dates: [],
    contact_notes: [], contact_reminders: [], user_privacy_settings: [],
    blocked_users: [], reported_users: [],
    conversations: [], conversation_members: [], messages: [], message_attachments: [],
    message_reactions: [], message_edits: [], message_reads: [], message_hidden_for_me: [],
    shared_message_batches: [], shared_message_items: [], calls: [],
    gold_providers: [], gold_settings: [], gold_price_observations: [], gold_purchases: [], gold_alerts: [],
    calendar_events: [], app_settings: [],
    push_subscriptions: [], shared_portfolios: [], portfolio_members: [],
    benchmark_observations: [], login_events: [], blog_posts: [], blog_comments: [],
    expense_projects: [], expense_categories: [], expense_vendors: [], expense_advances: [],
    expense_transactions: [], expense_recurring_templates: [], expense_project_custom_fields: [],
    expense_transaction_custom_values: [],
    notification_type_preferences: [],
    ticket_internal_notes: [], feature_suggestions: [], suggestion_internal_notes: [], suggestion_votes: [],
    accounts: [], liabilities: [], net_worth_snapshots: [],
    automation_rules: [], copilot_usage: [], ai_providers: [], ai_settings: [],
  };
  const counters = {};
  function genId(table) { counters[table] = (counters[table] || 0) + 1; return counters[table]; }
  const DEMO_USER = { id: 'demo-user', email: 'demo@example.com' };
  const nowIso = () => new Date().toISOString();

  // ---- minimal realtime simulation: enough for community/ticket chat and
  // the notification badge to feel "live" while exploring the demo, without
  // an actual websocket. Real Supabase Realtime is what the app talks to
  // outside of demo mode; see supabaseClient.js/api.js. ----
  const channelListeners = []; // { table, event, filterCol, filterVal, cb }
  // event matters now (Contacts/Chat/Calls is the first module needing
  // UPDATE-driven realtime, e.g. call status changes) - every earlier
  // subscription in this app (notifications/community/tickets) only ever
  // used INSERT, so this previously didn't need to distinguish event types.
  function fireChannelListeners(table, eventType, row) {
    channelListeners
      .filter((l) => l.table === table && (l.event === '*' || l.event === eventType)
        && (!l.filterCol || String(row[l.filterCol]) === String(l.filterVal)))
      .forEach((l) => setTimeout(() => l.cb({ new: row, eventType }), 10));
  }
  // Broadcast (used by webrtc.js's SDP/ICE signaling) is scoped to the
  // channel NAME, not a table - every subscriber to the same name receives
  // every send(), same as real Supabase Realtime broadcast.
  const broadcastListenersByName = {}; // name -> [{ event, cb }]
  function makeChannel(name) {
    const registered = [];
    const broadcastRegistered = [];
    const handle = {
      on(event, opts, cb) {
        if (event === 'broadcast') {
          const entry = { event: opts.event, cb };
          (broadcastListenersByName[name] = broadcastListenersByName[name] || []).push(entry);
          broadcastRegistered.push(entry);
          return handle;
        }
        let filterCol = null, filterVal = null;
        if (opts.filter) { const [col, val] = opts.filter.split(/=eq\.|=/); filterCol = col; filterVal = val; }
        const entry = { table: opts.table, event: opts.event || '*', filterCol, filterVal, cb };
        channelListeners.push(entry);
        registered.push(entry);
        return handle;
      },
      send(msg) {
        if (msg.type === 'broadcast') {
          const listeners = broadcastListenersByName[name] || [];
          listeners.filter((l) => l.event === msg.event).forEach((l) => setTimeout(() => l.cb({ payload: msg.payload, event: msg.event }), 10));
        }
        return Promise.resolve('ok');
      },
      subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 5); return handle; },
      _registered: registered,
      _broadcastRegistered: broadcastRegistered,
      _name: name,
    };
    return handle;
  }
  function removeChannel(handle) {
    if (!handle) return;
    (handle._registered || []).forEach((entry) => {
      const idx = channelListeners.indexOf(entry);
      if (idx >= 0) channelListeners.splice(idx, 1);
    });
    (handle._broadcastRegistered || []).forEach((entry) => {
      const list = broadcastListenersByName[handle._name] || [];
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
    });
  }

  function matchesRow(row, f) {
    for (const [k, v] of Object.entries(f.eq)) if (row[k] !== v) return false;
    for (const [k, v] of Object.entries(f.in)) if (!v.includes(row[k])) return false;
    for (const [k, v] of Object.entries(f.gte)) if (!(row[k] >= v)) return false;
    for (const [k, v] of Object.entries(f.lte)) if (!(row[k] <= v)) return false;
    for (const [k, v] of Object.entries(f.is)) if (!(v === null ? (row[k] === null || row[k] === undefined) : row[k] === v)) return false;
    return true;
  }

  // Mirrors contacts.full_name (a real generated column, 016_contacts.sql)
  // and the default_contact_display_name trigger (display_name falls back
  // to full_name only when left blank).
  function recomputeContactColumns(row) {
    row.full_name = [row.first_name, row.middle_name, row.last_name].filter((s) => s).join(' ');
  }
  function applyContactDisplayNameDefault(row) {
    if (!row.display_name) row.display_name = row.full_name || null;
  }

  // Mirrors the real reinvestments generated columns (004_payment_engine.sql)
  // - recomputed whenever the underlying columns change, same as Postgres
  // would do automatically.
  function recomputeReinvestmentColumns(row) {
    if (row.reinvestment_date && row.returned_date) {
      row.reinvestment_delay_days = Math.round((new Date(row.reinvestment_date) - new Date(row.returned_date)) / 86400000);
      row.same_day_reinvestment = row.reinvestment_delay_days === 0;
    } else {
      row.reinvestment_delay_days = null;
      row.same_day_reinvestment = false;
    }
    row.reinvestment_ratio = (row.returned_amount && row.reinvested_amount != null)
      ? Math.round((row.reinvested_amount / row.returned_amount) * 10000) / 10000 : null;
  }

  // Mirrors audit_row_change() (006_audit_imports.sql): one row per changed
  // field on UPDATE, one summary row on INSERT.
  const AUDITED_TABLES = new Set(['deals', 'payments', 'payment_schedule', 'reinvestments', 'recurring_items', 'recurring_occurrences']);
  function auditHistoryEnabled() { return !DB.app_settings[0] || DB.app_settings[0].audit_history_enabled !== false; }
  function auditInsert(table, row) {
    if (!AUDITED_TABLES.has(table) || !auditHistoryEnabled()) return;
    DB.audit_logs.push({ id: genId('audit_logs'), user_id: row.user_id, table_name: table, record_id: row.id, action: 'INSERT', field_name: null, old_value: null, new_value: JSON.stringify(row), source: 'system', changed_at: nowIso() });
  }
  function auditUpdate(table, before, after) {
    if (!AUDITED_TABLES.has(table) || !auditHistoryEnabled()) return;
    Object.keys(after).forEach((key) => {
      if (key === 'updated_at' || key === 'created_at') return;
      const oldVal = before[key], newVal = after[key];
      if (oldVal === newVal) return;
      DB.audit_logs.push({ id: genId('audit_logs'), user_id: after.user_id, table_name: table, record_id: after.id, action: 'UPDATE', field_name: key, old_value: oldVal == null ? null : String(oldVal), new_value: newVal == null ? null : String(newVal), source: 'system', changed_at: nowIso() });
    });
  }

  class QB {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = { eq: {}, in: {}, gte: {}, lte: {}, is: {} }; }
    eq(k, v) { this.filters.eq[k] = v; return this; }
    in(k, v) { this.filters.in[k] = v; return this; }
    gte(k, v) { this.filters.gte[k] = v; return this; }
    lte(k, v) { this.filters.lte[k] = v; return this; }
    is(k, v) { this.filters.is[k] = v; return this; }
    order(col, opts) { this._order = { col, asc: !opts || opts.ascending !== false }; return this; }
    limit(n) { this._limit = n; return this; }
    select() { return this; }
    single() { this._single = true; return this._exec(); }
    maybeSingle() { this._maybeSingle = true; return this._exec(); }
    insert(row) { this.op = 'insert'; this._payload = row; return this; }
    update(patch) { this.op = 'update'; this._payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    upsert(row, opts) { this.op = 'upsert'; this._payload = row; this._onConflict = opts && opts.onConflict; return this; }
    then(resolve, reject) { return this._exec().then(resolve, reject); }
    async _exec() {
      await new Promise((r) => setTimeout(r, 15));
      if (VIRTUAL_TABLES[this.table] && this.op === 'select') {
        const rows = VIRTUAL_TABLES[this.table]().filter((r) => matchesRow(r, this.filters));
        if (this._single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'No rows found' } };
        if (this._maybeSingle) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }
      const table = DB[this.table] || (DB[this.table] = []);
      if (this.op === 'select') {
        let rows = table.filter((r) => matchesRow(r, this.filters));
        if (this._order) rows = rows.slice().sort((a, b) => {
          const av = a[this._order.col], bv = b[this._order.col];
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (this._order.asc ? 1 : -1);
        });
        if (this._limit) rows = rows.slice(0, this._limit);
        if (this._single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'No rows found' } };
        if (this._maybeSingle) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }
      if (this.op === 'insert') {
        const rows = Array.isArray(this._payload) ? this._payload : [this._payload];
        const inserted = rows.map((r) => {
          if (this.table === 'recurring_occurrences') {
            // Mirrors the real unique(recurring_item_id, scheduled_date)
            // constraint (015_recurring.sql) - keeps repeated Recurring
            // History imports idempotent in Demo Mode too.
            const dupe = table.find((x) => x.recurring_item_id === r.recurring_item_id && x.scheduled_date === r.scheduled_date);
            if (dupe) throw new Error('duplicate key value violates unique constraint (this occurrence already exists for that date)');
          }
          const row = Object.assign({ id: genId(this.table), created_at: nowIso(), updated_at: nowIso() }, r);
          if (this.table === 'reinvestments') recomputeReinvestmentColumns(row);
          if (this.table === 'support_tickets') {
            // Mirrors the real schema (034_help_support_suggestions.sql):
            // status defaults to 'New' (the old 4-value lifecycle's 'Open'
            // was remapped there), category/priority default too, and
            // ticket_number is a generated column derived from id.
            if (row.status === undefined) row.status = 'New';
            if (row.category === undefined) row.category = 'General Question';
            if (row.priority === undefined) row.priority = 'Medium';
            row.ticket_number = 'TKT-' + String(row.id).padStart(5, '0');
          }
          if (this.table === 'feature_suggestions') {
            row.suggestion_number = 'SUG-' + String(row.id).padStart(5, '0');
            if (row.priority === undefined) row.priority = 'Medium';
            if (row.status === undefined) row.status = 'Submitted';
            if (row.notify_on_implement === undefined) row.notify_on_implement = true;
          }
          if (this.table === 'ticket_messages' && row.is_admin_reply === undefined) row.is_admin_reply = false;
          if (this.table === 'contacts') {
            row.tags = row.tags || [];
            row.interests = row.interests || [];
            row.custom_fields = row.custom_fields || {};
            row.favorite = !!row.favorite;
            recomputeContactColumns(row);
            applyContactDisplayNameDefault(row);
          }
          if (this.table === 'conversation_members') {
            row.role = row.role || 'MEMBER';
            row.archived = !!row.archived;
            row.pinned = !!row.pinned;
            if (row.history_visible_from === undefined) row.history_visible_from = nowIso();
          }
          if (this.table === 'messages') {
            row.message_type = row.message_type || 'TEXT';
            row.status = row.status || 'SENT';
          }
          if (this.table === 'calls') {
            row.status = row.status || 'CALLING';
          }
          if (this.table === 'automation_rules' && row.is_active === undefined) {
            row.is_active = true;
          }
          if (this.table === 'gold_providers') {
            if (row.requests_used_this_period === undefined) row.requests_used_this_period = 0;
            if (row.last_fetch_status === undefined) row.last_fetch_status = 'never';
          }
          if (this.table === 'ai_providers' && row.last_status === undefined) {
            row.last_status = 'never';
          }
          table.push(row);
          auditInsert(this.table, row);
          fireChannelListeners(this.table, 'INSERT', row);
          return row;
        });
        return this._single ? { data: inserted[0], error: null } : { data: inserted, error: null };
      }
      if (this.op === 'update') {
        const rows = table.filter((r) => matchesRow(r, this.filters));
        rows.forEach((r) => {
          const before = Object.assign({}, r);
          Object.assign(r, this._payload, { updated_at: nowIso() });
          if (this.table === 'reinvestments') recomputeReinvestmentColumns(r);
          if (this.table === 'recurring_items') trackRecurringChanges(before, r);
          if (this.table === 'contacts') recomputeContactColumns(r);
          auditUpdate(this.table, before, r);
          fireChannelListeners(this.table, 'UPDATE', r);
        });
        return this._single ? { data: rows[0], error: null } : { data: rows, error: null };
      }
      if (this.op === 'delete') {
        const toDelete = table.filter((r) => matchesRow(r, this.filters));
        const toDeleteSet = new Set(toDelete);
        DB[this.table] = table.filter((r) => !toDeleteSet.has(r));
        toDelete.forEach((r) => fireChannelListeners(this.table, 'DELETE', r));
        return { data: null, error: null };
      }
      if (this.op === 'upsert') {
        const keys = this._onConflict ? this._onConflict.split(',') : ['id'];
        let existing = table.find((r) => keys.every((k) => r[k] === this._payload[k]));
        if (existing) Object.assign(existing, this._payload, { updated_at: nowIso() });
        else { existing = Object.assign({ id: genId(this.table), created_at: nowIso(), updated_at: nowIso() }, this._payload); table.push(existing); }
        return { data: existing, error: null };
      }
    }
  }

  // ---- virtual "tables" mirroring the real SQL views (008_views.sql) ----
  const VIRTUAL_TABLES = {
    v_deal_metrics: () => DB.deals.map((d) => {
      const pay = DB.payments.filter((p) => p.deal_id === d.id && !p.is_voided);
      const sched = DB.payment_schedule.filter((s) => s.deal_id === d.id);
      const principal_returned = pay.reduce((a, p) => a + (p.principal_amount || 0), 0);
      const interest_received = pay.reduce((a, p) => a + (p.interest_amount || 0), 0);
      const total_received = pay.reduce((a, p) => a + (p.amount || 0), 0);
      const pending = ['UPCOMING', 'DUE_TODAY', 'OVERDUE'];
      const interest_pending = sched.filter((s) => pending.includes(s.status)).reduce((a, s) => a + (s.expected_interest || 0), 0);
      const completed = sched.filter((s) => ['RECEIVED', 'RECEIVED_EARLY', 'RECEIVED_ON_TIME', 'RECEIVED_LATE', 'PARTIALLY_RECEIVED', 'MISSED'].includes(s.status));
      const goodCount = sched.filter((s) => ['RECEIVED', 'RECEIVED_EARLY', 'RECEIVED_ON_TIME'].includes(s.status)).length;
      const days_active = Math.round((Date.now() - new Date(d.start_date)) / 86400000);
      return {
        deal_id: d.id, user_id: d.user_id, platform_id: d.platform_id, status: d.status,
        invested_amount: d.invested_amount, current_principal: d.current_principal,
        days_active, principal_returned, interest_received, interest_pending, total_received,
        total_outstanding: Math.max(0, d.invested_amount - principal_returned),
        realized_roi: d.invested_amount ? interest_received / d.invested_amount * 100 : null,
        annualized_realized_roi: d.invested_amount && days_active > 0 ? interest_received / d.invested_amount * 100 * (365 / days_active) : null,
        payout_reliability: completed.length ? goodCount / completed.length * 100 : null,
        recovery_percentage: d.invested_amount ? principal_returned / d.invested_amount * 100 : null,
        missed_payment_count: sched.filter((s) => s.status === 'MISSED').length,
      };
    }),
    v_portfolio_summary: () => {
      const metrics = VIRTUAL_TABLES.v_deal_metrics();
      const totalInvested = DB.deals.reduce((a, d) => a + (d.invested_amount || 0), 0);
      const currentOutstanding = DB.deals.reduce((a, d) => a + (d.current_principal || 0), 0);
      const interestEarned = metrics.reduce((a, m) => a + (m.interest_received || 0), 0);
      const interestPending = metrics.reduce((a, m) => a + (m.interest_pending || 0), 0);
      const active = DB.deals.filter((d) => d.status === 'ACTIVE');
      const weightedNum = active.filter((d) => d.annual_roi != null).reduce((a, d) => a + d.annual_roi * d.invested_amount, 0);
      const weightedDen = active.filter((d) => d.annual_roi != null).reduce((a, d) => a + d.invested_amount, 0);
      return [{
        user_id: DEMO_USER.id, total_invested: totalInvested, current_outstanding_principal: currentOutstanding,
        principal_returned: metrics.reduce((a, m) => a + (m.principal_returned || 0), 0),
        interest_earned: interestEarned, interest_pending: interestPending,
        expected_future_interest: active.reduce((a, d) => a + Math.max(0, (d.expected_total_interest || 0) - ((metrics.find((m) => m.deal_id === d.id) || {}).interest_received || 0)), 0),
        total_portfolio_value: currentOutstanding + interestPending,
        net_profit: interestEarned - DB.deals.reduce((a, d) => a + (d.fees || 0) + (d.tax_withheld || 0), 0),
        realized_roi: totalInvested ? interestEarned / totalInvested * 100 : null,
        annualized_roi: totalInvested ? interestEarned / totalInvested * 100 * 4 : null,
        weighted_average_roi: weightedDen ? weightedNum / weightedDen : null,
        active_deals_count: active.length,
        closed_deals_count: DB.deals.filter((d) => ['CLOSED', 'MATURED'].includes(d.status)).length,
        overdue_deals_count: new Set(DB.payment_schedule.filter((s) => s.status === 'OVERDUE').map((s) => s.deal_id)).size,
      }];
    },
    v_recurring_summary: () => {
      const now = new Date();
      const curMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
      const curYear = now.getFullYear();
      const occs = DB.recurring_occurrences;
      const inMonth = (o) => { const d = new Date(o.scheduled_date); return `${d.getFullYear()}-${d.getMonth()}` === curMonthKey; };
      const inYear = (o) => new Date(o.scheduled_date).getFullYear() === curYear;
      const confirmedStatuses = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];
      const dueWithin = (o, days) => { const diff = (new Date(o.due_date) - now) / 86400000; return diff >= 0 && diff <= days; };
      const sum = (arr, f) => arr.reduce((a, o) => a + (f(o) || 0), 0);
      return [{
        user_id: DEMO_USER.id,
        active_items_count: DB.recurring_items.filter((i) => i.status === 'ACTIVE').length,
        month_expected: sum(occs.filter(inMonth), (o) => o.expected_amount),
        month_confirmed: sum(occs.filter((o) => inMonth(o) && confirmedStatuses.includes(o.status)), (o) => o.actual_amount),
        month_in_progress_count: occs.filter((o) => inMonth(o) && o.status === 'IN_PROGRESS').length,
        month_yet_to_confirm_count: occs.filter((o) => inMonth(o) && ['UPCOMING', 'DUE'].includes(o.status)).length,
        month_overdue_count: occs.filter((o) => inMonth(o) && o.status === 'OVERDUE').length,
        month_overdue_amount: sum(occs.filter((o) => inMonth(o) && o.status === 'OVERDUE'), (o) => o.expected_amount),
        year_expected: sum(occs.filter(inYear), (o) => o.expected_amount),
        year_confirmed: sum(occs.filter((o) => inYear(o) && confirmedStatuses.includes(o.status)), (o) => o.actual_amount),
        year_pending_count: occs.filter((o) => inYear(o) && ['UPCOMING', 'DUE'].includes(o.status)).length,
        year_skipped_count: occs.filter((o) => inYear(o) && o.status === 'SKIPPED').length,
        year_overdue_count: occs.filter((o) => inYear(o) && o.status === 'OVERDUE').length,
        next_7_days_amount: sum(occs.filter((o) => dueWithin(o, 7) && ['UPCOMING', 'DUE'].includes(o.status)), (o) => o.expected_amount),
        next_30_days_amount: sum(occs.filter((o) => dueWithin(o, 30) && ['UPCOMING', 'DUE'].includes(o.status)), (o) => o.expected_amount),
      }];
    },
    v_recurring_consistency: () => DB.recurring_items.map((ri) => {
      const occs = DB.recurring_occurrences.filter((o) => o.recurring_item_id === ri.id);
      const confirmedStatuses = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];
      const confirmed = occs.filter((o) => confirmedStatuses.includes(o.status));
      const skipped = occs.filter((o) => o.status === 'SKIPPED');
      const missed = occs.filter((o) => ['OVERDUE', 'FAILED'].includes(o.status));
      const denom = confirmed.length + missed.length;
      const delays = confirmed.filter((o) => o.paid_date).map((o) => Math.round((new Date(o.paid_date) - new Date(o.due_date)) / 86400000));
      return {
        recurring_item_id: ri.id, user_id: ri.user_id, item_name: ri.item_name,
        confirmed_count: confirmed.length, skipped_count: skipped.length, missed_count: missed.length,
        consistency_pct: denom ? Math.round((confirmed.length / denom) * 10000) / 100 : null,
        avg_delay_days: delays.length ? Math.round((delays.reduce((a, b) => a + b, 0) / delays.length) * 10) / 10 : null,
        total_expected_amount: occs.reduce((a, o) => a + (o.expected_amount || 0), 0),
        total_actual_amount: occs.reduce((a, o) => a + (o.actual_amount || 0), 0),
      };
    }),
    // Mirrors v_gold_scheme_holdings (019_gold_intelligence.sql) exactly -
    // a join/aggregation over recurring_items+recurring_occurrences, not a
    // real table, same relationship v_deal_metrics has to deals.
    v_gold_scheme_holdings: () => DB.recurring_items
      .filter((ri) => ri.item_type === 'Gold Scheme' || ri.item_type === 'Gold Savings')
      .map((ri) => {
        const occs = DB.recurring_occurrences.filter((o) => o.recurring_item_id === ri.id);
        const confirmedStatuses = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];
        const withUnits = occs.filter((o) => o.actual_units != null);
        const confirmed = occs.filter((o) => confirmedStatuses.includes(o.status));
        const totalGrams = withUnits.reduce((a, o) => a + o.actual_units, 0);
        const totalPaid = confirmed.reduce((a, o) => a + (o.actual_amount || 0), 0);
        return {
          recurring_item_id: ri.id, user_id: ri.user_id, item_name: ri.item_name, item_type: ri.item_type,
          total_grams: totalGrams, total_paid: totalPaid,
          avg_purchase_price: totalGrams > 0 ? totalPaid / totalGrams : null,
          confirmed_periods: confirmed.length,
          remaining_periods: occs.filter((o) => ['UPCOMING', 'DUE', 'IN_PROGRESS', 'OVERDUE'].includes(o.status)).length,
        };
      }),
    v_my_conversations: () => DB.conversation_members
      .filter((cm) => cm.user_id === DEMO_USER.id && !cm.left_at)
      .map((cm) => {
        const conv = DB.conversations.find((c) => c.id === cm.conversation_id) || {};
        const unread = DB.messages.filter((m) => m.conversation_id === cm.conversation_id && !m.deleted_at
          && (!cm.history_visible_from || m.created_at >= cm.history_visible_from)
          && m.id > (cm.last_read_message_id || 0)).length;
        return {
          membership_id: cm.id, conversation_id: cm.conversation_id, role: cm.role, joined_at: cm.joined_at,
          left_at: cm.left_at, muted_until: cm.muted_until, archived: cm.archived, pinned: cm.pinned,
          last_read_message_id: cm.last_read_message_id, history_visible_from: cm.history_visible_from,
          type: conv.type, name: conv.name, photo_path: conv.photo_path, description: conv.description,
          created_by: conv.created_by, conversation_created_at: conv.created_at, last_message_at: conv.last_message_at,
          unread_count: unread,
        };
      }),
    // Expense & Project Cost Management (031_expense_projects.sql) - mirrors
    // v_expense_project_summary/v_expense_category_summary/v_expense_vendor_summary.
    v_expense_project_summary: () => DB.expense_projects.map((p) => {
      const txns = DB.expense_transactions.filter((t) => t.project_id === p.id);
      const debits = txns.filter((t) => t.transaction_type === 'Debit');
      const credits = txns.filter((t) => t.transaction_type === 'Credit');
      const totalDebit = debits.reduce((a, t) => a + (t.amount || 0), 0);
      const totalCredit = credits.reduce((a, t) => a + (t.amount || 0), 0);
      const totalPaid = debits.filter((t) => t.payment_status === 'Paid').reduce((a, t) => a + (t.amount_paid ?? t.amount ?? 0), 0)
        + debits.filter((t) => t.payment_status === 'Partially Paid').reduce((a, t) => a + (t.amount_paid || 0), 0);
      const totalPending = debits.filter((t) => ['Pending', 'Partially Paid', 'Overdue'].includes(t.payment_status))
        .reduce((a, t) => a + (t.amount - (t.amount_paid || 0)), 0);
      const now = new Date();
      const thisMonth = debits.filter((t) => { const d = new Date(t.transaction_date); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).reduce((a, t) => a + t.amount, 0);
      const thisYear = debits.filter((t) => new Date(t.transaction_date).getFullYear() === now.getFullYear()).reduce((a, t) => a + t.amount, 0);
      const netExpense = totalDebit - totalCredit;
      return {
        project_id: p.id, user_id: p.user_id, name: p.name, budget_total: p.budget_total,
        total_debit: totalDebit, total_credit: totalCredit, net_expense: netExpense,
        total_paid: totalPaid, total_pending: totalPending,
        this_month_total: thisMonth, this_year_total: thisYear,
        budget_remaining: p.budget_total != null ? p.budget_total - netExpense : null,
      };
    }),
    v_expense_category_summary: () => DB.expense_categories.map((c) => {
      const spent = DB.expense_transactions.filter((t) => t.category_id === c.id && t.transaction_type === 'Debit').reduce((a, t) => a + (t.amount || 0), 0);
      const pctUsed = c.budget_amount ? Math.round((spent / c.budget_amount) * 1000) / 10 : null;
      return {
        category_id: c.id, project_id: c.project_id, user_id: c.user_id, name: c.name,
        parent_category_id: c.parent_category_id, budget_amount: c.budget_amount,
        actual_spent: spent, remaining: c.budget_amount != null ? c.budget_amount - spent : null, pct_used: pctUsed,
      };
    }),
    v_expense_vendor_summary: () => DB.expense_vendors.map((v) => {
      const txns = DB.expense_transactions.filter((t) => t.vendor_id === v.id && t.transaction_type === 'Debit');
      return {
        vendor_id: v.id, user_id: v.user_id, name: v.name,
        total_paid: txns.reduce((a, t) => a + (t.amount || 0), 0),
        transaction_count: txns.length,
        pending_amount: txns.filter((t) => ['Pending', 'Partially Paid', 'Overdue'].includes(t.payment_status)).reduce((a, t) => a + (t.amount - (t.amount_paid || 0)), 0),
      };
    }),
    v_suggestion_vote_counts: () => {
      const counts = {};
      DB.suggestion_votes.forEach((v) => { counts[v.suggestion_id] = (counts[v.suggestion_id] || 0) + 1; });
      return Object.entries(counts).map(([suggestion_id, vote_count]) => ({ suggestion_id: Number(suggestion_id), vote_count }));
    },
  };

  // ---- schedule generation, mirrors fn_generate_payment_schedule (009_functions.sql) ----
  function generateSchedule(dealId) {
    const d = DB.deals.find((x) => x.id === dealId);
    if (!d || !d.maturity_date || ['Irregular', 'Custom'].includes(d.payment_frequency)) return 0;
    DB.payment_schedule = DB.payment_schedule.filter((s) => !(s.deal_id === dealId && ['UPCOMING', 'DUE_TODAY', 'OVERDUE'].includes(s.status)));
    const stepMonths = { Monthly: 1, Quarterly: 3, 'Half-Yearly': 6, Yearly: 12, 'At Maturity': null }[d.payment_frequency];
    const dates = [];
    if (d.payment_frequency === 'At Maturity') dates.push(d.maturity_date);
    else {
      let cur = new Date(d.first_payment_date || d.start_date);
      if (!d.first_payment_date) cur.setMonth(cur.getMonth() + stepMonths);
      const end = new Date(d.maturity_date);
      let guard = 0;
      while (cur <= end && guard < 600) { dates.push(cur.toISOString().slice(0, 10)); cur = new Date(cur); cur.setMonth(cur.getMonth() + stepMonths); guard++; }
      if (!dates.length || dates[dates.length - 1] !== d.maturity_date) dates.push(d.maturity_date);
    }
    const periodsPerYear = { Monthly: 12, Quarterly: 4, 'Half-Yearly': 2, Yearly: 1, 'At Maturity': 1 }[d.payment_frequency];
    const ratePerPeriod = (d.annual_roi || 0) / 100 / periodsPerYear;
    let balance = d.invested_amount;
    dates.forEach((date, i) => {
      const isFinal = i === dates.length - 1;
      let interest = Math.round(balance * ratePerPeriod * 100) / 100;
      let principal = 0;
      if (d.payout_type === 'Interest Only') principal = 0;
      else if (isFinal) principal = balance;
      else if (d.payout_type === 'Interest + Principal' || d.payout_type === 'EMI') principal = Math.round(d.invested_amount / dates.length * 100) / 100;
      const row = {
        id: genId('payment_schedule'), user_id: DEMO_USER.id, deal_id: dealId, scheduled_date: date,
        expected_interest: interest, expected_principal: principal, expected_total: interest + principal,
        payment_type: d.payout_type, status: 'UPCOMING', grace_period_days: 3, actual_payment_id: null,
        created_at: nowIso(), updated_at: nowIso(),
      };
      DB.payment_schedule.push(row);
      auditInsert('payment_schedule', row);
      balance = Math.max(0, balance - principal);
    });
    d.next_payment_date = dates[0];
    return dates.length;
  }

  // ---- payment recording, mirrors fn_record_payment (009_functions.sql) ----
  function recordPayment(p) {
    const deal = DB.deals.find((d) => d.id === p.p_deal_id);
    if (!deal) throw new Error('Deal not found');
    const candidates = DB.payment_schedule.filter((s) => s.deal_id === p.p_deal_id && ['UPCOMING', 'DUE_TODAY', 'OVERDUE', 'PARTIALLY_RECEIVED'].includes(s.status));
    candidates.sort((a, b) => Math.abs(new Date(a.scheduled_date) - new Date(p.p_transaction_date)) - Math.abs(new Date(b.scheduled_date) - new Date(p.p_transaction_date)));
    const sched = p.p_scheduled_payment_id ? DB.payment_schedule.find((s) => s.id === p.p_scheduled_payment_id) : candidates[0];
    const payment = {
      id: genId('payments'), user_id: DEMO_USER.id, deal_id: p.p_deal_id, scheduled_payment_id: sched ? sched.id : null,
      transaction_date: p.p_transaction_date, amount: p.p_amount, interest_amount: p.p_interest_amount,
      principal_amount: p.p_principal_amount, fee_amount: p.p_fee_amount || 0, tax_amount: p.p_tax_amount || 0,
      payment_reference: p.p_payment_reference, payment_mode: p.p_payment_mode, confirmation_method: p.p_confirmation_method || 'Manual',
      notes: p.p_notes, is_voided: false, created_at: nowIso(), updated_at: nowIso(),
    };
    const dupe = DB.payments.find((x) => x.deal_id === payment.deal_id && x.transaction_date === payment.transaction_date && x.amount === payment.amount && (x.payment_reference || '') === (payment.payment_reference || ''));
    if (dupe) throw new Error('duplicate key value violates unique constraint (this exact payment is already recorded)');
    DB.payments.push(payment);
    auditInsert('payments', payment);
    if (sched) {
      const before = Object.assign({}, sched);
      const days = (new Date(p.p_transaction_date) - new Date(sched.scheduled_date)) / 86400000;
      sched.status = days < 0 ? 'RECEIVED_EARLY' : days === 0 ? 'RECEIVED_ON_TIME' : 'RECEIVED_LATE';
      sched.actual_payment_id = payment.id;
      auditUpdate('payment_schedule', before, sched);
    }
    const dealBefore = Object.assign({}, deal);
    deal.last_payment_date = p.p_transaction_date;
    deal.current_principal = Math.max(0, deal.current_principal - (p.p_principal_amount || 0));
    auditUpdate('deals', dealBefore, deal);
    if (p.p_principal_amount > 0) {
      const r = { id: genId('reinvestments'), user_id: DEMO_USER.id, source_payment_id: payment.id, returned_amount: p.p_principal_amount, returned_date: p.p_transaction_date, reinvested_amount: null, reinvestment_date: null, new_deal_id: null, reinvestment_destination: null, created_at: nowIso() };
      recomputeReinvestmentColumns(r);
      DB.reinvestments.push(r);
    }
    return payment.id;
  }

  // Mirrors private.fn_track_recurring_changes() (015_recurring.sql) - fires
  // automatically on every recurring_items update, so future amount/
  // frequency changes (Sections 83/84) are logged without the UI having to
  // remember to do it, exactly like the real BEFORE UPDATE trigger.
  function trackRecurringChanges(before, after) {
    if (before.expected_amount !== after.expected_amount) {
      DB.recurring_amount_history.push({
        id: genId('recurring_amount_history'), user_id: after.user_id, recurring_item_id: after.id,
        effective_from: nowIso().slice(0, 10), old_amount: before.expected_amount, new_amount: after.expected_amount,
        changed_at: nowIso(),
      });
    }
    if (before.frequency !== after.frequency) {
      DB.recurring_schedule_history.push({
        id: genId('recurring_schedule_history'), user_id: after.user_id, recurring_item_id: after.id,
        effective_from: nowIso().slice(0, 10), old_frequency: before.frequency, new_frequency: after.frequency,
        changed_at: nowIso(),
      });
    }
  }

  // ---- recurring investments & commitments: frequency engine + generation/
  // confirm/pause/resume, mirroring private.fn_recurring_next_date and
  // fn_generate_recurring_occurrences/fn_confirm_recurring_occurrence/
  // fn_pause_recurring_item/fn_resume_recurring_item (015_recurring.sql).
  // Deliberately separate from deals/payments above - never touches deal ROI
  // math. ----
  // "YYYY-MM-DD" strings are UTC per the JS Date parsing spec, but every
  // date in this app is a plain calendar date with no time/timezone
  // component - parsing with `new Date(isoString)` then reading it back
  // with local getters (or the reverse, building a local Date and calling
  // .toISOString()) silently shifts the day in any timezone behind UTC.
  // parseISODate/toLocalISO stay entirely in local-date-arithmetic terms,
  // the same safe pattern utils.js's parseDate/toISO already use.
  function parseISODate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function toLocalISO(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function isoWeekday(d) { const w = d.getDay(); return w === 0 ? 7 : w; }
  function clampDayInMonth(year, month, day) {
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const target = new Date(year, month, Math.max(day, 1));
    return target > lastDayOfMonth ? lastDayOfMonth : target;
  }
  function recurringNextDate(item, afterIso) {
    const after = parseISODate(afterIso);
    const day = item.payment_day
      || (item.first_due_date ? parseISODate(item.first_due_date).getDate() : parseISODate(item.start_date).getDate())
      || 1;
    const rule = item.custom_rule || {};
    let next;
    switch (item.frequency) {
      case 'Weekly': next = new Date(after); next.setDate(next.getDate() + 7); break;
      case 'Biweekly': next = new Date(after); next.setDate(next.getDate() + 14); break;
      case 'Monthly': next = clampDayInMonth(after.getFullYear(), after.getMonth() + 1, day); break;
      case 'Quarterly': next = clampDayInMonth(after.getFullYear(), after.getMonth() + 3, day); break;
      case 'Half-Yearly': next = clampDayInMonth(after.getFullYear(), after.getMonth() + 6, day); break;
      case 'Yearly': next = clampDayInMonth(after.getFullYear(), after.getMonth() + 12, day); break;
      case 'Custom': {
        const type = rule.type || 'day_of_month';
        if (type === 'day_of_month') {
          next = clampDayInMonth(after.getFullYear(), after.getMonth() + 1, rule.day || day);
        } else if (type === 'weekday') {
          next = new Date(after); next.setDate(next.getDate() + 1);
          const target = rule.weekday || 1;
          while (isoWeekday(next) !== target) next.setDate(next.getDate() + 1);
        } else if (type === 'every_n_months') {
          next = clampDayInMonth(after.getFullYear(), after.getMonth() + (rule.n || 1), rule.day || day);
        } else if (type === 'explicit_dates') {
          const dates = (rule.dates || []).map((d) => parseISODate(d)).filter((d) => d > after).sort((a, b) => a - b);
          next = dates[0] || null;
        } else {
          next = clampDayInMonth(after.getFullYear(), after.getMonth() + 1, day);
        }
        break;
      }
      default: next = new Date(after); next.setDate(next.getDate() + 30);
    }
    return next ? toLocalISO(next) : null;
  }

  function generateRecurringOccurrences(recurringItemId) {
    const item = DB.recurring_items.find((x) => x.id === recurringItemId);
    if (!item || item.status !== 'ACTIVE') return 0;
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 90);
    let existing = DB.recurring_occurrences.filter((o) => o.recurring_item_id === recurringItemId);
    let lastDate = existing.length ? existing.reduce((max, o) => (o.scheduled_date > max ? o.scheduled_date : max), existing[0].scheduled_date) : null;
    let next = lastDate ? recurringNextDate(item, lastDate) : (item.first_due_date || item.start_date);
    let occCount = existing.length;
    let inserted = 0;
    let iterations = 0;
    while (next && parseISODate(next) <= horizon && iterations <= 500) {
      if (item.end_date && next > item.end_date) break;
      if (item.number_of_occurrences && occCount >= item.number_of_occurrences) break;

      const openPause = DB.recurring_pauses.find((p) => p.recurring_item_id === recurringItemId
        && p.paused_from <= next && (!p.resumed_at || next < p.resumed_at));
      if (!openPause) {
        const already = DB.recurring_occurrences.find((o) => o.recurring_item_id === recurringItemId && o.scheduled_date === next);
        if (!already) {
          const label = ['Weekly', 'Biweekly'].includes(item.frequency)
            ? parseISODate(next).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
            : parseISODate(next).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
          const row = {
            id: genId('recurring_occurrences'), user_id: item.user_id, recurring_item_id: item.id,
            period_label: label, scheduled_date: next, due_date: next, expected_amount: item.expected_amount,
            actual_amount: null, paid_date: null, status: 'UPCOMING', payment_reference: null,
            payment_method: null, confirmation_method: null, notes: null, actual_units: null, actual_nav: null,
            created_at: nowIso(), updated_at: nowIso(),
          };
          DB.recurring_occurrences.push(row);
          auditInsert('recurring_occurrences', row);
          inserted++;
          occCount++;
        }
      }
      lastDate = next;
      next = recurringNextDate(item, lastDate);
      iterations++;
    }

    const pending = DB.recurring_occurrences.filter((o) => o.recurring_item_id === recurringItemId && ['UPCOMING', 'DUE', 'OVERDUE'].includes(o.status));
    item.next_due_date = pending.length ? pending.reduce((min, o) => (o.scheduled_date < min ? o.scheduled_date : min), pending[0].scheduled_date) : null;
    return inserted;
  }

  function confirmRecurringOccurrence(p) {
    const occ = DB.recurring_occurrences.find((o) => o.id === p.p_occurrence_id);
    if (!occ) throw new Error('Occurrence not found');
    const before = Object.assign({}, occ);
    Object.assign(occ, {
      actual_amount: p.p_actual_amount, paid_date: p.p_paid_date, status: p.p_status,
      payment_reference: p.p_payment_reference ?? null, payment_method: p.p_payment_method ?? null,
      notes: p.p_notes ?? occ.notes, actual_units: p.p_actual_units ?? occ.actual_units,
      actual_nav: p.p_actual_nav ?? occ.actual_nav, confirmation_method: 'Manual', updated_at: nowIso(),
    });
    auditUpdate('recurring_occurrences', before, occ);
    const item = DB.recurring_items.find((x) => x.id === occ.recurring_item_id);
    if (item && p.p_status !== 'SKIPPED') item.last_confirmed_date = p.p_paid_date;
    generateRecurringOccurrences(occ.recurring_item_id);
    return occ;
  }

  function pauseRecurringItem(p) {
    const item = DB.recurring_items.find((x) => x.id === p.p_recurring_item_id);
    if (!item) throw new Error('Recurring item not found');
    const pausedFrom = p.p_paused_from || nowIso().slice(0, 10);
    DB.recurring_pauses.push({
      id: genId('recurring_pauses'), user_id: item.user_id, recurring_item_id: item.id,
      paused_from: pausedFrom, resumed_at: null, reason: p.p_reason || null, created_at: nowIso(),
    });
    item.status = 'PAUSED';
    DB.recurring_occurrences = DB.recurring_occurrences.filter((o) => !(o.recurring_item_id === item.id && o.status === 'UPCOMING' && o.scheduled_date >= pausedFrom));
  }

  // ---- Contacts / Chat / Calls: portfolio-user discovery + message-sharing
  // engine, mirroring find_portfolio_user/fn_share_messages
  // (016_contacts.sql/017_chat.sql). Deliberately separate from
  // deals/payments/recurring above. ----
  function findPortfolioUserMock(query) {
    const target = DB.profiles.find((p) => p.id !== DEMO_USER.id && (p.email === query || p.mobile === query || p.username === query));
    if (!target) return [];
    const privacy = DB.user_privacy_settings.find((p) => p.user_id === target.id);
    const tier = (privacy && privacy.who_can_find_me) || 'Contacts';
    const allowDiscovery = privacy ? privacy.allow_contact_discovery : true;
    if (!allowDiscovery || tier === 'Nobody') return [];
    if (tier === 'Contacts') {
      const me = DB.profiles.find((p) => p.id === DEMO_USER.id) || {};
      const inTargetContacts = DB.contacts.some((c) => {
        if (c.owner_user_id !== target.id) return false;
        const phones = DB.contact_phones.filter((cp) => cp.contact_id === c.id);
        const emails = DB.contact_emails.filter((ce) => ce.contact_id === c.id);
        return phones.some((p) => p.phone_number === me.mobile) || emails.some((e) => e.email === me.email);
      });
      if (!inTargetContacts) return [];
    }
    return [{ id: target.id, display_name: target.full_name || 'User' }];
  }

  // Mirrors fn_clear_my_data()/fn_admin_clear_all_data()'s own table list
  // (032_ui_and_notification_preferences.sql) exactly - strictly personal/
  // portfolio tables only, never community/blog/tickets/chat/shared
  // portfolios (see that migration's own scope decision #2). `contacts`
  // uses `owner_user_id`, not `user_id` - the one real owner-column
  // exception in this list, handled explicitly below rather than silently
  // matching nothing.
  const CLEAR_DATA_TABLES = [
    'payments', 'payment_matches', 'bank_transactions', 'reinvestments', 'deals', 'platforms',
    'recurring_items', 'recurring_occurrences', 'recurring_amount_history', 'recurring_schedule_history', 'recurring_pauses',
    'gold_purchases', 'gold_alerts',
    'expense_projects', 'expense_categories', 'expense_vendors', 'expense_advances', 'expense_transactions',
    'expense_recurring_templates', 'expense_project_custom_fields', 'expense_transaction_custom_values',
    'contact_phones', 'contact_emails', 'contact_addresses', 'contact_important_dates', 'contact_notes',
    'contact_reminders', 'contact_group_members', 'contact_groups',
    'accounts', 'liabilities', 'net_worth_snapshots',
    'portfolio_goals', 'cash_transactions', 'tax_records', 'notes', 'documents', 'imports',
    'calendar_events', 'notifications', 'audit_logs', 'ai_insights', 'scenario_simulations', 'integration_configs',
  ];
  function clearPersonalData(userId) {
    CLEAR_DATA_TABLES.forEach((table) => { DB[table] = (DB[table] || []).filter((r) => r.user_id !== userId); });
    DB.contacts = (DB.contacts || []).filter((c) => c.owner_user_id !== userId);
  }

  function shareMessagesMock(params) {
    const { p_source_conversation_id, p_target_conversation_id, p_message_ids } = params;
    const batch = {
      id: genId('shared_message_batches'), source_conversation_id: p_source_conversation_id,
      target_conversation_id: p_target_conversation_id, shared_by: DEMO_USER.id, shared_at: nowIso(),
    };
    DB.shared_message_batches.push(batch);
    const toShare = DB.messages
      .filter((m) => p_message_ids.includes(m.id) && m.conversation_id === p_source_conversation_id && !m.deleted_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const results = toShare.map((m) => {
      const newMsg = {
        id: genId('messages'), conversation_id: p_target_conversation_id, sender_id: DEMO_USER.id,
        message_type: m.message_type, content: m.content, reply_to_message_id: null,
        forwarded_from_message_id: m.id, status: 'SENT', created_at: nowIso(), updated_at: nowIso(),
        edited_at: null, deleted_at: null,
      };
      DB.messages.push(newMsg);
      auditInsert('messages', newMsg);
      fireChannelListeners('messages', 'INSERT', newMsg);
      DB.shared_message_items.push({ id: genId('shared_message_items'), batch_id: batch.id, source_message_id: m.id });
      return { source_message_id: m.id, new_message_id: newMsg.id };
    });
    const targetConv = DB.conversations.find((c) => c.id === p_target_conversation_id);
    if (targetConv) targetConv.last_message_at = nowIso();
    return results;
  }

  // Stands in for the real gold-price-fetch Edge Function (which Demo Mode
  // can never actually reach - no live project, no provider key). Appends
  // one new simulated observation per purity off the last known 24K price
  // (a small bounded step, not fresh random noise, so "Refresh Now" looks
  // like a real tick rather than a discontinuous jump), and mirrors
  // fn_gold_provider_record_fetch's reset-then-increment quota logic so the
  // Settings panel's usage counter behaves identically to the real thing.
  function refreshGoldPriceMock() {
    const settings = DB.gold_settings[0];
    const provider = DB.gold_providers.find((p) => p.key === (settings && settings.active_provider_key));
    if (!provider) return { ok: false, error: 'No active gold provider configured.' };
    const now = new Date();
    if (provider.requests_limit != null && now > new Date(provider.period_reset_at)) {
      provider.requests_used_this_period = 0;
      provider.period_reset_at = toLocalISO(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    }
    provider.requests_used_this_period += 1;
    provider.last_fetch_at = nowIso();
    provider.last_fetch_status = 'ok';
    provider.last_error = null;

    const last24k = DB.gold_price_observations.filter((o) => o.purity === '24K').sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
    const basePrice = last24k ? last24k.price : 13800;
    const step = 1 + (Math.random() - 0.5) * 0.015; // +-0.75% single-tick move
    const price24k = Math.round(basePrice * step);
    const observedAt = nowIso();
    const prices = {};
    [['24K', 1], ['22K', 22 / 24], ['18K', 18 / 24]].forEach(([purity, ratio]) => {
      const price = Math.round(price24k * ratio * 100) / 100;
      prices[purity] = price;
      DB.gold_price_observations.push({
        id: genId('gold_price_observations'), provider_key: provider.key, price_type: 'SPOT', purity,
        currency: 'INR', unit: 'gram', price, observed_at: observedAt, market: null, city: null,
        is_benchmark: false, is_retail: false, created_at: observedAt,
      });
    });
    return { ok: true, provider: provider.key, observed_at: observedAt, prices };
  }

  function resumeRecurringItem(p) {
    const resumeDate = p.p_resume_date || nowIso().slice(0, 10);
    const openPause = DB.recurring_pauses.find((x) => x.recurring_item_id === p.p_recurring_item_id && !x.resumed_at);
    if (openPause) openPause.resumed_at = resumeDate;
    const item = DB.recurring_items.find((x) => x.id === p.p_recurring_item_id);
    if (item) item.status = 'ACTIVE';
    generateRecurringOccurrences(p.p_recurring_item_id);
  }

  function seed() {
    Object.keys(DB).forEach((k) => { DB[k] = []; });
    Object.keys(counters).forEach((k) => { delete counters[k]; });

    const platformA = { id: genId('platforms'), user_id: DEMO_USER.id, name: 'Sample P2P Platform', investment_type: 'P2P Lending', created_at: nowIso(), updated_at: nowIso() };
    const platformB = { id: genId('platforms'), user_id: DEMO_USER.id, name: 'Sample Bank', investment_type: 'Fixed Income', created_at: nowIso(), updated_at: nowIso() };
    DB.platforms.push(platformA, platformB);
    DB.risk_ratings.push({ id: 1, user_id: null, code: 'LOW', label: 'Low Risk', sort_order: 1, is_system: true }, { id: 2, user_id: null, code: 'MEDIUM', label: 'Medium Risk', sort_order: 2, is_system: true }, { id: 3, user_id: null, code: 'HIGH', label: 'High Risk', sort_order: 3, is_system: true });
    DB.investment_categories.push({ id: 1, user_id: null, investment_type: 'P2P Lending', category: 'P2P', sub_category: 'Consumer Loan', is_system: true }, { id: 2, user_id: null, investment_type: 'Fixed Income', category: 'Fixed Deposit', sub_category: 'Bank FD', is_system: true });
    DB.profiles.push({ id: DEMO_USER.id, email: DEMO_USER.email, full_name: 'Demo User', preferred_currency: 'INR', financial_year_start_month: 4, financial_year_start_day: 1, timezone: 'Asia/Kolkata', is_admin: true, is_active: true, analytics_consent: null, created_at: nowIso(), updated_at: nowIso() });

    // A second demo profile purely so Portfolio Sharing / "Shared With Me"
    // has something real to show without needing a second live account -
    // seeded as a Viewer on the demo user's own shared portfolio below.
    const FAMILY_MEMBER_ID = 'demo-family-member';
    DB.profiles.push({ id: FAMILY_MEMBER_ID, email: 'family.member@example.com', full_name: 'Family Member (Demo)', preferred_currency: 'INR', is_admin: false, is_active: true, analytics_consent: null, created_at: nowIso(), updated_at: nowIso() });

    const today = new Date();
    // Local-date formatting, not d.toISOString().slice(0,10): every date
    // here is built as a local midnight (new Date(y,m,d)), and .toISOString()
    // reports UTC - in any timezone with a nonzero offset (e.g. IST, +5:30)
    // that silently rolls the date back or forward a day. toLocalISO (the
    // same fix applied to the recurring-item date engine above) reads the
    // Date back with local getters instead, so the seeded dates always match
    // what was actually intended.
    const iso = toLocalISO;
    const deal1Start = new Date(today.getFullYear(), today.getMonth() - 6, 5);
    const deal1Maturity = new Date(today.getFullYear(), today.getMonth() + 6, 5);
    const deal1 = { id: genId('deals'), user_id: DEMO_USER.id, deal_name: 'Sample P2P Deal - 12mo', platform_id: platformA.id, investment_type: 'P2P Lending', category: 'P2P', invested_amount: 50000, principal_amount: 50000, original_principal: 50000, current_principal: 50000, annual_roi: 24, payment_frequency: 'Monthly', payout_type: 'Interest Only', start_date: iso(deal1Start), maturity_date: iso(deal1Maturity), status: 'ACTIVE', risk_rating: 'MEDIUM', expected_total_interest: 12000, fees: 0, tax_withheld: 0, source: 'Manual', created_at: nowIso(), updated_at: nowIso() };
    const deal2Start = new Date(today.getFullYear() - 1, today.getMonth(), 1);
    const deal2Maturity = new Date(today.getFullYear() + 2, today.getMonth(), 1);
    const deal2 = { id: genId('deals'), user_id: DEMO_USER.id, deal_name: 'Sample Bank FD - 36mo', platform_id: platformB.id, investment_type: 'Fixed Income', category: 'Fixed Deposit', invested_amount: 100000, principal_amount: 100000, original_principal: 100000, current_principal: 100000, annual_roi: 7.5, payment_frequency: 'Yearly', payout_type: 'Interest + Principal', start_date: iso(deal2Start), maturity_date: iso(deal2Maturity), status: 'ACTIVE', risk_rating: 'LOW', expected_total_interest: 22500, fees: 0, tax_withheld: 0, source: 'Manual', created_at: nowIso(), updated_at: nowIso() };
    const closedStart = new Date(today.getFullYear() - 1, today.getMonth() - 2, 1);
    const closedMaturity = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    const deal3 = { id: genId('deals'), user_id: DEMO_USER.id, deal_name: 'Sample Closed P2P Deal', platform_id: platformA.id, investment_type: 'P2P Lending', category: 'P2P', invested_amount: 20000, principal_amount: 20000, original_principal: 20000, current_principal: 0, annual_roi: 20, payment_frequency: 'Monthly', payout_type: 'Interest Only', start_date: iso(closedStart), maturity_date: iso(closedMaturity), closure_date: iso(closedMaturity), status: 'CLOSED', risk_rating: 'MEDIUM', expected_total_interest: 4000, fees: 0, tax_withheld: 0, source: 'Manual', created_at: nowIso(), updated_at: nowIso() };
    DB.deals.push(deal1, deal2, deal3);
    deal1.created_at = deal1.updated_at = nowIso();
    [deal1, deal2, deal3].forEach((d) => auditInsert('deals', d));

    generateSchedule(deal1.id);
    generateSchedule(deal2.id);
    generateSchedule(deal3.id);

    for (let i = 6; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 5);
      if (d < deal1Start) continue;
      try { recordPayment({ p_deal_id: deal1.id, p_transaction_date: iso(d), p_amount: 1000, p_interest_amount: 1000, p_principal_amount: 0, p_confirmation_method: 'Manual' }); } catch (e) { /* skip */ }
    }
    for (let i = 12; i >= 1; i--) {
      const d = new Date(closedStart.getFullYear(), closedStart.getMonth() + i - 1, 5);
      if (d > closedMaturity) continue;
      try { recordPayment({ p_deal_id: deal3.id, p_transaction_date: iso(d), p_amount: 333.33, p_interest_amount: 333.33, p_principal_amount: 0, p_confirmation_method: 'Manual' }); } catch (e) { /* skip */ }
    }
    try { recordPayment({ p_deal_id: deal3.id, p_transaction_date: iso(closedMaturity), p_amount: 20000, p_interest_amount: 0, p_principal_amount: 20000, p_confirmation_method: 'Manual' }); } catch (e) { /* skip */ }

    const overdueRow = DB.payment_schedule.find((s) => s.deal_id === deal1.id && s.status === 'UPCOMING' && new Date(s.scheduled_date) < today);
    if (overdueRow) overdueRow.status = 'OVERDUE';

    DB.notification_preferences.push({ user_id: DEMO_USER.id, reminder_offset_days: [-7, -3, -1, 0, 1, 3, 7, 30], channels_enabled: { 'In-app': true }, email_frequency: '1_day', last_email_digest_sent_at: null, push_enabled: false, created_at: nowIso(), updated_at: nowIso() });
    DB.notifications.push({ id: genId('notifications'), user_id: DEMO_USER.id, deal_id: deal1.id, type: 'Payment Overdue', title: 'Payment overdue - ' + deal1.deal_name, message: 'A payment is overdue for this deal.', priority: 'High', channel: 'In-app', status: 'Pending', scheduled_at: nowIso(), created_at: nowIso() });
    DB.portfolio_goals.push({ id: genId('portfolio_goals'), user_id: DEMO_USER.id, label: 'Sample 2026 Goals', target_annual_income: 50000, target_portfolio_size: 300000, target_roi: 15, is_active: true, created_at: nowIso(), updated_at: nowIso() });
    DB.app_settings.push({ id: 1, audit_history_enabled: true, fd_reference_rate: 7.0, updated_at: nowIso() });

    // Shared Portfolio (024) - demo user's own portfolio, switched on, with
    // the family-member profile as a Viewer, so "Shared With Me" has a
    // real example on both sides without needing two live accounts.
    const sharedPortfolio = { id: genId('shared_portfolios'), owner_user_id: DEMO_USER.id, name: "Demo User's Portfolio", is_active: true, created_at: nowIso() };
    DB.shared_portfolios.push(sharedPortfolio);
    DB.portfolio_members.push({ id: genId('portfolio_members'), portfolio_id: sharedPortfolio.id, member_user_id: FAMILY_MEMBER_ID, role: 'Viewer', invited_at: nowIso(), accepted_at: nowIso() });

    // Benchmark Comparison (026) - a year of simulated Nifty/Sensex daily
    // closes (bounded random walk, same technique as Gold Intelligence's
    // own 90-day seed) so the Analytics panel has something to plot without
    // a live Yahoo Finance call.
    (function seedBenchmarkHistory() {
      let nifty = 24500, sensex = 80500;
      for (let i = 365; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue; // markets closed on weekends
        nifty = Math.max(1000, nifty * (1 + (Math.random() - 0.48) * 0.012));
        sensex = Math.max(1000, sensex * (1 + (Math.random() - 0.48) * 0.012));
        const dateStr = iso(d);
        DB.benchmark_observations.push({ id: genId('benchmark_observations'), symbol: 'NIFTY50', observed_date: dateStr, close_value: Math.round(nifty * 100) / 100, created_at: nowIso() });
        DB.benchmark_observations.push({ id: genId('benchmark_observations'), symbol: 'SENSEX', observed_date: dateStr, close_value: Math.round(sensex * 100) / 100, created_at: nowIso() });
      }
    })();

    // Blog / Knowledge Sharing (028) - a couple of sample posts with a
    // comment, so the module doesn't look empty on first visit.
    const blogPost1 = { id: genId('blog_posts'), author_user_id: DEMO_USER.id, title: 'Why I ladder my Fixed Deposits by maturity date', content: 'Spreading FD maturities across the year instead of renewing one lump sum means better liquidity and a chance to catch rate changes. Sharing my rough schedule here in case it helps someone else.', category: 'Fixed Income', tags: ['fd', 'strategy'], pinned: true, created_at: nowIso(), updated_at: nowIso() };
    const blogPost2 = { id: genId('blog_posts'), author_user_id: FAMILY_MEMBER_ID, title: 'Gold Scheme vs standalone purchases - what I learned', content: "After a year on a jeweller's Gold Scheme alongside a few standalone purchases, the Gold Intelligence page's Gold Scheme panel made it obvious my scheme's effective average price beat my standalone buys by a noticeable margin - mostly discipline, not timing skill.", category: 'Gold', tags: ['gold', 'gold-scheme'], pinned: false, created_at: nowIso(), updated_at: nowIso() };
    DB.blog_posts.push(blogPost1, blogPost2);
    DB.blog_comments.push({ id: genId('blog_comments'), post_id: blogPost1.id, author_user_id: FAMILY_MEMBER_ID, content: 'This is exactly what I needed to read before my next renewal - thank you!', created_at: nowIso() });

    // Login analytics (027) - a couple of sample events (one consented,
    // one declined) so the admin-only Visits & Logins panel isn't empty.
    DB.login_events.push(
      { id: genId('login_events'), user_id: DEMO_USER.id, occurred_at: nowIso(), consent_given: true, ip_address: '203.0.113.42', city: 'Mumbai', region: 'Maharashtra', country: 'India', user_agent: navigator.userAgent, browser: 'Chrome', os: 'Windows', device_type: 'Desktop' },
      { id: genId('login_events'), user_id: FAMILY_MEMBER_ID, occurred_at: new Date(Date.now() - 86400000).toISOString(), consent_given: false, ip_address: null, city: null, region: null, country: null, user_agent: null, browser: null, os: null, device_type: null },
    );

    // Expense & Project Cost Management (031_expense_projects.sql) - a
    // realistic Home Construction project using the spec's own worked
    // example numbers (Section 4's budget table), plus a smaller Travel
    // project with one foreign-currency transaction, so multi-currency and
    // Project Comparison are both exercisable with more than one project.
    (function seedExpenseProjects() {
      const homeProject = {
        id: genId('expense_projects'), user_id: DEMO_USER.id, name: 'Home Construction',
        project_type: 'Home Construction', start_date: iso(new Date(today.getFullYear(), today.getMonth() - 4, 1)),
        end_date: iso(new Date(today.getFullYear(), today.getMonth() + 6, 1)), budget_total: 900000, currency: 'INR',
        description: 'Ground-floor construction, foundation to finishing.', status: 'Active', created_at: nowIso(), updated_at: nowIso(),
      };
      DB.expense_projects.push(homeProject);

      const catDefs = [
        ['Civil Work', 400000], ['Electrical', 100000], ['Plumbing', 80000],
        ['Furniture', 200000], ['Painting', 70000], ['Other', 50000],
      ];
      const cats = {};
      catDefs.forEach(([name, budget], i) => {
        const row = { id: genId('expense_categories'), project_id: homeProject.id, user_id: DEMO_USER.id, name, parent_category_id: null, budget_amount: budget, sort_order: i, created_at: nowIso() };
        DB.expense_categories.push(row);
        cats[name] = row.id;
      });
      // Sub-category example under Civil Work, per the spec's own
      // Category/Sub-category distinction (Cement/Bricks under Civil Work).
      const cementSub = { id: genId('expense_categories'), project_id: homeProject.id, user_id: DEMO_USER.id, name: 'Cement', parent_category_id: cats['Civil Work'], budget_amount: null, sort_order: 0, created_at: nowIso() };
      DB.expense_categories.push(cementSub);

      const raviVendor = { id: genId('expense_vendors'), user_id: DEMO_USER.id, name: 'Ravi Electrical', phone: '+919900011122', email: null, address: null, category: 'Electrical', gst_number: null, bank_upi_reference: 'ravi@upi', linked_contact_id: null, notes: 'Reliable, usually available within a day.', created_at: nowIso(), updated_at: nowIso() };
      const abcCement = { id: genId('expense_vendors'), user_id: DEMO_USER.id, name: 'ABC Cement Suppliers', phone: '+919812300011', email: null, address: null, category: 'Material Supplier', gst_number: '27ABCDE1234F1Z5', bank_upi_reference: null, linked_contact_id: null, notes: null, created_at: nowIso(), updated_at: nowIso() };
      DB.expense_vendors.push(raviVendor, abcCement);

      // Advance to the electrician (spec Section 12's own worked example:
      // Rs.1,00,000 advance, Rs.70,000 adjusted, Rs.30,000 remaining).
      const raviAdvance = { id: genId('expense_advances'), project_id: homeProject.id, vendor_id: raviVendor.id, user_id: DEMO_USER.id, amount_paid: 100000, date_paid: iso(new Date(today.getFullYear(), today.getMonth() - 3, 5)), notes: 'Advance for full electrical wiring work.', created_at: nowIso() };
      DB.expense_advances.push(raviAdvance);

      const txn = (overrides) => DB.expense_transactions.push(Object.assign({
        id: genId('expense_transactions'), user_id: DEMO_USER.id, project_id: homeProject.id,
        transaction_type: 'Debit', payment_status: 'Paid', currency: 'INR',
        created_at: nowIso(), updated_at: nowIso(),
      }, overrides));

      txn({ category_id: cementSub.id, transaction_date: iso(new Date(today.getFullYear(), today.getMonth() - 3, 12)), item: 'Cement - 50 bags', amount: 21000, payment_method: 'Bank Transfer', account_source: 'HDFC Savings', vendor_id: abcCement.id, description: 'Foundation stage cement purchase.', invoice_number: 'INV-1024', amount_paid: 21000 });
      txn({ category_id: cats['Civil Work'], transaction_date: iso(new Date(today.getFullYear(), today.getMonth() - 3, 20)), item: 'Bricks - 5000 units', amount: 45000, payment_method: 'UPI', account_source: 'HDFC Savings', description: 'Wall construction, ground floor.', amount_paid: 45000 });
      txn({ category_id: cats['Electrical'], transaction_date: iso(new Date(today.getFullYear(), today.getMonth() - 2, 8)), item: 'Wiring - ground floor', amount: 35000, payment_method: 'UPI', account_source: 'HDFC Savings', vendor_id: raviVendor.id, description: 'Adjusted against advance.', payment_status: 'Partially Paid', amount_paid: 20000, advance_id: raviAdvance.id, notes: 'Rs.15,000 still pending against this work.' });
      txn({ category_id: cats['Plumbing'], transaction_date: iso(new Date(today.getFullYear(), today.getMonth() - 1, 15)), item: 'Pipes and fittings', amount: 28000, payment_method: 'Cash', account_source: 'Cash', payment_status: 'Pending', due_date: iso(new Date(today.getFullYear(), today.getMonth() + 1, 1)) });
      txn({ category_id: cats['Furniture'], transaction_date: iso(new Date(today.getFullYear(), today.getMonth(), 5)), item: 'Modular kitchen - advance', amount: 90000, payment_method: 'Bank Transfer', account_source: 'HDFC Savings', description: 'Booking advance for modular kitchen.', amount_paid: 90000 });
      // A refund credit, tracked independently per spec Section 11 - not a
      // negative expense.
      txn({ category_id: cats['Civil Work'], transaction_date: iso(new Date(today.getFullYear(), today.getMonth(), 10)), item: 'Excess cement returned', amount: 3000, transaction_type: 'Credit', credit_type: 'Material Return', payment_method: 'Cash', description: 'Returned 7 unused bags to supplier.' });
      txn({ category_id: cats['Electrical'], transaction_date: iso(today), item: 'Switchboard fittings', amount: 42000, payment_method: 'UPI', vendor_id: raviVendor.id, payment_status: 'Overdue', due_date: iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5)), notes: 'Follow up with Ravi.' });

      // Custom fields (Section 25) - Home Construction specialization
      // (Section 18) as pure configuration, not hardcoded columns.
      const phaseField = { id: genId('expense_project_custom_fields'), project_id: homeProject.id, user_id: DEMO_USER.id, field_name: 'Phase', field_type: 'select', field_options: ['Foundation', 'Structure', 'Roof', 'Electrical', 'Plumbing', 'Painting', 'Furniture'], sort_order: 0, created_at: nowIso() };
      const qtyField = { id: genId('expense_project_custom_fields'), project_id: homeProject.id, user_id: DEMO_USER.id, field_name: 'Quantity', field_type: 'text', field_options: null, sort_order: 1, created_at: nowIso() };
      DB.expense_project_custom_fields.push(phaseField, qtyField);
      const firstTxnId = DB.expense_transactions.find((t) => t.project_id === homeProject.id).id;
      DB.expense_transaction_custom_values.push(
        { id: genId('expense_transaction_custom_values'), transaction_id: firstTxnId, custom_field_id: phaseField.id, value: 'Foundation' },
        { id: genId('expense_transaction_custom_values'), transaction_id: firstTxnId, custom_field_id: qtyField.id, value: '50 bags' },
      );

      // A second, smaller project - proves Project Comparison and
      // multi-currency (Section 26) work with more than one project.
      const travelProject = {
        id: genId('expense_projects'), user_id: DEMO_USER.id, name: 'Singapore Trip',
        project_type: 'International Trip', start_date: iso(new Date(today.getFullYear(), today.getMonth() + 1, 10)),
        end_date: iso(new Date(today.getFullYear(), today.getMonth() + 1, 17)), budget_total: 150000, currency: 'INR',
        description: 'Family trip - flights, hotel, activities.', status: 'Active', created_at: nowIso(), updated_at: nowIso(),
      };
      DB.expense_projects.push(travelProject);
      const flightsCategory = { id: genId('expense_categories'), project_id: travelProject.id, user_id: DEMO_USER.id, name: 'Flights', parent_category_id: null, budget_amount: 60000, sort_order: 0, created_at: nowIso() };
      const hotelCategory = { id: genId('expense_categories'), project_id: travelProject.id, user_id: DEMO_USER.id, name: 'Hotel', parent_category_id: null, budget_amount: 50000, sort_order: 1, created_at: nowIso() };
      DB.expense_categories.push(flightsCategory, hotelCategory);
      DB.expense_transactions.push({
        id: genId('expense_transactions'), user_id: DEMO_USER.id, project_id: travelProject.id, category_id: hotelCategory.id,
        transaction_date: iso(new Date(today.getFullYear(), today.getMonth() + 1, 10)), item: 'Hotel booking - 6 nights', amount: 42000,
        transaction_type: 'Debit', payment_status: 'Paid', payment_method: 'Card', account_source: 'HDFC Credit Card',
        description: 'Paid in SGD, converted at booking.', amount_paid: 42000,
        currency: 'SGD', foreign_currency: 'SGD', foreign_amount: 670, exchange_rate: 62.7,
        created_at: nowIso(), updated_at: nowIso(),
      });
      DB.expense_transactions.push({
        id: genId('expense_transactions'), user_id: DEMO_USER.id, project_id: travelProject.id, category_id: flightsCategory.id,
        transaction_date: iso(new Date(today.getFullYear(), today.getMonth(), 20)), item: 'Return flights (2 pax)', amount: 58000,
        transaction_type: 'Debit', payment_status: 'Paid', payment_method: 'Card', account_source: 'HDFC Credit Card',
        amount_paid: 58000, currency: 'INR', created_at: nowIso(), updated_at: nowIso(),
      });
    })();
    DB.calendar_events.push({
      id: genId('calendar_events'), user_id: DEMO_USER.id, title: 'My Birthday', event_type: 'Birthday',
      event_date: iso(new Date(today.getFullYear(), today.getMonth(), Math.min(today.getDate() + 10, 28))),
      recurring_yearly: true, reminder_days_before: [7, 3, 1, 0], notes: 'Sample calendar event - edit or delete freely.',
      created_at: nowIso(), updated_at: nowIso(),
    });

    // ---- Recurring Investments & Commitments sample data - deliberately
    // separate from the deals above, exercising every status the module
    // supports in one pass (see plan file addendum). ----
    const sipStart = new Date(today.getFullYear(), today.getMonth() - 5, 10);
    const sip = {
      id: genId('recurring_items'), user_id: DEMO_USER.id, item_name: 'Sample Monthly SIP - Index Fund',
      item_type: 'SIP', category: 'Mutual Fund', provider: 'Sample AMC', source: 'Manual',
      expected_amount: 10000, currency: 'INR', amount_type: 'Fixed', frequency: 'Monthly',
      start_date: iso(sipStart), payment_day: 10, first_due_date: iso(sipStart), status: 'ACTIVE',
      reminder_enabled: true, reminder_days_before: [3, 1, 0], overdue_reminder_enabled: true, escalation_days: [1, 3, 7],
      folio_number: 'FOLIO-DEMO-001', scheme_name: 'Sample Index Fund - Direct Growth',
      created_at: nowIso(), updated_at: nowIso(),
    };
    DB.recurring_items.push(sip);
    auditInsert('recurring_items', sip);
    generateRecurringOccurrences(sip.id);
    const sipPast = DB.recurring_occurrences.filter((o) => o.recurring_item_id === sip.id && new Date(o.scheduled_date) <= today)
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
    sipPast.slice(0, -1).forEach((o) => confirmRecurringOccurrence({
      p_occurrence_id: o.id, p_actual_amount: 10000, p_paid_date: o.scheduled_date, p_status: 'INVESTED',
      p_payment_reference: 'SIP-AUTO', p_actual_units: 45.2, p_actual_nav: 221.15,
    }));
    if (sipPast.length) { const last = sipPast[sipPast.length - 1]; last.status = 'DUE'; }

    const goldStart = new Date(today.getFullYear(), today.getMonth() - 8, 15);
    const gold = {
      id: genId('recurring_items'), user_id: DEMO_USER.id, item_name: 'Sample Gold Savings Scheme',
      item_type: 'Gold Scheme', category: 'Gold', provider: 'Sample Jeweller', source: 'Manual',
      expected_amount: 15000, currency: 'INR', amount_type: 'Fixed', frequency: 'Monthly',
      start_date: iso(goldStart), payment_day: 15, first_due_date: iso(goldStart), status: 'ACTIVE',
      reminder_enabled: true, reminder_days_before: [7, 3, 1, 0], overdue_reminder_enabled: true, escalation_days: [1, 3, 7],
      scheme_name: 'Sample 11+1 Gold Scheme', maturity_date: iso(new Date(goldStart.getFullYear() + 1, goldStart.getMonth(), 15)),
      created_at: nowIso(), updated_at: nowIso(),
    };
    DB.recurring_items.push(gold);
    auditInsert('recurring_items', gold);
    generateRecurringOccurrences(gold.id);
    // actual_units/actual_nav populated (unlike a plain recurring bill) so
    // Gold Intelligence's v_gold_scheme_holdings has real grams to show -
    // a gently rising nav per month, mirroring how gold has actually moved,
    // never recalculated later from today's live price (Section 19/35).
    DB.recurring_occurrences.filter((o) => o.recurring_item_id === gold.id && new Date(o.scheduled_date) < today)
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
      .forEach((o, i) => {
        const nav = 8900 + i * 120;
        confirmRecurringOccurrence({
          p_occurrence_id: o.id, p_actual_amount: 15000, p_paid_date: o.scheduled_date, p_status: 'INVESTED', p_payment_reference: 'GOLD-AUTO',
          p_actual_units: Math.round((15000 / nav) * 10000) / 10000, p_actual_nav: nav,
        });
      });

    const insuranceStart = new Date(today.getFullYear() - 1, today.getMonth(), 1);
    const insurance = {
      id: genId('recurring_items'), user_id: DEMO_USER.id, item_name: 'Sample Term Insurance Premium',
      item_type: 'Term Insurance', category: 'Insurance', provider: 'Sample Life Insurance Co', source: 'Manual',
      expected_amount: 25000, currency: 'INR', amount_type: 'Fixed', frequency: 'Yearly',
      start_date: iso(insuranceStart), payment_day: 1, first_due_date: iso(insuranceStart), status: 'ACTIVE',
      reminder_enabled: true, reminder_days_before: [15, 3, 0], overdue_reminder_enabled: true, escalation_days: [1, 3, 7],
      policy_number: 'POL-DEMO-9001', beneficiary: 'Sample Nominee',
      maturity_date: iso(new Date(insuranceStart.getFullYear() + 20, insuranceStart.getMonth(), 1)),
      created_at: nowIso(), updated_at: nowIso(),
    };
    DB.recurring_items.push(insurance);
    auditInsert('recurring_items', insurance);
    generateRecurringOccurrences(insurance.id);
    const insuranceDue = DB.recurring_occurrences.find((o) => o.recurring_item_id === insurance.id && new Date(o.scheduled_date) <= today);
    if (insuranceDue) insuranceDue.status = 'OVERDUE';

    // Reconciliation Center: one unmatched bank transaction whose amount/date
    // line up with the overdue insurance premium above, so the generalized
    // Bank Reconciliation matcher (payments.js) has a real Recurring match
    // to suggest in Demo Mode, not just Deal-schedule matches.
    DB.bank_transactions.push({
      id: genId('bank_transactions'), user_id: DEMO_USER.id,
      transaction_date: iso(insuranceStart), amount: 25000,
      description: 'NEFT - Sample Life Insurance Co Premium', reference: 'BANKREF-DEMO-01',
      import_id: null, matched: false, created_at: nowIso(),
    });

    const ccStart = new Date(today.getFullYear(), today.getMonth() - 3, 20);
    const creditCard = {
      id: genId('recurring_items'), user_id: DEMO_USER.id, item_name: 'Sample Credit Card Bill',
      item_type: 'Credit Card Bill', category: 'Bills', provider: 'Sample Bank Card', source: 'Manual',
      expected_amount: 30000, currency: 'INR', amount_type: 'Variable', frequency: 'Monthly',
      start_date: iso(ccStart), payment_day: 20, first_due_date: iso(ccStart), status: 'ACTIVE',
      reminder_enabled: true, reminder_days_before: [7, 2, 0], overdue_reminder_enabled: true, escalation_days: [1, 3, 7],
      created_at: nowIso(), updated_at: nowIso(),
    };
    DB.recurring_items.push(creditCard);
    auditInsert('recurring_items', creditCard);
    generateRecurringOccurrences(creditCard.id);
    const ccPast = DB.recurring_occurrences.filter((o) => o.recurring_item_id === creditCard.id && new Date(o.scheduled_date) < today)
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
    ccPast.slice(0, -1).forEach((o) => confirmRecurringOccurrence({
      p_occurrence_id: o.id, p_actual_amount: 30000, p_paid_date: o.scheduled_date, p_status: 'PAID', p_payment_reference: 'CC-AUTO',
    }));
    if (ccPast.length) {
      const last = ccPast[ccPast.length - 1];
      confirmRecurringOccurrence({
        p_occurrence_id: last.id, p_actual_amount: 18000, p_paid_date: last.scheduled_date, p_status: 'PARTIALLY_PAID',
        p_notes: 'Paid the minimum due for now, will clear the rest before the next cycle.',
      });
    }

    const pausedStart = new Date(today.getFullYear(), today.getMonth() - 4, 1);
    const pausedItem = {
      id: genId('recurring_items'), user_id: DEMO_USER.id, item_name: 'Sample Paused Stock SIP',
      item_type: 'Stocks / Shares', category: 'Equity', provider: 'Sample Broker', source: 'Manual',
      expected_amount: 5000, currency: 'INR', amount_type: 'Fixed', frequency: 'Monthly',
      start_date: iso(pausedStart), payment_day: 1, first_due_date: iso(pausedStart), status: 'ACTIVE',
      reminder_enabled: true, reminder_days_before: [3, 0], overdue_reminder_enabled: true, escalation_days: [1, 3],
      created_at: nowIso(), updated_at: nowIso(),
    };
    DB.recurring_items.push(pausedItem);
    auditInsert('recurring_items', pausedItem);
    generateRecurringOccurrences(pausedItem.id);
    DB.recurring_occurrences.filter((o) => o.recurring_item_id === pausedItem.id).sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
      .slice(0, 2).forEach((o) => confirmRecurringOccurrence({
        p_occurrence_id: o.id, p_actual_amount: 5000, p_paid_date: o.scheduled_date, p_status: 'INVESTED', p_payment_reference: 'STOCK-AUTO',
      }));
    pauseRecurringItem({
      p_recurring_item_id: pausedItem.id, p_paused_from: iso(new Date(today.getFullYear(), today.getMonth(), 1)),
      p_reason: 'Temporary cash requirement',
    });

    // ---- Contacts / Private Chat / Calls sample data - deliberately
    // separate from deals/recurring/community/support above. "Priya" is a
    // second, non-logged-in demo profile standing in for "another
    // registered portfolio user" so discovery/chat/calling have someone
    // real to find - not something a single-browser demo session could
    // otherwise show. ----
    const PRIYA_ID = 'demo-priya';
    DB.profiles.push({
      id: PRIYA_ID, email: 'priya@example.com', mobile: '+919812345678', full_name: 'Priya Sharma',
      username: 'priya.sharma', preferred_currency: 'INR', is_admin: false, created_at: nowIso(), updated_at: nowIso(),
    });
    DB.user_privacy_settings.push({
      user_id: PRIYA_ID, who_can_find_me: 'Anyone', who_can_message_me: 'Anyone', who_can_call_me: 'Contacts',
      show_online_status: true, show_last_seen: true, show_read_receipts: true, show_profile_photo: true,
      allow_contact_discovery: true, allow_group_invitations: true, allow_call_invitations: true,
      created_at: nowIso(), updated_at: nowIso(),
    });
    DB.user_privacy_settings.push({
      user_id: DEMO_USER.id, who_can_find_me: 'Contacts', who_can_message_me: 'Contacts', who_can_call_me: 'Contacts',
      show_online_status: true, show_last_seen: true, show_read_receipts: true, show_profile_photo: true,
      allow_contact_discovery: true, allow_group_invitations: true, allow_call_invitations: true,
      created_at: nowIso(), updated_at: nowIso(),
    });

    const familyGroup = { id: genId('contact_groups'), user_id: DEMO_USER.id, name: 'Family', created_at: nowIso() };
    const investFriendsGroup = { id: genId('contact_groups'), user_id: DEMO_USER.id, name: 'Investment Friends', created_at: nowIso() };
    DB.contact_groups.push(familyGroup, investFriendsGroup);

    function makeContact(fields) {
      const row = Object.assign({
        id: genId('contacts'), owner_user_id: DEMO_USER.id, tags: [], interests: [], custom_fields: {},
        favorite: false, created_at: nowIso(), updated_at: nowIso(),
      }, fields);
      recomputeContactColumns(row);
      applyContactDisplayNameDefault(row);
      DB.contacts.push(row);
      auditInsert('contacts', row);
      return row;
    }

    const priyaContact = makeContact({
      first_name: 'Priya', last_name: 'Sharma', tags: ['Friend', 'Investor'], favorite: true,
      family_relationship: null, company: 'Sharma Capital Advisors', job_title: 'Financial Consultant',
      linked_user_id: PRIYA_ID,
    });
    DB.contact_phones.push({ id: genId('contact_phones'), contact_id: priyaContact.id, user_id: DEMO_USER.id, phone_number: '+919812345678', country_code: '+91', label: 'Primary', is_primary: true, is_whatsapp: true, is_verified: true, created_at: nowIso() });
    DB.contact_emails.push({ id: genId('contact_emails'), contact_id: priyaContact.id, user_id: DEMO_USER.id, email: 'priya@example.com', label: 'Primary', is_primary: true, created_at: nowIso() });
    DB.contact_group_members.push({ id: genId('contact_group_members'), group_id: investFriendsGroup.id, contact_id: priyaContact.id, user_id: DEMO_USER.id, added_at: nowIso() });
    DB.contact_notes.push({ id: genId('contact_notes'), contact_id: priyaContact.id, user_id: DEMO_USER.id, note_text: 'Met at the investor meetup - good source of gold scheme recommendations.', created_at: nowIso() });

    const raviContact = makeContact({
      first_name: 'Ravi', last_name: 'Kumar', tags: ['Family'], family_relationship: 'Brother',
      birthday: iso(today),
    });
    DB.contact_phones.push({ id: genId('contact_phones'), contact_id: raviContact.id, user_id: DEMO_USER.id, phone_number: '+919900011122', country_code: '+91', label: 'Primary', is_primary: true, is_whatsapp: true, is_verified: false, created_at: nowIso() });
    DB.contact_group_members.push({ id: genId('contact_group_members'), group_id: familyGroup.id, contact_id: raviContact.id, user_id: DEMO_USER.id, added_at: nowIso() });
    DB.contact_reminders.push({ id: genId('contact_reminders'), contact_id: raviContact.id, user_id: DEMO_USER.id, remind_at: nowIso(), message: 'Call Ravi to wish him for his birthday.', is_done: false, created_at: nowIso() });

    const amitContact = makeContact({
      first_name: 'Amit', last_name: 'Traders', tags: ['Business', 'Client'],
      company: 'Amit Traders Pvt Ltd', job_title: 'Proprietor', industry: 'Wholesale Trading',
    });
    DB.contact_phones.push({ id: genId('contact_phones'), contact_id: amitContact.id, user_id: DEMO_USER.id, phone_number: '+919988877766', country_code: '+91', label: 'Work', is_primary: true, is_whatsapp: false, is_verified: false, created_at: nowIso() });
    DB.contact_emails.push({ id: genId('contact_emails'), contact_id: amitContact.id, user_id: DEMO_USER.id, email: 'amit@amittraders.example', label: 'Work', is_primary: true, created_at: nowIso() });
    DB.contact_addresses.push({ id: genId('contact_addresses'), contact_id: amitContact.id, user_id: DEMO_USER.id, address_type: 'Work', line1: '12 Market Road', city: 'Mumbai', state: 'Maharashtra', country: 'India', postal_code: '400001', created_at: nowIso() });
    DB.contact_important_dates.push({ id: genId('contact_important_dates'), contact_id: amitContact.id, user_id: DEMO_USER.id, date_type: 'Renewal', date: iso(new Date(today.getFullYear(), today.getMonth() + 1, 1)), label: 'Supply contract renewal', reminder_offset_days: 7, created_at: nowIso() });

    // Direct chat with Priya - a short history including a reaction and an edited message.
    const directConv = { id: genId('conversations'), type: 'DIRECT', created_by: DEMO_USER.id, name: null, photo_path: null, description: null, created_at: nowIso(), updated_at: nowIso(), last_message_at: nowIso() };
    DB.conversations.push(directConv);
    DB.conversation_members.push(
      { id: genId('conversation_members'), conversation_id: directConv.id, user_id: DEMO_USER.id, role: 'OWNER', joined_at: nowIso(), history_visible_from: null, archived: false, pinned: true },
      { id: genId('conversation_members'), conversation_id: directConv.id, user_id: PRIYA_ID, role: 'MEMBER', joined_at: nowIso(), history_visible_from: null, archived: false, pinned: false },
    );
    function pushMessage(convId, senderId, content, opts) {
      const row = Object.assign({
        id: genId('messages'), conversation_id: convId, sender_id: senderId, message_type: 'TEXT',
        content, status: 'SENT', created_at: nowIso(), updated_at: nowIso(), edited_at: null, deleted_at: null,
        reply_to_message_id: null, forwarded_from_message_id: null,
      }, opts || {});
      DB.messages.push(row);
      auditInsert('messages', row);
      return row;
    }
    pushMessage(directConv.id, PRIYA_ID, 'Hi! Saw your question about gold schemes in the community room.');
    const myReply = pushMessage(directConv.id, DEMO_USER.id, 'Yes! Was wondering if the 11+1 scheme is worth it.');
    pushMessage(directConv.id, PRIYA_ID, 'Worth it if you can commit to all 11 months - the bonus month is the whole point.');
    const editedMsg = pushMessage(directConv.id, DEMO_USER.id, 'Makes sense, thanks!');
    DB.message_edits.push({ id: genId('message_edits'), message_id: editedMsg.id, previous_content: 'Makes sense, thnx!', edited_at: nowIso() });
    editedMsg.edited_at = nowIso();
    DB.message_reactions.push({ id: genId('message_reactions'), message_id: myReply.id, user_id: PRIYA_ID, reaction: '\u{1F44D}', created_at: nowIso() });
    DB.message_reads.push({ id: genId('message_reads'), message_id: editedMsg.id, user_id: PRIYA_ID, read_at: nowIso() });

    // Group chat - Priya joined partway through, so she shouldn't see the
    // earliest message (demonstrates Section 16's history-privacy rule).
    const groupConv = { id: genId('conversations'), type: 'GROUP', created_by: DEMO_USER.id, name: 'Investment Friends', photo_path: null, description: 'Just us talking gold schemes and FDs.', created_at: nowIso(), updated_at: nowIso(), last_message_at: nowIso() };
    DB.conversations.push(groupConv);
    DB.conversation_members.push(
      { id: genId('conversation_members'), conversation_id: groupConv.id, user_id: DEMO_USER.id, role: 'OWNER', joined_at: nowIso(), history_visible_from: null, archived: false, pinned: false },
    );
    pushMessage(groupConv.id, DEMO_USER.id, 'Created this group for anyone comparing notes on gold schemes and FDs.');
    const priyaJoinCutoff = nowIso();
    DB.conversation_members.push(
      { id: genId('conversation_members'), conversation_id: groupConv.id, user_id: PRIYA_ID, role: 'MEMBER', joined_at: priyaJoinCutoff, history_visible_from: priyaJoinCutoff, archived: false, pinned: false },
    );
    pushMessage(groupConv.id, PRIYA_ID, 'Thanks for the add! Happy to share what I know.');

    // One missed call from Priya, demonstrating call history + the Missed
    // Call notification (both the calls row and the notification are
    // seeded directly, since there's no cron sweep running in Demo Mode).
    const missedCall = {
      id: genId('calls'), conversation_id: directConv.id, caller_id: PRIYA_ID, receiver_id: DEMO_USER.id,
      call_type: 'VOICE', started_at: nowIso(), answered_at: null, ended_at: nowIso(), duration: 0, status: 'MISSED',
    };
    DB.calls.push(missedCall);
    DB.notifications.push({
      id: genId('notifications'), user_id: DEMO_USER.id, type: 'Missed Call',
      title: 'Missed call from Priya Sharma', message: 'VOICE call missed.', priority: 'Medium',
      channel: 'In-app', status: 'Pending', scheduled_at: nowIso(), created_at: nowIso(),
    });

    DB.community_messages.push(
      { id: genId('community_messages'), user_id: DEMO_USER.id, message: 'Welcome to the community room - ask anything here.', created_at: nowIso() },
      { id: genId('community_messages'), user_id: DEMO_USER.id, message: 'This is sample data, so it is just you talking to yourself for now!', created_at: nowIso() },
    );
    DB.notes.push({ id: genId('notes'), user_id: DEMO_USER.id, title: 'Sample note', content: 'Notes are private - only you can see these, not even admin.', created_at: nowIso(), updated_at: nowIso() });
    const demoTicket = {
      id: genId('support_tickets'), user_id: DEMO_USER.id, subject: 'Sample resolved ticket',
      category: 'Excel/Import Issue', priority: 'Medium', assigned_to: DEMO_USER.id,
      status: 'Resolved', first_response_at: nowIso(), resolution_rating: 5,
      created_at: nowIso(), updated_at: nowIso(), resolved_at: nowIso(),
    };
    demoTicket.ticket_number = 'TKT-' + String(demoTicket.id).padStart(5, '0');
    DB.support_tickets.push(demoTicket);
    DB.ticket_messages.push(
      { id: genId('ticket_messages'), ticket_id: demoTicket.id, sender_id: DEMO_USER.id, is_admin_reply: false, message: 'How do I mark a payment as received?', created_at: nowIso() },
      { id: genId('ticket_messages'), ticket_id: demoTicket.id, sender_id: DEMO_USER.id, is_admin_reply: true, message: 'Go to Payments, find the row in the schedule, and click Record.', created_at: nowIso() },
    );
    DB.ticket_internal_notes.push({
      id: genId('ticket_internal_notes'), ticket_id: demoTicket.id, admin_user_id: DEMO_USER.id,
      note: 'Confirmed via screen share - user was looking at the Schedule tab, not the Ledger tab.', created_at: nowIso(),
    });

    // ---- Feature Suggestions (034_help_support_suggestions.sql) - a
    // spread across statuses/categories/vote counts so Roadmap, My
    // Suggestions, and voting are all exercisable immediately. ----
    const sugg1 = {
      id: genId('feature_suggestions'), user_id: DEMO_USER.id, title: 'Automatic bank statement import',
      category: 'Integration', description: 'Connect a bank account and pull transactions automatically.',
      problem_being_solved: 'Manually entering every transaction is tedious.', suggested_solution: 'Bank feed integration.',
      expected_benefit: 'Saves time, fewer missed entries.', priority: 'High', related_feature: null,
      notify_on_implement: true, status: 'Planned', created_at: nowIso(), updated_at: nowIso(),
    };
    sugg1.suggestion_number = 'SUG-' + String(sugg1.id).padStart(5, '0');
    const sugg2 = {
      id: genId('feature_suggestions'), user_id: DEMO_USER.id, title: 'Gold Intelligence 3-month historical comparison',
      category: 'Existing Feature Improvement', description: 'Show a rolling 3-month comparison chart, not just single-day change.',
      problem_being_solved: 'Hard to see the trend at a glance.', suggested_solution: 'Add a 3-month toggle to the existing chart.',
      expected_benefit: 'Faster trend reading.', priority: 'Medium', related_feature: 'Gold Intelligence',
      notify_on_implement: true, status: 'Under Review', created_at: nowIso(), updated_at: nowIso(),
    };
    sugg2.suggestion_number = 'SUG-' + String(sugg2.id).padStart(5, '0');
    const sugg3 = {
      id: genId('feature_suggestions'), user_id: DEMO_USER.id, title: 'Dashboard drag-and-drop widgets',
      category: 'UI/UX', description: 'Let me rearrange the dashboard cards myself.',
      problem_being_solved: null, suggested_solution: null, expected_benefit: 'More personal dashboard layout.',
      priority: 'Low', related_feature: 'Dashboard', notify_on_implement: false, status: 'Submitted',
      created_at: nowIso(), updated_at: nowIso(),
    };
    sugg3.suggestion_number = 'SUG-' + String(sugg3.id).padStart(5, '0');
    DB.feature_suggestions.push(sugg1, sugg2, sugg3);
    DB.suggestion_votes.push(
      { id: genId('suggestion_votes'), suggestion_id: sugg1.id, user_id: DEMO_USER.id, created_at: nowIso() },
      { id: genId('suggestion_votes'), suggestion_id: sugg1.id, user_id: FAMILY_MEMBER_ID, created_at: nowIso() },
      { id: genId('suggestion_votes'), suggestion_id: sugg2.id, user_id: FAMILY_MEMBER_ID, created_at: nowIso() },
    );
    DB.suggestion_internal_notes.push({
      id: genId('suggestion_internal_notes'), suggestion_id: sugg1.id, admin_user_id: DEMO_USER.id,
      note: 'Checked Plaid/Yodlee pricing - worth prioritizing once budget allows.', created_at: nowIso(),
    });

    // ---- Gold Intelligence (019_gold_intelligence.sql) - seeded so the
    // whole feature (chart, moving averages, projections, Gold Scheme
    // panel) is fully exercisable without a live provider/Edge Function,
    // which can never be reached from Demo Mode. ----
    DB.gold_providers.push(
      { key: 'metalpriceapi', kind: 'metalpriceapi', display_name: 'MetalpriceAPI', requests_limit: 100, requests_used_this_period: 7, period_reset_at: iso(new Date(today.getFullYear(), today.getMonth() + 1, 1)), last_fetch_at: null, last_fetch_status: 'never', last_error: null, custom_config: null, created_at: nowIso(), updated_at: nowIso() },
      { key: 'goldapi_io', kind: 'goldapi_io', display_name: 'GoldAPI.io', requests_limit: 500, requests_used_this_period: 12, period_reset_at: iso(new Date(today.getFullYear(), today.getMonth() + 1, 1)), last_fetch_at: null, last_fetch_status: 'never', last_error: null, custom_config: null, created_at: nowIso(), updated_at: nowIso() },
      { key: 'goldprice_dev', kind: 'goldprice_dev', display_name: 'goldprice.dev (free, no key needed)', requests_limit: null, requests_used_this_period: 0, period_reset_at: iso(new Date(today.getFullYear(), today.getMonth() + 1, 1)), last_fetch_at: nowIso(), last_fetch_status: 'ok', last_error: null, custom_config: null, created_at: nowIso(), updated_at: nowIso() },
    );
    DB.gold_settings.push({ id: 1, active_provider_key: 'goldprice_dev', refresh_cadence: 'daily', updated_at: nowIso() });

    // ---- AI Copilot providers (039_ai_copilot_providers.sql) - mirrors the
    // gold provider seed above; defaults to Google Gemini since that's the
    // key the user actually has. ----
    DB.ai_providers.push(
      { key: 'anthropic', kind: 'anthropic', display_name: 'Anthropic Claude', model_id: 'claude-sonnet-5', requests_limit: null, last_used_at: null, last_status: 'never', last_error: null, custom_config: null, created_at: nowIso(), updated_at: nowIso() },
      { key: 'google_gemini', kind: 'google_gemini', display_name: 'Google Gemini (AI Studio)', model_id: 'gemini-2.5-flash', requests_limit: 250, last_used_at: null, last_status: 'never', last_error: null, custom_config: null, created_at: nowIso(), updated_at: nowIso() },
    );
    DB.ai_settings.push({ id: 1, active_provider_key: 'google_gemini', updated_at: nowIso() });

    // 90 days of simulated daily 24K/22K/18K prices - a bounded random walk
    // with a gentle upward drift (not literal noise), ending near real
    // current-day reference values so the "Live Price" card looks plausible.
    // provider_key is 'goldprice_dev' throughout since that's the seeded
    // active provider.
    (function seedGoldHistory() {
      let rngSeed = 42;
      const rng = () => { rngSeed = (rngSeed * 9301 + 49297) % 233280; return rngSeed / 233280; };
      let price24k = 13800;
      const days = 90;
      for (let i = days; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const drift = 1 + (0.10 / days); // ~10% total drift over the window, matching gold's real 2025-26 run
        const noise = 1 + (rng() - 0.5) * 0.01; // +-0.5% daily wobble
        price24k = Math.round(price24k * drift * noise);
        const observedAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 30).toISOString();
        [['24K', 1], ['22K', 22 / 24], ['18K', 18 / 24]].forEach(([purity, ratio]) => {
          DB.gold_price_observations.push({
            id: genId('gold_price_observations'), provider_key: 'goldprice_dev', price_type: 'SPOT', purity,
            currency: 'INR', unit: 'gram', price: Math.round(price24k * ratio * 100) / 100,
            observed_at: observedAt, market: null, city: null, is_benchmark: false, is_retail: false, created_at: observedAt,
          });
        });
      }
    })();

    DB.gold_purchases.push({
      id: genId('gold_purchases'), user_id: DEMO_USER.id, purchase_date: iso(new Date(today.getFullYear(), today.getMonth() - 5, 10)),
      purity: '22K', price_per_gram: 9200, grams: 10, net_grams: 9.8, making_charges: 800, gst: 552, other_charges: 0, discount: 0,
      amount_paid: 93352, source: 'Sample Jeweller', notes: 'Anniversary gift purchase.', created_at: nowIso(), updated_at: nowIso(),
    });

    // Accounts & Liabilities, and Net Worth - a bank account, a cash
    // balance, and one liability, plus a few months of backdated snapshots
    // so the historical chart has something real to show immediately.
    DB.accounts.push({
      id: genId('accounts'), user_id: DEMO_USER.id, account_name: 'HDFC Savings', account_type: 'Bank',
      institution: 'HDFC Bank', account_number_masked: 'XXXX4521', currency: 'INR',
      opening_balance: 200000, current_balance: 265000, is_active: true, notes: 'Primary salary account.',
      created_at: nowIso(), updated_at: nowIso(),
    });
    DB.accounts.push({
      id: genId('accounts'), user_id: DEMO_USER.id, account_name: 'Cash on Hand', account_type: 'Cash',
      institution: null, account_number_masked: null, currency: 'INR',
      opening_balance: 15000, current_balance: 12500, is_active: true, notes: null,
      created_at: nowIso(), updated_at: nowIso(),
    });
    DB.liabilities.push({
      id: genId('liabilities'), user_id: DEMO_USER.id, liability_name: 'Two-Wheeler Loan', liability_type: 'Vehicle Loan',
      lender: 'Sample Finance Ltd', principal_amount: 90000, outstanding_amount: 34000, interest_rate: 9.5,
      emi_amount: 3200, start_date: iso(new Date(today.getFullYear() - 1, today.getMonth(), 5)),
      end_date: iso(new Date(today.getFullYear() + 1, today.getMonth(), 5)),
      next_payment_date: iso(new Date(today.getFullYear(), today.getMonth() + 1, 5)),
      is_active: true, notes: null, created_at: nowIso(), updated_at: nowIso(),
    });
    // Automation Center - a couple of example rules so the list isn't empty
    // on first visit. Evaluation itself isn't simulated in Demo Mode (see
    // the fn_admin_run_automation mock's own comment) - these exist to show
    // the CRUD/list UI working, not to demonstrate a live-firing rule.
    DB.automation_rules.push({
      id: genId('automation_rules'), user_id: DEMO_USER.id, rule_type: 'ACCOUNT_BALANCE_BELOW',
      name: 'Warn me if Cash on Hand runs low', target_id: null, threshold_value: 5000, lookback_days: null,
      is_active: true, last_triggered_at: null, created_at: nowIso(), updated_at: nowIso(),
    });
    DB.automation_rules.push({
      id: genId('automation_rules'), user_id: DEMO_USER.id, rule_type: 'NET_WORTH_CHANGE_PCT',
      name: 'Alert on a Net Worth drop', target_id: null, threshold_value: -5, lookback_days: 30,
      is_active: true, last_triggered_at: null, created_at: nowIso(), updated_at: nowIso(),
    });

    (function seedNetWorthHistory() {
      // Coarse, gently-rising totals across 3 backdated months plus today -
      // real precision isn't the point here, a plausible upward trend for
      // the chart is.
      // Roughly consistent with the actual seeded accounts/deals/gold totals
      // (~7.7L assets / 34k liabilities today) - a plausible gentle climb,
      // not an arbitrary jump, so the "Growth vs ~30 Days Ago" figure on the
      // Net Worth tab reads sensibly in a walkthrough.
      const points = [
        { monthsAgo: 3, assets: 705000, liabilities: 40000 },
        { monthsAgo: 2, assets: 725000, liabilities: 38000 },
        { monthsAgo: 1, assets: 750000, liabilities: 36000 },
      ];
      points.forEach((p) => {
        const d = new Date(today.getFullYear(), today.getMonth() - p.monthsAgo, 15);
        DB.net_worth_snapshots.push({
          id: genId('net_worth_snapshots'), user_id: DEMO_USER.id, snapshot_date: iso(d),
          total_assets: p.assets, total_liabilities: p.liabilities, net_worth: p.assets - p.liabilities,
          breakdown: { accounts: 260000, deals: 0, gold: 0 }, created_at: d.toISOString(),
        });
      });
    })();
  }

  let session = null;
  const authListeners = [];
  function fireAuthChange() { authListeners.forEach((cb) => cb('SIGNED_IN', session)); }
  const auth = {
    async signUp({ email }) { session = { user: { id: DEMO_USER.id, email } }; fireAuthChange(); return { data: { user: session.user, session }, error: null }; },
    async signInWithPassword({ email }) { session = { user: { id: DEMO_USER.id, email } }; fireAuthChange(); return { data: { user: session.user, session }, error: null }; },
    async signOut() { session = null; fireAuthChange(); return { error: null }; },
    async getSession() { return { data: { session } }; },
    onAuthStateChange(cb) { authListeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
  };

  const storageFiles = {};
  const storage = {
    from() {
      return {
        async upload(path, file) { storageFiles[path] = file; return { data: { path }, error: null }; },
        async createSignedUrl(path) { return { data: { signedUrl: 'about:blank#demo-file-' + encodeURIComponent(path) }, error: null }; },
        async remove(paths) { paths.forEach((p) => delete storageFiles[p]); return { data: null, error: null }; },
        // One level at a time, same shape the real Storage API returns -
        // an immediate child that's itself a folder comes back with
        // `id: null` so a caller doing a recursive walk (see api.js's
        // clearMyData) knows to list one level deeper rather than treating
        // it as a file to remove directly.
        async list(prefix) {
          const p = prefix ? prefix + '/' : '';
          const seen = new Map();
          Object.keys(storageFiles).forEach((path) => {
            if (!path.startsWith(p)) return;
            const rest = path.slice(p.length);
            const slash = rest.indexOf('/');
            if (slash === -1) seen.set(rest, { name: rest, id: genId('storage_object') });
            else { const folder = rest.slice(0, slash); if (!seen.has(folder)) seen.set(folder, { name: folder, id: null }); }
          });
          return { data: [...seen.values()], error: null };
        },
      };
    },
  };

  function createClient() {
    session = { user: DEMO_USER };
    return {
      auth,
      storage,
      from(table) { return new QB(table); },
      channel(name) { return makeChannel(name); },
      removeChannel(handle) { removeChannel(handle); },
      functions: {
        // Real supabase-js resolves { data, error } from invoke(); demo
        // mode's own gold-price-fetch stand-in follows the same shape so
        // api.js's refreshGoldPrice() needs no Demo Mode branch at all.
        async invoke(name, opts) {
          await new Promise((r) => setTimeout(r, 200));
          const body = (opts && opts.body) || {};
          if (name === 'gold-price-fetch') {
            try {
              const result = refreshGoldPriceMock();
              return result.ok ? { data: result, error: null } : { data: null, error: { message: result.error } };
            } catch (e) { return { data: null, error: { message: e.message } }; }
          }
          if (name === 'send-notification-emails') {
            // Demo Mode has no real Resend account to send through - this
            // just mirrors the real function's decision logic (frequency
            // due-check, DND) against the mock DB so the "Trigger Emails
            // Now" button's response looks like the real thing, then marks
            // matching notifications as emailed so the UI reflects it.
            const pref = DB.notification_preferences.find((p) => p.user_id === DEMO_USER.id);
            if (!pref || pref.email_frequency === 'never') return { data: { ok: true, digestsSent: 0, notificationsEmailed: 0, usersSkipped: 1, usersFailed: 0, errors: [] }, error: null };
            const isSnoozed = pref.snoozed_until && new Date(pref.snoozed_until) > new Date();
            if (isSnoozed) return { data: { ok: true, digestsSent: 0, notificationsEmailed: 0, usersSkipped: 1, usersFailed: 0, errors: [] }, error: null };
            const pending = DB.notifications.filter((n) => n.user_id === DEMO_USER.id && !n.email_sent_at);
            pending.forEach((n) => { n.email_sent_at = nowIso(); });
            pref.last_email_digest_sent_at = nowIso();
            return { data: { ok: true, digestsSent: pending.length ? 1 : 0, notificationsEmailed: pending.length, usersSkipped: pending.length ? 0 : 1, usersFailed: 0, errors: [] }, error: null };
          }
          if (name === 'send-web-push') {
            // Mirrors the real function's decision logic (push_enabled +
            // DND + "do they have any subscribed device") against the
            // mock DB, marking matching notifications push_sent_at like
            // the real sweep would - Demo Mode obviously can't deliver an
            // actual browser push.
            const pref = DB.notification_preferences.find((p) => p.user_id === DEMO_USER.id);
            const pushEnabled = !!(pref && pref.push_enabled);
            const isSnoozed = pref && pref.snoozed_until && new Date(pref.snoozed_until) > new Date();
            const hasSub = DB.push_subscriptions.some((s) => s.user_id === DEMO_USER.id);
            const pending = DB.notifications.filter((n) => n.user_id === DEMO_USER.id && !n.push_sent_at);
            if (!pushEnabled || isSnoozed || !hasSub) {
              pending.forEach((n) => { n.push_sent_at = nowIso(); });
              return { data: { ok: true, sent: 0, skipped: pending.length, failed: 0, errors: [] }, error: null };
            }
            pending.forEach((n) => { n.push_sent_at = nowIso(); });
            return { data: { ok: true, sent: pending.length, skipped: 0, failed: 0, errors: [] }, error: null };
          }
          if (name === 'admin-user-management') {
            const isAdmin = !!(DB.profiles.find((p) => p.id === DEMO_USER.id) || {}).is_admin;
            if (!isAdmin) return { data: { ok: false, error: 'Only an admin can do this.' }, error: null };
            if (body.action === 'create') {
              if (!body.email) return { data: { ok: false, error: 'Email is required.' }, error: null };
              const tempPassword = 'Demo' + Math.random().toString(36).slice(2, 10) + '!9';
              const newId = 'demo-created-' + genId('profiles');
              DB.profiles.push({ id: newId, email: body.email, full_name: body.fullName || body.email, is_admin: false, is_active: true, created_at: nowIso(), updated_at: nowIso() });
              return { data: { ok: true, userId: newId, email: body.email, tempPassword }, error: null };
            }
            if (body.action === 'deactivate' || body.action === 'reactivate') {
              const target = DB.profiles.find((p) => p.id === body.userId);
              if (!target) return { data: { ok: false, error: 'User not found.' }, error: null };
              if (target.id === DEMO_USER.id) return { data: { ok: false, error: 'You cannot deactivate your own account.' }, error: null };
              target.is_active = body.action === 'reactivate';
              return { data: { ok: true }, error: null };
            }
            if (body.action === 'delete') {
              const target = DB.profiles.find((p) => p.id === body.userId);
              if (!target) return { data: { ok: false, error: 'User not found.' }, error: null };
              if ((target.email || '').toLowerCase() !== (body.confirmEmail || '').toLowerCase()) {
                return { data: { ok: false, error: 'Confirmation email does not match this user - nothing was deleted.' }, error: null };
              }
              DB.profiles = DB.profiles.filter((p) => p.id !== target.id);
              return { data: { ok: true }, error: null };
            }
            return { data: { ok: false, error: 'Unknown action: ' + body.action }, error: null };
          }
          if (name === 'benchmark-fetch') {
            // Demo Mode can't reach Yahoo Finance either - this just
            // confirms the seeded 1-year history stays present, mirroring
            // the real function's "ok" response shape.
            return { data: { ok: true, results: { NIFTY50: { ok: true, rows: DB.benchmark_observations.filter((o) => o.symbol === 'NIFTY50').length }, SENSEX: { ok: true, rows: DB.benchmark_observations.filter((o) => o.symbol === 'SENSEX').length } } }, error: null };
          }
          if (name === 'log-login') {
            DB.login_events.push({
              id: genId('login_events'), user_id: DEMO_USER.id, occurred_at: nowIso(), consent_given: !!body.consent,
              ip_address: body.consent ? '203.0.113.42' : null, city: body.consent ? 'Mumbai' : null, region: body.consent ? 'Maharashtra' : null, country: body.consent ? 'India' : null,
              user_agent: body.consent ? body.userAgent : null, browser: body.consent ? 'Chrome' : null, os: body.consent ? 'Windows' : null, device_type: body.consent ? 'Desktop' : null,
            });
            return { data: { ok: true }, error: null };
          }
          if (name === 'ai-copilot') {
            // No real Anthropic call in Demo Mode, ever - a canned response
            // that still reflects the real context payload the client sent
            // (so the quota/limit mechanics are genuinely exercisable),
            // mirroring the DAILY_LIMIT the real Edge Function enforces.
            const DAILY_LIMIT = 20;
            const today = App.utils.todayISO();
            let usage = DB.copilot_usage.find((u) => u.user_id === DEMO_USER.id && u.usage_date === today);
            if (!usage) { usage = { user_id: DEMO_USER.id, usage_date: today, requests_used: 0 }; DB.copilot_usage.push(usage); }
            usage.requests_used += 1;
            if (usage.requests_used > DAILY_LIMIT) {
              return { data: { ok: false, error: `Daily question limit reached (${DAILY_LIMIT}/day) - resets tomorrow.`, requestsUsed: usage.requests_used, dailyLimit: DAILY_LIMIT }, error: null };
            }
            const ctx = body.context || {};
            const nw = ctx.netWorth != null ? App.utils.fmtMoney(ctx.netWorth) : null;
            const aiSettings = DB.ai_settings[0];
            const aiProvider = DB.ai_providers.find((p) => p.key === (aiSettings && aiSettings.active_provider_key));
            const providerDisplayName = aiProvider ? aiProvider.display_name : 'the configured provider';
            const answer = `(Demo Mode - no real ${providerDisplayName} call is made here) Based on the numbers loaded for your account${nw ? `, your Net Worth is currently ${nw}` : ''}. In a real deployment, ${providerDisplayName} would answer "${body.question}" using exactly this data, never inventing a figure not shown above.`;
            if (aiProvider) { aiProvider.last_used_at = nowIso(); aiProvider.last_status = 'ok'; }
            return { data: { ok: true, answer, providerDisplayName, requestsUsed: usage.requests_used, dailyLimit: DAILY_LIMIT }, error: null };
          }
          return { data: null, error: { message: 'Unknown demo function: ' + name } };
        },
      },
      async rpc(fn, params) {
        try {
          if (fn === 'fn_generate_payment_schedule') return { data: generateSchedule(params.p_deal_id), error: null };
          if (fn === 'fn_record_payment') return { data: recordPayment(params), error: null };
          if (fn === 'get_display_names') {
            const ids = params.p_user_ids || [];
            return { data: DB.profiles.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, full_name: p.full_name || 'User' })), error: null };
          }
          if (fn === 'fn_admin_table_stats') {
            if (!DB.profiles.find((p) => p.id === DEMO_USER.id && p.is_admin)) return { data: null, error: { message: 'Only an admin can run this.' } };
            // Real disk size isn't something JS in a browser can measure -
            // this fabricates a plausible size proportional to row count
            // (roughly 200 bytes/row plus a fixed table overhead) purely so
            // the Database Health panel has something to sort/render in
            // Demo Mode; the real function returns the real
            // pg_total_relation_size() instead.
            return {
              data: Object.keys(DB).map((table) => {
                const rows = DB[table].length;
                const bytes = 8192 + rows * 200;
                return { table_name: table, estimated_rows: rows, total_size_bytes: bytes, total_size_pretty: bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : (bytes / 1024).toFixed(0) + ' kB' };
              }).sort((a, b) => b.total_size_bytes - a.total_size_bytes),
              error: null,
            };
          }
          if (fn === 'fn_admin_run_automation') {
            if (!DB.profiles.find((p) => p.id === DEMO_USER.id && p.is_admin)) return { data: null, error: { message: 'Only an admin can run this.' } };
            // Same standing gap as every other cron-only generator this mock
            // never simulates (gold alerts, budget alerts, recurring
            // reminders, ...) - fn_evaluate_automation_rules (037) is
            // included in that same no-op, not a regression specific to
            // Automation Center. Rule CRUD itself is fully real in Demo Mode;
            // only the periodic evaluation isn't simulated.
            return { data: 'ok', error: null };
          }
          if (fn === 'fn_generate_recurring_occurrences') return { data: generateRecurringOccurrences(params.p_recurring_item_id), error: null };
          if (fn === 'fn_confirm_recurring_occurrence') return { data: confirmRecurringOccurrence(params), error: null };
          if (fn === 'fn_pause_recurring_item') { pauseRecurringItem(params); return { data: null, error: null }; }
          if (fn === 'fn_resume_recurring_item') { resumeRecurringItem(params); return { data: null, error: null }; }
          if (fn === 'find_portfolio_user') return { data: findPortfolioUserMock(params.p_query), error: null };
          if (fn === 'fn_share_messages') return { data: shareMessagesMock(params), error: null };
          if (fn === 'fn_submit_guest_ticket') {
            // Demo Mode has no real concept of "not logged in" to submit
            // this as, and skips the real rate-limit check entirely - it
            // just inserts and returns a fake ticket number so the flow is
            // visibly exercisable, documented plainly as a Demo Mode gap
            // rather than silently glossed over.
            const id = genId('support_tickets');
            const ticket_number = 'TKT-' + String(id).padStart(5, '0');
            DB.support_tickets.push({
              id, ticket_number, user_id: null, subject: params.p_category, category: params.p_category,
              guest_name: params.p_guest_name, guest_email: params.p_guest_email, guest_message: params.p_guest_message,
              account_email: params.p_account_email || null,
              priority: ['Cannot Create Account', 'Forgot Password'].includes(params.p_category) ? 'High' : 'Medium',
              status: 'New', created_at: nowIso(), updated_at: nowIso(), resolved_at: null,
            });
            return { data: ticket_number, error: null };
          }
          if (fn === 'fn_clear_my_data') { clearPersonalData(DEMO_USER.id); return { data: null, error: null }; }
          if (fn === 'fn_admin_clear_all_data') {
            if (!DB.profiles.find((p) => p.id === DEMO_USER.id && p.is_admin)) return { data: null, error: { message: 'Only an admin can run this.' } };
            CLEAR_DATA_TABLES.forEach((table) => { DB[table] = []; });
            return { data: null, error: null };
          }
          return { data: null, error: { message: 'Unknown demo RPC: ' + fn } };
        } catch (e) { return { data: null, error: { message: e.message } }; }
      },
    };
  }

  return { createClient, seed, DEMO_USER };
})();
