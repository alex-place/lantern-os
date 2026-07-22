### Added

- **Spiral borrow survey → convergence records + Phase-0 runner + SSOT doc (ADR-0030).** Borrowing
  from open research is now grounded, not hand-waved: each candidate open **weight** or **training
  set** is validated as one honest ConvergenceRecord.
  - `scripts/spiral_borrow_records.js` — 11 borrows (SWE-Gym, SWE-rebench V2, SWE-HERO exec-verified
    subset, KodCode, TACO, Open-SWE-Traces, OpenCoder, DeepCoder, Qwen2.5-Coder-7B, TRM/HRM,
    pass-rate reward) each emitted with claim/evidence/confidence/source/`verified_by`. Only the
    reproduced-on-box Qwen2.5-Coder-7B is `verified`; the rest are web-grounded **candidates**, and
    synthesized trajectory sets are gated behind our own exec-verification before becoming VTD
    targets (Gekhman 2405.05904). Records land in the gitignored canonical ledger.
  - `experiments/spiral_phase0.js` — runs the verified spiral over real executable tasks, emits the
    escalation corpus (the Phase-1 VTD fuel), and self-emits a ConvergenceRecord. Default mode is a
    free, deterministic **mechanics** run (real exec + Fix-Rate ratchet + corpus); `--live` uses real
    model tiers (spend-gated). Observed: 4/6 cheap-tier sufficiency, 2/6 escalated with real
    `distillTarget` rows.
  - `docs/SIGMA0-OURO-CODER.md` — **rewritten as the single source of truth** on the owned local
    coder and its whole legacy: Qwen-3B QLoRA → Ouro-1.4B looped kernel → the owned PLT coder → the
    verified Qwen-7B default → **the Spiral** (ADR-0030). Includes the borrow evidence table, the
    three phases, the moat framing (the system, not a home-grown model; generalization from the
    verifier, not scale), and the preserved Ouro recurrent-depth kernel mechanism.
