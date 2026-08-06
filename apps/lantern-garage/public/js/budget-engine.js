/**
 * budget-engine.js — deterministic personal-budget analysis for /budget.html.
 *
 * PURE functions, no I/O, no LLM, no network. Given a monthly income and expenses grouped by
 * category, it computes the savings rate, the 50/30/20 split, per-category benchmark flags, and
 * priority-ordered recommendations — every threshold traceable to a studied source (see
 * BUDGET_BENCHMARKS). This is the Σ₀ "never fake a number" rule applied to money: the tool
 * computes from cited rules, it does not have a model guess a figure.
 *
 * Income is treated as monthly TAKE-HOME (after-tax) — that is the basis the 50/30/20 rule is
 * defined on. Housing / transport / debt-to-income benchmarks are conventionally measured
 * against GROSS (pre-tax) income, so when computed against take-home they read slightly high;
 * the UI notes this. v1 keeps a single income field for simplicity over lender-grade precision.
 *
 * Exposed both as `window.BudgetEngine` (browser) and `module.exports` (node tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BudgetEngine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── Studied benchmarks (thresholds + sources) ───────────────────────────────────────────────
  const BUDGET_BENCHMARKS = {
    savingsBands: { poor: 0.10, fair: 0.20, good: 0.30 }, // <10 Poor, 10-20 Fair, 20-30 Good, >=30 Excellent
    savingsTarget: 0.20,      // 50/30/20 savings leg; absorbs Fidelity's 15% retirement guideline + goals
    housingWarn: 0.28,        // 28/36 rule — housing <= 28% of income
    housingHigh: 0.30,        // ~30% commonly tolerated ceiling
    transportSoft: 0.10,      // car costs <= ~10% of income (soft)
    transportWarn: 0.15,      // total transportation <= ~15%
    dtiWarn: 0.36,            // total debt-to-income back-end <= 36%
    dtiHigh: 0.43,            // qualified-mortgage ceiling
    fiftyThirtyTwenty: { needs: 0.50, wants: 0.30, savings: 0.20 },
    emergencyMonthsMin: 3,    // 3-6 months of essential expenses
    emergencyMonthsMax: 6,
    sources: {
      "50/30/20": "https://www.transamerica.com/knowledge-place/50-30-20-budget-rule",
      savingsRate: "https://www.nerdwallet.com/article/finance/how-much-of-my-income-should-i-save-every-month",
      emergencyFund: "https://www.fidelity.com/viewpoints/personal-finance/save-for-an-emergency",
      housing2836: "https://www.bankrate.com/real-estate/what-is-the-28-36-rule/",
      transport: "https://www.financialsamurai.com/average-vs-recommended-percent-of-income-spent-on-a-car/",
      retirement: "https://www.fidelity.com/viewpoints/retirement/how-much-do-i-need-to-retire",
      dti: "https://www.consumerfinance.gov/ask-cfpb/what-is-a-debt-to-income-ratio-en-1791/",
    },
  };

  // ── Category taxonomy: 50/30/20 class + which ratio benchmark it feeds ───────────────────────
  // cls: "needs" | "wants" | "savings" (drives the 50/30/20 split). A category in "savings" is
  // money the user is deliberately saving/investing and is NOT counted as spending.
  const CATEGORIES = [
    { id: "housing",       label: "Housing",              cls: "needs",   ratio: "housing" },
    { id: "utilities",     label: "Utilities",            cls: "needs" },
    { id: "transportation",label: "Transportation",       cls: "needs",   ratio: "transport" },
    { id: "groceries",     label: "Groceries",            cls: "needs" },
    { id: "insurance",     label: "Insurance & Health",   cls: "needs" },
    { id: "debt",          label: "Debt Payments",        cls: "needs",   ratio: "debt" },
    { id: "dining",        label: "Dining & Takeout",     cls: "wants" },
    { id: "subscriptions", label: "Subscriptions",        cls: "wants" },
    { id: "personal",      label: "Personal & Fun",       cls: "wants" },
    { id: "other",         label: "Other",                cls: "wants" },
    { id: "savings",       label: "Savings & Investing",  cls: "savings" },
  ];
  const CATEGORY_BY_ID = CATEGORIES.reduce((m, c) => ((m[c.id] = c), m), {});

  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const round2 = (n) => Math.round(n * 100) / 100;

  function savingsBand(rate) {
    const b = BUDGET_BENCHMARKS.savingsBands;
    if (rate < b.poor) return { key: "poor", label: "Needs work" };
    if (rate < b.fair) return { key: "fair", label: "Fair" };
    if (rate < b.good) return { key: "good", label: "Good" };
    return { key: "excellent", label: "Excellent" };
  }

  // Concrete, category-specific trim ideas — only surfaced for an over-benchmark category.
  const TRIM_IDEAS = {
    housing: ["Take on a roommate or rent out a spare room", "Refinance or shop a lower rate; appeal an over-assessed property-tax bill", "Right-size to a cheaper unit at renewal — housing is the biggest lever"],
    transportation: ["Refinance the auto loan or trade down to a cheaper/used vehicle", "Drop to one car and use transit/bike where you can", "Raise your insurance deductible and shop quotes annually"],
    debt: ["Attack highest-APR debt first (avalanche) to cut interest, or smallest balance (snowball) for momentum", "Consolidate high-APR balances to a lower rate", "Avoid taking on new financed purchases until DTI is under 36%"],
    dining: ["Cap restaurant + delivery spend — the classic 'wants' overspend", "Meal-plan and batch-cook; bring lunch a few days a week"],
    subscriptions: ["Audit every recurring charge and cancel duplicates/unused ones", "Rotate streaming services instead of stacking them", "Switch to annual plans only for the ones you truly use"],
    utilities: ["Shop electricity/gas providers where deregulated", "Switch to a cheaper prepaid/MVNO mobile carrier", "Cut cable in favor of streaming + antenna"],
    personal: ["Set a monthly 'fun money' cap and track against it", "Pause impulse buys with a 48-hour wait rule"],
  };

  /**
   * @param {object} input
   * @param {number} input.income            monthly take-home income
   * @param {object} input.categories        { <categoryId>: amountNumber }  (missing = 0)
   * @param {number} [input.emergencySavings] current liquid emergency savings (optional)
   * @returns analysis object (see fields below)
   */
  function analyze(input) {
    const income = num(input && input.income);
    const cats = (input && input.categories) || {};
    const byId = {};
    for (const c of CATEGORIES) byId[c.id] = num(cats[c.id]);

    // Spending excludes the explicit savings/investing category (that money IS saved, not spent).
    const spend = CATEGORIES.filter((c) => c.cls !== "savings").reduce((s, c) => s + byId[c.id], 0);
    const explicitSavings = byId.savings;
    const surplus = income - spend;                 // whatever isn't spent is saved (leftover + explicit)
    const savingsRate = income > 0 ? surplus / income : 0;
    const band = savingsBand(savingsRate);

    // 50/30/20 split — needs/wants from spending, savings = the surplus.
    const needs = CATEGORIES.filter((c) => c.cls === "needs").reduce((s, c) => s + byId[c.id], 0);
    const wants = CATEGORIES.filter((c) => c.cls === "wants").reduce((s, c) => s + byId[c.id], 0);
    const split = {
      needs:   { amount: round2(needs),  pct: income > 0 ? needs / income : 0,  target: BUDGET_BENCHMARKS.fiftyThirtyTwenty.needs },
      wants:   { amount: round2(wants),  pct: income > 0 ? wants / income : 0,  target: BUDGET_BENCHMARKS.fiftyThirtyTwenty.wants },
      savings: { amount: round2(Math.max(0, surplus)), pct: Math.max(0, savingsRate), target: BUDGET_BENCHMARKS.fiftyThirtyTwenty.savings },
    };

    // ── Benchmark flags ──────────────────────────────────────────────────────────────────────
    const flags = [];
    const push = (priority, category, level, message, benchmark) => flags.push({ priority, category, level, message, benchmark });
    const pct = (n) => (income > 0 ? n / income : 0);

    // Emergency fund (only when the optional inputs let us compute it).
    const essential = needs; // essential monthly expenses ≈ the needs bucket
    const emergencySavings = num(input && input.emergencySavings);
    let emergencyMonths = null;
    if (emergencySavings > 0 && essential > 0) {
      emergencyMonths = emergencySavings / essential;
      if (emergencyMonths < BUDGET_BENCHMARKS.emergencyMonthsMin) push(1, "emergency", "high", `Emergency fund covers ~${emergencyMonths.toFixed(1)} months — build toward 3–6 months of essentials.`, BUDGET_BENCHMARKS.sources.emergencyFund);
      else if (emergencyMonths <= BUDGET_BENCHMARKS.emergencyMonthsMax) push(6, "emergency", "ok", `Emergency fund covers ~${emergencyMonths.toFixed(1)} months — on target (3–6).`, BUDGET_BENCHMARKS.sources.emergencyFund);
      else push(7, "emergency", "ok", `Emergency fund covers ~${emergencyMonths.toFixed(1)} months — beyond 6; consider investing the excess.`, BUDGET_BENCHMARKS.sources.emergencyFund);
    }

    // Debt-to-income (housing + debt payments, back-end).
    const dti = pct(byId.housing + byId.debt);
    if (dti > BUDGET_BENCHMARKS.dtiHigh) push(2, "debt", "high", `Debt-to-income ~${(dti * 100).toFixed(0)}% exceeds the 43% qualified-mortgage ceiling — high risk.`, BUDGET_BENCHMARKS.sources.dti);
    else if (dti > BUDGET_BENCHMARKS.dtiWarn) push(4, "debt", "warn", `Debt-to-income ~${(dti * 100).toFixed(0)}% is over the 36% guideline.`, BUDGET_BENCHMARKS.sources.dti);

    // Savings rate.
    if (savingsRate < BUDGET_BENCHMARKS.savingsBands.poor) push(3, "savings", "high", `Savings rate ~${(savingsRate * 100).toFixed(0)}% is critically low (target 20%).`, BUDGET_BENCHMARKS.sources.savingsRate);
    else if (savingsRate < BUDGET_BENCHMARKS.savingsTarget) push(5, "savings", "warn", `Savings rate ~${(savingsRate * 100).toFixed(0)}% is below the 20% target.`, BUDGET_BENCHMARKS.sources.savingsRate);

    // Housing.
    const hp = pct(byId.housing);
    if (hp > BUDGET_BENCHMARKS.housingHigh) push(4, "housing", "high", `Housing is ~${(hp * 100).toFixed(0)}% of income — over the ~30% ceiling.`, BUDGET_BENCHMARKS.sources.housing2836);
    else if (hp > BUDGET_BENCHMARKS.housingWarn) push(6, "housing", "warn", `Housing is ~${(hp * 100).toFixed(0)}% of income — over the 28% guideline.`, BUDGET_BENCHMARKS.sources.housing2836);

    // Transportation.
    const tp = pct(byId.transportation);
    if (tp > BUDGET_BENCHMARKS.transportWarn) push(6, "transportation", "warn", `Transportation is ~${(tp * 100).toFixed(0)}% of income — over the ~15% guideline.`, BUDGET_BENCHMARKS.sources.transport);
    else if (tp > BUDGET_BENCHMARKS.transportSoft) push(7, "transportation", "soft", `Transportation is ~${(tp * 100).toFixed(0)}% of income — above the ~10% car-cost target.`, BUDGET_BENCHMARKS.sources.transport);

    // 50/30/20 caps.
    if (split.needs.pct > BUDGET_BENCHMARKS.fiftyThirtyTwenty.needs) push(6, "needs", "warn", `Needs are ~${(split.needs.pct * 100).toFixed(0)}% of income — over the 50% cap.`, BUDGET_BENCHMARKS.sources["50/30/20"]);
    if (split.wants.pct > BUDGET_BENCHMARKS.fiftyThirtyTwenty.wants) push(6, "wants", "warn", `Wants are ~${(split.wants.pct * 100).toFixed(0)}% of income — over the 30% cap.`, BUDGET_BENCHMARKS.sources["50/30/20"]);

    flags.sort((a, b) => a.priority - b.priority);

    // ── Recommendations (headline + trims for over-benchmark categories only) ──────────────────
    const recommendations = [];
    const gapToTarget = BUDGET_BENCHMARKS.savingsTarget - savingsRate;
    if (income <= 0) {
      recommendations.push({ priority: 0, category: "income", text: "Enter your monthly income to see your savings rate and recommendations." });
    } else if (gapToTarget > 0) {
      const monthly = Math.max(0, Math.round(gapToTarget * income));
      recommendations.push({ priority: 0, category: "savings", text: `To reach a 20% savings rate you'd free up about ${fmtMoney(monthly)}/month — trim the over-benchmark categories below.` });
    } else {
      recommendations.push({ priority: 0, category: "savings", text: `You're saving ~${(savingsRate * 100).toFixed(0)}% — at or above the 20% target. Consider directing the surplus to retirement (aim ~15% incl. match) and a 3–6 month emergency fund.` });
    }
    // One trim block per over-benchmark category that has ideas.
    const flaggedCats = [];
    for (const f of flags) {
      if ((f.level === "warn" || f.level === "high" || f.level === "soft") && TRIM_IDEAS[f.category] && !flaggedCats.includes(f.category)) {
        flaggedCats.push(f.category);
        recommendations.push({ priority: f.priority, category: f.category, text: TRIM_IDEAS[f.category][0], ideas: TRIM_IDEAS[f.category] });
      }
    }

    return {
      income: round2(income),
      spend: round2(spend),
      surplus: round2(surplus),
      explicitSavings: round2(explicitSavings),
      savingsRate: Math.round(savingsRate * 1000) / 1000,
      band,
      split,
      dti: Math.round(dti * 1000) / 1000,
      emergencyMonths: emergencyMonths == null ? null : Math.round(emergencyMonths * 10) / 10,
      flags,
      recommendations,
      benchmarks: BUDGET_BENCHMARKS,
    };
  }

  function fmtMoney(n) {
    const v = Number(n) || 0;
    return "$" + Math.round(v).toLocaleString("en-US");
  }

  return { analyze, savingsBand, fmtMoney, CATEGORIES, CATEGORY_BY_ID, BUDGET_BENCHMARKS };
});
