// destroyUserSessions removes exactly the target user's persisted sessions and nothing
// else — the mechanism that makes a privileged role change take effect on live sessions
// immediately (#2627), instead of the old "keeps privileges until logout".
//
// Run: node apps/lantern-garage/test/session-invalidation.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { destroyUserSessions } = require("../lib/session-file-store");

let failures = 0;
function check(name, fn) { try { fn(); console.error("  ok  -", name); } catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-inval-"));
const write = (sid, userId) => fs.writeFileSync(path.join(dir, sid + ".json"),
  JSON.stringify({ __expires: Date.now() + 1e6, sess: userId ? { user: { id: userId, role: "admin" } } : {} }));

write("a", "victim");
write("b", "victim");
write("c", "other-user");
write("d", null);            // anonymous session (no user)
fs.writeFileSync(path.join(dir, "notes.txt"), "not a session");

check("removes exactly the target user's sessions", () => {
  const n = destroyUserSessions(dir, "victim");
  assert.equal(n, 2, "should remove both victim sessions");
  assert.ok(!fs.existsSync(path.join(dir, "a.json")) && !fs.existsSync(path.join(dir, "b.json")), "victim files gone");
});
check("leaves other users, anonymous sessions, and non-session files untouched", () => {
  assert.ok(fs.existsSync(path.join(dir, "c.json")), "other user kept");
  assert.ok(fs.existsSync(path.join(dir, "d.json")), "anonymous session kept");
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "non-json kept");
});
check("no match / bad dir → 0, no throw", () => {
  assert.equal(destroyUserSessions(dir, "nobody"), 0);
  assert.equal(destroyUserSessions(path.join(dir, "does-not-exist"), "x"), 0);
  assert.equal(destroyUserSessions(null, "x"), 0);
});

console.error(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
