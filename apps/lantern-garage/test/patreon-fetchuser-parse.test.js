// Integration test for the REAL Patreon parsing path: drive realistic Patreon v2
// identity JSON:API payloads through PROVIDERS.patreon.fetchUser() (which the OAuth
// callback calls with a live access token) and assert the derived amounts + role.
//
// Critically covers CAMPAIGN SCOPING: the identity.memberships scope returns the user's
// memberships to EVERY creator they back, so fetchUser must select only OUR campaign's
// membership (PATREON_CAMPAIGN_ID) — otherwise an unrelated pledge escalates or a paying
// member is locked out.
//
// Run: node apps/lantern-garage/test/patreon-fetchuser-parse.test.js

let CURRENT; // the payload the mocked identity endpoint returns for the current case
global.fetch = async () => ({ ok: true, status: 200, json: async () => CURRENT, text: async () => "" });

const assert = require("assert");
const OUR = "campaign_OURS";
process.env.PATREON_CAMPAIGN_ID = OUR; // scope to our campaign for the scoped cases
delete require.cache[require.resolve("../lib/auth-providers")];
const { PROVIDERS, resolveRole } = require("../lib/auth-providers");
const patreon = PROVIDERS.patreon;

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.error("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

// One membership block: a `member` object (with campaign + currently_entitled_tiers
// relationships) plus the `tier` objects it entitles. tiers = [{id, amount, title}].
function membership(campaignId, tiers) {
  const memberId = "m_" + campaignId + "_" + tiers.map((t) => t.id).join("_");
  return {
    member: {
      type: "member",
      id: memberId,
      relationships: {
        campaign: { data: { type: "campaign", id: campaignId } },
        currently_entitled_tiers: { data: tiers.map((t) => ({ type: "tier", id: t.id })) },
      },
    },
    tierObjs: tiers.map((t) => ({
      type: "tier",
      id: t.id,
      attributes: t.amount === undefined ? { title: t.title || "Tier" } : { title: t.title || "Tier", amount_cents: t.amount },
    })),
    memberRef: { type: "member", id: memberId },
  };
}

// Build a full identity payload from one or more membership blocks.
function identity(userId, blocks) {
  const included = [];
  const memberRefs = [];
  for (const b of blocks) { included.push(b.member, ...b.tierObjs); memberRefs.push(b.memberRef); }
  return {
    data: {
      type: "user",
      id: String(userId),
      attributes: { email: `u${userId}@example.com`, full_name: `User ${userId}` },
      relationships: { memberships: { data: memberRefs } },
    },
    included,
  };
}

async function resolve(payload) {
  CURRENT = payload;
  const user = await patreon.fetchUser("tok");
  return { user, role: resolveRole(patreon, user) };
}

(async () => {
  // ── basic tiers on OUR campaign ────────────────────────────────────────────────
  await check("no membership → guest", async () => {
    const { user, role } = await resolve(identity("1", []));
    assert.deepEqual(user.entitledAmountsCents, []);
    assert.equal(role, "guest");
  });
  await check("$5 on our campaign → supporter", async () => {
    const { role } = await resolve(identity("2", [membership(OUR, [{ id: "t5", amount: 500 }])]));
    assert.equal(role, "supporter");
  });
  await check("$20 on our campaign → deep_dreamer (trading unlock)", async () => {
    const { user, role } = await resolve(identity("3", [membership(OUR, [{ id: "t20", amount: 2000 }])]));
    assert.deepEqual(user.entitledAmountsCents, [2000]);
    assert.equal(role, "deep_dreamer");
  });
  await check("$200 top tier → deep_dreamer, NOT admin", async () => {
    const { role } = await resolve(identity("4", [membership(OUR, [{ id: "t200", amount: 20000 }])]));
    assert.equal(role, "deep_dreamer");
  });

  // ── fail-closed edge cases ─────────────────────────────────────────────────────
  await check("$0 free tier on our campaign → guest (no free paid gate)", async () => {
    const { role } = await resolve(identity("5", [membership(OUR, [{ id: "t0", amount: 0 }])]));
    assert.equal(role, "guest");
  });
  await check("entitled tier with missing amount_cents → guest (fail closed, never over-grant)", async () => {
    const { user, role } = await resolve(identity("6", [membership(OUR, [{ id: "tX" /* no amount */ }])]));
    assert.deepEqual(user.entitledAmountsCents, []);
    assert.equal(role, "guest");
  });

  // ── CAMPAIGN SCOPING (the blocker) ─────────────────────────────────────────────
  await check("SCOPING: unrelated $200 elsewhere + our $0 → deep_dreamer NOT granted; our free → guest (no cross-campaign escalation)", async () => {
    // member of OUR campaign at $0, and a $200 pledge to an UNRELATED campaign listed FIRST.
    const { user, role } = await resolve(
      identity("7", [
        membership("campaign_OTHER", [{ id: "o200", amount: 20000 }]),
        membership(OUR, [{ id: "t0", amount: 0 }]),
      ])
    );
    assert.deepEqual(user.entitledAmountsCents, [0], "only OUR campaign's amounts count");
    assert.equal(role, "guest", "unrelated $200 must NOT escalate on our campaign");
  });
  await check("SCOPING: our paying $20 listed SECOND behind an unrelated free membership → deep_dreamer (no lockout)", async () => {
    const { user, role } = await resolve(
      identity("8", [
        membership("campaign_OTHER", []), // unrelated free follow, first
        membership(OUR, [{ id: "t20", amount: 2000 }]),
      ])
    );
    assert.deepEqual(user.entitledAmountsCents, [2000], "picks OUR campaign regardless of order");
    assert.equal(role, "deep_dreamer", "paying member is NOT locked out");
  });
  await check("SCOPING: member of ONLY an unrelated campaign → guest here", async () => {
    const { role } = await resolve(identity("9", [membership("campaign_OTHER", [{ id: "o20", amount: 2000 }])]));
    assert.equal(role, "guest");
  });

  // ── behavior when PATREON_CAMPAIGN_ID is unset ─────────────────────────────────
  await check("no campaign id + single membership → used (single-campaign back-compat)", async () => {
    delete process.env.PATREON_CAMPAIGN_ID;
    const { role } = await resolve(identity("10", [membership(OUR, [{ id: "t20", amount: 2000 }])]));
    assert.equal(role, "deep_dreamer");
  });
  await check("no campaign id + MULTIPLE memberships → guest (fail closed, refuse to guess)", async () => {
    const { role } = await resolve(
      identity("11", [
        membership("campaign_OTHER", [{ id: "o200", amount: 20000 }]),
        membership(OUR, [{ id: "t20", amount: 2000 }]),
      ])
    );
    assert.equal(role, "guest", "ambiguous multi-campaign with no configured id must not guess");
    process.env.PATREON_CAMPAIGN_ID = OUR; // restore
  });

  // ── owner override end-to-end (the 'owner keeps admin' claim) ──────────────────
  await check("LANTERN_ADMIN_IDS owner is admin end-to-end even with no paid tier", async () => {
    process.env.LANTERN_ADMIN_IDS = "owner777";
    delete require.cache[require.resolve("../lib/auth-providers")];
    const fresh = require("../lib/auth-providers");
    CURRENT = { data: { type: "user", id: "owner777", attributes: { email: "o@x", full_name: "Owner" },
      relationships: { memberships: { data: [] } } }, included: [] };
    const u = await fresh.PROVIDERS.patreon.fetchUser("tok");
    assert.equal(fresh.resolveRole(fresh.PROVIDERS.patreon, u), "admin", "owner is admin regardless of pledge");
    // a non-owner with the SAME free profile is guest
    CURRENT.data.id = "randomuser";
    const u2 = await fresh.PROVIDERS.patreon.fetchUser("tok");
    assert.equal(fresh.resolveRole(fresh.PROVIDERS.patreon, u2), "guest", "non-owner free → guest");
    delete process.env.LANTERN_ADMIN_IDS;
    delete require.cache[require.resolve("../lib/auth-providers")];
  });

  console.error(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
