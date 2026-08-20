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
const gapmill = require(path.join(R, "gapmill"));

// Tests are queued and awaited: an async assertion invoked without await is a test that cannot
// fail, which is worse than no test.
let passed = 0;
const queue = [];
function ok(name, fn) { queue.push([name, fn]); }
async function runAll() {
  // Name the failing test. A suite that reports only "0 !== 1" costs more to diagnose than it
  // saves -- measured, twice, on this file.
  for (const [name, fn] of queue) {
    try {
      await fn();
    } catch (e) {
      e.message = `${name}
      ${e.message}`;
      throw e;
    }
    passed++;
    console.log(`  ok  ${name}`);
  }
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
  // web:false keeps this offline -- the claim under test is the PARSE failure path, and a test
  // that quietly hits four scholarly APIs is not a unit test.
  const r = await novelty.auditIdea({ title: "T", mechanism: "M" }, { llm: junk, web: false }, []);
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

ok("the judge's window shows every leg, not just the first one concatenated", () => {
  // Hits arrive leg by leg, so a flat slice of 12 was twelve arXiv results and the OpenReview
  // leg -- added specifically to catch conference submissions -- was invisible on every idea.
  const hits = [];
  for (let i = 0; i < 20; i++) hits.push({ source: "arxiv", id: `a${i}`, title: `A${i}`, rung: 1 });
  for (let i = 0; i < 5; i++) hits.push({ source: "openreview", id: `o${i}`, title: `O${i}`, rung: 0 });
  const win = novelty.webSlice(hits, 9);
  assert.strictEqual(win.length, 9);
  assert.ok(win.some((h) => h.source === "openreview"), "the smallest leg must still be represented");
  assert.ok(win.filter((h) => h.source === "openreview").length >= 4,
            `expected the interleave to carry openreview through: ${win.map((h) => h.source).join(",")}`);
});

ok("prior-work indexing excludes the mill's own output lists", () => {
  // Indexing results/ made every idea match the very list it came from, which then outranked the
  // note that actually names its prior art.
  const hits = priorwork.search("verification head frozen model reasoning step correctness", 5);
  assert.ok(!hits.some((h) => /robin_llm[\/]results/.test(h.file)),
            `a bench list is not prior work: ${hits.map((h) => h.file).join(", ")}`);
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

// ── the gap mill: milling for what is NOT done, and the failure that invites ─────────────
ok("an idea that cannot say what it is NOT is rejected before ranking, and counted", () => {
  // Restatements arrive without a difference. bench.js milled 16 ideas and 0 were unencumbered;
  // requiring the generator to name its closest prior work is the cheapest filter for that.
  const lines = [
    // Carries the technical fields too: the contract gained them when "improves reasoning" was
    // ruled out, so an idea without them is no longer valid regardless of its difference.
    JSON.stringify({ title: "a", mechanism: "m", experiment: "e", falsifier: "f", needs: "n",
                     cost: "low", closest_prior: "X et al",
                     difference: "reads the signal at a different stage, before decoding rather than after",
                     technical_problem: "verification doubles decode latency",
                     technical_means: "score the layer-14 residual instead of decoding twice",
                     technical_effect: "cuts verifier calls by ~40% at equal pass@1" }),
    JSON.stringify({ title: "b", mechanism: "m", closest_prior: "Y", difference: "better" }),
    JSON.stringify({ title: "c", mechanism: "m" }),
    "{broken",
  ].join(String.fromCharCode(10));
  const p = gapmill.parseIdeas(lines);
  assert.strictEqual(p.ideas.length, 1);
  assert.strictEqual(p.no_difference, 2, "a one-word difference is not a difference");
  assert.strictEqual(p.malformed, 1);
});

ok("rephrasing a rejected proposal is caught as evasion, not counted as a gap", () => {
  // Measured on the second gap-mill run: the placed rate fell to 5/8 and ALL THREE survivors
  // named a round-one collision as their own closest prior work. Telling the generator what it
  // collided with taught it to reword the collision until the audit stopped recognising it, so
  // the falling placed rate was measuring evasion. The generator's own closest_prior field is
  // what catches it.
  const collisions = [{ title: "Epistemic-Controller-Gated Curriculum for Small Models" }];
  const line = JSON.stringify({
    title: "Epistemic-Controller-Gated Dynamic Parameter Allocation", mechanism: "m",
    experiment: "e", falsifier: "f", needs: "n", cost: "low",
    closest_prior: "Epistemic-Controller-Gated Curriculum for Small Models",
    difference: "gates per step rather than per curriculum stage, a finer granularity of control",
    // Technical fields present so this isolates the EVASION check: without them the idea would
    // be rejected for having no measurable effect and the test would pass for the wrong reason.
    technical_problem: "curriculum gating wastes forward passes on already-mastered steps",
    technical_means: "gate per step on the controller's own boundary signal",
    technical_effect: "removes ~25% of training steps at equal held-out accuracy",
  });
  const blocked = gapmill.parseIdeas(line, collisions);
  assert.strictEqual(blocked.ideas.length, 0);
  assert.strictEqual(blocked.evasion, 1);
  // ... and the same idea is fine when it is not dodging something we already rejected
  assert.strictEqual(gapmill.parseIdeas(line, []).ideas.length, 1);
});

ok("evasion is blocked against SURVIVORS too, not only collisions", () => {
  // On the evasion-blocked run a survivor named another survivor of the same run as its closest
  // prior work -- the same dodge one level over.
  const kept = [{ title: "Ledger-Driven Curriculum Learning for Small Model Reasoning" }];
  const line = JSON.stringify({
    title: "Prediction-Market-Driven Curriculum for Formal Specification Reasoning", mechanism: "m",
    experiment: "e", falsifier: "f", needs: "n", cost: "low",
    closest_prior: "Ledger-Driven Curriculum Learning",
    difference: "driven by live market outcomes targeting formal specification reasoning instead",
  });
  assert.strictEqual(gapmill.parseIdeas(line, kept).evasion, 1);
});

ok("diversity is measured, because optimising novelty collapses onto one theme", () => {
  // Four of six survivors on one run were "Ledger-Guided/Driven X". A low placed rate with high
  // overlap is one asset permuted, not a set of gaps -- and the published protocol for scoring
  // generated ideas measures diversity alongside novelty for exactly this reason.
  const same = [1, 2, 3, 4].map((i) => ({ title: `Ledger-Guided Reasoning Curriculum ${i}`,
                                          mechanism: "ledger guided reasoning curriculum for small models" }));
  const varied = [
    { title: "Attention Sparsity Drift", mechanism: "measure head concentration during decoding" },
    { title: "Market-Weighted Probe Labels", mechanism: "supervise hidden states with settled outcomes" },
    { title: "Null-World Calibration", mechanism: "compare residual structure against a drift-only control" },
    { title: "Cascade Escalation Budgets", mechanism: "spend verification only where the cheap tier is unsure" },
  ];
  const a = gapmill.diversity(same).mean_overlap;
  const b = gapmill.diversity(varied).mean_overlap;
  assert.ok(a > b, `permutations of one theme must score less diverse: ${a} vs ${b}`);
  assert.ok(gapmill.diversity(same).repeated.length > 0, "the repeated words must be named, not just counted");
  assert.strictEqual(gapmill.diversity([{ title: "x", mechanism: "y" }]).mean_overlap, null);
});

ok("a technical effect is a number with a unit, or it is not an improvement", () => {
  // "Improves reasoning" is unfalsifiable and is what the worst-ranked ideas in every run were
  // made of. It is also the exact register that fails subject-matter tests: an abstract idea on a
  // general-purpose computer is not a technical improvement however novel it is.
  const base = { mechanism: "m", experiment: "e", falsifier: "f", needs: "n", cost: "low",
                 closest_prior: "X et al 2025",
                 difference: "reads the signal at a different stage of the pipeline entirely",
                 technical_problem: "the verifier doubles decode latency",
                 technical_means: "read the layer-14 residual instead of decoding twice" };
  const mk = (title, technical_effect) => JSON.stringify({ ...base, title, technical_effect });
  const lines = [
    mk("quantified", "cuts verifier calls by ~40% at equal pass@1"),
    mk("vague", "improves reasoning and robustness substantially"),
    mk("unitless", "reduces it a lot, by 40"),
  ].join(String.fromCharCode(10));
  const p = gapmill.parseIdeas(lines, []);
  assert.deepStrictEqual(p.ideas.map((i) => i.title), ["quantified"]);
  assert.strictEqual(p.no_effect, 2, "both the vague and the unitless claim must be counted, not dropped");
});

ok("the patent leg exists, because none of the paper legs can see patents", () => {
  // First patent query on our own goal returned Microsoft's "Detecting hallucination in a language
  // model" (US20240419912A1) -- prior art squarely on list B that arXiv, OpenAlex and OpenReview
  // between them never surfaced.
  assert.strictEqual(typeof websearch.googlepatents, "function");
});

ok("an empty generator reply is distinguishable from a fussy filter", async () => {
  // A run that returns nothing parsed AND nothing rejected has FAILED; a run where everything was
  // rejected has a finding. The first version of the CLI printed the flattering message for both.
  const empty = gapmill.parseIdeas("", []);
  assert.strictEqual(empty.ideas.length + empty.malformed + empty.no_difference
                     + empty.evasion + empty.no_effect, 0,
                     "an empty reply must leave every counter at zero -- that is the signature");
  const rejected = gapmill.parseIdeas(JSON.stringify({ title: "t", mechanism: "m" }), []);
  assert.ok(rejected.no_difference > 0, "a rejected idea moves a counter, which is what tells them apart");
});

ok("there is a VAGUE sham, because 'not in the literature' is trivially achieved by nonsense", () => {
  // Optimising for unplaceability selects for word salad. The inert sham catches plausible-but-
  // empty; this one catches impressive-but-empty, which is the failure this mill invites.
  assert.strictEqual(gapmill.VAGUE_SHAM.vague_sham, true);
  assert.ok(!gapmill.VAGUE_SHAM.sham, "it must be a SECOND arm, not a relabelling of the first");
  assert.ok(gapmill.VAGUE_SHAM.falsifier, "even the sham states a falsifier, or the test is easy");
});

ok("our own notebook is an exclusion list the generator can actually be handed", () => {
  const mine = gapmill.ourWork("detect when a model is answering beyond what it knows", 5);
  assert.ok(mine.length > 0, "the goal that produced list B must match something we have measured");
  assert.ok(mine.every((h) => h.file && h.title), "each exclusion needs a path and a title to be quotable");
});

ok("the assets list is concrete, because a vague asset list produces vague ideas", () => {
  assert.ok(gapmill.OUR_ASSETS.length >= 4);
  for (const a of gapmill.OUR_ASSETS) {
    assert.ok(a.length > 60, `too thin to aim at: "${a}"`);
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