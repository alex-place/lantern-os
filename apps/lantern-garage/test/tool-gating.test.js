// #2777 — per-faculty tool gating for capability evals. An eval run gates named tools
// (via CHAT_EVAL_GATED_TOOLS or ctx.gatedTools) so a memory eval can't substitute
// web_search for recall (Burnell et al. §4.3). Gating must deny BEFORE execution and
// record the reason. Uses github_issue: gated → denied before shelling out to gh; not
// gated → proceeds to arg validation. No network is hit either way.
//
// Run: node apps/lantern-garage/test/tool-gating.test.js
const assert = require("assert");
const { runTool } = require("../lib/tool-runner");

let failures = 0;
async function check(name, fn) {
  const prev = process.env.CHAT_EVAL_GATED_TOOLS;
  try { await fn(); process.stdout.write(`  ok  - ${name}\n`); }
  catch (e) { failures++; process.stderr.write(`  FAIL- ${name}\n       ${e.stack || e.message}\n`); }
  finally { if (prev === undefined) delete process.env.CHAT_EVAL_GATED_TOOLS; else process.env.CHAT_EVAL_GATED_TOOLS = prev; }
}
const S = (r) => JSON.stringify(r);

(async () => {
  await check("env CHAT_EVAL_GATED_TOOLS gates a tool (denied before execution)", async () => {
    process.env.CHAT_EVAL_GATED_TOOLS = "github_issue,web_search";
    const r = await runTool("github_issue", { number: 1 }, { operator: true });
    assert.strictEqual(r.ok, false, S(r));
    assert.match(S(r), /tool_gated/, S(r));
  });

  await check("gating is case-insensitive", async () => {
    process.env.CHAT_EVAL_GATED_TOOLS = "GitHub_Issue";
    const r = await runTool("github_issue", { number: 1 }, { operator: true });
    assert.match(S(r), /tool_gated/, S(r));
  });

  await check("ctx.gatedTools (array) gates a tool", async () => {
    delete process.env.CHAT_EVAL_GATED_TOOLS;
    const r = await runTool("github_issue", { number: 1 }, { operator: true, gatedTools: ["github_issue"] });
    assert.match(S(r), /tool_gated/, S(r));
  });

  await check("ctx.gatedTools (comma string) gates a tool", async () => {
    delete process.env.CHAT_EVAL_GATED_TOOLS;
    const r = await runTool("github_issue", { number: 1 }, { operator: true, gatedTools: "web_search, github_issue" });
    assert.match(S(r), /tool_gated/, S(r));
  });

  await check("NOT gated → gating does not fire (proceeds to arg validation)", async () => {
    delete process.env.CHAT_EVAL_GATED_TOOLS;
    // Missing required `number` → the call proceeds past gating to schema validation,
    // proving the gate stayed open. (invalid_arguments, NOT tool_gated.)
    const r = await runTool("github_issue", {}, { operator: true });
    assert.doesNotMatch(S(r), /tool_gated/, S(r));
    assert.match(S(r), /invalid_arguments/, S(r));
  });

  await check("empty gate set → unrelated tool not gated", async () => {
    process.env.CHAT_EVAL_GATED_TOOLS = "   ";  // blank → no gating
    const r = await runTool("github_issue", {}, { operator: true });
    assert.doesNotMatch(S(r), /tool_gated/, S(r));
  });

  process.stdout.write(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
  process.exit(failures ? 1 : 0);
})();
