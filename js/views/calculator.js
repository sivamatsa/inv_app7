/* Interest Calculator + EMI Calculator, as tabs of one page.

   Interest Calculator supports BOTH Monthly (principal + months + a MONTHLY
   rate, the shape almost every real P2P/gold-scheme/chit-fund rate is
   actually quoted in, e.g. "1.75% per month") and Yearly (principal + years
   + an ANNUAL rate, the traditional FD/loan-quote shape) - a radio toggle
   switches between them; neither mode was meant to replace the other.

   EMI Calculator is the standard reducing-balance loan formula
   (EMI = P*r*(1+r)^n / ((1+r)^n-1)) with a full month-by-month amortization
   schedule.

   The "smart suggestion" against the user's own portfolio is a deterministic
   comparison (weighted-average annual ROI vs. this calculator's own
   annualized rate) - not a live LLM call. There's no server here that could
   hold a model API key safely for this, so it's a rule-based stand-in, same
   honest substitution used for AI Insights (009_functions.sql) - it never
   invents a number, only compares two real ones. */
window.App = window.App || {};

(function () {
  const TABS = [
    { key: 'interest', label: 'Interest Calculator' },
    { key: 'emi', label: 'EMI Calculator' },
  ];

  const QUICK_AMOUNTS = [10000, 25000, 50000, 100000, 200000, 500000, 1000000];
  const QUICK_MONTHS = [2, 5, 6, 7, 8, 10, 11];
  const QUICK_MONTHLY_RATES = [1.4, 1.5, 1.6, 1.65, 1.7, 1.75, 1.8, 1.9, 1.9999, 2, 2.1];
  const QUICK_YEARS = [1, 2, 3, 5, 7, 10, 15, 20];
  const QUICK_ANNUAL_RATES = [6, 7, 8, 9, 10, 12, 15, 18, 20, 24];

  const QUICK_LOAN_AMOUNTS = [100000, 300000, 500000, 1000000, 2000000, 5000000];
  const QUICK_LOAN_YEARS = [1, 2, 3, 5, 10, 15, 20, 30];
  const QUICK_LOAN_RATES = [7, 7.5, 8, 8.5, 9, 9.5, 10, 11, 12];

  let state = { tab: 'interest', mode: 'monthly' };

  // Simple interest never compounds - the same amount every period, by
  // definition. Compound interest reinvests each period's interest into the
  // next period's balance. Shared by both Monthly and Yearly mode - they
  // differ only in what a "period" means and which quick-pick lists apply.
  function computePeriodBreakdown(principal, ratePct, periods) {
    const r = ratePct / 100;
    const simpleInterestPerPeriod = principal * r;
    let compoundBalance = principal;
    const rows = [];
    let cumulativeSimple = 0;
    for (let p = 1; p <= periods; p++) {
      cumulativeSimple += simpleInterestPerPeriod;
      const compoundInterestThisPeriod = compoundBalance * r;
      compoundBalance += compoundInterestThisPeriod;
      rows.push({
        period: p,
        simpleInterest: simpleInterestPerPeriod,
        cumulativeSimpleInterest: cumulativeSimple,
        simpleBalance: principal + cumulativeSimple,
        compoundInterest: compoundInterestThisPeriod,
        cumulativeCompoundInterest: compoundBalance - principal,
        compoundBalance,
      });
    }
    const totalSimpleInterest = simpleInterestPerPeriod * periods;
    const totalCompoundInterest = compoundBalance - principal;
    return {
      rows,
      simpleInterestPerPeriod,
      totalSimpleInterest,
      maturitySimple: principal + totalSimpleInterest,
      totalCompoundInterest,
      maturityCompound: compoundBalance,
      compoundingEffect: totalCompoundInterest - totalSimpleInterest,
    };
  }

  // Standard reducing-balance EMI formula. r === 0 (a 0% loan) is handled
  // separately since the closed-form formula divides by zero there.
  function computeEmi(principal, annualRatePct, months) {
    const r = annualRatePct / 12 / 100;
    const emi = r === 0 ? principal / months : principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
    const totalPayment = emi * months;
    const totalInterest = totalPayment - principal;
    let balance = principal;
    const rows = [];
    for (let m = 1; m <= months; m++) {
      const interestComponent = balance * r;
      const principalComponent = emi - interestComponent;
      balance = Math.max(0, balance - principalComponent);
      rows.push({ month: m, emi, interestComponent, principalComponent, balance });
    }
    return { emi, totalPayment, totalInterest, rows };
  }

  async function renderCalculatorView() {
    const pane = App.utils.qs('#pane-calculator');
    pane.innerHTML = `
      <div class="section-title">Calculators <div class="line"></div><small>interest projections and loan EMI - not tied to any real deal</small></div>
      <div class="chip-row" id="calcTabRow" style="margin-bottom:16px">${TABS.map((t) => `<div class="chip ${t.key === state.tab ? 'active' : ''}" data-calc-tab="${t.key}">${t.label}</div>`).join('')}</div>
      <div id="calcTabHost"></div>`;

    App.utils.qsa('[data-calc-tab]', pane).forEach((chip) => chip.addEventListener('click', () => {
      state.tab = chip.dataset.calcTab;
      App.utils.qsa('[data-calc-tab]', pane).forEach((c) => c.classList.toggle('active', c === chip));
      drawTab();
    }));

    async function drawTab() {
      const host = App.utils.qs('#calcTabHost', pane);
      if (state.tab === 'interest') await drawInterestTab(host);
      else await drawEmiTab(host);
    }

    async function drawInterestTab(host) {
      const isMonthly = state.mode === 'monthly';
      host.innerHTML = `
        <div class="panel">
          <div class="field" style="margin-bottom:12px">
            <label>Calculate by</label>
            <div style="display:flex;gap:18px;margin-top:4px">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                <input type="radio" name="calcMode" value="monthly" ${isMonthly ? 'checked' : ''}> Monthly (months + monthly rate)
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                <input type="radio" name="calcMode" value="yearly" ${!isMonthly ? 'checked' : ''}> Yearly (years + annual rate)
              </label>
            </div>
          </div>
          <div class="form-grid">
            <div class="field"><label>Principal Amount</label><input type="number" id="calcAmount" value="5000"></div>
            <div class="field"><label>${isMonthly ? 'Number of Months' : 'Number of Years'}</label><input type="number" step="1" id="calcPeriods" value="${isMonthly ? 5 : 1}"></div>
            <div class="field"><label>${isMonthly ? 'Monthly' : 'Annual'} Interest Rate %</label><input type="number" step="any" id="calcRate" value="${isMonthly ? 1.75 : 10}"></div>
            <div class="field"><label>&nbsp;</label><button class="btn btn-gold" id="calcRunBtn">Calculate</button></div>
          </div>
          <div class="hint" style="margin-bottom:6px">Common amounts</div>
          <div class="chip-row" id="quickAmounts" style="margin-bottom:12px">${QUICK_AMOUNTS.map((a) => `<div class="chip" data-amt="${a}">${App.utils.fmtMoney(a)}</div>`).join('')}</div>
          <div class="hint" style="margin-bottom:6px">Common ${isMonthly ? 'months' : 'years'}</div>
          <div class="chip-row" id="quickPeriods" style="margin-bottom:12px">${(isMonthly ? QUICK_MONTHS : QUICK_YEARS).map((p) => `<div class="chip" data-period="${p}">${p}${isMonthly ? 'mo' : 'yr'}</div>`).join('')}</div>
          <div class="hint" style="margin-bottom:6px">Common ${isMonthly ? 'monthly' : 'annual'} rates</div>
          <div class="chip-row" id="quickRates">${(isMonthly ? QUICK_MONTHLY_RATES : QUICK_ANNUAL_RATES).map((r) => `<div class="chip" data-rate="${r}">${r}%</div>`).join('')}</div>
        </div>
        <div id="calcResult"></div>`;

      App.utils.qsa('input[name="calcMode"]', host).forEach((r) => r.addEventListener('change', (e) => {
        state.mode = e.target.value;
        drawInterestTab(host);
      }));

      function bindQuickChips() {
        App.utils.qsa('[data-amt]', host).forEach((c) => c.addEventListener('click', () => {
          App.utils.qs('#calcAmount', host).value = c.dataset.amt;
          App.utils.qsa('[data-amt]', host).forEach((x) => x.classList.toggle('active', x === c));
          run();
        }));
        App.utils.qsa('[data-period]', host).forEach((c) => c.addEventListener('click', () => {
          App.utils.qs('#calcPeriods', host).value = c.dataset.period;
          App.utils.qsa('[data-period]', host).forEach((x) => x.classList.toggle('active', x === c));
          run();
        }));
        App.utils.qsa('[data-rate]', host).forEach((c) => c.addEventListener('click', () => {
          App.utils.qs('#calcRate', host).value = c.dataset.rate;
          App.utils.qsa('[data-rate]', host).forEach((x) => x.classList.toggle('active', x === c));
          run();
        }));
      }

      async function run() {
        const principal = App.utils.parseNum(App.utils.qs('#calcAmount', host).value) || 0;
        const periods = Math.max(0, Math.round(App.utils.parseNum(App.utils.qs('#calcPeriods', host).value) || 0));
        const rate = App.utils.parseNum(App.utils.qs('#calcRate', host).value) || 0;
        const b = computePeriodBreakdown(principal, rate, periods);
        const unit = isMonthly ? 'month' : 'year';
        const unitCap = isMonthly ? 'Month' : 'Year';

        let suggestionHtml = '';
        try {
          const deals = await App.api.listDeals({ eq: { status: 'ACTIVE' } });
          const withRoi = deals.filter((d) => d.annual_roi != null && d.invested_amount);
          if (withRoi.length) {
            const weightedAvg = withRoi.reduce((a, d) => a + d.annual_roi * d.invested_amount, 0) / withRoi.reduce((a, d) => a + d.invested_amount, 0);
            const equivalentAnnual = isMonthly ? rate * 12 : rate;
            const diff = equivalentAnnual - weightedAvg;
            const verdict = Math.abs(diff) < 0.5 ? 'about the same as' : diff > 0 ? `${App.utils.fmtNum(diff, 1)} points above` : `${App.utils.fmtNum(-diff, 1)} points below`;
            suggestionHtml = `<div class="hint"><b>Rule-based comparison</b> (not AI - a straight comparison against your own data): ${App.utils.fmtNum(rate, 2)}%${isMonthly ? '/month' : '/year'} is ${App.utils.fmtPct(equivalentAnnual)} annualized${isMonthly ? ' (simple x12)' : ''}, which is ${verdict} your active portfolio's capital-weighted average of ${App.utils.fmtPct(weightedAvg)}.</div>`;
          } else {
            suggestionHtml = `<div class="hint">Add a few active deals to see how this rate compares to your own portfolio average.</div>`;
          }
        } catch (e) { /* calculator still works standalone without this */ }

        const breakdownRows = b.rows.map((r) => `<tr>
          <td>${r.period}</td>
          <td>${App.utils.fmtMoney(r.simpleInterest)}</td>
          <td>${App.utils.fmtMoney(r.cumulativeSimpleInterest)}</td>
          <td>${App.utils.fmtMoney(r.simpleBalance)}</td>
          <td>${App.utils.fmtMoney(r.compoundInterest)}</td>
          <td>${App.utils.fmtMoney(r.compoundBalance)}</td>
          <td>${App.utils.fmtMoney(r.cumulativeCompoundInterest - r.cumulativeSimpleInterest)}</td>
        </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:14px">Enter a number of ${unit}s above.</td></tr>`;

        App.utils.qs('#calcResult', host).innerHTML = `
          <div class="grid-4">
            <div class="kpi c-gold"><div class="kpi-label">Interest / ${unitCap} (simple)</div><div class="kpi-value">${App.utils.fmtMoney(b.simpleInterestPerPeriod)}</div></div>
            <div class="kpi c-blue"><div class="kpi-label">Total Interest (${periods}${isMonthly ? 'mo' : 'yr'}, simple)</div><div class="kpi-value">${App.utils.fmtMoney(b.totalSimpleInterest)}</div></div>
            <div class="kpi c-teal"><div class="kpi-label">Maturity Value (simple)</div><div class="kpi-value">${App.utils.fmtMoney(b.maturitySimple)}</div></div>
            <div class="kpi c-purple"><div class="kpi-label">Maturity Value (compounded ${unit}ly)</div><div class="kpi-value">${App.utils.fmtMoney(b.maturityCompound)}</div></div>
          </div>
          <div class="panel">
            <div class="stat-line"><span>Total Interest (compounded ${unit}ly)</span><span class="v">${App.utils.fmtMoney(b.totalCompoundInterest)}</span></div>
            <div class="stat-line"><span>Compounding Effect (compound − simple, over ${periods} ${unit}${periods === 1 ? '' : 's'})</span><span class="v">${App.utils.fmtMoney(b.compoundingEffect)}</span></div>
            ${suggestionHtml}
          </div>
          <div class="panel">
            <div class="hint" style="margin-bottom:8px">${unitCap}-by-${unit} breakdown - Simple vs Compound</div>
            <div class="table-scroll" style="max-height:360px">
              <table class="data">
                <thead><tr>
                  <th>${unitCap}</th><th>Interest This ${unitCap} (simple)</th><th>Cumulative Interest (simple)</th><th>Balance (simple)</th>
                  <th>Interest This ${unitCap} (compound)</th><th>Balance (compound)</th><th>Difference So Far</th>
                </tr></thead>
                <tbody>${breakdownRows}</tbody>
              </table>
            </div>
          </div>`;
      }

      bindQuickChips();
      App.utils.qs('#calcRunBtn', host).addEventListener('click', run);
      await run();
    }

    async function drawEmiTab(host) {
      host.innerHTML = `
        <div class="panel">
          <div class="form-grid">
            <div class="field"><label>Loan Amount</label><input type="number" id="emiAmount" value="1000000"></div>
            <div class="field"><label>Tenure (Years)</label><input type="number" step="any" id="emiYears" value="5"></div>
            <div class="field"><label>Annual Interest Rate %</label><input type="number" step="any" id="emiRate" value="9"></div>
            <div class="field"><label>&nbsp;</label><button class="btn btn-gold" id="emiRunBtn">Calculate</button></div>
          </div>
          <div class="hint" style="margin-bottom:6px">Common loan amounts</div>
          <div class="chip-row" id="emiQuickAmounts" style="margin-bottom:12px">${QUICK_LOAN_AMOUNTS.map((a) => `<div class="chip" data-eamt="${a}">${App.utils.fmtMoney(a)}</div>`).join('')}</div>
          <div class="hint" style="margin-bottom:6px">Common tenures</div>
          <div class="chip-row" id="emiQuickYears" style="margin-bottom:12px">${QUICK_LOAN_YEARS.map((y) => `<div class="chip" data-eyears="${y}">${y}yr</div>`).join('')}</div>
          <div class="hint" style="margin-bottom:6px">Common rates</div>
          <div class="chip-row" id="emiQuickRates">${QUICK_LOAN_RATES.map((r) => `<div class="chip" data-erate="${r}">${r}%</div>`).join('')}</div>
        </div>
        <div id="emiResult"></div>`;

      App.utils.qsa('[data-eamt]', host).forEach((c) => c.addEventListener('click', () => {
        App.utils.qs('#emiAmount', host).value = c.dataset.eamt;
        App.utils.qsa('[data-eamt]', host).forEach((x) => x.classList.toggle('active', x === c));
        runEmi();
      }));
      App.utils.qsa('[data-eyears]', host).forEach((c) => c.addEventListener('click', () => {
        App.utils.qs('#emiYears', host).value = c.dataset.eyears;
        App.utils.qsa('[data-eyears]', host).forEach((x) => x.classList.toggle('active', x === c));
        runEmi();
      }));
      App.utils.qsa('[data-erate]', host).forEach((c) => c.addEventListener('click', () => {
        App.utils.qs('#emiRate', host).value = c.dataset.erate;
        App.utils.qsa('[data-erate]', host).forEach((x) => x.classList.toggle('active', x === c));
        runEmi();
      }));

      function runEmi() {
        const principal = App.utils.parseNum(App.utils.qs('#emiAmount', host).value) || 0;
        const years = App.utils.parseNum(App.utils.qs('#emiYears', host).value) || 0;
        const rate = App.utils.parseNum(App.utils.qs('#emiRate', host).value) || 0;
        const months = Math.max(0, Math.round(years * 12));
        if (!principal || !months) {
          App.utils.qs('#emiResult', host).innerHTML = '<div class="empty-note">Enter a loan amount and tenure above.</div>';
          return;
        }
        const e = computeEmi(principal, rate, months);
        const rows = e.rows.map((r) => `<tr>
          <td>${r.month}</td>
          <td>${App.utils.fmtMoney(r.emi)}</td>
          <td>${App.utils.fmtMoney(r.principalComponent)}</td>
          <td>${App.utils.fmtMoney(r.interestComponent)}</td>
          <td>${App.utils.fmtMoney(r.balance)}</td>
        </tr>`).join('');

        App.utils.qs('#emiResult', host).innerHTML = `
          <div class="grid-3">
            <div class="kpi c-gold"><div class="kpi-label">Monthly EMI</div><div class="kpi-value">${App.utils.fmtMoney(e.emi)}</div></div>
            <div class="kpi c-blue"><div class="kpi-label">Total Interest</div><div class="kpi-value">${App.utils.fmtMoney(e.totalInterest)}</div></div>
            <div class="kpi c-teal"><div class="kpi-label">Total Payment</div><div class="kpi-value">${App.utils.fmtMoney(e.totalPayment)}</div></div>
          </div>
          <div class="panel">
            <div class="hint" style="margin-bottom:8px">Amortization Schedule (${months} months)</div>
            <div class="table-scroll" style="max-height:360px">
              <table class="data">
                <thead><tr><th>Month</th><th>EMI</th><th>Principal</th><th>Interest</th><th>Balance</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      }

      App.utils.qs('#emiRunBtn', host).addEventListener('click', runEmi);
      runEmi();
    }

    await drawTab();
  }

  App.router.register('calculator', renderCalculatorView);
})();
