/* AI Portfolio Copilot (038_ai_copilot_usage.sql) - this app's first live
   LLM API call. Context is assembled entirely client-side from the exact
   same computations/queries every other page here already trusts
   (computeNetWorth, computeCashFlow, the summary/aggregate API views) and
   sent alongside the question - the Edge Function never queries anything
   itself beyond the usage-cap check, so there's no second implementation of
   Net Worth/Cash Flow math to drift out of sync with the real pages.

   Ephemeral, single-user, request/response only - no conversation history
   is ever persisted (a deliberate, privacy-minimizing default; see the
   migration's own header comment). Visually modeled on chat.js's message-
   bubble structure, with none of its persistence/realtime machinery. */
window.App = window.App || {};

(function () {
  const DAILY_LIMIT = 20;
  let thread = []; // { role: 'user'|'assistant', text } - session-only, never persisted

  async function assembleContext() {
    const [netWorth, cashFlow, portfolioSummary, dealMetrics, recurringSummary, recurringConsistency, goldHoldings, expenseProjects] = await Promise.all([
      App.netWorthCalc.computeNetWorth(),
      App.cashFlowCalc.computeCashFlow(),
      App.api.getPortfolioSummary(),
      App.api.listDealMetrics(),
      App.api.getRecurringSummary(),
      App.api.listRecurringConsistency(),
      App.api.listGoldSchemeHoldings(),
      App.api.listExpenseProjects(),
    ]);

    // Per-project expense summaries - small scale (a handful of projects at
    // most for a personal app), so a Promise.all per project here is cheap.
    const expenseSummaries = await Promise.all(expenseProjects.map(async (p) => ({
      project: p.name,
      summary: await App.api.getExpenseProjectSummary(p.id),
      categories: await App.api.listExpenseCategorySummary(p.id),
    })));

    return {
      netWorth: netWorth.netWorth,
      totalAssets: netWorth.totalAssets,
      totalLiabilities: netWorth.liabilitiesTotal,
      accountsTotal: netWorth.accountsTotal,
      dealsOutstandingTotal: netWorth.dealsTotal,
      goldGrams: netWorth.goldGrams,
      goldValue: netWorth.goldTotal,
      netWorthHoldings: netWorth.breakdown.holdings,
      cashFlow: {
        thisMonthReceived: cashFlow.thisMonthReceived, thisMonthExpected: cashFlow.thisMonthExpected,
        recurringConfirmedThisMonth: cashFlow.thisMonthRecurringConfirmed, recurringPendingThisMonth: cashFlow.thisMonthRecurringPending,
        expenseDebitThisMonth: cashFlow.thisMonthExpenseDebit, expenseCreditThisMonth: cashFlow.thisMonthExpenseCredit,
        netCashMovementThisMonth: cashFlow.netCashMovement,
        next7Days: cashFlow.next7Days, next30Days: cashFlow.next30Days, next90Days: cashFlow.next90Days,
        availableCash: cashFlow.availableCash,
      },
      portfolioSummary,
      deals: dealMetrics.map((m) => ({ dealId: m.deal_id, status: m.status, investedAmount: m.invested_amount, currentPrincipal: m.current_principal, totalOutstanding: m.total_outstanding, realizedRoi: m.realized_roi, payoutReliability: m.payout_reliability })),
      recurringSummary,
      recurringConsistency: recurringConsistency.map((r) => ({ itemName: r.item_name, consistencyPct: r.consistency_pct, missedCount: r.missed_count, skippedCount: r.skipped_count })),
      goldSchemeHoldings: goldHoldings.map((h) => ({ itemName: h.item_name, totalGrams: h.total_grams, totalPaid: h.total_paid, avgPurchasePrice: h.avg_purchase_price })),
      expenseProjects: expenseSummaries,
    };
  }

  function bubble(role, text, providerDisplayName) {
    const mine = role === 'user';
    return `<div style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px">
      <div style="max-width:75%;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;background:${mine ? 'rgba(201,168,76,0.15)' : 'rgba(76,155,232,0.15)'};border:1px solid var(--border2)">
        ${App.utils.escapeHtml(text)}
        ${!mine && providerDisplayName ? `<div style="margin-top:6px;font-size:10.5px;color:var(--text3)">via ${App.utils.escapeHtml(providerDisplayName)}</div>` : ''}
      </div>
    </div>`;
  }

  async function renderAiCopilotView() {
    const pane = App.utils.qs('#pane-aicopilot');
    pane.innerHTML = `
      <div class="section-title">AI Portfolio Copilot <div class="line"></div><small>ask questions about your real portfolio - your chosen AI provider answers only from the data below, never invents a figure</small></div>
      <div class="panel">
        <div class="hint" style="margin-bottom:10px">Your admin-selected AI provider (see Settings) answers using the real numbers already loaded for your account below — it cannot see or invent anything not already shown here. Each question uses one of your daily quota.</div>
        <div id="acQuota" class="hint" style="margin-bottom:10px"></div>
        <div id="acThread" style="height:360px;overflow-y:auto;border:1px solid var(--border2);border-radius:8px;padding:12px;margin-bottom:12px;background:var(--fill-1)"></div>
        <div id="acLimitNote"></div>
        <div style="display:flex;gap:8px">
          <input class="search-input" id="acQuestionInput" placeholder="e.g. How is my portfolio doing this month?" style="flex:1">
          <button class="btn btn-gold" id="acAskBtn">Ask</button>
        </div>
      </div>`;

    function drawThread() {
      const host = App.utils.qs('#acThread', pane);
      host.innerHTML = thread.length
        ? thread.map((m) => bubble(m.role, m.text, m.providerDisplayName)).join('')
        : '<div class="empty-note">Ask a question below to get started - e.g. "What\'s my net worth?" or "How is my cash flow this month?"</div>';
      host.scrollTop = host.scrollHeight;
    }
    drawThread();

    // The exact count-used-today isn't known until the first real question
    // of this page-visit gets a response (no dedicated "check my usage"
    // endpoint exists - the atomic check-and-increment RPC only runs as
    // part of actually asking a question) - shown as a plain cap statement
    // until then, then replaced with the real count from the response.
    App.utils.qs('#acQuota', pane).textContent = `Daily quota: up to ${DAILY_LIMIT} questions/day.`;

    App.utils.qs('#acAskBtn', pane).addEventListener('click', ask);
    App.utils.qs('#acQuestionInput', pane).addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

    async function ask() {
      const input = App.utils.qs('#acQuestionInput', pane);
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      thread.push({ role: 'user', text: question });
      drawThread();
      const btn = App.utils.qs('#acAskBtn', pane);
      btn.disabled = true; btn.textContent = 'Thinking...';
      App.utils.qs('#acLimitNote', pane).innerHTML = '';
      try {
        const context = await assembleContext();
        const res = await App.api.askCopilot(question, context);
        thread.push({ role: 'assistant', text: res.answer, providerDisplayName: res.providerDisplayName });
        drawThread();
        App.utils.qs('#acQuota', pane).textContent = `Daily quota: ${res.requestsUsed} of ${res.dailyLimit} questions used today.`;
      } catch (e) {
        thread.pop(); drawThread();
        if (e.requestsUsed != null) {
          App.utils.qs('#acLimitNote', pane).innerHTML = `<div class="hint" style="color:var(--red)">${App.utils.escapeHtml(e.message)}</div>`;
        } else {
          App.utils.toast('Could not reach the Copilot: ' + (e.message || e), 'err');
        }
      } finally {
        btn.disabled = false; btn.textContent = 'Ask';
      }
    }
  }

  App.router.register('aicopilot', renderAiCopilotView);
})();
