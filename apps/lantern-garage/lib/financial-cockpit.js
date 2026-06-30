"use strict";
/**
 * Personal financial reasoning cockpit (#1434).
 *
 * Local-first: the numbers never leave the machine. Reasons about a money snapshot with
 * its work shown — runway, savings rate, net worth, debt-payoff timelines — and
 * stress-tests "can I afford this?" against the actual snapshot rather than a vibe. Every
 * figure carries the formula it came from (Σ₀ evidence) and honest flags surface real risk.
 *
 * All math is pure (no I/O) and deterministic, so it's fully testable.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");
const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const round2 = (x) => Math.round(x * 100) / 100;

// Months to pay off `balance` at `monthlyPayment` and annual `apr` (amortization).
// Returns Infinity if the payment doesn't even cover the monthly interest.
function payoffMonths(balance, apr, monthlyPayment) {
  balance = n(balance); monthlyPayment = n(monthlyPayment);
  if (balance <= 0) return 0;
  const r = n(apr) / 12;
  if (r <= 0) return monthlyPayment > 0 ? Math.ceil(balance / monthlyPayment) : Infinity;
  if (monthlyPayment <= balance * r) return Infinity;            // never clears
  return Math.ceil(-Math.log(1 - (balance * r) / monthlyPayment) / Math.log(1 + r));
}

// Full snapshot analysis with formulas + honest flags.
function analyze(profile = {}) {
  const income = n(profile.monthlyIncome);
  const expenses = n(profile.monthlyExpenses);
  const savings = n(profile.savings);
  const debts = (Array.isArray(profile.debts) ? profile.debts : []).map((d) => ({
    name: String(d.name || "debt"), balance: n(d.balance), apr: n(d.apr), minPayment: n(d.minPayment),
  }));

  const monthlyNet = round2(income - expenses);
  const savingsRate = income > 0 ? round2(monthlyNet / income) : null;
  const runwayMonths = expenses > 0 ? round2(savings / expenses) : Infinity;
  const totalDebt = round2(debts.reduce((a, d) => a + d.balance, 0));
  const netWorth = round2(savings - totalDebt);

  const debtPlans = debts.map((d) => {
    const months = payoffMonths(d.balance, d.apr, d.minPayment);
    return { name: d.name, balance: d.balance, apr: d.apr, minPayment: d.minPayment,
      payoffMonths: months, neverClears: months === Infinity };
  });

  const flags = [];
  if (monthlyNet < 0) flags.push({ level: "alert", msg: `Spending exceeds income by $${Math.abs(monthlyNet)}/mo — the gap is draining savings.` });
  if (runwayMonths !== Infinity && runwayMonths < 1) flags.push({ level: "alert", msg: `Under 1 month of runway — savings barely cover one month of expenses.` });
  else if (runwayMonths !== Infinity && runwayMonths < 3) flags.push({ level: "warn", msg: `Runway is ${runwayMonths} months — below the 3-month emergency-fund floor.` });
  if (savingsRate != null && savingsRate < 0.1 && monthlyNet >= 0) flags.push({ level: "warn", msg: `Savings rate is ${Math.round(savingsRate * 100)}% — under the common 10–20% target.` });
  for (const d of debtPlans) {
    if (d.neverClears) flags.push({ level: "alert", msg: `${d.name}: the minimum payment doesn't cover interest — the balance never clears.` });
    else if (d.apr >= 0.2) flags.push({ level: "warn", msg: `${d.name} carries ${Math.round(d.apr * 100)}% APR — high-interest debt to prioritize.` });
  }
  if (!flags.length) flags.push({ level: "ok", msg: "No red flags: positive cash flow and a healthy runway." });

  return {
    monthlyNet, savingsRate, runwayMonths, totalDebt, netWorth, debtPlans, flags,
    work: {
      monthlyNet: `income ${income} − expenses ${expenses} = ${monthlyNet}`,
      savingsRate: income > 0 ? `net ${monthlyNet} ÷ income ${income} = ${savingsRate}` : "n/a (no income given)",
      runwayMonths: expenses > 0 ? `savings ${savings} ÷ expenses ${expenses} = ${runwayMonths} months` : "n/a (no expenses given)",
      netWorth: `savings ${savings} − total debt ${totalDebt} = ${netWorth}`,
    },
  };
}

// "Can I afford $X?" — stress-test a purchase against the snapshot, showing the work.
function affordability(profile = {}, purchase = {}) {
  const a = analyze(profile);
  const amount = n(purchase.amount);
  const savings = n(profile.savings);
  const expenses = n(profile.monthlyExpenses);
  if (amount <= 0) return { ok: false, error: "purchase amount required" };

  if (purchase.financed) {
    const months = Math.max(1, Math.round(n(purchase.months) || 12));
    const apr = n(purchase.apr);
    const r = apr / 12;
    const payment = r > 0 ? round2(amount * r / (1 - Math.pow(1 + r, -months))) : round2(amount / months);
    const newNet = round2(a.monthlyNet - payment);
    const verdict = newNet < 0 ? "no" : (payment > a.monthlyNet * 0.5 ? "caution" : "yes");
    return {
      mode: "financed", amount, payment, months, newMonthlyNet: newNet, verdict,
      reasoning: verdict === "no"
        ? `A $${payment}/mo payment turns your $${a.monthlyNet}/mo surplus negative ($${newNet}). You'd fund this by shrinking savings each month.`
        : verdict === "caution"
        ? `The $${payment}/mo payment eats over half your $${a.monthlyNet}/mo surplus — doable but tight; an income dip would break it.`
        : `The $${payment}/mo payment leaves $${newNet}/mo surplus — comfortably within cash flow.`,
      work: { payment: `amortize $${amount} over ${months} mo at ${Math.round(apr * 100)}% APR → $${payment}/mo`, newMonthlyNet: `surplus ${a.monthlyNet} − payment ${payment} = ${newNet}` },
    };
  }

  // Cash purchase
  const postSavings = round2(savings - amount);
  const postRunway = expenses > 0 ? round2(postSavings / expenses) : Infinity;
  const pctOfSavings = savings > 0 ? Math.round(amount / savings * 100) : 100;
  const verdict = amount > savings ? "no" : (postRunway !== Infinity && postRunway < 3 ? "caution" : "yes");
  return {
    mode: "cash", amount, postSavings, postRunway, pctOfSavings, verdict,
    reasoning: verdict === "no"
      ? `$${amount} is more than your $${savings} in savings — you can't cover this in cash.`
      : verdict === "caution"
      ? `Paying cash drops savings to $${postSavings} (${postRunway} months runway, below the 3-month floor). It's affordable but would leave you thin.`
      : `Paying cash leaves $${postSavings} (${postRunway === Infinity ? "ample" : postRunway + " months"} runway) — comfortably affordable; it's ${pctOfSavings}% of savings.`,
    work: { postSavings: `savings ${savings} − ${amount} = ${postSavings}`, postRunway: expenses > 0 ? `${postSavings} ÷ expenses ${expenses} = ${postRunway} months` : "n/a" },
  };
}

// ── thin persistence (a single private snapshot, local-only) ────────────────────
function _file(root) { return path.join(root || DEFAULT_REPO_ROOT, "data", "finance", "snapshot.json"); }
function readSnapshot(root) { try { return JSON.parse(fs.readFileSync(_file(root), "utf8")); } catch { return null; } }
function saveSnapshot(root, profile) {
  const f = _file(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(profile, null, 2));
  return profile;
}

module.exports = { payoffMonths, analyze, affordability, readSnapshot, saveSnapshot };
