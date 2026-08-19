/**
 * test/tool-loop-memory-refresh.test.js
 *
 * #3065 per-step memory: runToolLoop's onBeforeTurn hook fires AFTER each tool round and
 * BEFORE the next model turn, carrying the just-completed calls, so the caller can refresh
 * per-step context (re-query CSF against the evolving tool context) and have the NEXT turn
 * see it. Verifies the mechanism deterministically with a mock adapter — no live provider,
 * no seeded data.
 *
 * Run with: npx jest test/tool-loop-memory-refresh.test.js
 */
const { runToolLoop } = require("../lib/stream-chat/tool-turns");

// Mock adapter whose turn() reads a MUTABLE system value each call (mirrors the Gemini
// adapter reading `_stepSystem`), plays a scripted sequence of tool-call lists, and records
// the system value seen at each turn.
function makeAdapter(sysRef, plan) {
  let i = 0;
  return {
    maxIters: 8,
    turn: async () => { sysRef.seen.push(sysRef.value); return { calls: plan[i++] || [] }; },
    toolCalls: (t) => t.calls,
    pushAssistant: () => {},
    pushToolResults: () => {},
  };
}
const noSse = { writeData: () => {} };
const okTool = async (name) => ({ ok: true, result: `ran ${name}` });

test("onBeforeTurn fires once per tool round with the completed calls; the refresh reaches the next turn", async () => {
  const sysRef = { value: "BASE", seen: [] };
  // iter0 makes one tool call; iter1 finalizes (no calls).
  const adapter = makeAdapter(sysRef, [[{ name: "web_search", input: { q: "kyoto" } }], []]);
  const fired = [];
  const onBeforeTurn = async ({ iter, calls }) => {
    fired.push({ iter, name: calls[0] && calls[0].name });
    sysRef.value = `BASE + MEM(${calls[0].name})`; // simulate the memory refresh mutating the system
  };
  const { toolCalls } = await runToolLoop(adapter, { sse: noSse, res: {}, runTool: okTool, onBeforeTurn });
  expect(toolCalls).toBe(1);
  expect(fired).toEqual([{ iter: 0, name: "web_search" }]); // fired once, after the tool round
  expect(sysRef.seen[0]).toBe("BASE"); // first turn: initial memory
  expect(sysRef.seen[1]).toBe("BASE + MEM(web_search)"); // next turn: refreshed per-step context
});

test("onBeforeTurn is NOT called when the model gives a final answer with no tool calls", async () => {
  const sysRef = { value: "BASE", seen: [] };
  const adapter = makeAdapter(sysRef, [[]]); // single-shot: no tool calls
  let calls = 0;
  await runToolLoop(adapter, { sse: noSse, res: {}, runTool: okTool, onBeforeTurn: async () => { calls++; } });
  expect(calls).toBe(0);
});

test("a throwing onBeforeTurn is best-effort and never breaks the loop", async () => {
  const sysRef = { value: "BASE", seen: [] };
  const adapter = makeAdapter(sysRef, [[{ name: "t", input: {} }], []]);
  const { toolCalls } = await runToolLoop(adapter, { sse: noSse, res: {}, runTool: okTool, onBeforeTurn: async () => { throw new Error("boom"); } });
  expect(toolCalls).toBe(1); // completed despite the refresh throwing
});
