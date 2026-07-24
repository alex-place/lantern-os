// LongMemEval on the LIVE JS chat memory path (#2111).
//
// experiments/longmemeval_harness.py already scores the Python MemoryEngine
// (src/csf/memory_engine.py) — but that is NOT the retriever a real chat turn uses. The
// product path is lib/csf-memory.js::searchConversation: a keyword
// retriever that windows the LAST 1200 conversation-log turns and ranks by relevanceScore.
// Its recall was never measured, so the 0.709 recall@5 we quote is the Python engine's, not
// the product's. This harness closes that gap by driving searchConversation directly over the
// LongMemEval haystack and scoring recall@k / MRR, writing a SEPARATE row so the two numbers
// never get conflated.
//
// It also surfaces a real product limitation the Python engine doesn't have: the 1200-turn
// window. When a haystack is larger than that, the earliest sessions fall outside the window
// and CANNOT be retrieved — we count those as `truncated_gold` so the recall number is read
// with that caveat, not silently depressed.
//
// Run: node scripts/eval_longmemeval_js.js --limit 50 --k 5
//   --dataset <path>   default data/longmemeval/longmemeval_s.json
//   --semantic         also try the semantic rerank path (falls back to keyword if the
//                      embeddings service is unavailable — e.g. :11434 is serving Ouro)

const fs = require("fs");
const os = require("os");
const path = require("path");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const REPO = path.resolve(__dirname, "..");
const DATASET = String(arg("dataset", path.join(REPO, "data", "longmemeval", "longmemeval_s.json")));
const K = parseInt(String(arg("k", "5")), 10);
const LIMIT = parseInt(String(arg("limit", "0")), 10) || 0;
const TRY_SEMANTIC = arg("semantic", false) === true;
const WINDOW = 1200; // must match searchConversation's window; used only to flag truncation

// Point the product memory reader at a throwaway log BEFORE requiring it, so searchConversation
// reads our per-instance haystack instead of the real conversation store.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lme-js-"));
const LOG = path.join(TMP, "garage-conversations.jsonl");
process.env.KEYSTONE_CONVERSATION_LOG = LOG;
process.env.CSF_MEMORY_PATH = path.join(TMP, "csf_memory"); // isolate; unused by searchConversation
fs.mkdirSync(process.env.CSF_MEMORY_PATH, { recursive: true });

const mem = require(path.join(REPO, "apps", "lantern-garage", "lib", "csf-memory.js"));

function norm(s) {
  return String(s || "").trim().slice(0, 80).toLowerCase();
}

// Ingest one instance's haystack into the log; return {textKey -> Set(sessionId)} and the
// count of turns, so a retrieved turn can be attributed back to its (possibly gold) session.
function ingest(instance) {
  const lines = [];
  const textToSessions = new Map();
  const sessions = instance.haystack_sessions || [];
  const ids = instance.haystack_session_ids || [];
  for (let s = 0; s < sessions.length; s++) {
    const sid = ids[s];
    for (const turn of sessions[s] || []) {
      const text = String(turn.content || turn.text || "").trim();
      if (!text) continue;
      lines.push(JSON.stringify({ role: turn.role === "assistant" ? "lantern" : "operator", text }));
      const key = norm(text);
      if (!textToSessions.has(key)) textToSessions.set(key, new Set());
      textToSessions.get(key).add(sid);
    }
  }
  fs.writeFileSync(LOG, lines.join("\n") + "\n", "utf8");
  return { textToSessions, nTurns: lines.length };
}

// Was any gold-session turn INSIDE the searchable window? If not, no keyword retriever could
// find it — that's a product-window miss, distinct from a ranking miss.
function goldInWindow(instance, textToSessions, nTurns) {
  const gold = new Set(instance.answer_session_ids || []);
  // reconstruct the last-WINDOW slice of turns and check if any belongs to a gold session
  const startIdx = Math.max(0, nTurns - WINDOW);
  const all = fs.readFileSync(LOG, "utf8").trim().split("\n");
  for (let i = startIdx; i < all.length; i++) {
    let e; try { e = JSON.parse(all[i]); } catch { continue; }
    const sess = textToSessions.get(norm(e.text));
    if (sess && [...sess].some((x) => gold.has(x))) return true;
  }
  return false;
}

function scoreHits(hits, instance, textToSessions) {
  const gold = new Set(instance.answer_session_ids || []);
  let rank = 0;
  for (let r = 0; r < hits.length; r++) {
    const sess = textToSessions.get(norm(hits[r].text));
    if (sess && [...sess].some((x) => gold.has(x))) { rank = r + 1; break; }
  }
  return { recall: rank > 0 ? 1 : 0, mrr: rank > 0 ? 1 / rank : 0 };
}

async function semanticHits(question, k) {
  // Best-effort semantic rerank over the keyword candidate pool. Needs the embeddings service;
  // returns null (→ caller skips the semantic arm) if it isn't reachable.
  try {
    const { semanticRerank } = require(path.join(REPO, "apps", "lantern-garage", "lib", "semantic-reranker.js"));
    const cand = mem.searchConversation(question, k * 4);
    if (!cand.length) return [];
    const reranked = await semanticRerank(question, cand, { topK: k, textField: "text" });
    // if the reranker silently fell back to identity, we still return something usable
    return reranked.slice(0, k);
  } catch {
    return null;
  }
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATASET, "utf8"));
  const instances = (Array.isArray(data) ? data : Object.values(data)).slice(0, LIMIT || undefined);

  const kw = { recall: 0, mrr: 0 };
  const sem = { recall: 0, mrr: 0, ran: 0 };
  let semanticAvailable = TRY_SEMANTIC;
  let truncatedGold = 0;
  const n = instances.length;

  for (const inst of instances) {
    const { textToSessions, nTurns } = ingest(inst);
    if (!goldInWindow(inst, textToSessions, nTurns)) truncatedGold++;

    const kwHits = mem.searchConversation(inst.question, K);
    const ks = scoreHits(kwHits, inst, textToSessions);
    kw.recall += ks.recall; kw.mrr += ks.mrr;

    if (semanticAvailable) {
      const semHits = await semanticHits(inst.question, K);
      if (semHits === null) { semanticAvailable = false; } // embeddings service down — stop trying
      else { const ss = scoreHits(semHits, inst, textToSessions); sem.recall += ss.recall; sem.mrr += ss.mrr; sem.ran++; }
    }
  }

  const row = {
    timestamp: new Date().toISOString(),
    dataset: path.basename(DATASET),
    harness: "product-path-js (csf-memory.searchConversation)",
    k: K, scored_instances: n,
    window_turns: WINDOW, truncated_gold: truncatedGold,
    modes: {
      keyword: { recall_at_k: +(kw.recall / n).toFixed(4), mrr: +(kw.mrr / n).toFixed(4), hits: kw.recall },
    },
    semantic_available: semanticAvailable && sem.ran > 0,
    source: "scripts/eval_longmemeval_js.js",
    note: "#2111 — live JS product retriever, NOT the Python MemoryEngine; keyword windows last 1200 turns",
  };
  if (sem.ran > 0) {
    row.modes.semantic = { recall_at_k: +(sem.recall / sem.ran).toFixed(4), mrr: +(sem.mrr / sem.ran).toFixed(4), hits: sem.recall, n: sem.ran };
  }

  const outDir = path.join(REPO, "data", "longmemeval");
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, "runs.jsonl"), JSON.stringify(row) + "\n", "utf8");

  console.log(`[product-path-js] recall@${K} keyword = ${row.modes.keyword.recall_at_k}  ` +
    `MRR = ${row.modes.keyword.mrr}  (n=${n}, ${kw.recall} hits)`);
  console.log(`  window=${WINDOW} turns; ${truncatedGold}/${n} instances had gold OUTSIDE the window ` +
    `(unreachable by the product retriever — a real limitation, not a ranking miss)`);
  if (row.modes.semantic) {
    console.log(`  semantic recall@${K} = ${row.modes.semantic.recall_at_k} (n=${sem.ran})`);
  } else if (TRY_SEMANTIC) {
    console.log("  semantic: UNAVAILABLE (embeddings service not reachable — :11434 may be serving a chat model)");
  }
  console.log("wrote data/longmemeval/runs.jsonl row");
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { norm, scoreHits };
