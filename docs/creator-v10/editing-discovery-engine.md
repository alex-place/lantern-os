# Editing Discovery Engine

**Status:** structural core shipped (`src/creator-intelligence/discovery/`), gated.
**Idea:** an always-on lab that *discovers* recurring editing techniques and turns
them into a reusable playbook — the honest realization of the "Editing Discovery
Engine" loop (DISCOVER → SEGMENT → HIGHLIGHT → PATTERN → PLAYBOOK → VERIFY).

## What it is
Composes the measured detectors already in the dashboard into named, reusable
editing techniques:
- **SEGMENT** (`segment.js`): a clip's analysis → role-labeled beats in the spec
  time buckets (0-1 / 1-3 / 3-7 / 7-15 / 15s+). Roles — `hook`, `build`,
  `surprise`, `payoff`, `cta` — come ONLY from measured signals (A1 cuts, A2
  `novel` tag, A3 speech hook/CTA, A4 retention). Consecutive runs are collapsed so
  a sequence reflects transitions.
- **PATTERN DISCOVERY** (`pattern-mining.js`): mines recurring role sub-sequences
  (length 2–4) across clips, counts how many clips share each, and names them
  ("hook → surprise → payoff" = *Quick Payoff*; "hook → build → surprise → payoff"
  = *Delayed Reveal*).
- **PLAYBOOK** (`playbook.js`): patterns → techniques with plain-language steps.
- **Orchestrator** (`index.js`): `discoverFromClips(clips, opts)` (pure) +
  `discoverFromDisk()` (loads analyzed entries + outcomes from the calibration store).

## The honesty contract (the VERIFY stage)
This is the whole point, and it is enforced in code + tests:
- A sequence is a "pattern" only when **≥3 clips** share it (structural frequency).
- A pattern's **performance** is `insufficient_data` until **≥5** of its example
  clips carry a real first-party outcome → then `directional`; **≥20** →
  `calibrated`. Frequency ≠ performance; they are never conflated.
- A technique is **never** promoted to "verified" without that data. With zero
  outcomes (today), the playbook is purely structural and every technique reads
  `insufficient_data`.

## What it does NOT do (the wall, made explicit)
It does **not** scrape other creators' top Shorts/TikToks/Reels for replay
rate / shares / engagement-per-second. No platform API exposes those per-video
private metrics, bulk-downloading the videos is ToS + copyright, and inventing the
numbers is exactly what the no-fabrication rule forbids. So DISCOVER operates on
clips the operator actually has — **own renders/uploads + a curated reference set**
— and "performance" comes from the operator's **own** analytics (the calibration
store, `docs/creator-v10/learning-pipeline-research.md`).

## Dependency / when it becomes powerful
The engine is the **consumer** of the calibration loop. It can discover and cluster
patterns now (exploratory), but its headline output — *verified techniques* — only
lights up once real outcomes are imported. Until then it honestly reports
`insufficient_data`. Run it after analytics flow in, not "forever" before.

## Tests
`tests/test_discovery_engine.js` (10 checks): buckets, role labeling (incl.
measured-only CTA), template naming, pattern discovery (≥3-clip floor), the
insufficient_data → directional gate, and that the playbook never claims a verified
technique without data.

## Not yet built
Persistence (`editingPlaybook.json` / `highlightLibrary.jsonl`), an HTTP route +
UI for the playbook, segment-by-context "best for", and the experimentation loop
(reuses the B1 variant engine). All deferred until there's a reason to surface them.
