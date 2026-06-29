// report-card.js — grounded, letter-grade self-assessment of Keystone OS.
//
// Strengthens the Verify/Converge stage of the loop: an honest scorecard the
// user can check, where every grade is earned by evidence. The Σ₀ rule here is
// non-negotiable — the LLM must never invent a receipt. So this module gathers
// the EVIDENCE deterministically in Node (git state, real file counts, actual
// eval numbers, a boot probe) and hands that bundle to the model, which is only
// allowed to SYNTHESIZE grades from what it was given. A number the model cites
// therefore traces to a real measurement, not a hallucination.
//
// Mirrors the methodology of the `report-card` Claude Code skill so the in-chat
// `!report-card` and the editor skill produce the same kind of card.

const fs = require("fs");
const path = require("path");
const { safeExec } = require("./safe-exec");

// Run a git command and return trimmed stdout, or an honest "unavailable" marker.
// Evidence we cannot gather is surfaced as such — never silently dropped, never faked.
function _git(repoRoot, args) {
  try {
    return safeExec(["git", ...args], { cwd: repoRoot, timeout: 15000 }).trim();
  } catch (e) {
    return `(unavailable: ${e.message.split("\n")[0]})`;
  }
}

// Count entries under a dir matching a predicate, recursing only when asked.
// Returns a number, or null when the path is missing (an honest "couldn't measure").
function _count(dir, { ext, recurse = false } = {}) {
  try {
    let n = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (recurse && entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(path.join(d, entry.name));
        } else if (!ext || entry.name.endsWith(ext)) {
          n++;
        }
      }
    };
    walk(dir);
    return n;
  } catch {
    return null;
  }
}

// Tail the last N lines of a JSONL file as parsed objects. Returns [] when the
// file is absent — a missing eval log is graded as "not measured", not invented.
function _tailJsonl(file, n = 5) {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function _lineCount(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

// Gather the deterministic evidence bundle. Everything here is a real measurement
// of the repo on disk right now; nothing is guessed.
function gatherEvidence(repoRoot) {
  const app = path.join(repoRoot, "apps", "lantern-garage");
  const ev = {};

  // ── Git / change state ──────────────────────────────────────────────
  ev.git = {
    branch: _git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    uncommitted: _git(repoRoot, ["status", "--porcelain"]).split("\n").filter(Boolean).length,
    recentCommits: _git(repoRoot, ["log", "--oneline", "-12"]),
  };

  // ── Surface area (the scope-discipline evidence) ────────────────────
  ev.surface = {
    htmlSurfaces: _count(path.join(app, "public"), { ext: ".html" }),
    libModules: _count(path.join(app, "lib"), { ext: ".js" }),
    routeFiles: _count(path.join(app, "routes"), { ext: ".js" }),
    nodeTests: _count(path.join(app, "test"), { ext: ".js" }),
    pythonTests: _count(path.join(repoRoot, "tests"), { ext: ".py" }),
    adrs: _count(path.join(repoRoot, "docs", "adr"), { ext: ".md" }),
    changelogFragments: _count(path.join(repoRoot, "changelog.d"), { ext: ".md" }),
  };

  // ── Boot probe — does the entrypoint at least parse? ────────────────
  try {
    safeExec(["node", "--check", path.join(app, "server.js")], { cwd: repoRoot, timeout: 20000 });
    ev.bootProbe = "node --check server.js: clean";
  } catch (e) {
    ev.bootProbe = `node --check server.js: FAILED — ${(e.stderr || e.message || "").split("\n")[0]}`;
  }

  // ── Measured capability / health numbers ────────────────────────────
  ev.evals = {
    leaderboard: _tailJsonl(path.join(repoRoot, "data", "eval", "leaderboard.jsonl"), 6),
    agiBenchmark: _tailJsonl(path.join(repoRoot, "data", "agi-benchmark.jsonl"), 4),
    convergenceRecords: _lineCount(path.join(repoRoot, "data", "convergence", "records.jsonl")),
  };

  return ev;
}

// Render the evidence bundle as compact, model-readable text. Kept terse so the
// model spends its attention on grading, not parsing.
function formatEvidenceForPrompt(ev) {
  const lines = [];
  lines.push("## EVIDENCE (gathered deterministically from the repo — these are real measurements)");
  lines.push("");
  lines.push("### Git / change state");
  lines.push(`- branch: ${ev.git.branch}`);
  lines.push(`- uncommitted files: ${ev.git.uncommitted}`);
  lines.push(`- recent commits:\n${ev.git.recentCommits.split("\n").map((l) => "    " + l).join("\n")}`);
  lines.push("");
  lines.push("### Surface area");
  for (const [k, v] of Object.entries(ev.surface)) {
    lines.push(`- ${k}: ${v === null ? "(could not measure)" : v}`);
  }
  lines.push("");
  lines.push("### Boot probe");
  lines.push(`- ${ev.bootProbe}`);
  lines.push("");
  lines.push("### Measured numbers");
  lines.push(`- convergence records logged: ${ev.evals.convergenceRecords === null ? "(no log)" : ev.evals.convergenceRecords}`);
  const fmt = (arr) => arr.length ? arr.map((r) => "    " + JSON.stringify(r)).join("\n") : "    (no entries — not measured)";
  lines.push(`- eval leaderboard (last ${ev.evals.leaderboard.length}):\n${fmt(ev.evals.leaderboard)}`);
  lines.push(`- AGI/autowork benchmark (last ${ev.evals.agiBenchmark.length}):\n${fmt(ev.evals.agiBenchmark)}`);
  return lines.join("\n");
}

// The grading methodology — distilled from the report-card skill. The hard rules:
// honesty over flattery, spread the grades, cite a real receipt per row, and an
// honest "couldn't verify" beats an invented grade.
const REPORT_CARD_SYSTEM_PROMPT = `You are producing an honest, evidence-grounded LETTER-GRADE report card for Keystone OS as it actually is right now.

This is a Σ₀ artifact: external reality beats internal consistency. A report card graded from vibes is worse than none — it launders feeling into a letter. The user lives inside this project; what they cannot get from themselves is a frank outside read with receipts. That is the deliverable.

GRADE ONLY FROM THE EVIDENCE PROVIDED BELOW. Do not invent log lines, numbers, or test results. If the evidence for a dimension is missing or marked "not measured", say so in that row rather than guessing — an honest "couldn't verify this" is a valid cell.

Two failure modes ruin this card, avoid both:
- Grade inflation / flattery. A row of B+'s is worthless. Hunt for the C's and D's — the weak dimension is the most valuable line on the card.
- Ungrounded grades. Every grade must point at something concrete from the evidence (a count, a number, a commit, the boot probe).

Choose 5–8 dimensions that capture the whole system. A strong default spine: Grounding/verification engine, Core product (the chat), Engineering discipline, Code quality, Operational health, Raw capability (cite real eval numbers), and Scope discipline. Pay special attention to Scope discipline — this project's own North Star forbids architectural sprawl ("one loop, four objects, reject sprawl"), so a large surface count (many HTML pages, lib modules, route groups) is a real low grade against the project's OWN stated rule, and naming it honestly is exactly what the user wants.

Use real letter grades with +/- and let them SPREAD across at least three levels. A=excellent (rare, reserve it); B=solid/works; C=works with serious caveats or measured-mediocre; D=a real problem; F=broken/absent. The overall grade is a judgment call weighted by what matters, not an average — a brilliant core wrapped in fragility and sprawl is a B−, not a B+.

OUTPUT FORMAT (follow exactly):
1. One or two framing sentences: what this is graded on, and that it's a grounded snapshot of the repo state, not a full audit (you did not boot the live server or drive the UI).
2. A markdown table with columns: Dimension | Grade | Evidence. Each Evidence cell cites a concrete receipt from the evidence bundle. Keep cells tight.
3. A short "what would raise it" note covering the rows graded C+ or below — one sentence each on the single change that would lift that grade. (Only for weak rows; don't dilute the strong ones.)
4. A bold "Overall: <grade>" followed by ONE candid paragraph naming the central tension in plain language.

Tone: a sharp, fair colleague who respects the user enough to be straight — warm about what's genuinely good, unflinching about what isn't, never cruel and never flattering.`;

module.exports = {
  gatherEvidence,
  formatEvidenceForPrompt,
  REPORT_CARD_SYSTEM_PROMPT,
};
