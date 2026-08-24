/* Client-side calculation helpers for instant UI feedback (deal-form
   previews, the What-If simulator, deal comparison). The DB views
   (v_deal_metrics / v_portfolio_summary) remain the authoritative numbers
   once a deal/payment is actually saved - these are for "before you save"
   previews and standalone projections only (spec Section 33: "Clearly
   label simulations as projections"). */
window.App = window.App || {};

App.calc = (function () {
  function simpleExpectedInterest(principal, annualRoiPct, years) {
    if (!principal || !annualRoiPct || !years) return 0;
    return principal * (annualRoiPct / 100) * years;
  }

  function emiAmount(principal, annualRoiPct, periodsPerYear, totalPeriods) {
    if (!principal || !totalPeriods) return 0;
    const r = (annualRoiPct || 0) / 100 / periodsPerYear;
    if (r <= 0) return principal / totalPeriods;
    return principal * r * Math.pow(1 + r, totalPeriods) / (Math.pow(1 + r, totalPeriods) - 1);
  }

  // Section 33 what-if simulator. Every branch is a clearly-labelled,
  // simplified projection (non-compounding periodic interest unless the
  // scenario explicitly reinvests), not a guarantee.
  function whatIf(input) {
    const amount = App.utils.parseNum(input.amount) || 0;
    const roi = App.utils.parseNum(input.annualRoiPct) || 0;
    const months = App.utils.parseNum(input.tenureMonths) || 0;
    const monthlyRate = roi / 100 / 12;
    const out = { scenario: input.scenario, inputs: { amount, roi, months } };

    if (input.scenario === 'reinvest_every_payment') {
      const finalValue = amount * Math.pow(1 + monthlyRate, months);
      out.finalPrincipal = finalValue;
      out.totalInterest = finalValue - amount;
      out.cashReceived = finalValue;
      out.annualizedReturn = months > 0 ? (Math.pow(finalValue / amount, 12 / months) - 1) * 100 : 0;
      out.reinvestmentEffect = out.totalInterest - simpleExpectedInterest(amount, roi, months / 12);
    } else if (input.scenario === 'reinvest_principal_only') {
      // Cycle 1: interest withdrawn as cash each period, principal returned
      // at maturity. Cycle 2 (illustrative only): that returned principal is
      // assumed to go into an identical deal for the same tenure, at the
      // same rate - a simplification, not a forecast of what will actually
      // be available to reinvest into.
      const cycle1Interest = simpleExpectedInterest(amount, roi, months / 12);
      const cycle2Interest = simpleExpectedInterest(amount, roi, months / 12);
      out.finalPrincipal = amount;
      out.totalInterest = cycle1Interest + cycle2Interest;
      out.cashReceived = cycle1Interest + amount + cycle2Interest;
      out.annualizedReturn = roi;
      out.reinvestmentEffect = cycle2Interest;
      out.note = 'Principal-only reinvestment is modelled as two identical back-to-back cycles at the same rate - illustrative, not a forecast.';
    } else {
      // withdraw_interest (default): interest taken as cash each period,
      // principal returned unchanged at maturity.
      const totalInterest = simpleExpectedInterest(amount, roi, months / 12);
      out.finalPrincipal = amount;
      out.totalInterest = totalInterest;
      out.cashReceived = amount + totalInterest;
      out.annualizedReturn = roi;
      out.reinvestmentEffect = 0;
    }
    return out;
  }

  function compareDeals(deals) {
    // Deals is an array of {deal, metrics} pairs already fetched by the
    // caller - this just shapes them into comparable rows, no new maths.
    return deals.map(({ deal, metrics }) => ({
      id: deal.id,
      name: deal.deal_name,
      amount: deal.invested_amount,
      roi: deal.annual_roi,
      tenureMonths: deal.start_date && deal.maturity_date
        ? Math.round(App.utils.daysBetween(deal.start_date, deal.maturity_date) / 30.44) : null,
      frequency: deal.payment_frequency,
      expectedIncome: deal.expected_total_interest,
      risk: deal.risk_rating,
      reliability: metrics ? metrics.payout_reliability : null,
      maturity: deal.maturity_date,
      platform: deal.platform_id,
    }));
  }

  return { simpleExpectedInterest, emiAmount, whatIf, compareDeals };
})();
