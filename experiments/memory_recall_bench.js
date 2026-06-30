#!/usr/bin/env node
/**
 * memory_recall_bench.js — durable, re-runnable LongMemEval recall harness for
 * Keystone's LIVE memory retrieval (#1739).
 *
 * Why this exists: the memory "edge" had been asserted but never durably measured
 * — data/longmemeval/runs.jsonl referenced an `experiments/longmemeval_harness.py`
 * that was never committed. This harness benchmarks the ACTUAL scoring code in
 * apps/lantern-garage/lib/csf-memory.js (not a re-implementation), so the number
 * tracks the code we ship. Recall@k is retrieval-only — no LLM, no API key, runs
 * locally and in CI.
 *
 * Modes (our retrieval, real functions):
 *   keyword  — relevanceScore           (flat hit ratio)
 *   idf      — relevanceScoreIdf + buildDocFreq  (#1689 IDF ranking, the "multi" signal)
 *   semantic — semanticRerank (Ollama nomic-embed-text); skipped if model absent
 *
 * Incumbents (Letta/MemGPT, Mem0, Zep) are Python; run the sibling adapter
 * experiments/memory_bench_incumbents.py against the SAME dataset + metric. Both
 * write rows to data/eval/leaderboard.jsonl so the head-to-head is one table.
 *
 * Usage:
 *   node experiments/memory_recall_bench.js                 # fixture, keyword+idf, k=5
 *   node experiments/memory_recall_bench.js --dataset data/longmemeval/longmemeval_s.json
 *   node experiments/memory_recall_bench.js --k 5 --modes keyword,idf,semantic
 *   node experiments/memory_recall_bench.js --selftest      # CI: assert harness measures real signal
 *   node experiments/memory_recall_bench.js --no-write --json
 *
 * Dataset shape (either is accepted):
 *   - Keystone fixture: { instances:[ { id, question, sessions:[{session_id,turns:[{role,content}]}], answer_session_ids:[..] } ] }
 *   - Official LongMemEval: [ { question_id, question, haystack_session_ids, haystack_sessions:[[{role,content}]], answer_session_ids:[..] } ]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const mem = require(path.join(REPO, 'apps/lantern-garage/lib/csf-memory.js'));
const { relevanceScore, relevanceScoreIdf, buildDocFreq } = mem;

// ── args ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { k: 5, modes: ['keyword', 'idf'], dataset: null, write: true, json: false, selftest: false, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--k') a.k = parseInt(argv[++i], 10);
    else if (t === '--modes') a.modes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (t === '--dataset') a.dataset = argv[++i];
    else if (t === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (t === '--no-write') a.write = false;
    else if (t === '--json') a.json = true;
    else if (t === '--selftest') { a.selftest = true; a.write = false; }
  }
  return a;
}

// ── dataset loading + normalization ──────────────────────────────────────────────
function sessionText(turns) {
  return (turns || []).map((t) => (typeof t === 'string' ? t : (t.content || ''))).join('\n');
}

/** Normalize either accepted shape into [{ id, question, sessions:[{id,text}], gold:Set }]. */
function normalize(raw) {
  const rows = Array.isArray(raw) ? raw : (raw.instances || raw.data || []);
  return rows.map((r, i) => {
    let sessions;
    if (Array.isArray(r.haystack_sessions)) {
      // official LongMemEval: parallel arrays of ids + session turn-lists
      const ids = r.haystack_session_ids || r.haystack_sessions.map((_, j) => `sess_${j}`);
      sessions = r.haystack_sessions.map((turns, j) => ({ id: String(ids[j]), text: sessionText(turns) }));
    } else {
      sessions = (r.sessions || []).map((s, j) => ({ id: String(s.session_id ?? s.id ?? `sess_${j}`), text: s.text || sessionText(s.turns) }));
    }
    const gold = new Set((r.answer_session_ids || r.gold_session_ids || []).map(String));
    return { id: String(r.id ?? r.question_id ?? `q_${i}`), question: r.question || r.query || '', sessions, gold };
  }).filter((x) => x.question && x.sessions.length && x.gold.size);
}

function loadDataset(arg) {
  const candidates = arg
    ? [arg]
    : [path.join(REPO, 'data/longmemeval/longmemeval_s.json'), path.join(REPO, 'data/longmemeval/fixture.json')];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const instances = normalize(raw);
      if (instances.length) {
        const isReal = /longmemeval_[sml]\.json$/i.test(p);
        return { instances, path: p, label: isReal ? path.basename(p, '.json') : 'synthetic-fixture' };
      }
    }
  }
  throw new Error('no dataset found (looked for longmemeval_s.json then fixture.json)');
}

// ── scorers (the REAL retrieval functions) ───────────────────────────────────────
function rankBy(instance, scoreFn) {
  const scored = instance.sessions.map((s) => ({ id: s.id, score: scoreFn(s.text) }));
  // stable sort: score desc, original order as tiebreak
  return scored
    .map((s, idx) => ({ ...s, idx }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
}

function metricsFor(ranked, gold, k) {
  const topK = ranked.slice(0, k).map((r) => r.id);
  const hit = topK.some((id) => gold.has(id)) ? 1 : 0;
  let rr = 0;
  for (let i = 0; i < ranked.length; i++) { if (gold.has(ranked[i].id)) { rr = 1 / (i + 1); break; } }
  return { hit, rr };
}

const KEYWORD = (inst) => (text) => relevanceScore(text, inst.question);
const IDF = (inst) => {
  const df = buildDocFreq(inst.sessions.map((s) => ({ content: { text: s.text } })));
  return (text) => relevanceScoreIdf(text, inst.question, df);
};

async function semanticScorerOrNull(instances) {
  let semanticRerank;
  try { ({ semanticRerank } = require(path.join(REPO, 'apps/lantern-garage/lib/semantic-reranker.js'))); }
  catch { return null; }
  // probe once: if the embed model is unavailable, fallback=false yields the input
  // order unchanged → skip rather than report a misleading number.
  try {
    const probe = instances[0];
    const cands = probe.sessions.map((s) => ({ id: s.id, text: s.text }));
    const out = await semanticRerank(probe.question, cands, { topK: cands.length, textField: 'text', fallback: false });
    if (!Array.isArray(out) || !out.length) return null;
    // return an async ranker that mirrors rankBy's output shape
    return async (inst) => {
      const cs = inst.sessions.map((s) => ({ id: s.id, text: s.text }));
      const reranked = await semanticRerank(inst.question, cs, { topK: cs.length, textField: 'text', fallback: false });
      return reranked.map((r, i) => ({ id: r.id, score: (cs.length - i), idx: i }));
    };
  } catch { return null; }
}

// ── run ──────────────────────────────────────────────────────────────────────────
async function run(args) {
  const ds = loadDataset(args.dataset);
  let instances = ds.instances;
  if (args.limit > 0) instances = instances.slice(0, args.limit);

  const modeResults = {};
  const wantSemantic = args.modes.includes('semantic');
  const semRanker = wantSemantic ? await semanticScorerOrNull(instances) : null;
  if (wantSemantic && !semRanker) modeResults.semantic = { skipped: true, reason: 'embed model unavailable (Ollama nomic-embed-text)' };

  for (const mode of args.modes) {
    if (mode === 'semantic' && !semRanker) continue;
    let hits = 0, rrSum = 0;
    for (const inst of instances) {
      let ranked;
      if (mode === 'keyword') ranked = rankBy(inst, KEYWORD(inst));
      else if (mode === 'idf') ranked = rankBy(inst, IDF(inst));
      else if (mode === 'semantic') ranked = await semRanker(inst);
      else throw new Error(`unknown mode: ${mode}`);
      const m = metricsFor(ranked, inst.gold, args.k);
      hits += m.hit; rrSum += m.rr;
    }
    const n = instances.length;
    modeResults[mode] = {
      recall_at_k: +(hits / n).toFixed(4),
      mrr: +(rrSum / n).toFixed(4),
      hits, n,
    };
  }

  const ts = new Date().toISOString();
  const multiMinusKeyword = (modeResults.idf && modeResults.keyword)
    ? +(modeResults.idf.recall_at_k - modeResults.keyword.recall_at_k).toFixed(4)
    : null;

  const summary = {
    timestamp: ts,
    dataset: ds.label,
    dataset_path: path.relative(REPO, ds.path),
    k: args.k,
    scored_instances: instances.length,
    modes: modeResults,
    multi_minus_keyword_recall: multiMinusKeyword,
    source: 'experiments/memory_recall_bench.js',
  };

  if (args.write) writeOutputs(summary, ds.label, ts, args.k, instances.length);
  return summary;
}

function writeOutputs(summary, dataset, ts, k, n) {
  const runsPath = path.join(REPO, 'data/longmemeval/runs.jsonl');
  fs.mkdirSync(path.dirname(runsPath), { recursive: true });
  fs.appendFileSync(runsPath, JSON.stringify(summary) + '\n', 'utf8');

  const lbPath = path.join(REPO, 'data/eval/leaderboard.jsonl');
  fs.mkdirSync(path.dirname(lbPath), { recursive: true });
  const epoch = String(Math.floor(new Date(ts).getTime() / 1000));
  for (const [mode, r] of Object.entries(summary.modes)) {
    if (r.skipped) continue;
    fs.appendFileSync(lbPath, JSON.stringify({
      benchmark: 'longmemeval',
      ts: epoch,
      label: `keystone-csf-memory:${mode}`,
      engine: 'keystone-csf-memory',
      mode,
      dataset,
      k,
      n,
      recall_at_k: r.recall_at_k,
      mrr: r.mrr,
      subset: dataset === 'synthetic-fixture',
      source: 'experiments/memory_recall_bench.js',
    }) + '\n', 'utf8');
  }
}

// ── selftest: prove the harness measures real signal ─────────────────────────────
async function selftest() {
  const s = await run({ k: 5, modes: ['keyword', 'idf'], dataset: null, write: false, limit: 0 });
  const fails = [];
  if (s.dataset !== 'synthetic-fixture') fails.push(`expected fixture, got ${s.dataset}`);
  if (!s.modes.idf || s.modes.idf.recall_at_k < 1.0) fails.push(`idf recall@${s.k} should be 1.0 on fixture, got ${s.modes.idf && s.modes.idf.recall_at_k}`);
  if (s.modes.idf && s.modes.keyword && s.modes.idf.recall_at_k < s.modes.keyword.recall_at_k) fails.push('idf recall must be >= keyword recall on fixture');
  if (s.modes.idf && s.modes.idf.mrr <= 0) fails.push('idf mrr should be > 0');
  if (fails.length) { console.error('SELFTEST FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
  console.log('SELFTEST PASS', JSON.stringify(s.modes));
  process.exit(0);
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.selftest) return selftest();
  const summary = await run(args);
  if (args.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`LongMemEval recall — dataset=${summary.dataset} (n=${summary.scored_instances}, k=${summary.k})`);
  for (const [mode, r] of Object.entries(summary.modes)) {
    if (r.skipped) { console.log(`  ${mode.padEnd(9)} SKIPPED (${r.reason})`); continue; }
    console.log(`  ${mode.padEnd(9)} recall@${summary.k}=${r.recall_at_k}  mrr=${r.mrr}  (${r.hits}/${r.n})`);
  }
  if (summary.multi_minus_keyword_recall !== null) console.log(`  idf − keyword recall: ${summary.multi_minus_keyword_recall >= 0 ? '+' : ''}${summary.multi_minus_keyword_recall}`);
  if (summary.dataset === 'synthetic-fixture') console.log('  NOTE: synthetic fixture — drop a real longmemeval_s.json in data/longmemeval/ for a publishable number.');
  console.log(`  incumbents (Letta/Mem0/Zep): run experiments/memory_bench_incumbents.py on the same dataset`);
})().catch((e) => { console.error('bench failed:', e.message); process.exit(1); });
