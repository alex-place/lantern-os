"use strict";
/**
 * account-lock.test.js — one broker account, one managing process.
 *
 * On 2026-07-31 the stable (:4177) and dev (:4178) servers both ran the scan loop
 * against IBKR DUR193395 with separate trader-state.json files. Neither could see the
 * other's orders: duplicate submissions seconds apart, mirrored exit rows in both
 * ledgers, and a TLT long that went through flat into an unintended short.
 *
 * The lock must also FAIL OPEN and must RECOVER from a crashed holder — an account
 * left unmanaged means open positions stop getting their exits run, which is strictly
 * worse than a duplicate order.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TRADER_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "acct-lock-"));
const lock = require("../lib/account-lock");

const ACCT = "DUR193395";
const OTHER_PROCESS = { pid: process.pid + 12345, host: os.hostname() };

/** Hard reset a lock file — release() deliberately refuses to remove a FOREIGN lock,
 *  so tests that seed one must clear it themselves rather than leak it to the next. */
function clearLock(acct) {
  try { fs.unlinkSync(path.join(lock.LOCK_DIR, acct + ".lock.json")); } catch (_e) { /* absent */ }
}

function writeForeignLock(heartbeat, armed = false) {
  fs.mkdirSync(lock.LOCK_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(lock.LOCK_DIR, ACCT + ".lock.json"),
    JSON.stringify({ ...OTHER_PROCESS, accountId: ACCT, armed, heartbeat }),
  );
}

test("a free account is acquired, and re-acquiring is a renewal not a conflict", () => {
  lock.release(ACCT);
  const a = lock.acquire(ACCT);
  assert.strictEqual(a.acquired, true);
  assert.strictEqual(a.reason, "acquired");
  const b = lock.acquire(ACCT);
  assert.strictEqual(b.acquired, true, "the SAME process must never lock itself out");
  assert.strictEqual(b.reason, "renewed");
});

test("a second live process is refused — this is the collision that cost us TLT", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now());              // the other server, heartbeating now
  const r = lock.acquire(ACCT);
  assert.strictEqual(r.acquired, false, "two processes must not manage one account");
  assert.match(r.reason, /held by pid/);
  assert.strictEqual(r.heldBy.pid, OTHER_PROCESS.pid);
});

test("a CRASHED holder is taken over — an account must never be left unmanaged", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now() - (lock.DEFAULT_STALE_MS + 60_000));
  const r = lock.acquire(ACCT);
  assert.strictEqual(r.acquired, true, "a dead process must not wedge the account forever");
  assert.match(r.reason, /took over from stale/);
  assert.strictEqual(lock.holder(ACCT).pid, process.pid);
});

test("a holder that is merely slow is NOT evicted", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now() - 90_000);     // 90s: slower than a 60s scan, still alive
  const r = lock.acquire(ACCT);
  assert.strictEqual(r.acquired, false, "staleMs must comfortably exceed the scan interval");
  assert.ok(lock.DEFAULT_STALE_MS > 60_000, "a 60s scan must never look stale");
});

// ── ARMED RANK (2026-08-05 incident) ─────────────────────────────────────────
// The disarmed dev server held IBKR DUR193395 all morning and the armed trader
// stood down, so a live trading day produced zero entries and no error.

test("the ARMED trader preempts a live DISARMED holder — the 2026-08-05 lockout", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now(), false);        // exit-only dev server, heartbeating NOW
  const r = lock.acquire(ACCT, { armed: true });
  assert.strictEqual(r.acquired, true, "an armed trader must outrank an exit-only holder");
  assert.match(r.reason, /preempted disarmed/);
  assert.strictEqual(lock.holder(ACCT).pid, process.pid);
  assert.strictEqual(lock.holder(ACCT).armed, true);
});

test("a DISARMED process must NEVER evict the armed trader", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now(), true);         // the armed trader owns it
  const r = lock.acquire(ACCT, { armed: false });
  assert.strictEqual(r.acquired, false, "exit-only must not steal the account from the armed trader");
  assert.strictEqual(lock.holder(ACCT).pid, OTHER_PROCESS.pid, "their lock survives");
});

test("two ARMED instances still cannot both drive one account", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now(), true);
  const r = lock.acquire(ACCT, { armed: true });
  assert.strictEqual(r.acquired, false, "equal rank stays first-come-first-served — the original bug");
});

test("armed rank is STICKY — our own exit-only tick must not demote our lock", () => {
  clearLock(ACCT);                            // prior test seeded a FOREIGN lock; release() won't remove it
  assert.strictEqual(lock.acquire(ACCT, { armed: true }).acquired, true);
  lock.acquire(ACCT, { armed: false });       // the armed trader's own fast-exit tick
  assert.strictEqual(lock.holder(ACCT).armed, true,
    "a self-renewal must not drop armed rank, or a second armed instance could preempt us");
});

test("release only ever removes OUR lock", () => {
  lock.release(ACCT);
  writeForeignLock(Date.now());
  assert.strictEqual(lock.release(ACCT), false, "must not release another process's lock");
  assert.strictEqual(lock.holder(ACCT).pid, OTHER_PROCESS.pid, "their lock survives");
});

test("two different accounts never contend", () => {
  clearLock(ACCT);
  clearLock("PA3KZEWVVZTP");
  assert.strictEqual(lock.acquire(ACCT).acquired, true);
  assert.strictEqual(lock.acquire("PA3KZEWVVZTP").acquired, true,
    "a second Pilot customer's account must not be blocked by the first");
});

test("FAILS OPEN when the lock store is unusable", () => {
  const saved = process.env.TRADER_LOCK_DIR;
  try {
    // Point the dir at a FILE so mkdir/write must fail.
    const asFile = path.join(os.tmpdir(), "acct-lock-not-a-dir-" + process.pid);
    fs.writeFileSync(asFile, "x");
    delete require.cache[require.resolve("../lib/account-lock")];
    process.env.TRADER_LOCK_DIR = asFile;
    const broken = require("../lib/account-lock");
    const r = broken.acquire(ACCT);
    assert.strictEqual(r.acquired, true, "a broken lock must never strand a live position");
    assert.match(r.reason, /lock unavailable/);
  } finally {
    process.env.TRADER_LOCK_DIR = saved;
    delete require.cache[require.resolve("../lib/account-lock")];
  }
});

test("a missing account id is not lockable and does not block", () => {
  const r = lock.acquire(null);
  assert.strictEqual(r.acquired, true);
  assert.strictEqual(lock.holder(null), null);
});

test("the DEFAULT lock dir is machine-wide, NOT inside a checkout", () => {
  // Regression: resolving the dir relative to __dirname gave each worktree its own
  //   dev    -> C:\dev\lantern-os-dev\data\lantern-garage\trading\locks
  //   stable -> C:\dev\lantern-os-stable\data\lantern-garage\trading\locks
  // so neither server could see the other's lock and the collision it exists to stop
  // would have gone right on happening, silently.
  const saved = process.env.TRADER_LOCK_DIR;
  try {
    delete process.env.TRADER_LOCK_DIR;
    delete require.cache[require.resolve("../lib/account-lock")];
    const fresh = require("../lib/account-lock");
    assert.strictEqual(fresh.LOCK_DIR, path.join(os.tmpdir(), "unisona-account-locks"));
    // Must not sit under the repo, or two checkouts diverge again.
    assert.ok(!/lantern-garage/.test(fresh.LOCK_DIR), "lock dir must not live in a checkout");
    assert.ok(!fresh.LOCK_DIR.startsWith(path.resolve(__dirname, "..")), "lock dir must be outside the app tree");
  } finally {
    if (saved === undefined) delete process.env.TRADER_LOCK_DIR; else process.env.TRADER_LOCK_DIR = saved;
    delete require.cache[require.resolve("../lib/account-lock")];
  }
});
