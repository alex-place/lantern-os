# Comet Leap P2 — Tesseract × CSF → 3¹² Singularity (`!comet-leap`)

**Sprint type:** Single **8-hour convergence block** (one operator, ultra model, web-grounded)
**Date:** 2026-06-19
**Branch:** `research/convergence-tesseract-spiral` (human lane)
**Workflow:** `!convergance` self-training loop (Observe → Remember → Reason → Act → Verify → Converge)
**Method:** ultra model + live web searches for external grounding (External Reality Rule)
**Status:** Active

> **One-line goal:** Stop carrying *two* designs ("CSF" and "the Tesseract"). Prove they are
> one `3**12` balanced-ternary lattice, write the single design reference, and update or
> archive every CSF/tesseract doc + skill so the repo holds **one** Convergence-Core object.

**North Star check:** This leap *removes* sprawl (two design vocabularies → one), so it passes
the Feature Gate under **Converge** ("better convergence metrics / one core"). It adds **no**
new runtime subsystem — only documentation consolidation over already-built code
([`src/csf/v07/`](../src/csf/v07/), [`src/converged_tesseract.py`](../src/converged_tesseract.py)).

Design reference produced by this leap: [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md).

---

## The 8-Hour Block (one operator, six stages)

| Hour | Stage | Work | Output |
|---|---|---|---|
| **0–1** | **Observe** | Inventory every CSF/tesseract doc, code path, and skill. Find what's scattered. | doc/code map (§Inventory) |
| **1–2** | **Remember** | Read the canon: Σ₀ briefing, CSF spec, spiral paper, core-mapping, qutrit/dust code. | grounded context |
| **2–4** | **Reason** | Web-search latest research (ternary/BitNet, radix economy, recurrent-depth, STARS, HDC). Derive the one-lattice thesis. | [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) §2–3 |
| **4–6** | **Act** | Write the design doc; wire pointers into CSF spec, RESEARCH-CANON, core-mapping, spiral paper, math-foundations skill. | this leap's commits |
| **6–7** | **Verify** | Status-tag every claim ([implemented]/[grounded]/[hypothesis]); cite all sources; run the doc-link + test sanity checks. | clean grounding pass |
| **7–8** | **Converge** | Mark superseded notes for archive; record what changed; leave the falsifiable experiment list (X1–X4). | this doc's Converge section |

---

## `!convergance` Work Items (lanes + acceptance)

This is a single-operator leap, but the work is split into lane-shaped units so it can be
re-run by the agent fleet if needed. Each unit is independently acceptance-tested.

### CL2-1 — Design reference (blocker)
- **Scope:** Write the single `3**12`-lattice design doc. Prove CSF (storage face) ≡ Tesseract
  (motion face) on one ternary lattice.
- **Lane:** `claude/`
- **Acceptance:** [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) exists; every
  load-bearing claim status-tagged; ≥ 8 external sources cited; code refs resolve. ✅ Done.

### CL2-2 — CSF spec lattice pointer
- **Scope:** Add a "lattice view" section to the canonical CSF spec — qutrit_delta is the
  storage face of the lattice; point to the singularity doc.
- **Lane:** `codex/`
- **Acceptance:** [`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md) links the doc;
  no contradiction with v0.3/v0.7/v0.8/v1 lineage. ✅ Done.

### CL2-3 — Research canon anchors
- **Scope:** Add the external research trail (BitNet b1.58, Sparse-BitNet, T-SAR, radix
  economy, recurrent-depth, STARS, SpiralFormer, HDC/VSA) under the right Convergence-12
  components.
- **Lane:** `openai/`
- **Acceptance:** [`RESEARCH-CANON.md`](RESEARCH-CANON.md) entries are component-linked with
  status notes (canon rule #2/#3); "Last Updated" bumped. ✅ Done.

### CL2-4 — Core-mapping reclassification
- **Scope:** Reclassify CSF in the divergence table from "implementation-detail leak" to
  "storage face of the lattice."
- **Lane:** `devin/`
- **Acceptance:** [`convergence-core-mapping.md`](convergence-core-mapping.md) row updated;
  alignment test still passes. ✅ Done.

### CL2-5 — Spiral paper gap-closure + skill
- **Scope:** Add the STARS citation that closes the spiral paper's open non-normal-operator
  gap; cross-link the singularity doc. Add a "3¹² Convergence Lattice" section to the
  math-foundations skill.
- **Lane:** `gemini/`
- **Acceptance:** [`spiral paper`](research/2026-06-19-convergence-tesseract-spiral.md) cites
  STARS; [`convergence-mathematical-foundations`](../skills/convergence-mathematical-foundations/SKILL.md)
  has the lattice section. ✅ Done.

---

## Inventory: update vs. archive

The leap touches every CSF/tesseract surface. Decision per artifact:

| Artifact | Decision | Reason |
|---|---|---|
| [`CSF-FORMAT-SPECIFICATION.md`](CSF-FORMAT-SPECIFICATION.md) | **Update** (canonical) | Add lattice-view pointer; remains the format authority |
| [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) | **Create** | The single design reference (this leap) |
| [`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md) | **Update** | The geometry paper; gains STARS + cross-link |
| [`RESEARCH-CANON.md`](RESEARCH-CANON.md) | **Update** | Add external anchors |
| [`convergence-core-mapping.md`](convergence-core-mapping.md) | **Update** | Reclassify CSF |
| [`PHASE-1-CSF-BACKEND.md`](PHASE-1-CSF-BACKEND.md) | **Archive pointer** | Phase notes superseded by the spec (already noted in spec §5) |
| `docs/CSF-Whitepaper-v0.3.pdf` | **Keep (history)** | Original whitepaper; historical record |
| [`skills/convergence-mathematical-foundations`](../skills/convergence-mathematical-foundations/SKILL.md) | **Update** | Add lattice section |
| [`skills/comet-leap-agile`](../skills/comet-leap-agile/SKILL.md) | **Keep** | Codex master-PDF skill; different surface, no change |
| `data/tesseract/*.csf`, `data/tesseract/manifest.json` | **Keep (data)** | Packed research pool; produced by [`csf_research_tesseract.py`](../scripts/csf_research_tesseract.py) |

"Archive pointer" = the doc stays on disk for history but the spec's §5 consolidation list is
the single index; no content is deleted (Memory is append-only — nothing is destroyed).

---

## Verify (grounding pass)

Per the External Reality Rule, before this leap is trusted:

- [x] Every claim in the design doc tagged **[implemented]**, **[grounded]**, or **[hypothesis]**.
- [x] All external claims carry a citable source (arXiv / Quanta / Wikipedia radix-economy).
- [x] All `[implemented]` claims point at real code (`NUM_DIMENSIONS=12`, `3**12=531441`,
      `converge_step`, `QuantumDustField`).
- [x] No new runtime subsystem introduced (anti-sprawl).
- [x] **X3** (dust vs BitNet sparsity) and **X4** (`converge_step` contraction instrument) run +
      3-lens adversarially verified on 2026-06-19 → X3 `refined`, X4 `supported` (semantics). See
      [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) §6.1.
- [ ] **X1** (CSF round-trip integrity) and **X2** (wavefront minimality) still queued.

Sanity command (does not prove the thesis, only that the substrate runs):
```bash
python -c "from csf.v07.qutrit_delta import NUM_DIMENSIONS, TOTAL_POSITIONS; print(NUM_DIMENSIONS, TOTAL_POSITIONS)"
# expect: 12 531441
python -m pytest tests/test_converged_tesseract.py -q
```

---

## Converge (what changed, what's next)

**Changed this leap:** two design threads ("CSF", "Tesseract") collapsed into one documented
object (the `3**12` lattice). Five canon docs + one skill now point at a single reference.

**Pattern extracted (Convergence record):** *When two subsystems share one state
representation, they are one object — consolidate the docs before the code drifts.* The repo
had two vocabularies for `{-1,0,+1}^12`; the fix was documentation, not code.

**Measured this leap (2026-06-19):** X3 → `refined` (value-sparsity is population-dependent, not
BitNet's learned 2/3 mass); X4 → `supported` (the contraction instrument is not fooled by
orbit/divergence). Both 3-lens adversarially verified (6/6 lenses sound, reproduced). Details and
numbers in [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) §6.1.

**Next sprint backlog:**
1. Run X1 (CSF round-trip integrity: pack→unpack→diff a `QuantumDustField`).
2. Run X2 (wavefront minimality: active-cell count vs 531,441 over a session).
3. Real-model X4: run `converge_step` over an actual Ouro-1.4B trajectory once a CUDA box /
   fixed `huggingface-hub` is available (CPU-only blocked it this round).
4. Adopt balanced ternary `{-1,0,+1}` end-to-end (engine currently stores unsigned `pos % 3`).
5. Wire `ConvergenceRecord` to lattice points (a record = a contraction step toward `h*`).

---

## Related

- [`TESSERACT-CSF-SINGULARITY.md`](TESSERACT-CSF-SINGULARITY.md) — the design reference
- [`CONVERGANCE-SIGMA0-BRIEFING.md`](CONVERGANCE-SIGMA0-BRIEFING.md) — immutable North Star
- [`COMET-LEAP-P1-CONVERGANCE-SPRINT.md`](COMET-LEAP-P1-CONVERGANCE-SPRINT.md) — prior leap format
- [`COMET-LEAP-1.5-CONVERGENCE-WORKFLOW.md`](COMET-LEAP-1.5-CONVERGENCE-WORKFLOW.md) — `!convergance` workflow
- [`research/2026-06-19-convergence-tesseract-spiral.md`](research/2026-06-19-convergence-tesseract-spiral.md) — the spiral geometry paper
