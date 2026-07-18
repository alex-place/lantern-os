// The Alpaca adapter must load server paper keys under every documented spelling.
// The trader docs + shipped .env use ALPACA_API_KEY / ALPACA_SECRET_KEY, but the
// adapter used to read ONLY ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY — so a
// correctly-configured operator saw the Alpaca paper account as "disconnected" /
// $0.00 (available() returned false because the keys it looked for were unset).
//
// Run: node apps/lantern-garage/test/alpaca-server-key-names.test.js  (isolates cwd)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate so no real stored OAuth creds under data/ shadow the server-keys path.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "lantern-alpaca-keys-")));
const adapter = require(path.join(__dirname, "..", "lib", "alpaca-adapter"));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write("  ok  - " + name + "\n"); }
  catch (e) { failures++; process.stdout.write("  FAIL- " + name + "\n        " + e.message + "\n"); }
}

const ALL = ["ALPACA_API_KEY_ID", "ALPACA_API_KEY", "APCA_API_KEY_ID",
             "ALPACA_API_SECRET_KEY", "ALPACA_API_SECRET", "ALPACA_SECRET_KEY", "APCA_API_SECRET_KEY"];
function clear() { for (const k of ALL) delete process.env[k]; }
const USER = "no-oauth-user"; // fresh id → no stored token → falls through to server keys

check("no keys set → not available (no false positive)", () => {
  clear();
  assert.strictEqual(adapter.available(USER), false);
});

check("documented names ALPACA_API_KEY / ALPACA_SECRET_KEY → available (the #brokers-disconnected fix)", () => {
  clear();
  process.env.ALPACA_API_KEY = "PKID";
  process.env.ALPACA_SECRET_KEY = "sk-secret";
  assert.strictEqual(adapter.available(USER), true);
});

check("official SDK names APCA_API_KEY_ID / APCA_API_SECRET_KEY → available", () => {
  clear();
  process.env.APCA_API_KEY_ID = "PKID";
  process.env.APCA_API_SECRET_KEY = "sk-secret";
  assert.strictEqual(adapter.available(USER), true);
});

check("legacy names ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY still work (no regression)", () => {
  clear();
  process.env.ALPACA_API_KEY_ID = "PKID";
  process.env.ALPACA_API_SECRET_KEY = "sk-secret";
  assert.strictEqual(adapter.available(USER), true);
});

check("id present but secret missing → not available (both required)", () => {
  clear();
  process.env.ALPACA_API_KEY = "PKID";
  assert.strictEqual(adapter.available(USER), false);
});

process.stdout.write("\n" + (failures ? failures + " FAILED\n" : "all alpaca-server-key-names checks passed\n"));
process.exit(failures ? 1 : 0);
