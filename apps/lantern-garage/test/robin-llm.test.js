"use strict";
// The Robin-shaped design loop (research/robin_llm), tested with no network and no subprocess.
//
// What is worth testing here is not "does it call the model" -- it is the four rules that stop
// the pipeline from manufacturing results:
//   1. BTL actually recovers a ranking from pairwise votes, and abstentions are dropped
//   2. a candidate is only admitted if the assay can really run it
//   3. a malformed proposal is COUNTED, never repaired into a proposal we did not receive
//   4. a delta inside the measurement's own noise band is NOT an improvement
//
// Run: node apps/lantern-garage/test/robin-llm.test.js
const assert = require("assert");
const path = require("path");

const R = path.join(__dirname, "..", "..", "..", "research", "robin_llm");
const btl = require(path.join(R, "btl"));
const assays = require(path.join(R, "assays"));
const pipeline = require(path.join(R, "pipeline"));
const agents = require(path.join(R, "agents"));
const bench = require(path.join(R, "bench"));

// Tests are queued and awaited: an async assertion invoked without await is a test that cannot
// fail, which is worse than no test.
let passed = 0;
const queue = [];
function ok(name, fn) { queue.push([name, fn]); }
async function runAll() {
  for (const [name, fn] of queue) { await fn(); passed++; console.log(`  ok  ${name}`); }
}

// ── 1. BTL ────────────────────────────────────────────────────────────────────────────────
ok("BTL recovers a known ordering from noiseless pairwise votes", () => {
  // items 0..3 with true strength decreasing; the better index always wins
  const n = 4;
  const results = [];
  for (const [i, j] of btl.schedule(n)) results.push({ i, j, winner: Math.min(i, j) });
  const p = btl.fit(n, results);
  for (let i = 0; i < n - 1; i++) assert.ok(p[i] > p[i + 1], `strength must decrease: ${p}`);
});

ok("BTL: an undefeated item does not take infinite strength", () => {
  const results = [{ i: 0, j: 1, winner: 0 }, { i: 0, j: 2, winner: 0 }, { i: 1, j: 2, winner: 1 }];
  const p = btl.fit(3, results);
  assert.ok(p.every(Number.isFinite), `all finite: ${p}`);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9, "normalised");
});

ok("BTL schedule: round robin up to 25, sampled above, deterministic per seed", () => {
  assert.strictEqual(btl.schedule(6).length, 15);
  assert.strictEqual(btl.schedule(25).length, 300);
  assert.strictEqual(btl.schedule(40, 7).length, btl.MAX_PAIRS);
  assert.deepStrictEqual(btl.schedule(40, 7), btl.schedule(40, 7));
  assert.notDeepStrictEqual(btl.schedule(40, 7), btl.schedule(40, 8));
});

ok("BTL: abstentions are dropped, not split", async () => {
  // compare() returning null must leave no trace in the fit
  const withAbstain = btl.fit(2, [{ i: 0, j: 1, winner: 0 }, { i: 0, j: 1, winner: null }]);
  const without = btl.fit(2, [{ i: 0, j: 1, winner: 0 }]);
  assert.deepStrictEqual(withAbstain, without);
});

// ── 2. runnability ────────────────────────────────────────────────────────────────────────
ok("a candidate is admitted only for declared knobs inside their range", () => {
  assert.strictEqual(assays.validate({ assay: "controller-discovery", params: { mse_k: 2 } }).ok, true);
  assert.strictEqual(assays.validate({ assay: "controller-discovery", params: { imaginary: 1 } }).ok, false);
  assert.strictEqual(assays.validate({ assay: "controller-discovery", params: { mse_k: 999 } }).ok, false);
  assert.strictEqual(assays.validate({ assay: "no-such-assay", params: {} }).ok, false);
});

ok("every assay's knobs are forwarded as EC_* or as argv, never silently ignored", () => {
  for (const [name, a] of Object.entries(assays.ASSAYS)) {
    for (const knob of Object.keys(a.knobs)) {
      const params = { [knob]: a.knobs[knob].default };
      const argv = a.args(params).join(" ");
      const env = a.env ? a.env(params) : {};
      const reaches = argv.includes(String(a.knobs[knob].default)) || env[`EC_${knob.toUpperCase()}`] !== undefined;
      assert.ok(reaches, `${name}: knob ${knob} reaches neither argv nor env`);
    }
  }
});

// ── 3. parsing ────────────────────────────────────────────────────────────────────────────
ok("malformed proposals are counted, not repaired", () => {
  const text = [
    '{"title":"good","rationale":"r","assay":"controller-discovery","params":{"mse_k":2}}',
    "{not json}",
    '{"rationale":"no title"}',
    "prose that is not a proposal",
  ].join("\n");
  const p = pipeline.parseCandidates(text, "controller-discovery");
  assert.strictEqual(p.candidates.length, 1);
  assert.strictEqual(p.malformed, 2);            // bad JSON + titleless object; prose is not a proposal at all
});

ok("the judge abstains rather than inventing a winner", async () => {
  const tie = await agents.judge({ title: "a" }, { title: "b" }, "goal", { llm: async () => '{"winner":"TIE","why":"same"}' });
  assert.strictEqual(tie.winner, null);
  const junk = await agents.judge({ title: "a" }, { title: "b" }, "goal", { llm: async () => "I prefer the first one." });
  assert.strictEqual(junk.winner, null);
  const good = await agents.judge({ title: "a" }, { title: "b" }, "goal", { llm: async () => 'blah {"winner":"B","why":"x"} blah' });
  assert.strictEqual(good.winner, "B");
});

ok("finch reads the last JSON line of stdout, ignoring earlier prose", () => {
  assert.deepStrictEqual(agents.lastJsonLine('noise\n{"a":1}\nVERDICT x\n{"b":2}'), { b: 2 });
  assert.strictEqual(agents.lastJsonLine("no json here"), null);
});

// ── 4. the noise floor ────────────────────────────────────────────────────────────────────
ok("a delta inside the measurement's own noise band is NOT an improvement", () => {
  // the exact case from the first live round: +0.001 on a proportion whose 2-SE band is 0.021
  const v = pipeline.verdictFor({ ok: true, metric: 0.984, noise: 0.0215 }, { metric: 0.983, noise: 0.0215 });
  assert.strictEqual(v.verdict, "WITHIN NOISE");
  assert.strictEqual(pipeline.verdictFor({ ok: true, metric: 0.99, noise: 0.001 }, { metric: 0.90, noise: 0.001 }).verdict, "IMPROVED");
  assert.strictEqual(pipeline.verdictFor({ ok: true, metric: 0.80, noise: 0.001 }, { metric: 0.90, noise: 0.001 }).verdict, "WORSE");
});

ok("breaking the assay's control outranks any headline gain", () => {
  const v = pipeline.verdictFor({ ok: true, metric: 0.99, noise: 0.001, control: false }, { metric: 0.5, noise: 0.001 });
  assert.strictEqual(v.verdict, "REGRESSION (control broken)");
});

ok("the noise band is computed from the run's own counts, not assumed", () => {
  const wh = { arms: { hold: { truth_rate_among_two: 0.98, chose_true: 178, chose_proxy: 3 } },
               gates: { hold: { H4_pass: true } } };
  const band = assays.ASSAYS["controller-two-explanations"].noise(wh);
  assert.ok(band > 0.01 && band < 0.05, `2-SE band on p=0.98,n=181 should be ~0.02, got ${band}`);
  // more observations must give a tighter band
  const wide = assays.ASSAYS["controller-two-explanations"].noise(
    { arms: { hold: { truth_rate_among_two: 0.98, chose_true: 18, chose_proxy: 1 } } });
  assert.ok(wide > band, "fewer observations must widen the band");
});

// ── the sham arm exists and is inert ──────────────────────────────────────────────────────
ok("the sham candidate sets no knob, so it cannot accidentally be a real experiment", () => {
  assert.deepStrictEqual(pipeline.SHAM.params, {});
  assert.strictEqual(pipeline.SHAM.sham, true);
});

// ── the bench list: ideas for a human, which is where a pipeline flatters itself most ────
ok("a bench idea needs a title AND a mechanism, and the rest are counted", () => {
  const text = [
    '{"title":"t","mechanism":"m","experiment":"e","falsifier":"f","needs":"n","cost":"low"}',
    '{"title":"no mechanism"}',
    "{broken",
  ].join(String.fromCharCode(10));
  const p = bench.parseIdeas(text);
  assert.strictEqual(p.ideas.length, 1);
  assert.strictEqual(p.malformed, 2);
});

ok("the bench sham is inert and cannot be mistaken for a real proposal", () => {
  assert.strictEqual(bench.SHAM.sham, true);
  assert.ok(/no change/i.test(bench.SHAM.falsifier), "an inert proposal's falsifier is 'nothing moves'");
});

ok("the rendered list says nothing has been run, and disowns its own order when the sham wins", () => {
  const base = { goal: "g", pairs: 10, of: 4, lit: { available: true, pool: 9, relevant: 3, recent: 2 },
                 ideas: [{ rank: 1, strength: 0.4, wins: 2, comparisons: 3, title: "T", mechanism: "M",
                           experiment: "E", falsifier: "F", needs: "N", cost: "low", grounded: true, citations: ["2501.00001"] }] };
  const held = bench.renderMarkdown({ ...base, sham_rank: 4, sham_control_held: true });
  assert.ok(/NOTHING HERE HAS BEEN RUN/.test(held), "the banner is not optional");
  assert.ok(/Sham control held/.test(held));
  const failed = bench.renderMarkdown({ ...base, sham_rank: 1, sham_control_held: false });
  assert.ok(/SHAM CONTROL FAILED/.test(failed) && /ignore the order/.test(failed),
            "a failed control must disown the ranking, not bury the note");
});

ok("retrieval shows the generator both the most relevant and the most recent, without overlap", () => {
  const r = bench.retrieve("long context sparse attention language model efficiency", 40);
  if (!r.available) return;                    // no corpus on this machine: nothing to assert
  const ids = new Set(r.relevant.map((p) => p.id));
  assert.ok(r.recent.every((p) => !ids.has(p.id)), "the recent bucket must not repeat the relevant one");
  const dates = r.recent.map((p) => String(p.published || ""));
  assert.deepStrictEqual(dates, [...dates].sort().reverse(), "the recent bucket must be newest-first");
});

runAll().then(() => console.log(String.fromCharCode(10) + passed + " passed"))

  .catch((e) => { console.error("FAILED after " + passed + ":", e.message); process.exit(1); });