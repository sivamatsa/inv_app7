/* Reconciliation Center - "Accounts vs. expected Payments/Recurring amounts"
   from the user's own wishlist. Two things live here: a genuinely new
   Balance Check (does your manually-entered Accounts balance roughly match
   what your confirmed activity says it should), computed entirely client-
   side like Net Worth/Cash Flow before it; and a link-through to the
   already-live Bank Reconciliation matcher inside payments.js (extended,
   not duplicated, to also match against Recurring occurrences - see
   payments.js's own suggestMatch()). See the plan file's own scope decision
   for why this isn't a second bank-statement-matching UI. */
window.App = window.App || {};

(function () {
  const RECURRING_CONFIRMED = ['CONFIRMED', 'PAID', 'INVESTED', 'PARTIALLY_PAID'];

  async function renderReconciliationView() {
    const pane = App.utils.qs('#pane-reconciliation');
    pane.innerHTML = `
      <div class="section-title">Reconciliation Center <div class="line"></div><small>does your recorded activity match your actual balances</small></div>
      <div class="panel" id="reconBalanceCheck"></div>
      <div class="panel" id="reconBankLink"></div>`;

    const [accounts, payments, recurringOcc, expenseTxns] = await Promise.all([
      App.api.listAccounts(), App.api.listPayments(), App.api.listRecurringOccurrences(), App.api.listExpenseTransactions(),
    ]);
    const activeAccounts = accounts.filter((a) => a.is_active);
    const openingTotal = activeAccounts.reduce((a, r) => a + (r.opening_balance || 0), 0);
    const currentTotal = activeAccounts.reduce((a, r) => a + (r.current_balance || 0), 0);
    const paymentsReceived = payments.filter((p) => !p.is_voided).reduce((a, p) => a + (p.amount || 0), 0);
    const recurringOutflow = recurringOcc.filter((o) => RECURRING_CONFIRMED.includes(o.status)).reduce((a, o) => a + (o.actual_amount || 0), 0);
    const expenseNet = expenseTxns.reduce((a, t) => a + (t.transaction_type === 'Debit' ? (t.amount || 0) : -(t.amount || 0)), 0);
    const expectedTotal = openingTotal + paymentsReceived - recurringOutflow - expenseNet;
    const variance = currentTotal - expectedTotal;
    const varianceAbsPct = expectedTotal !== 0 ? Math.abs(variance / expectedTotal) * 100 : 0;
    const varianceColor = Math.abs(variance) < 1 ? 'var(--teal)' : varianceAbsPct > 10 ? 'var(--red)' : 'var(--gold)';

    App.utils.qs('#reconBalanceCheck', pane).innerHTML = `
      <div class="chart-title" style="margin-bottom:10px">Balance Check</div>
      <div class="grid-3" style="margin-bottom:12px">
        <div class="kpi c-blue"><div class="kpi-label">Expected Balance</div><div class="kpi-value">${App.utils.fmtMoney(expectedTotal)}</div></div>
        <div class="kpi c-gold"><div class="kpi-label">Actual Balance</div><div class="kpi-value">${App.utils.fmtMoney(currentTotal)}</div></div>
        <div class="kpi"><div class="kpi-label">Variance</div><div class="kpi-value" style="color:${varianceColor}">${variance >= 0 ? '+' : ''}${App.utils.fmtMoney(variance)}</div></div>
      </div>
      <div class="stat-line"><span>Opening Balances (active accounts)</span><span class="v">${App.utils.fmtMoney(openingTotal)}</span></div>
      <div class="stat-line"><span>+ Payments Received (Deals)</span><span class="v">${App.utils.fmtMoney(paymentsReceived)}</span></div>
      <div class="stat-line"><span>− Recurring Confirmed Outflow</span><span class="v">${App.utils.fmtMoney(recurringOutflow)}</span></div>
      <div class="stat-line"><span>− Expense Net (Debit − Credit)</span><span class="v">${App.utils.fmtMoney(expenseNet)}</span></div>
      <div class="hint" style="margin-top:10px">This is a <b>portfolio-wide estimate, not a per-account reconciliation</b> — transactions aren't currently linked to a specific account, so this compares totals across all your active accounts, not each one individually. A large variance usually means an activity wasn't logged (a cash withdrawal, an unrecorded expense) rather than a data error.</div>`;

    App.utils.qs('#reconBankLink', pane).innerHTML = `
      <div class="chart-title" style="margin-bottom:10px">Bank Statement Matching</div>
      <div class="hint" style="margin-bottom:10px">Match real bank-statement transactions against your Deal payment schedule and Recurring Investments — upload a statement, get suggested matches, confirm with one click.</div>
      <button class="btn btn-gold btn-sm" id="reconOpenBankMatching">Open Bank Reconciliation &rarr;</button>`;
    App.utils.qs('#reconOpenBankMatching', pane).addEventListener('click', () => {
      if (App.paymentsView) App.paymentsView.openReconciliationTab();
    });
  }

  App.router.register('reconciliation', renderReconciliationView);
})();
