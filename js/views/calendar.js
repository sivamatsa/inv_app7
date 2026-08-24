/* Calendar (spec Section 46 nav; Section 72 "Recurring Investment Calendar").
   Month grid of expected deal payments/maturities AND recurring occurrences
   in one place - deliberately one calendar, not two (see the plan file's
   scope note), with a type filter chip-row so either source can be viewed
   alone. Recurring occurrences are visually distinct (purple) from deal
   payments (teal) and maturities (gold) even though they share a grid.

   Also hosts calendar_events (022_calendar_events_email_digest_audit_toggle.sql)
   - manual, user-created entries (birthdays, anniversaries, countdowns,
   reminders, arbitrary events) that are NOT tied to a Contact (unlike
   contacts.js's own Important Dates, which are) and NOT tied to a
   deal/recurring item. Shown in green on the grid; reminders fire in
   advance via fn_generate_calendar_event_reminders(), same unified
   notifications table as everything else. */
window.App = window.App || {};

(function () {
  let viewMonth = new Date().getMonth();
  let viewYear = new Date().getFullYear();
  let typeFilter = 'All';

  const EVENT_TYPES = ['Birthday', 'Anniversary', 'Reminder', 'Important Date', 'Countdown', 'Event', 'Custom'];
  const EVENT_FIELDS = [
    { key: 'title', label: 'Title', required: true, span: 2 },
    { key: 'event_type', label: 'Type', type: 'select', options: EVENT_TYPES, required: true },
    { key: 'event_date', label: 'Date', type: 'date', required: true },
    { key: 'recurring_yearly', label: 'Repeats Every Year (e.g. Birthday/Anniversary)', type: 'checkbox' },
    { key: 'reminder_days_before_text', label: 'Remind Me (days before, comma-separated - 0 = on the day)', span: 2, placeholder: '7, 3, 1, 0' },
    { key: 'notes', label: 'Notes', type: 'textarea', span: 2 },
  ];

  // Birthday/Anniversary only ever make sense as year-after-year events -
  // matching by month/day regardless of the year entered (see the reminder
  // generator's SQL comment). Left unmanaged, a user typing their actual
  // birth year with "Repeats Every Year" still unchecked would create an
  // event that matches NO current or future month (recurring_yearly=false
  // requires an exact date match, and their birth year will never equal
  // this year) - it would silently never appear anywhere. Auto-syncing the
  // checkbox to the type removes that trap without removing the control -
  // it's still editable afterward for the rare one-off exception.
  const YEARLY_TYPES = new Set(['Birthday', 'Anniversary']);

  function openEventWizard(existing) {
    const values = Object.assign(
      { event_type: 'Event', recurring_yearly: false, reminder_days_before_text: '7, 3, 1, 0' },
      existing || {},
      existing ? { reminder_days_before_text: (existing.reminder_days_before || []).join(', ') } : {},
    );
    App.ui.open({
      title: existing ? 'Edit Event' : 'Add Event',
      bodyHtml: `<div id="eventFormHost"></div><div class="auth-error" id="eventFormError"></div>`,
      onMount: (body) => {
        App.utils.qs('#eventFormHost', body).innerHTML = App.ui.renderForm(EVENT_FIELDS, values);
        App.utils.qs('#fld_event_type', body).addEventListener('change', (e) => {
          if (YEARLY_TYPES.has(e.target.value)) App.utils.qs('#fld_recurring_yearly', body).value = 'true';
          else if (e.target.value === 'Countdown') App.utils.qs('#fld_recurring_yearly', body).value = 'false';
        });
      },
      actions: [
        { label: existing ? 'Save Changes' : 'Create Event', className: 'btn-gold', onClick: async () => {
          const { values: v, errors } = App.ui.readForm(EVENT_FIELDS);
          if (errors.length) { App.utils.qs('#eventFormError').textContent = 'Fill in the required fields.'; return; }
          const reminderDays = (v.reminder_days_before_text || '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 0);
          const payload = {
            title: v.title, event_type: v.event_type, event_date: v.event_date,
            recurring_yearly: v.recurring_yearly, reminder_days_before: reminderDays, notes: v.notes,
          };
          try {
            if (existing) await App.api.updateCalendarEvent(existing.id, payload);
            else await App.api.createCalendarEvent(payload);
            App.utils.toast(existing ? 'Event updated' : 'Event created');
            App.ui.close();
            App.router.refreshCurrent();
          } catch (e) { App.utils.qs('#eventFormError').textContent = 'Could not save event: ' + (e.message || e); }
        } },
        ...(existing ? [{ label: 'Delete', className: 'btn-outline', onClick: async () => {
          if (!confirm('Delete this event? Its reminders will stop.')) return;
          try { await App.api.deleteCalendarEvent(existing.id); App.utils.toast('Event deleted'); App.ui.close(); App.router.refreshCurrent(); }
          catch (e) { App.utils.toast('Could not delete: ' + (e.message || e), 'err'); }
        } }] : []),
        { label: 'Cancel', className: 'btn-outline', onClick: App.ui.close },
      ],
    });
  }

  const TYPE_FILTERS = {
    All: null,
    Deals: 'deals-only',
    Investments: ['SIP', 'Mutual Fund', 'Gold Scheme', 'Gold Savings', 'Stocks / Shares', 'ETF', 'Recurring Deposit', 'NPS', 'Pension'],
    Bills: ['Loan / EMI', 'Credit Card Bill', 'Rent', 'Education Fee', 'Subscription', 'Membership', 'Tax Payment'],
    Insurance: ['Insurance', 'Term Insurance', 'Health Insurance', 'Life Insurance'],
    SIP: ['SIP'],
    Gold: ['Gold Scheme', 'Gold Savings'],
    Stocks: ['Stocks / Shares'],
    Rent: ['Rent'],
    'Credit Card': ['Credit Card Bill'],
    Custom: ['Custom'],
    Events: 'events-only',
    Expenses: 'expenses-only',
  };

  async function renderCalendarView() {
    const pane = App.utils.qs('#pane-calendar');
    pane.innerHTML = `
      <div class="section-title">Calendar <div class="line"></div><small>deal payments, maturities &amp; recurring commitments by day</small></div>
      <div class="panel">
        <div class="chip-row" id="calTypeFilter" style="margin-bottom:14px">${Object.keys(TYPE_FILTERS).map((g) => `<div class="chip ${g === 'All' ? 'active' : ''}" data-cal-filter="${g}">${g}</div>`).join('')}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <button class="btn btn-outline btn-sm" id="calPrev">&larr; Prev</button>
          <div class="chart-title" id="calLabel"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-gold btn-sm" id="calAddEventBtn">+ Add Event</button>
            <button class="btn btn-outline btn-sm" id="calNext">Next &rarr;</button>
          </div>
        </div>
        <div id="calGrid"></div>
        <div id="calDayDetail" class="hint"></div>
      </div>`;
    App.utils.qs('#calPrev', pane).addEventListener('click', () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } draw(); });
    App.utils.qs('#calNext', pane).addEventListener('click', () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } draw(); });
    App.utils.qs('#calAddEventBtn', pane).addEventListener('click', () => openEventWizard(null));
    App.utils.qsa('[data-cal-filter]', pane).forEach((chip) => chip.addEventListener('click', () => {
      typeFilter = chip.dataset.calFilter;
      App.utils.qsa('[data-cal-filter]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      draw();
    }));

    async function draw() {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      App.utils.qs('#calLabel', pane).textContent = `${monthNames[viewMonth]} ${viewYear}`;

      const rangeStart = App.utils.toISO(new Date(viewYear, viewMonth, 1));
      const rangeEnd = App.utils.toISO(new Date(viewYear, viewMonth + 1, 0));
      const filterValue = TYPE_FILTERS[typeFilter];
      const showDeals = filterValue === null || filterValue === 'deals-only';
      const showRecurring = filterValue === null || Array.isArray(filterValue);
      const showEvents = filterValue === null || filterValue === 'events-only';
      const showExpenses = filterValue === null || filterValue === 'expenses-only';

      const [schedule, deals, recurringOccurrences, recurringItems, calendarEvents, expenseTxns] = await Promise.all([
        showDeals ? App.api.listSchedule({ gte: { scheduled_date: rangeStart }, lte: { scheduled_date: rangeEnd } }) : [],
        showDeals ? App.api.listDeals({ gte: { maturity_date: rangeStart }, lte: { maturity_date: rangeEnd } }) : [],
        showRecurring ? App.api.listRecurringOccurrences({ gte: { due_date: rangeStart }, lte: { due_date: rangeEnd } }) : [],
        showRecurring ? App.api.listRecurringItems() : [],
        // Fetched unfiltered (not a huge personal-scale table) since a
        // recurring_yearly event's original event_date can be any past
        // year - matching "does this land in the visible month" has to
        // happen client-side below, a plain gte/lte range can't express it.
        showEvents ? App.api.listCalendarEvents() : [],
        showExpenses ? App.api.listExpenseTransactions({ gte: { transaction_date: rangeStart }, lte: { transaction_date: rangeEnd } }) : [],
      ]);
      const dealsById = {}; deals.forEach((d) => { dealsById[d.id] = d; });
      const recurringItemsById = {}; recurringItems.forEach((i) => { recurringItemsById[i.id] = i; });
      const relevantOccurrences = Array.isArray(filterValue)
        ? recurringOccurrences.filter((o) => { const item = recurringItemsById[o.recurring_item_id]; return item && filterValue.includes(item.item_type); })
        : recurringOccurrences;

      const byDay = {};
      const ensure = (day) => (byDay[day] = byDay[day] || { payments: [], maturities: [], recurring: [], events: [], expenses: [] });
      schedule.forEach((s) => { ensure(Number(s.scheduled_date.slice(8, 10))).payments.push(s); });
      deals.forEach((d) => { ensure(Number(d.maturity_date.slice(8, 10))).maturities.push(d); });
      relevantOccurrences.forEach((o) => { ensure(Number(o.due_date.slice(8, 10))).recurring.push(o); });
      expenseTxns.forEach((t) => { ensure(Number(t.transaction_date.slice(8, 10))).expenses.push(t); });
      calendarEvents.forEach((ev) => {
        const evYear = Number(ev.event_date.slice(0, 4));
        const evMonth = Number(ev.event_date.slice(5, 7)) - 1;
        const evDay = Number(ev.event_date.slice(8, 10));
        const matchesThisMonth = ev.recurring_yearly ? evMonth === viewMonth : (evMonth === viewMonth && evYear === viewYear);
        if (matchesThisMonth) ensure(evDay).events.push(ev);
      });

      const firstDow = new Date(viewYear, viewMonth, 1).getDay();
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const todayStr = App.utils.todayISO();
      const cells = [];
      for (let i = 0; i < firstDow; i++) cells.push('<div></div>');
      for (let day = 1; day <= daysInMonth; day++) {
        const info = byDay[day];
        const dateStr = App.utils.toISO(new Date(viewYear, viewMonth, day));
        const isToday = dateStr === todayStr;
        const total = info ? info.payments.reduce((s, p) => s + (p.expected_total || 0), 0) : 0;
        const recurringTotal = info ? info.recurring.reduce((s, o) => s + (o.expected_amount || 0), 0) : 0;
        const expenseTotal = info ? info.expenses.reduce((s, t) => s + (t.amount || 0), 0) : 0;
        cells.push(`<div class="chart-card" data-day="${day}" style="padding:8px;min-height:70px;cursor:pointer;${isToday ? 'border-color:var(--gold)' : ''}">
          <div style="font-size:11px;color:${isToday ? 'var(--gold)' : 'var(--text2)'};font-weight:${isToday ? 700 : 500}">${day}</div>
          ${info && info.payments.length ? `<div style="font-size:10.5px;color:var(--teal);margin-top:4px">${App.utils.fmtMoney(total)}</div>` : ''}
          ${info && info.maturities.length ? `<div style="font-size:10px;color:var(--gold);margin-top:2px">${info.maturities.length} maturing</div>` : ''}
          ${info && info.recurring.length ? `<div style="font-size:10.5px;color:var(--purple);margin-top:2px">${App.utils.fmtMoney(recurringTotal)} recurring</div>` : ''}
          ${info && info.events.length ? `<div style="font-size:10px;color:var(--green,#2ecc71);margin-top:2px">${info.events.length === 1 ? App.utils.escapeHtml(info.events[0].title) : info.events.length + ' events'}</div>` : ''}
          ${info && info.expenses.length ? `<div style="font-size:10.5px;color:#ff9f43;margin-top:2px">${App.utils.fmtMoney(expenseTotal)} expense</div>` : ''}
        </div>`);
      }
      App.utils.qs('#calGrid', pane).innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;font-size:10px;color:var(--text3);margin-bottom:6px;text-align:center">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div>${d}</div>`).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">${cells.join('')}</div>`;

      App.utils.qsa('[data-day]', pane).forEach((cell) => cell.addEventListener('click', () => {
        const day = Number(cell.dataset.day);
        const info = byDay[day] || { payments: [], maturities: [], recurring: [], events: [], expenses: [] };
        const detail = App.utils.qs('#calDayDetail', pane);
        if (!info.payments.length && !info.maturities.length && !info.recurring.length && !info.events.length && !info.expenses.length) { detail.innerHTML = 'Nothing scheduled that day.'; return; }
        const expenseStatusDot = (status) => (status === 'Paid' ? '🟢' : (status === 'Overdue' ? '🔴' : '🟡'));
        const lines = [
          ...info.payments.map((p) => `&bull; Payment expected: ${App.utils.fmtMoney(p.expected_total)} (${(dealsById[p.deal_id] || {}).deal_name || 'deal #' + p.deal_id})`),
          ...info.maturities.map((d) => `&bull; Matures: ${App.utils.escapeHtml(d.deal_name)} (${App.utils.fmtMoney(d.invested_amount)})`),
          ...info.recurring.map((o) => {
            const item = recurringItemsById[o.recurring_item_id] || {};
            return `&bull; ${App.utils.escapeHtml(item.item_name || 'Recurring item')}: ${App.utils.fmtMoney(o.expected_amount)} <span class="badge ${App.utils.statusBadgeClass(o.status)}" style="margin-left:4px">${o.status}</span>`;
          }),
          ...info.events.map((ev) => `&bull; <span data-edit-event="${ev.id}" style="cursor:pointer;text-decoration:underline">${App.utils.escapeHtml(ev.event_type)}: ${App.utils.escapeHtml(ev.title)}${ev.recurring_yearly ? ' (yearly)' : ''}</span>`),
          ...info.expenses.map((t) => `&bull; ${expenseStatusDot(t.payment_status)} ${App.utils.escapeHtml(t.item)}: ${App.utils.fmtMoney(t.amount)} <span class="hint" style="margin:0">(${t.transaction_type})</span>`),
        ];
        detail.innerHTML = `<b>${App.utils.fmtDate(new Date(viewYear, viewMonth, day))}</b><br>${lines.join('<br>')}`;
        App.utils.qsa('[data-edit-event]', detail).forEach((el) => el.addEventListener('click', () => {
          const ev = info.events.find((e) => e.id === Number(el.dataset.editEvent));
          if (ev) openEventWizard(ev);
        }));
      }));
    }

    await draw();
  }

  App.router.register('calendar', renderCalendarView);
})();
