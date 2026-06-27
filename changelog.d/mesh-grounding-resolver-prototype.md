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

Loop stage: **Remember + Verify**. Next: ADR (Proposed) for the topology, then wire the
rings to the real local memory / Knowledge Center / web / a read-only `/api/mesh/ground`
peer endpoint.
