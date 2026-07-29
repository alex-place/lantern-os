/**
 * test/tool-loop-hardening.test.js
 *
 * #3066 — hardening runToolLoop enough for the native tool loop to be trusted as the DEFAULT
 * path. Three failure modes a default-on agent loop must survive:
 *   1. a tool that THROWS must not kill the turn (previously Promise.all rejected and the
 *      user lost the whole reply),
 *   2. a model repeating an IDENTICAL call must be nudged, not re-run (burns iterations,
 *      latency and quota while it loops),
 *   3. exhausting the step cap must be REPORTED (stopReason) rather than looking like a
 *      normal completion.
 *
 * Deterministic: mock adapter, no live provider.
 *
 * Run with: npx jest test/tool-loop-hardening.test.js
 */
const { runToolLoop } = require("../lib/stream-chat/tool-turns");

const noSse = { writeData: () => {} };
// Adapter that plays a scripted list of tool-call rounds.
function makeAdapter(plan, maxIters = 8) {
  let i = 0;
  return {
    maxIters,
    turn: async () => ({ calls: plan[i] !== undefined ? plan[i++] : [] }),
    toolCalls: (t) => t.calls,
    pushAssistant: () => {},
    pushToolResults: () => {},
  };
}

describe("a throwing tool never kills the turn", () => {
  test("the throw becomes a tool result the model can react to; the loop finishes", async () => {
    const adapter = makeAdapter([[{ name: "boom", input: {} }], []]);
    const pushed = [];
    adapter.pushToolResults = (outs) => pushed.push(...outs);
    const runTool = async () => { throw new Error("upstream exploded"); };
    const { toolCalls, stopReason } = await runToolLoop(adapter, { sse: noSse, res: {}, runTool });
    expect(toolCalls).toBe(1);
    expect(stopReason).toBe("final");            // the turn still completed
    expect(pushed[0].ok).toBe(false);
    expect(pushed[0].out).toContain("tool_threw");
    expect(pushed[0].out).toContain("upstream exploded"); // model sees WHY
  });

  test("a tool returning nothing is handled, not crashed on", async () => {
    const adapter = makeAdapter([[{ name: "silent", input: {} }], []]);
    const pushed = [];
    adapter.pushToolResults = (outs) => pushed.push(...outs);
    await runToolLoop(adapter, { sse: noSse, res: {}, runTool: async () => undefined });
    expect(pushed[0].ok).toBe(false);
    expect(pushed[0].out).toContain("tool_no_result");
  });
});

describe("repeat-call guard", () => {
  test("an identical repeated call is NOT re-run; it is nudged", async () => {
    const call = { name: "web_search", input: { q: "same" } };
    const adapter = makeAdapter([[call], [{ ...call }], []]);
    const pushed = [];
    adapter.pushToolResults = (outs) => pushed.push(...outs);
    let ran = 0;
    const runTool = async () => { ran++; return { ok: true, result: "result" }; };
    await runToolLoop(adapter, { sse: noSse, res: {}, runTool });
    expect(ran).toBe(1);                          // executed once, not twice
    expect(pushed[1].duplicate).toBe(true);
    expect(pushed[1].out).toContain("already called");
  });

  test("the same tool with DIFFERENT args still runs", async () => {
    const adapter = makeAdapter([
      [{ name: "web_search", input: { q: "a" } }],
      [{ name: "web_search", input: { q: "b" } }],
      [],
    ]);
    let ran = 0;
    await runToolLoop(adapter, { sse: noSse, res: {}, runTool: async () => { ran++; return { ok: true, result: "r" }; } });
    expect(ran).toBe(2);                          // different args ⇒ genuinely new information
  });
});

describe("stop reason", () => {
  test("exhausting the step cap reports max_steps", async () => {
    // Always asks for another tool → can never finish on its own.
    const adapter = { maxIters: 3, turn: async () => ({ calls: [{ name: "t", input: { n: Math.random() } }] }),
      toolCalls: (t) => t.calls, pushAssistant: () => {}, pushToolResults: () => {} };
    const { stopReason } = await runToolLoop(adapter, { sse: noSse, res: {}, runTool: async () => ({ ok: true, result: "r" }) });
    expect(stopReason).toBe("max_steps");
  });

  test("a normal finish reports final", async () => {
    const adapter = makeAdapter([[{ name: "t", input: {} }], []]);
    const { stopReason } = await runToolLoop(adapter, { sse: noSse, res: {}, runTool: async () => ({ ok: true, result: "r" }) });
    expect(stopReason).toBe("final");
  });

  test("a single-shot answer (no tools) reports final", async () => {
    const { stopReason, toolCalls } = await runToolLoop(makeAdapter([[]]), { sse: noSse, res: {}, runTool: async () => ({ ok: true }) });
    expect(stopReason).toBe("final");
    expect(toolCalls).toBe(0);
  });
});
