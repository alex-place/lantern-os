"use strict";

/**
 * test/orchestrator-agents.test.js
 *
 * Orchestrator–worker sub-agents (#1392). The model-call dep is INJECTED (a fake
 * `orchestrate`) so the decomposition / context-isolation / synthesis / fallback
 * logic is verified WITHOUT a live model. Live end-to-end is verified through the
 * dream-chat UI.
 *
 * Zero-dep — run with:  node --test apps/lantern-garage/test/orchestrator-agents.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const oa = require("../lib/orchestrator-agents");

const noEmit = async () => {};

// A fake orchestrate that records every call and returns scripted text by matching
// the systemPrompt (manager vs worker vs synthesizer).
function fakeOrchestrate(script) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const text = script(opts, calls.length);
    return { provider: "fake", model: "fake-1", text };
  };
  fn.calls = calls;
  return fn;
}

test("extractJson tolerates fences and surrounding prose", () => {
  assert.deepEqual(oa.extractJson('```json\n{"workers":[{"task":"a"}]}\n```'), { workers: [{ task: "a" }] });
  assert.deepEqual(oa.extractJson('Sure! Here you go: {"workers":[]} hope that helps'), { workers: [] });
  assert.equal(oa.extractJson("no json here"), null);
  assert.equal(oa.extractJson(null), null);
  // braces inside strings must not break matching
  assert.deepEqual(oa.extractJson('{"a":"a } b"}'), { a: "a } b" });
});

test("decompose parses the manager's JSON into worker specs", async () => {
  const orchestrate = fakeOrchestrate(() => '{"workers":[{"name":"w1","role":"researcher","task":"find facts"},{"name":"w2","role":"writer","task":"draft"}]}');
  const specs = await oa.decompose("write a brief", "SYS", orchestrate);
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((s) => s.name), ["w1", "w2"]);
  assert.equal(specs[0].task, "find facts");
});

test("decompose falls back to a single generalist worker on bad/empty output", async () => {
  const bad = fakeOrchestrate(() => "I cannot do that as JSON, sorry!");
  const specs = await oa.decompose("do the thing", "SYS", bad);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].role, "generalist");
  assert.equal(specs[0].task, "do the thing");
});

test("decompose caps workers at MAX_WORKERS", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `w${i}`, role: "r", task: `t${i}` }));
  const orchestrate = fakeOrchestrate(() => JSON.stringify({ workers: many }));
  const specs = await oa.decompose("big task", "SYS", orchestrate);
  assert.equal(specs.length, oa.MAX_WORKERS);
});

test("runWorkers isolates context: each worker sees ONLY its task + empty history", async () => {
  const seen = [];
  const orchestrate = async (opts) => { seen.push(opts); return { text: `out:${opts.message}` }; };
  const specs = [
    { name: "a", role: "ra", task: "task-A" },
    { name: "b", role: "rb", task: "task-B" },
  ];
  const workers = await runWorkersHelper(specs, orchestrate);
  // each worker's message is exactly its own subtask, history is empty, and no
  // worker's prompt contains the OTHER worker's task (true isolation)
  const msgs = seen.map((o) => o.message).sort();
  assert.deepEqual(msgs, ["task-A", "task-B"]);
  for (const o of seen) {
    assert.deepEqual(o.history, [], "workers run with no shared history");
    assert.equal(o.message === "task-A" || o.message === "task-B", true);
    if (o.message === "task-A") assert.equal(o.systemPrompt.includes("task-B"), false, "worker A must not see task B");
  }
  assert.equal(workers.every((w) => w.ok), true);

  async function runWorkersHelper(s, orch) {
    return oa.runWorkers(s, "BASE", { orchestrate: orch, emit: noEmit, workerId: "t" });
  }
});

test("runWorkers captures a failing worker as {ok:false} without rejecting", async () => {
  const orchestrate = async (opts) => {
    if (opts.message === "boom") throw new Error("provider_down");
    return { text: "fine" };
  };
  const workers = await oa.runWorkers(
    [{ name: "ok", role: "r", task: "good" }, { name: "bad", role: "r", task: "boom" }],
    "BASE",
    { orchestrate, emit: noEmit }
  );
  assert.equal(workers.find((w) => w.name === "ok").ok, true);
  const bad = workers.find((w) => w.name === "bad");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "provider_down");
});

test("synthesize: single good worker returns its text directly (no extra call)", async () => {
  const orchestrate = fakeOrchestrate(() => "SHOULD-NOT-BE-CALLED");
  const out = await oa.synthesize("task", [{ name: "a", role: "r", ok: true, text: "only answer" }], "SYS", orchestrate);
  assert.equal(out.text, "only answer");
  assert.equal(orchestrate.calls.length, 0, "no synthesis call for a single worker");
});

test("synthesize: multiple good workers triggers a merge call", async () => {
  const orchestrate = fakeOrchestrate((opts) => `MERGED(${opts.message.includes("alpha") && opts.message.includes("beta") ? "both" : "?"})`);
  const out = await oa.synthesize(
    "task",
    [{ name: "a", role: "r", ok: true, text: "alpha" }, { name: "b", role: "r", ok: true, text: "beta" }],
    "SYS",
    orchestrate
  );
  assert.equal(orchestrate.calls.length, 1);
  assert.equal(out.text, "MERGED(both)", "synthesizer is given both worker outputs");
});

test("synthesize: zero good workers returns an honest failure note", async () => {
  const out = await oa.synthesize("task", [{ name: "a", ok: false, text: "" }], "SYS", fakeOrchestrate(() => "x"));
  assert.match(out.text, /failed to produce output/i);
});

test("runOrchestrator end-to-end (fake model): decompose → 2 workers → synthesize, with phase callbacks", async () => {
  const orchestrate = fakeOrchestrate((opts) => {
    if (opts.systemPrompt.includes("ORCHESTRATOR")) return '{"workers":[{"name":"r","role":"researcher","task":"research X"},{"name":"w","role":"writer","task":"write X"}]}';
    if (opts.systemPrompt.includes("SYNTHESIZER")) return "FINAL ANSWER";
    return `worker-did:${opts.message}`;
  });
  const phases = [];
  const started = [];
  const { synthesis, workers, specs } = await oa.runOrchestrator("explain X", {
    systemPrompt: "SYS",
    workerId: "t1",
    orchestrate,
    emit: noEmit,
    onPhase: (p, info) => phases.push([p, info && info.count]),
    onWorkerStart: (name) => started.push(name),
  });
  assert.deepEqual(specs.map((s) => s.name), ["r", "w"]);
  assert.equal(workers.length, 2);
  assert.equal(synthesis.text, "FINAL ANSWER");
  assert.deepEqual(phases.map((p) => p[0]), ["decompose", "workers", "synthesize"]);
  assert.equal(phases[1][1], 2, "phase 'workers' reports the worker count");
  assert.deepEqual(started.sort(), ["r", "w"]);
});
