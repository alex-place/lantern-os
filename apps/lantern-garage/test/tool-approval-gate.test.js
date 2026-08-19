/**
 * test/tool-approval-gate.test.js
 *
 * #3070 — human-in-the-loop approval for side-effectful tools. Tool execution is ON by
 * default now, so the model can reach for a repo-mutating, shell or money-spending tool
 * without anyone having agreed to that specific action. Operator-gating answers "who may use
 * this tool at all"; it does not answer "did a human approve THIS call".
 *
 * The property that actually matters is arg-binding: an approval for one call must never
 * authorise a different one.
 *
 * Run with: npx jest test/tool-approval-gate.test.js
 */
const { REGISTRY, approvalToken, runTool } = require("../lib/tool-runner");

describe("which tools are gated", () => {
  const gated = Object.entries(REGISTRY).filter(([, e]) => e.needsApproval).map(([n]) => n);

  test.each(["Write", "Edit", "Bash", "PowerShell", "propose_coding_change", "local_eval_keystone_run", "generate_image"])(
    "gated: %s", (n) => expect(gated).toContain(n));

  // Deliberately NOT gated: these write to the USER'S OWN workspace and producing that file
  // is the entire point of the call ("make me a resume"). Prompting for approval there would
  // be friction without a safety benefit.
  test.each(["workspace_write", "create_document", "generate_document", "export_document"])(
    "not gated (user's own workspace, explicitly requested): %s", (n) => expect(gated).not.toContain(n));

  test.each(["web_search", "Read", "Grep", "github_issue"])(
    "not gated (read-only): %s", (n) => expect(gated).not.toContain(n));
});

describe("approvalToken binds tool AND arguments", () => {
  test("same tool + same args → same token (so the client can echo it back)", () => {
    expect(approvalToken("Write", { file_path: "a.txt", content: "x" }))
      .toBe(approvalToken("Write", { file_path: "a.txt", content: "x" }));
  });

  test("key ORDER does not change the token", () => {
    expect(approvalToken("Write", { file_path: "a.txt", content: "x" }))
      .toBe(approvalToken("Write", { content: "x", file_path: "a.txt" }));
  });

  test("different args → different token (the whole point)", () => {
    expect(approvalToken("Write", { file_path: "notes.md" }))
      .not.toBe(approvalToken("Write", { file_path: "server.js" }));
  });

  test("different tool, same args → different token", () => {
    expect(approvalToken("Write", { file_path: "a" })).not.toBe(approvalToken("Edit", { file_path: "a" }));
  });

  test("a tool name cannot be smuggled across the separator boundary", () => {
    // Without an explicit separator, ("ab", "c") and ("a", "bc") could concatenate alike.
    expect(approvalToken("ab", { k: "c" })).not.toBe(approvalToken("a", { k: "bc" }));
  });
});

describe("enforcement in runTool", () => {
  const ctx = { operator: true };
  const args = { file_path: "data/__approval_test.txt", content: "hello" };

  test("a gated call with NO approval is refused and returns a challenge", async () => {
    const r = await runTool("Write", args, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason_code).toBe("approval_required");
    expect(r.approval && r.approval.token).toEqual(expect.any(String));
    expect(r.approval.tool).toBe("Write");
    expect(r.error).toMatch(/approval/i);
  });

  test("a WRONG token does not unlock it", async () => {
    const r = await runTool("Write", args, { ...ctx, approvals: ["0000000000000000"] });
    expect(r.reason_code).toBe("approval_required");
  });

  test("swapped arguments are DISCARDED — the approved call is what runs", async () => {
    // The model rarely reproduces byte-identical arguments when it retries, so an approval
    // replays the arguments the human actually saw. The security property that matters is
    // that the model's substituted arguments never take effect: asking to write __other.txt
    // on an approval granted for __approval_test.txt must not create __other.txt.
    const fs = require("fs");
    const path = require("path");
    const other = path.resolve(__dirname, "../../../data/__other.txt");
    try { fs.unlinkSync(other); } catch { /* not there */ }

    const challenge = await runTool("Write", args, ctx);          // creates the pending entry
    const token = challenge.approval.token;
    const r = await runTool("Write", { ...args, file_path: "data/__other.txt" }, { ...ctx, approvals: [token] });

    expect(r.ok).toBe(true);                                       // the APPROVED call ran
    expect(fs.existsSync(other)).toBe(false);                      // the swapped target did NOT
  });

  test("an approval is ONE-SHOT — it cannot authorise a second execution", async () => {
    const challenge = await runTool("Write", args, ctx);
    const token = challenge.approval.token;
    const first = await runTool("Write", args, { ...ctx, approvals: [token] });
    const second = await runTool("Write", args, { ...ctx, approvals: [token] });
    expect(first.ok).toBe(true);
    expect(second.reason_code).toBe("approval_required");          // must ask again
  });

  test("an ungated tool never asks for approval", async () => {
    const r = await runTool("Read", { file_path: "package.json" }, ctx);
    expect(r.reason_code).not.toBe("approval_required");
  });

  test("approvals accept an array, a Set, or a comma/space string", async () => {
    // A fresh challenge per format: approvals are one-shot, so the same token cannot be
    // reused across the loop.
    for (const wrap of [(t) => [t], (t) => new Set([t]), (t) => t, (t) => `${t} other`]) {
      const challenge = await runTool("Write", args, ctx);
      expect(challenge.reason_code).toBe("approval_required");
      const r = await runTool("Write", args, { ...ctx, approvals: wrap(challenge.approval.token) });
      expect(r.reason_code).not.toBe("approval_required");
    }
    try { require("fs").unlinkSync(require("path").resolve(__dirname, "../../../data/__approval_test.txt")); } catch { /* best effort */ }
  });
});
