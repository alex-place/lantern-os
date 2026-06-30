// #1434 — financial reasoning math: analysis, payoff, affordability. Pure, deterministic.
//
// Run: node apps/lantern-garage/test/financial-cockpit.test.js
const assert = require("assert");
const fc = require("../lib/financial-cockpit");

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.message}\n`); }
}

// payoffMonths
check("payoff: zero-interest is balance/payment", () =>
  assert.strictEqual(fc.payoffMonths(1200, 0, 100), 12));
check("payoff: never clears when payment <= monthly interest", () =>
  assert.strictEqual(fc.payoffMonths(10000, 0.24, 150), Infinity));   // 10000*0.02=200 > 150
check("payoff: finite for a real amortizing payment", () => {
  const m = fc.payoffMonths(5000, 0.18, 250);
  assert.ok(m > 0 && m < Infinity && m >= 22);
});
check("payoff: zero balance → 0", () => assert.strictEqual(fc.payoffMonths(0, 0.2, 50), 0));

// analyze
check("analyze computes net, savings rate, runway, net worth", () => {
  const a = fc.analyze({ monthlyIncome: 5000, monthlyExpenses: 4000, savings: 12000, debts: [{ balance: 3000 }] });
  assert.strictEqual(a.monthlyNet, 1000);
  assert.strictEqual(a.savingsRate, 0.2);
  assert.strictEqual(a.runwayMonths, 3);          // 12000/4000
  assert.strictEqual(a.netWorth, 9000);           // 12000 - 3000
});

check("analyze flags overspending (alert)", () => {
  const a = fc.analyze({ monthlyIncome: 3000, monthlyExpenses: 3500, savings: 5000 });
  assert.ok(a.monthlyNet < 0);
  assert.ok(a.flags.some((f) => f.level === "alert" && /exceeds income/.test(f.msg)));
});

check("analyze flags thin runway (warn) and high-APR debt", () => {
  const a = fc.analyze({ monthlyIncome: 4000, monthlyExpenses: 3000, savings: 5000, debts: [{ name: "Card", balance: 2000, apr: 0.25, minPayment: 200 }] });
  assert.ok(a.flags.some((f) => /Runway/.test(f.msg)));        // 5000/3000 = 1.67 < 3
  assert.ok(a.flags.some((f) => /25% APR/.test(f.msg)));
});

check("analyze flags a never-clearing minimum payment", () => {
  const a = fc.analyze({ monthlyIncome: 6000, monthlyExpenses: 3000, savings: 20000, debts: [{ name: "Card", balance: 10000, apr: 0.24, minPayment: 150 }] });
  assert.ok(a.flags.some((f) => /never clears/.test(f.msg)));
});

check("analyze: healthy snapshot → ok flag, shows its work", () => {
  const a = fc.analyze({ monthlyIncome: 6000, monthlyExpenses: 3500, savings: 20000 });
  assert.ok(a.flags.some((f) => f.level === "ok"));
  assert.ok(/income 6000 − expenses 3500/.test(a.work.monthlyNet));
});

// affordability — cash
check("afford cash: comfortably affordable → yes", () => {
  const r = fc.affordability({ monthlyExpenses: 3000, savings: 20000 }, { amount: 2000 });
  assert.strictEqual(r.verdict, "yes");
  assert.ok(/postSavings/.test(JSON.stringify(r.work)));
});
check("afford cash: drops runway below 3mo → caution", () => {
  const r = fc.affordability({ monthlyExpenses: 3000, savings: 10000 }, { amount: 3000 });   // post 7000/3000=2.33
  assert.strictEqual(r.verdict, "caution");
});
check("afford cash: more than savings → no", () => {
  const r = fc.affordability({ monthlyExpenses: 2000, savings: 1000 }, { amount: 5000 });
  assert.strictEqual(r.verdict, "no");
});

// affordability — financed
check("afford financed: payment that breaks cash flow → no", () => {
  const r = fc.affordability({ monthlyIncome: 3000, monthlyExpenses: 2900 }, { amount: 12000, financed: true, months: 12, apr: 0.1 });
  assert.strictEqual(r.mode, "financed");
  assert.strictEqual(r.verdict, "no");            // ~$1055/mo payment >> $100 surplus
  assert.ok(r.newMonthlyNet < 0);
});
check("afford financed: small payment within surplus → yes", () => {
  const r = fc.affordability({ monthlyIncome: 6000, monthlyExpenses: 3000 }, { amount: 1200, financed: true, months: 24, apr: 0.0 });
  assert.strictEqual(r.verdict, "yes");
  assert.strictEqual(r.payment, 50);              // 1200/24
});

if (failures) { process.stderr.write(`\n${failures} FAILED\n`); process.exit(1); }
process.stdout.write("\nall financial-cockpit checks passed\n");
