### Added

- **The Spiral — a verified-cascade convergence loop (ADR-0030, Phase 0).** The owned local
  reasoning core, built as the CLAUDE.md loop run on ONE problem: each turn is a verified cascade —
  the cheap/owned tier proposes a step, a **real bounded exec-test verifier** gates it by **Fix Rate**
  (fraction of failing tests newly passed, minus a regression penalty), and only on a stall does it
  **escalate to a frontier tier inheriting the accumulated progress**. A step commits to growing
  verified memory only when reality ratchets it (the anti-memorization gate); the loop halts on
  solved / honest-can't / a turn cap, and emits an **escalation corpus** (each frontier rescue is a
  Verified-Trace-Distillation target). No new weights — it reassembles the shipped live cascade
  (#2800), the constraint-aware cheap-tier picker (#2814), and the verified ledger (#2797).
  - `apps/lantern-garage/lib/spiral-fix-rate.js` — the M4 ratchet metric (SWE-Shepherd-grounded), pure.
  - `apps/lantern-garage/lib/spiral-harness.js` — the loop + per-turn cascade + escalation-corpus emit.
  - `apps/lantern-garage/lib/spiral-tiers.js` — real exec verifier + injectable model tiers (via the
    provider-agnostic `verify-llm` legs; no chat-loop recursion).
  - `apps/lantern-garage/lib/exec-verify.js` — added a non-blocking `verifyExecAsync` twin so the
    verifier never freezes the server event loop.
  - **Chat surface:** a `spiral_solve` operator tool in the chat tool-runner — a user drives a spiral on
    a tested coding task from dream-chat and watches it converge; returns the verified solution, the
    transcript, and the escalation rate. Honest scope: verifiable code/math on the smallest hardware;
    if no interpreter or no tests are present it says so rather than guessing.
  - Design of record: `docs/research/2026-07-22-spiral-verified-cascade-design.md`. Tests:
    `npm run test:spiral --prefix apps/lantern-garage` (24 cases, incl. real-sandbox end-to-end).
