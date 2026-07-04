// Workspace tool tests — #1096
// Verifies the four workspace tools (workspace_read, workspace_write, workspace_list,
// create_document) and the _safeWs path-escape guard.
//
// All workspace tools are OPERATOR-ONLY (no guest_safe): WORKSPACE is a single shared
// directory of personal artifacts, so #1213's filesystem-tool gate applies. Every runTool
// call therefore passes { operator: true } — guest access would leak one user's files to
// another on the public multi-tenant server. (Local users chat via loopback = operator.)
//
// Run: node apps/lantern-garage/test/workspace-tools.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point workspace at a temp dir so tests don't touch ~/.keystone/workspace
const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), "keystone-ws-test-"));
process.env.KEYSTONE_WORKSPACE = TMP_WS;

// Re-require after setting env var so WORKSPACE is picked up
delete require.cache[require.resolve("../lib/tool-runner")];
const { runTool } = require("../lib/tool-runner");

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("  ok  -", name); }
  catch (e) { failures++; console.error("  FAIL-", name, "\n      ", e.message); }
}

async function main() {
  // Helper: runTool returns an envelope {ok, result, reason_code, ...}
  // Extract the result string or the reason on error.
  function r(envelope) { return envelope.result || envelope.reason || JSON.stringify(envelope); }

  // ── workspace_write ─────────────────────────────────────────────────────────

  await check("workspace_write creates a file", async () => {
    await runTool("workspace_write", { file_path: "hello.txt", content: "hello world" }, { operator: true });
    const full = path.join(TMP_WS, "hello.txt");
    assert.ok(fs.existsSync(full), "file not created");
    assert.strictEqual(fs.readFileSync(full, "utf8"), "hello world");
  });

  await check("workspace_write creates intermediate directories", async () => {
    await runTool("workspace_write", { file_path: "sub/dir/note.txt", content: "nested" }, { operator: true });
    assert.ok(fs.existsSync(path.join(TMP_WS, "sub", "dir", "note.txt")));
  });

  await check("workspace_write returns a confirmation message", async () => {
    const env = await runTool("workspace_write", { file_path: "msg.txt", content: "x" }, { operator: true });
    const result = r(env);
    assert.ok(result.includes("workspace/msg.txt"), `unexpected: ${result}`);
  });

  // ── workspace_read ──────────────────────────────────────────────────────────

  await check("workspace_read returns file content", async () => {
    fs.writeFileSync(path.join(TMP_WS, "read-me.txt"), "content here", "utf8");
    const env = await runTool("workspace_read", { file_path: "read-me.txt" }, { operator: true });
    assert.strictEqual(r(env), "content here");
  });

  await check("workspace_read returns error on missing file", async () => {
    const env = await runTool("workspace_read", { file_path: "no-such.txt" }, { operator: true });
    assert.ok(!env.ok, "expected ok=false");
    assert.ok(/not.found|workspace/i.test(r(env)), `unexpected: ${r(env)}`);
  });

  // ── workspace_list ──────────────────────────────────────────────────────────

  await check("workspace_list returns file names", async () => {
    const env = await runTool("workspace_list", {}, { operator: true });
    const result = r(env);
    assert.ok(result.includes("hello.txt"), `listing was: ${result}`);
  });

  await check("workspace_list returns (no files) for empty subdir", async () => {
    fs.mkdirSync(path.join(TMP_WS, "emptydir"), { recursive: true });
    const env = await runTool("workspace_list", { path: "emptydir" }, { operator: true });
    assert.strictEqual(r(env), "(no files)");
  });

  // ── create_document ─────────────────────────────────────────────────────────

  await check("create_document adds .md extension when none provided", async () => {
    await runTool("create_document", { filename: "resume", content: "# My Resume" }, { operator: true });
    assert.ok(fs.existsSync(path.join(TMP_WS, "resume.md")));
  });

  await check("create_document respects .txt format", async () => {
    await runTool("create_document", { filename: "notes", content: "plain text", format: "text" }, { operator: true });
    assert.ok(fs.existsSync(path.join(TMP_WS, "notes.txt")));
  });

  await check("create_document does not double-add extension", async () => {
    await runTool("create_document", { filename: "cv.md", content: "# CV" }, { operator: true });
    assert.ok(fs.existsSync(path.join(TMP_WS, "cv.md")));
    assert.ok(!fs.existsSync(path.join(TMP_WS, "cv.md.md")));
  });

  // ── path-escape guard ───────────────────────────────────────────────────────

  await check("workspace_read rejects path escape attempt (..)", async () => {
    const env = await runTool("workspace_read", { file_path: "../../etc/passwd" }, { operator: true });
    assert.ok(!env.ok, "expected ok=false");
    assert.ok(/unsafe|escape/i.test(r(env)), `expected escape error, got: ${r(env)}`);
  });

  await check("workspace_write rejects path escape attempt (..)", async () => {
    const env = await runTool("workspace_write", { file_path: "../evil.txt", content: "x" }, { operator: true });
    assert.ok(!env.ok, "expected ok=false");
    assert.ok(/unsafe|escape/i.test(r(env)), `expected escape error, got: ${r(env)}`);
  });

  // ── workspace tools are separate from repo sandbox ───────────────────────────

  await check("workspace_write path does not touch repo root", async () => {
    const REPO = path.resolve(__dirname, "../../..");
    await runTool("workspace_write", { file_path: "artifact.txt", content: "out" }, { operator: true });
    const wPath = path.join(TMP_WS, "artifact.txt");
    assert.ok(!wPath.startsWith(REPO + path.sep), "workspace file landed inside repo");
  });

  // ── cleanup ──────────────────────────────────────────────────────────────────
  fs.rmSync(TMP_WS, { recursive: true, force: true });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  else           { console.log("\nAll tests passed"); }
}

main().catch(e => { console.error("Unexpected error:", e); process.exit(1); });
