### Prototype: mesh grounding resolver — "answer with citations, or honestly 'I don't know'"

`apps/lantern-garage/lib/mesh-grounding.js` — a tested prototype of the federated-grounding
design (mesh of lantern-os mirrors). It is a **Remember-stage** helper only: it decides
WHAT grounded evidence the one local model (Ouro) is handed, and whether there is enough to
answer at all. NOT wired into the chat path yet — engine + tests first, pending an ADR.

- `resolveGrounding(question, {rings, threshold, stopConfidence, …})` walks pluggable
  grounding rings nearest-first (local memory → KC → mesh peers → web), merges and
  confidence-ranks the evidence, and returns `answer` (with cited sources) or `abstain`
  ("I don't know") when no claim clears the threshold. Cheap-first: a strong local hit
  short-circuits before the web/peer rings run, so grounding is *always checked, not always
  injected*.
- `meshPeerSource(peers, {fetchImpl})` builds the mesh ring. **Two invariants keep it
  Σ₀-legal** (no swarm, no second memory system): peers federate *evidence, not agency* —
  a mirror returns `{claim, evidence, confidence}` tagged `mirror:<id>`, never an answer or
  an instruction (any other field, e.g. an injected `instruction`, is dropped — peer text
  is DATA); and a node borrows *grounding, not compute*, so a constrained 8GB single-model
  node can ground on a richer peer's memory and still reason locally.
- Honest abstention is anchored to evidence (a checkable retrieval fact), not a learned
  hedge — the only way "I don't know" stays trustworthy. Corroboration across mirrors boosts
  confidence via bounded noisy-OR (stays in [0,1]); a single source can't inflate itself.
- Test: `apps/lantern-garage/test/mesh-grounding.test.js` (11 cases) — answer/abstain
  decisions, the mesh ring, cheap-first short-circuit, corroboration bounds, per-source
  timeouts (a hung ring/peer never blocks), and the data-not-agency / confidence-clamp guards.

**Wired to real sources + live-tested** (after reviewing the existing mesh subsystem +
ADRs 0002/0004/0005, which it passes — a Remember/Verify helper, not a new subsystem):

- `lib/grounding-rings.js` — adapts the EXISTING retrievers into rings: `local-memory`
  (csf-memory.queryConversationMemory/queryMemories, relevance score → confidence),
  `knowledge-center` (queryRagHouse/queryResearchLibrary), `web`
  (web-search-client, gated by needsGrounding, calibrated 0.45 prior so a lone web hit
  abstains), and `mesh` (meshPeerSource over peer mirrors via an http/https `httpPostJson`).
  `localServeRings()` = local rings only (a node never re-federates when serving a peer).
- `routes/grounding.js` (registered in server.js, **gated by `MESH_GROUNDING=1`**, off by
  default): `GET /api/grounding/resolve` (full resolution + the model's prompt block) and
  the read-only federation primitive `POST /api/mesh/ground` (serves local evidence; shared
  -secret gate via `MESH_GROUND_SECRET`; data-not-agency).
- `server.js`: registered the route; added an opt-in `SKIP_DEP_PREFLIGHT=1` escape hatch for
  worktree/CI runs with a junctioned `node_modules`.
- Test: `test/grounding-rings.test.js` (7 cases, retrievers stubbed). Verified LIVE on a
  worktree server: answer-with-citations (local memory), honest abstain (no grounding), the
  federation self-loop over real HTTP (`mirror:self`, corroboration boosting confidence to
  0.82, bounded), and the raw `/api/mesh/ground` primitive.

**Chat splice wired + tested** (behind `MESH_GROUNDING=1`, off by default): both paths now
ground from local memory + Knowledge Center — `dream-chat.js` (non-stream, prepended to the
user prompt) and `stream-chat.js` (both system-prompt sites: ROUTER_PROMPT + RP/journal).
**Additive-only**: it injects the *cited evidence* block only when the resolver actually
grounds; it never forces "I don't know" into an ordinary chat turn (honest IDK stays the
system prompt's job, so a memory-thin turn isn't crippled). Web ring omitted (the chat does
its own web grounding); mesh peer ring omitted (ADR-gated). Verified live on a worktree
server: a memory-matching turn fired `[mesh-grounding] grounded turn: 1 source(s), conf 0.50`
and injected the block; an unrelated turn injected nothing. (The model *using* the evidence
in its reply needs a provider key — the keyless run proves the injection wiring.)

Loop stage: **Remember + Verify**. Still gated pending a Proposed ADR: the **mesh peer ring**
(cross-node fetch) stays behind the peer registry + ADR approval — `mesh-members.json` has no
per-node URLs and `cloud-mirrors.json` is "one canonical surface", so multi-mirror federation
needs Alex's topology decision.
