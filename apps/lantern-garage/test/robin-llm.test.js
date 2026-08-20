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
const novelty = require(path.join(R, "novelty"));
const priorwork = require(path.join(R, "priorwork"));
const websearch = require(path.join(R, "websearch"));

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

ok("a fenced or truncated reply is handled, not silently read as 'no ideas'", () => {
  // The first live bench run returned 0 ideas AND 0 malformed -- the reply was truncated
  // mid-object because ten ideas do not fit one call. Both failure shapes are now visible.
  const fenced = "```json" + String.fromCharCode(10)
    + '{"title":"a","mechanism":"m"}' + String.fromCharCode(10)
    + '{"title":"b","mechanism":"m"}' + String.fromCharCode(10) + "```";
  assert.strictEqual(bench.parseIdeas(fenced).ideas.length, 2, "a code fence must not hide the ideas");
  const arr = bench.parseIdeas('[{"title":"a","mechanism":"m"},{"nope":1}]');
  assert.strictEqual(arr.ideas.length, 1);
  assert.strictEqual(arr.malformed, 1, "an array reply is accepted and its bad entries counted");
  const cut = bench.parseIdeas('{"title":"a","mech');
  assert.strictEqual(cut.ideas.length, 0);
  assert.strictEqual(cut.malformed, 1, "a truncated object is MALFORMED, not invisible");
});

ok("near-duplicate ideas are collapsed, so a restated idea cannot vote for itself", () => {
  // Both of these came back from one live run as separate ideas.
  assert.strictEqual(bench.nearDuplicate("Test-Time Sampling with Depth-Entropy Guided Decoding",
                                         "Test-Time Depth-Entropy Sampling on Small Models"), true);
  assert.strictEqual(bench.nearDuplicate("Verification-Refinement Loop on 135M Model",
                                         "Sparse Activation Routing with Small MoE"), false);
});

// ── the novelty audit: the failure it exists to prevent ──────────────────────────────────
ok("the audit has no verdict that means 'novel'", () => {
  // On 2026-08-20 two ideas were called novel because the local corpus retrieved nothing, and a
  // single web search killed both. Silence is not evidence, so there is nothing to say it with.
  for (const v of novelty.VERDICTS) {
    assert.ok(!/novel|original|new/i.test(v), `verdict "${v}" would let silence read as novelty`);
  }
  assert.ok(novelty.VERDICTS.includes("UNVERIFIED"));
});

ok("the prior-work index finds what the red team found by hand", () => {
  const cases = [
    ["train a small classifier on frozen activations to predict hallucination per token", /hneurons|probe/i],
    ["generate multiple reasoning chains then rerank with a lightweight scorer to select the best", /rerank/i],
    ["hidden state surprise canary versus logprob gate for routing which items to ground", /canary|surprise/i],
  ];
  for (const [q, want] of cases) {
    const hits = priorwork.search(q, 5);
    assert.ok(hits.length, `no repo hit at all for: ${q}`);
    assert.ok(hits.some((h) => want.test(h.file)), `expected ${want} in: ${hits.map((h) => h.file).join(", ")}`);
  }
});

ok("the prior-work index reports nothing rather than noise for work we have never done", () => {
  const hits = priorwork.search("crystallography diffraction refinement of small molecule unit cells", 5);
  assert.ok(hits.length === 0 || hits.every((h) => h.score >= priorwork.FLOOR),
            "anything returned must clear the relevance floor");
});

ok("stemming is what stops a plural from costing a prior-art hit", () => {
  assert.strictEqual(priorwork.stem("reranking"), priorwork.stem("rerank"));
  assert.strictEqual(priorwork.stem("activations"), priorwork.stem("activation"));
});

ok("the audit's own controls are what make its verdicts mean anything", async () => {
  // A stub auditor that always answers UNVERIFIED must be caught by the plants, not trusted.
  const blind = async () => JSON.stringify({ verdict: "UNVERIFIED", evidence: "", why: "stub", web_queries: ["q"] });
  const shown = [{ id: "2601.00001", title: "A Paper About Something", snippet: "x".repeat(200) }];
  const c = await novelty.runControls(shown, { llm: blind });
  assert.strictEqual(c.trusted, false, "an auditor that never finds prior art must not be trusted");
  assert.ok(c.plants.some((p) => p.plant === "restatement" && !p.pass));
});

ok("an unparseable audit reply degrades to UNVERIFIED with queries, never to a novelty claim", async () => {
  const junk = async () => "I think this is probably new!";
  const r = await novelty.auditIdea({ title: "T", mechanism: "M" }, { llm: junk }, []);
  assert.strictEqual(r.verdict, "UNVERIFIED");
  assert.ok(r.web_queries.length > 0, "an unverified idea must carry the searches that would settle it");
});

// ── the live search leg ──────────────────────────────────────────────────────────────────
ok("both indexes get a narrowing ladder, because a multi-term query is a conjunction", () => {
  // Measured: "spectral rewiring parameter-efficient fine-tuning reasoning" returns nothing from
  // either leg, while "spectral rewiring" returns the paper the idea was restating. One word the
  // paper does not use zeroes the whole search, so the query has to get shorter, not smarter.
  const q = websearch.arxivQueries("spectral rewiring parameter efficient fine tuning reasoning");
  assert.ok(q.length >= 3, `expected phrase + narrowing rungs, got ${q.length}`);
  assert.ok(decodeURIComponent(q[0]).includes('"'), "first attempt is the exact phrase");
  const widths = q.slice(1).map((x) => x.split("+AND+").length);
  assert.deepStrictEqual(widths, [...widths].sort((a, b) => b - a), "rungs must get narrower, not wider");
  assert.ok(widths[widths.length - 1] <= 2, "the last rung must be short enough to actually match");
  assert.ok(!decodeURIComponent(q[1]).includes(" the "), "stopwords must not eat the term budget");

  const o = websearch.openalexQueries("spectral rewiring parameter efficient fine tuning reasoning");
  assert.ok(o.length >= 2 && o[o.length - 1].split(/\s+/).length <= 2, "openalex needs the same ladder");
});

ok("rungs come from distinctive pairs, not sentence position", () => {
  // "parameter-efficient spectral rewiring reasoning": the LEADING two terms are "parameter
  // efficient", which returns generic PEFT work; the pair that finds the restated paper is
  // "spectral rewiring", sitting in the middle. Position says nothing about which words carry
  // the idea, so the domain-generic words are dropped instead.
  const pairs = websearch.distinctivePairs("parameter-efficient spectral rewiring reasoning");
  assert.deepStrictEqual(pairs, [["spectral", "rewiring"]]);
  const rungs = websearch.arxivQueries("parameter-efficient spectral rewiring reasoning")
    .map((q) => decodeURIComponent(q));
  assert.ok(rungs.some((r) => r.includes("spectral") && r.includes("rewiring")),
            `no rung carries the distinctive pair: ${rungs.join(" | ")}`);
  assert.ok(!rungs.some((r) => /all:parameter\+AND\+all:efficient/.test(r)),
            "a rung of two domain-generic words matches everything and stops the ladder early");
});

ok("a leg that did not run is never reported as a leg that found nothing", async () => {
  process.env.ROBIN_WEB_NOCACHE = "1";
  process.env.ROBIN_WEB_GAP_MS = "0";
  websearch._setFetch(async () => ({ status: 503, body: "" }));
  try {
    const r = await websearch.search("anything at all", 3);
    assert.strictEqual(r.searched, false, "both legs down means the search did not happen");
    assert.strictEqual(r.legs.arxiv.ok, false);
    assert.ok(String(r.legs.arxiv.reason).includes("503"), "the failure reason must survive");
    assert.strictEqual(r.hits.length, 0);
  } finally {
    websearch._resetFetch();
    delete process.env.ROBIN_WEB_NOCACHE;
    delete process.env.ROBIN_WEB_GAP_MS;
  }
});

ok("one live leg is enough to count as searched", async () => {
  process.env.ROBIN_WEB_NOCACHE = "1";
  process.env.ROBIN_WEB_GAP_MS = "0";
  websearch._setFetch(async (url) => (url.includes("openalex")
    ? { status: 200, body: JSON.stringify({ results: [{ title: "A Real Paper", publication_year: 2026 }] }) }
    : { status: -2, body: "timeout" }));
  try {
    const r = await websearch.search("anything at all", 3);
    assert.strictEqual(r.searched, true);
    assert.strictEqual(r.legs.arxiv.ok, false);
    assert.strictEqual(r.hits.length, 1);
    assert.strictEqual(r.hits[0].title, "A Real Paper");
  } finally {
    websearch._resetFetch();
    delete process.env.ROBIN_WEB_NOCACHE;
    delete process.env.ROBIN_WEB_GAP_MS;
  }
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