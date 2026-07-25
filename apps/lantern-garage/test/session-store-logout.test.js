// Logout durability contract for the file-backed session store.
//
// express-session calls touch() at the end of every request that loaded an
// unmodified session. A request in flight while another tab logs out therefore
// touches a sid that destroy() already unlinked — and destroy() also drops the
// touch-throttle entry, so that touch is never throttled. touch() must be
// extend-only: it may refresh an existing file's expiry but must never
// re-create a destroyed session (the resurrection bug caught by the auth E2E).
//
// Run: node --test apps/lantern-garage/test/session-store-logout.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileSessionStore } = require("../lib/session-file-store");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sess-store-"));
}
const SESS = { cookie: { expires: new Date(Date.now() + 3600_000).toISOString() }, user: { id: "u1" } };
const call = (fn, ...args) => new Promise((res, rej) => fn(...args, (e, v) => (e ? rej(e) : res(v))));

test("touch() after destroy() does NOT resurrect the session", async () => {
  const store = new FileSessionStore({ dir: tmpDir() });
  await call(store.set.bind(store), "sid1", SESS);
  await call(store.destroy.bind(store), "sid1");
  await call(store.touch.bind(store), "sid1", SESS); // the in-flight request's touch
  const got = await call(store.get.bind(store), "sid1");
  assert.strictEqual(got, null, "destroyed session must stay destroyed after touch()");
});

test("touch() still extends a live session once the throttle window passes", async () => {
  const store = new FileSessionStore({ dir: tmpDir() });
  await call(store.set.bind(store), "sid2", SESS);
  store._lastSet.delete("sid2"); // simulate throttle window elapsed
  const later = { ...SESS, cookie: { expires: new Date(Date.now() + 7200_000).toISOString() } };
  await call(store.touch.bind(store), "sid2", later);
  const got = await call(store.get.bind(store), "sid2");
  assert.ok(got && got.user && got.user.id === "u1", "live session survives touch()");
});

test("set() after destroy() still creates a fresh session (touch guard must not block real logins)", async () => {
  const store = new FileSessionStore({ dir: tmpDir() });
  await call(store.set.bind(store), "sid3", SESS);
  await call(store.destroy.bind(store), "sid3");
  await call(store.set.bind(store), "sid3", SESS); // a genuine re-login re-uses set()
  const got = await call(store.get.bind(store), "sid3");
  assert.ok(got && got.user, "explicit set() recreates the session");
});
