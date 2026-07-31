"use strict";

/**
 * lib/plan-matrix.js — the four-plan capability matrix (#2550), single source of truth.
 *
 * Product plan v5 §01 tier matrix + §02 Level-2 gate. Maps the product plans
 * (Free / Pro / Pilot) onto the existing Patreon roles so current supporters keep
 * their access, and declares — as DATA — which capability each plan unlocks. Both
 * the server-side gates and the pricing page can read this one table, so
 * "pricing.html matches enforcement 1:1" becomes a checkable property instead of a
 * hope (that reconciliation + the flip to live enforcement are the founder's
 * Level-2 activation; see PLAN_ENFORCEMENT below).
 *
 * ENFORCEMENT IS OFF BY DEFAULT. This module is a pure matrix + resolvers. The
 * live gate (lib/auth-middleware.hasEntitlement) only consults it when
 * PLAN_ENFORCEMENT=1 — until then, current behavior is byte-identical. The plan
 * explicitly sequences activation AFTER Level 1 clears ("Pro isn't worth paying
 * for until BYOK works" — #2505, now done) and the green-path gate passes.
 *
 * LOOP STAGE: Act (role-appropriate capability surface, enforced not just hidden).
 */

// Plans, cheapest → dearest. `business` is an alias the product plan uses for pilot.
const PLAN_ORDER = ["free", "pro", "pilot"];
const PLAN_ALIASES = { business: "pilot" };

// Existing Patreon roles → plan. supporter ($5, retired) is grandfathered to Free
// (matches TIER_LABEL in routes/pages.js: supporter → "Free"). deep_dreamer/founder
// ($20) = Pro. admin is STAFF (holds everything implicitly) and maps to the top plan
// for capability purposes without being a purchasable tier.
const ROLE_TO_PLAN = {
  guest: "free",
  supporter: "free",
  deep_dreamer: "pro",
  founder: "pro", // legacy alias for deep_dreamer (#698)
  pilot: "pilot",
  tech_support: "pilot", // staff
  admin: "pilot",
};

/**
 * Capabilities, each with the MINIMUM plan that unlocks it. Grouped by the §01
 * matrix rows. `entitlement` (optional) is the legacy entitlement key this
 * capability corresponds to, so the flagged gate reconciles with today's checks.
 */
const CAPABILITIES = {
  // ── Free (signed-in) ────────────────────────────────────────────────────────
  chat_memory:        { minPlan: "free", label: "Memory-backed chat" },
  paper_account:      { minPlan: "free", label: "Paper trading account" },
  personalized_charts:{ minPlan: "free", label: "Personalized charts + watchlist" },
  demo_view:          { minPlan: "free", label: "Live demo account view" },
  // Own-broker trading is Free (operator decision, 2026-07-31): a signed-in user
  // who connects their OWN brokerage account trades their own money on their own
  // venue. Requires a connected broker, which lib/auth-middleware enforces — the
  // plan alone does not grant it. Pro still buys the terminal extras below.
  live_trading:       { minPlan: "free", label: "Trading via your own connected broker", entitlement: "trade" },
  // ── Pro adds ($20) ──────────────────────────────────────────────────────────
  trade_terminal:     { minPlan: "pro", label: "Trading terminal (manual orders + AI tradelist)" },
  advisor:            { minPlan: "pro", label: "Portfolio advisor (risk/rebalance/planner)" },
  options_manual:     { minPlan: "pro", label: "Manual paper options orders" },
  byok_keys:          { minPlan: "pro", label: "Bring-your-own AI keys (#2505)" },
  price_alerts:       { minPlan: "pro", label: "Price alerts + auto trade journal" },
  creator_suite:      { minPlan: "pro", label: "Creator Suite (video → shorts)" },
  wide_research:      { minPlan: "pro", label: "Wide multi-model research + persistent memory" },
  // ── Pilot / Business adds ($200) ────────────────────────────────────────────
  ai_trader:          { minPlan: "pilot", label: "Autonomous AI trader", entitlement: "ai_trader" },
  unisona_trader:     { minPlan: "pilot", label: "UnisonaTrader advisor (#2556)" },
  roadmap_say:        { minPlan: "pilot", label: "Backer say in what we build next" },
};

function planRank(plan) {
  const p = PLAN_ALIASES[plan] || plan;
  const i = PLAN_ORDER.indexOf(p);
  return i < 0 ? -1 : i;
}

/** Canonical plan for a role name (unknown → free floor). */
function planForRole(role) {
  return ROLE_TO_PLAN[String(role || "").toLowerCase()] || "free";
}

/** The minimum plan that unlocks a capability, or null for an unknown capability. */
function minPlanForCapability(cap) {
  const c = CAPABILITIES[cap];
  return c ? c.minPlan : null;
}

/** Does `plan` (or a dearer one) include `capability`? */
function planHasCapability(plan, capability) {
  const need = minPlanForCapability(capability);
  if (!need) return false; // unknown capability is never granted
  return planRank(plan) >= planRank(need);
}

/** Does a role's plan include a capability? */
function roleHasCapability(role, capability) {
  return planHasCapability(planForRole(role), capability);
}

/** Every capability a plan (or dearer) unlocks — for the pricing page / report. */
function capabilitiesForPlan(plan) {
  return Object.keys(CAPABILITIES).filter((c) => planHasCapability(plan, c));
}

/** Reconciliation report: plan → its capabilities (+ labels). Powers the 1:1 check. */
function planReport() {
  const out = {};
  for (const plan of PLAN_ORDER) {
    out[plan] = capabilitiesForPlan(plan).map((c) => ({ key: c, label: CAPABILITIES[c].label }));
  }
  return { plans: PLAN_ORDER, roleToPlan: ROLE_TO_PLAN, report: out };
}

module.exports = {
  PLAN_ORDER,
  PLAN_ALIASES,
  ROLE_TO_PLAN,
  CAPABILITIES,
  planForRole,
  planRank,
  minPlanForCapability,
  planHasCapability,
  roleHasCapability,
  capabilitiesForPlan,
  planReport,
};
