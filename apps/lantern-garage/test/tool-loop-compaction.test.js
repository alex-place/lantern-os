"use strict";

/**
 * test/tool-loop-compaction.test.js
 *
 * compactToolLoopMessages (#1391): micro-compacts the in-turn tool loop so a long
 * agentic turn doesn't crowd the local 8K context window. Uses the EXACT
 * tool-result message format the local Ollama loop pushes in stream-chat.js
 * ("The <name> tool returned:\n<output>...").
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/tool-loop-compaction.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { compactToolLoopMessages } = require("../lib/stream-chat/history");

// Mirror the real message the loop pushes (stream-chat.js:1736).
const toolResult = (name, out) =>
  `The ${name} tool returned:\n${out}\n\nIf you need another tool, reply with exactly one <tool_call>…</tool_call>. Otherwise answer my original request in plain text.`;

function convo(nTools) {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "do the thing" },
  ];
  for (let i = 0; i < nTools; i++) {
    msgs.push({ role: "assistant", content: `<tool_call>{"name":"Read","input":{"file":"f${i}.js"}}</tool_call>` });
    msgs.push({ role: "user", content: toolResult("Read", "X".repeat(1400) + " #" + i) });
  }
  return msgs;
}

test("no-op when tool results <= keepRecentResults", () => {
  const before = convo(2);
  const after = compactToolLoopMessages(before, { keepRecentResults: 2 });
  assert.deepEqual(after, before, "2 results, keep 2 → unchanged");
});

test("collapses older tool results, keeps the newest verbatim", () => {
  const msgs = convo(5); // 5 tool results
  const after = compactToolLoopMessages(msgs, { keepRecentResults: 2 });
  const results = after.filter((m) => m.role === "user" && /tool returned/.test(m.content));
  assert.equal(results.length, 5, "still 5 result messages (count preserved)");
  // First 3 stubbed, last 2 verbatim.
  const stubbed = results.filter((m) => /chars elided to save context/.test(m.content));
  assert.equal(stubbed.length, 3, "3 oldest collapsed to stubs");
  assert.ok(results[3].content.includes("XXXX"), "2nd-newest kept verbatim");
  assert.ok(results[4].content.includes("#4"), "newest kept verbatim");
});

test("stub names the tool and notes the elided size, and is far smaller", () => {
  const msgs = convo(4);
  const after = compactToolLoopMessages(msgs, { keepRecentResults: 1 });
  const firstStub = after.find((m) => m.role === "user" && /elided/.test(m.content));
  assert.match(firstStub.content, /^The Read tool returned: \[\d+ chars elided to save context\]$/);
  assert.ok(firstStub.content.length < 80, "stub is a one-liner");
});

test("materially shrinks total context for a long loop", () => {
  const msgs = convo(6);
  const before = msgs.reduce((n, m) => n + m.content.length, 0);
  const after = compactToolLoopMessages(msgs, { keepRecentResults: 2 })
    .reduce((n, m) => n + m.content.length, 0);
  assert.ok(after < before * 0.5, `compacted (${after}) should be < half of original (${before})`);
});

test("non-destructive: input array and messages are not mutated", () => {
  const msgs = convo(4);
  const snapshot = JSON.stringify(msgs);
  compactToolLoopMessages(msgs, { keepRecentResults: 2 });
  assert.equal(JSON.stringify(msgs), snapshot, "original array unchanged");
});

test("leaves non-tool messages (system/user/assistant) untouched", () => {
  const msgs = convo(4);
  const after = compactToolLoopMessages(msgs, { keepRecentResults: 2 });
  assert.equal(after[0].content, "sys");
  assert.equal(after[1].content, "do the thing");
  assert.ok(after.some((m) => m.role === "assistant" && m.content.includes("<tool_call>")));
});

test("tolerates non-arrays and empty input", () => {
  assert.equal(compactToolLoopMessages(null), null);
  assert.deepEqual(compactToolLoopMessages([]), []);
});
