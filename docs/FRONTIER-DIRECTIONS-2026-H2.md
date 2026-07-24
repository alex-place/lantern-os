# Frontier Directions — Deep Research + Design (2026 H2)

> **Status:** Internal design document. Solo developer (Alex Place), unisona.ai — a persistent, local-first convergence-loop AI system.
>
> **Method & integrity rule.** Every direction below was put through one loop: *research → mark a novelty verdict → adversarially verify (3 skeptics) → design*. We apply the **External-Reality Rule**: every important claim carries `[claim, evidence, confidence, source]`. **Where the adversarial verify refuted a novelty claim, this document says so and adopts the corrected verdict** — it does not re-publish the original "ahead" framing. The single most important finding of this whole exercise: **all four directions had their original "ahead / category-of-one" headline claims refuted (2–3 of 3 skeptics each). None survived as written.** The honest posture is *parity / mixed with a narrow execution edge*, not category leadership. Public-facing copy must be rewritten accordingly before it ships.

---

## 1. Executive Summary

We evaluated four candidate frontier directions for unisona.ai. The pattern is consistent and uncomfortable: each direction began with a confident "AHEAD" thesis, and each was knocked down by adversarial search to **MIXED or PARITY**. The strategy in every case is *directionally correct* — the bet on owned/local, verifiable, abstaining AI is well-aimed — but **the moats are execution-and-integration, not invention.** In every direction a 2025–2026 product or research artifact already ships the capability we claimed was uniquely ours.

What this means practically: these are still worth building, because (a) each strengthens exactly one stage of the convergence loop, (b) each reuses code we already have rather than adding subsystems, and (c) a real, narrow differentiation survives in each (the *bundle* + execution rigor). But we must strip "category of one," "ahead of shipped products," and "parity on capability" from any external copy until we have measured evidence.

### Ranking table

| # | Direction | Post-verification novelty | Demand strength | Feasibility | Highest-leverage first step |
|---|-----------|---------------------------|-----------------|-------------|------------------------------|
| 1 | **Verifiable Memory Vault** (`memory-vault`) | **Parity** (3/3 refuted "ahead"; survives as integration edge only) | Moderate | High (most primitives already in-repo) | `tests/test_vault.py`: import `cryptographic_proof.py` over a fixture JSONL ledger, prove a mutated record breaks the chain |
| 2 | **On-device groundedness canary** (`groundedness-canary`) | **Mixed** (2/3 refuted "ahead"; product whitespace real, "moat" reframed) | Moderate | Medium (valve dormant; one wire missing) | Run `experiments/surprise_leak_ab.py` for real on local Ollama + OpenAI non-reasoning; record per-model AUROC — **kill-switch gate** |
| 3 | **BetterSafe casework** (`bettersafe`) | **Mixed** (3/3 refuted "ahead"; narrow edge = abstention-default + local-first + FRIA binding) | **Strong** (42 CFR Part 2 binding *now*) | Medium–High (verify primitives exist; evaluator is a demo matcher) | Extend `social_services.py._score_match` into a citation-bearing per-rule evaluator |
| 4 | **Self-improving coding that proves its own work** (`self-improving-coding`) | **Mixed** (2–3/3 refuted; "parity" is unsubstantiated → currently *behind* on measured capability) | **Strong** | Medium (SWE-bench harness needs WSL2/Docker + live wiring) | Live-wire `swe_agent_loop` + grade a frozen 10–30 instance slice; post the **first real resolved%** |

> **Cross-cutting caveat the completeness critic raised and we accept:** the four "ahead/parity" verdicts in earlier drafts were all carried into customer-facing language *unchanged* despite `verify.survives = false` on all four. This document is the correction.

---

## 2. Direction 1 — The Verifiable Memory Vault

**Thesis.** Owned, tamper-evident, decades-durable institutional memory: fuse the append-only JSONL convergence ledger + SHA-256 archive (CSF), the "500-Year Hardening" doctrine (epoch gates, attested handoffs), and event-sourcing/Byzantine-consensus ADRs (HFF), so memory is provably unaltered and readable across operator turnover.

### 2a. Novelty — verdict after verification

**Original headline (REFUTED):** *"AHEAD of state of the art… category of one… none ship tamper-evidence + a succession/handoff doctrine."*

**Corrected verdict: PARITY.** *Skeptics refuting "ahead": 3 of 3.* (`verify.survives = false`, corrected verdicts `[parity, parity, mixed]`.)

The researcher had already downgraded "ahead" to "mixed," crediting the edge to the *fusion* (tamper-evidence + succession + multi-decade durability for owned/local queryable AI memory). Adversarial search then refuted the fusion as a category of one:

- **`github.com/kase1111-hash/memory-vault`** (shipped alpha 0.2.1, 2026) — literally named "Memory Vault," self-describes as the "owner-sovereign storage subsystem for a learning co-worker," and bundles in one product: Merkle tree over recall events + Ed25519-signed roots (tamper-evidence); a **designed** dead-man switch with named-heir public-key enrollment + Shamir quorum recovery (succession, *not* git-by-accident); FTS5 recall + LangChain (queryable AI-loop memory); offline/owned. That is 4 of our 5 bundled properties, fused. [confidence 0.9, https://github.com/kase1111-hash/memory-vault]
- **LeanCTX** (`yvgude/lean-ctx`, v3.8.16, 3000+ stars) — ships a "tamper-evident SHA-256 chain… local-only, on by default," portable `.ctxpkg`, FTS5 cross-archive search, git-anchored ed25519-signed snapshots: a *mature, genuinely shipping* local-first owned tamper-evident AI memory. [confidence 0.85]
- **Cathedral** (`cathedral-ai.com`) — a shipping paid product with a live "Succession Registrar" / "Agent Succession Protocol" (BCH anchoring, lineage hash, Ed25519, chain-of-custody, obligation inheritance). [confidence 0.8]
- **worthprotecting.ai** — ships "digital succession plans for AI agents" (Designated Agent Custodian, Owner Incapacity Protocol). Kills "succession is uniquely ours." [confidence 0.8]

The researcher's own concession holds: every *isolated* capability is parity-or-behind. The defensible remainder is **execution rigor on the regulated AI-agent-audit wedge** — external anchoring + a *written* multi-decade format-migration doctrine + integration into a working agent loop — **not** category novelty.

**Completeness-critic corrections we adopt:**
- Our own engine self-documents the ceiling: `src/hff-api/cryptographic_proof.py` says it is *tamper-**evident**, not tamper-**proof*** — "physical database access can still modify it," the private key is "written **unencrypted**," and it is "a teaching implementation." Public copy must say **"local tamper-evidence,"** never "proof that memory was never rewritten."
- **No external time-anchor exists in the design.** A local hash chain proves internal consistency, not that a record existed at a past date. The real moat is **RFC 3161 trusted timestamps and/or periodic Merkle-root publication to an RFC-6962/CT-style transparency log** — the in-repo Ed25519+Merkle+SQLite is table stakes.
- **C2PA / Content Authenticity Initiative** is the dominant verifiable-provenance standard (SHA-256, Merkle, X.509; 6,000+ members incl. Google/Meta/OpenAI/Adobe; recommended under EU AI Act Art. 50). It is the comparison the "category of one" claim omitted. The Vault should *compose with* C2PA/Trillian, not claim novelty over them.

#### Competitor gap table

| Competitor | What they ship | Gap vs us |
|---|---|---|
| **Letta (ex-MemGPT)** — [docs.letta.com/letta-code/memory] | MemFS / Context Repositories (Feb 2026): git-backed agent memory; every edit committed to a git repo | Git is a SHA Merkle DAG → practical tamper-evidence "for free." Lacks a *designed* succession doctrine, decades-durability, epoch gates, external anchoring |
| **MemOS (MemTensor)** — [arxiv.org/abs/2507.03724] | MemCube; graph store; lifecycle, scheduling, "traceable access" | Competes on governance/retrieval, **not** integrity. No hash-chain, no succession, no durability spec |
| **Mem0** — [mem0.ai/security] | SOC2/HIPAA audit-ready logs, encrypted storage, self-host | Compliance *logging* under a trusted operator — not operator-untrusted tamper-*evidence* |
| **Zep / Graphiti** — [arxiv.org/abs/2501.13956] | Bi-temporal KG, validity intervals, fact→source traceability | Best-in-class *provenance*, but provenance ≠ tamper-evidence; no succession, no durability |
| **Notion AI** — [notion.com/help/audit-log] | Enterprise audit log, version history | Server-trusted, cloud-only, alterable by vendor/admin. Confirms "no integrity layer" **for Notion** |
| **Obsidian (+ obsidian-git)** — [github.com/Vinzent03/obsidian-git] | Auto-commit vault to git (Merkle DAG); git-crypt | **Refutes** "Obsidian has no integrity layer" for the git setup; vanilla Sync lacks content↔metadata binding (Trail of Bits). DIY, no succession/anchoring |
| **Google Trillian / RFC 6962 CT** — [github.com/google/trillian] | Production tamper-evident append-only Merkle log; third-party-verifiable inclusion + consistency proofs | The gold-standard primitive, *stronger* than our hash chain. The Vault should **anchor to it**, not claim novelty |
| **Digital preservation (OAIS/ISO 14721, ARCHANGEL, Harvard LIL Century-Scale, chain-of-custody)** — [lil.law.harvard.edu/century-scale-storage] | Decades durability + integrity + custodial succession as a mature discipline | Most direct prior art for the *whole thesis*; predates us. Targets static archives, institution-operated — our only twist is applying it to live AI memory |
| **AI-memory tamper-evidence research (MemTrust, "Right to History", MemArchitect)** — [arxiv.org/html/2601.07004v1] | Hash-chained + TEE-signed + Trillian-anchored tamper-evident AI memory | Confirms the concept is current research. *But* none address operator succession or multi-decade durability — our genuine remaining edge over the research frontier |

### 2b. Demand

**Strength: Moderate.**

**Segments.** Enterprise compliance/risk teams running AI agents in regulated sectors (the strongest near-term pull: 88% had AI-agent security incidents in the past year, only 21% have runtime visibility, 33% have no evidence-quality audit trail); regulated record-keepers (HIPAA/SOX/FFIEC/AML, already legally required to keep tamper-evident logs 6–10 years); family offices / digital-legacy (latent, weak willingness-to-pay for "verifiability" specifically); long-horizon/elder care; researchers (FAIR data — soft pull); privacy/sovereignty individuals + data-localization orgs (digital-vault ~$1B, data-sovereignty-cloud ~$29B in 2026).

**Drivers.** Regulatory compliance is the dominant, deadline-bearing force. "AI rewrote history" integrity anxiety (documented: AI-edited media implants false memories at 2.05×). Data sovereignty (GDPR fines >€1.2B in 2024). Cost is a driver *against* over-engineering — buyers want minimum defensible evidence, not maximal storage.

**Regulation (with citations).**

| Regulation | Relevance | Source |
|---|---|---|
| EU AI Act Art. 12 (record-keeping) & Art. 19 (auto logs) | High-risk systems must auto-record events over their lifetime for traceability | https://artificialintelligenceact.eu/article/12/ |
| EU AI Act Art. 26 + enforcement timeline | Deployers retain logs ≥6 months; provider docs 10 years; high-risk Aug 2, 2026 (Omnibus may defer some Annex III to Dec 2, 2027); penalties up to €15M / 3% turnover | https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/ |
| HIPAA audit-log retention (6 yrs, tamper-evident) | Covered entities must retain audit logs tamper-evident (WORM/hashing/signatures) | https://www.hipaajournal.com/hipaa-retention-requirements/ |
| SOX / PCAOB AS 1105 & AS 1215 | 2026 auditors expect "cryptographic hash or equivalent" integrity proofs | https://www.kognitos.com/blog/ai-audit-trail-requirements-2026-checklist/ |
| NIST AI RMF provenance + C2PA Content Credentials v2.0 | Tamper-evident, cryptographically signed provenance; hash-bound manifests | https://www.numonic.ai/blog/iptc-2025-c2pa-ai-provenance-metadata |
| RUFADAA | Executor authority over digital records (estates wedge) | https://www.ironcladfamily.com/blog/digital-inheritance-planning-how-to-protect-your-digital-legacy-in-2026 |

**Wedge.** **Enterprise AI-agent audit trail for regulated industries** — a tamper-evident, cryptographically-chained, append-only record of everything an agent observed, remembered, and did, queryable as compliance-grade evidence. It is the only segment with all three demand ingredients at once: a hard-deadline regulation (EU AI Act Art. 12/19; HIPAA; SOX), an acute quantified pain, and budgeted buyers shopping before the deadline.

### 2c. Design

**Loop stage strengthened: VERIFY.** Pure extension, no new subsystem.

The Remember stage already writes append-only JSONL with a per-log SHA-256 hash chain (`src/convergence/memory.py`: `prev_hash` + `entry_hash` + Lamport seq, plus verify-by-replay). `src/hff-api/cryptographic_proof.py` already ships Ed25519 sign/verify, a Merkle tree with inclusion proofs, and a hash-chained `AuditLog` with `verify_chain`. Today these are fragmented: the ledger chains but is never sealed or anchored; the HFF engine is isolated with no caller over real `data/` logs; `csf.MemoryRecord.verify()` has 0 callers; the doctrine is prose only. The Vault fuses them on top of the existing Memory object: (1) the ledger already chains on append; (2) a periodic **epoch seal** computes a Merkle root over the JSONL segment, signs it (Ed25519), appends a `SealRecord`; (3) each seal is **anchored to an external reference** (git commit, then RFC-3161 / CT-style log) so the disk-holder cannot rewrite history undetectably; (4) a **succession record** is a first-class dual-signed handoff. Every seal/verify is itself a ConvergenceRecord `[hypothesis=vault-unaltered, evidence=Merkle proof+signature, result, confidence, source]`.

**Honest positioning:** PARITY with a 2026 cluster (memory-vault, LeanCTX, Cathedral, Cortex-Persist, Letta git-backing). No public copy may say "category of one." The defensible edge is external anchoring + written migration doctrine + integration in a working loop.

#### Components

| Name | Path | Status |
|---|---|---|
| Convergence MemoryStore (hash-chained JSONL) — add `epoch_id` tagging + public `verify_full_chain()` | `src/convergence/memory.py` | extend |
| Cryptographic proof engine (Ed25519 + Merkle + AuditLog) — promote out of hff-api isolation | `src/hff-api/cryptographic_proof.py` | extend |
| Vault sealer — read segment, build Merkle, sign root, append `SealRecord`, capture git anchor | `src/vault/sealer.py` | **new** |
| Vault verifier — recompute roots, check sigs + seal chain + anchor, emit ConvergenceRecord + audit report | `src/vault/verifier.py` | **new** |
| Succession / handoff doctrine — operator key enrollment, dual-signed handoff, verify-lineage | `src/vault/succession.py` | **new** |
| 500-Year hardening + format-migration doctrine (epoch gates, attested handoffs, **threat model**, **external anchoring**) | `docs/VAULT-HARDENING-DOCTRINE.md` | **new** |
| `csf MemoryRecord.verify()` — call as per-leaf secondary check (closes 0-callers gap) | `src/csf/memory_engine.py` | extend |
| Vault REST surface — `/api/vault/{status,verify,seal,succession,proof/:id}` plain handlers | `routes/vault.js` | **new** |
| JS memory writer — chain-field parity with sealer expectations | `lib/csf-memory-writer.js` | extend |
| Vault status panel / proof viewer (declare `core:verify` in boundary registry) | `public/vault.html` | **new** |
| Vault test suite — tamper-evidence, seal-chain continuity, signature, succession round-trip | `tests/test_vault.py` | **new** |

**Data model.** Extends Memory, Task, Tool, ConvergenceRecord — no new top-level object. `SealRecord {epoch_id, merkle_root, signature, prev_seal_hash, git_anchor, ts}` is itself a ConvergenceRecord. `SuccessionRecord {outgoing_key, incoming_key, attested_root, attested_epoch, dual_signature}`. The convergence JSONL ledger is the **single sealed source of truth**; CSF/JS records are feeders, not independently sealed (avoids cross-language root mismatch). One canonical-JSON spec is locked in the doctrine doc.

#### Build sequence

| Step | Loop stage | Effort |
|---|---|---|
| Spike: `tests/test_vault.py` imports `cryptographic_proof` over a fixture JSONL ledger; prove a mutated record breaks the chain | Verify | low |
| Promote `cryptographic_proof.py` to a shared importable module (no behavior change) | Verify | low |
| Build `src/vault/sealer.py`; add `epoch_id` tagging to `memory.py` append; capture git commit anchor | Remember | medium |
| Build `src/vault/verifier.py`; emit grounded ConvergenceRecord + audit report; wire `csf MemoryRecord.verify()` as per-leaf check | Verify | medium |
| Write `docs/VAULT-HARDENING-DOCTRINE.md` (threat model + anchoring + migration); add KC card | Converge | low |
| Build `src/vault/succession.py` + `SuccessionRecord` ledger | Converge | medium |
| Expose `routes/vault.js` plain handlers (return truthy) | Act | medium |
| Build `public/vault.html` proof viewer + downloadable evidence bundle; verify by driving real UI | Verify | medium |
| Schedule periodic sealing in the live loop | Converge | medium |
| **External anchoring** — RFC-3161 timestamps / CT-style log / public git tag; benchmark verify cost in `docs/BENCHMARKS.md` | Verify | high |

#### Risks & mitigations

- **Novelty overclaim (Σ₀ violation).** Refuted "category of one." → Position as PARITY + execution edge; strip "ahead/category of one"; require a deep-research pass before any "ahead" claim ships.
- **Tamper-evident ≠ tamper-proof.** Operator controls the disk; `AuditLog` docstring admits this; key is unencrypted. → External anchoring (git → CT/RFC-3161); dual-sign handoffs; document the threat model honestly (who holds the key, what disk access can do, rotation/escrow across succession).
- **Fragmented checksum schemes** (`_integrity_hash` vs CSF canonical form vs JS `1.0` ≠ `1`). → One sealed source of truth, sealed/verified in Python over one canonical-JSON spec.
- **Scope creep** (Shamir/dead-man/TPM/BFT all tempting; `byzantine_consensus.py` exists). → Hard-gate to VERIFY-stage extensions: chain, seal, anchor, verify, succession-attest. Defer the rest explicitly.
- **Performance** as the ledger grows. → Epoch segmentation makes incremental verify O(new records); benchmark and record.

#### Milestones

- **M1 — Proof-on-real-data.** `cryptographic_proof.py` shared; `test_vault.py` green proving a mutated convergence record breaks the chain; `epoch_id` added. Tamper-evidence demonstrable on actual `data/` logs.
- **M2 — Sealer + verifier end-to-end.** Signed `SealRecord`s with git anchoring; verifier emits grounded ConvergenceRecords + CLI audit report; `csf MemoryRecord.verify()` has callers. One command → pass/fail integrity verdict.
- **M3 — Doctrine + succession.** Doctrine written + KC-carded (incl. threat model + anchoring); dual-signed handoff records.
- **M4 — Product surface.** `routes/vault.js` + `public/vault.html` live in dev preview; downloadable evidence bundle; `core:verify` declared; verified by driving the real UI on 4178.
- **M5 — Live-loop + regulated wedge.** Automatic periodic sealing; packaged EU-AI-Act/HIPAA/SOX audit-trail demo; **external CT-style anchor** + verify-cost benchmark in `docs/BENCHMARKS.md`.

---

## 3. Direction 2 — On-device hallucination detection (the groundedness canary)

**Thesis.** Ship the benchmarked surprise-leak signal (−log₂ p, AUROC ~0.76–0.81) as a real-time "confident-but-unanchored" flag running entirely on the user's machine via local PLT/Ollama logprob decode.

### 3a. Novelty — verdict after verification

**Original headline (REFUTED as written):** *"AHEAD of shipped products: cloud vendors structurally cannot expose raw token-logprobs as a user-owned safety dial; an uncopyable moat."*

**Corrected verdict: MIXED.** *Skeptics refuting "ahead-as-written": 2 of 3* (the third confirmed MIXED and could push it neither to ahead nor behind). The thesis splits cleanly:

- **The PRODUCT gap is real (genuine whitespace).** Adversarial search tried hard and found **no shipped consumer/local tool exposing reference-free per-token surprise as a user-owned canary.** The strongest near-miss, **HaluGate** (vLLM, Dec 2025, Rust/Candle, 76–162ms, on-device) is NLI faithfulness, *reference-dependent*, developer-facing, and explicitly cannot detect hallucination "without any tool call." Braintrust's 2026 roundup (Braintrust, Galileo, Arize Phoenix, Patronus, Promptfoo) is all cloud/dev observability. [confidence 0.75, https://www.braintrust.dev/articles/best-hallucination-detection-tools-2026]
- **The MOAT claim is FALSE as stated.** OpenAI exposes logprobs in Chat Completions *and* the Responses API (June 2025) and markets them for "reducing RAG Q&A hallucinations" [confidence 0.95, https://developers.openai.com/cookbook/examples/using_logprobs]; Google Gemini/Vertex exposes logprobs (GA mid-2025) and recommends avg-logprob as a grounding/confidence score [confidence 0.9, https://developers.googleblog.com/unlock-gemini-reasoning-with-logprobs-on-vertex-ai/]. "Structurally cannot" holds only for **Anthropic** (no logprobs, tied to its anti-distillation stance) and for **reasoning models** (o1/o3/GPT-5 suppress logprobs). The completeness critic confirms this independently — the "cloud structurally can't hand you logprobs" premise is factually wrong for at least two majors.
- **Signal-strength caveat confirmed.** Raw surprise AUROC ~0.76–0.81 is at/below predictive-entropy/perplexity baselines and below NLI/semantic-entropy methods; QuCo-RAG (2026) criticizes "ill-calibrated model-internal signals like logits and entropy." Position it as a **zero-latency first-line flag, not an oracle.**

**Reframe the moat** around **local-first + user-ownership + hidden-state access** (Semantic-Entropy Probes need hidden states only a local weight-holder has), **not** vendor inability. Anthropic-class users remain a clean "strictly ahead" segment.

**Completeness-critic correction we adopt:** the canary, as raw token surprise, **structurally cannot catch fluent-but-semantically-wrong output** — that is the established job of **semantic entropy** (Farquhar et al., *Nature* 2024, answer-clustering over meanings) and 2026 logprob-time-series methods (HALT, EPR). Either adopt a semantic-entropy/clustering second axis, or **scope the copy honestly to "degeneration/anchoring" and state it does NOT catch fluent factual hallucination.** Selling it as general "on-device hallucination detection" would be mis-selling.

#### Competitor gap table

| Competitor | What they ship | Gap vs us |
|---|---|---|
| **OpenAI logprobs** — [developers.openai.com/cookbook/examples/using_logprobs] | Logprobs in Chat Completions + Responses API; marketed for confidence/RAG | Refutes "structurally cannot." But raw dev API, server-side, no user dial; absent on reasoning models |
| **Anthropic (Claude)** — [github.com/anerli/anthropic-logprobs] | **No** logprobs at all (anti-distillation) | The one major where the moat genuinely holds — we are strictly ahead for Claude-class users |
| **Google Gemini/Vertex** — [developers.googleblog.com] | `responseLogprobs` (GA 2025); recommends avg-logprob as confidence | Refutes "structurally cannot." Cloud, dev param, no local-first ownership |
| **Cleanlab TLM** — [help.cleanlab.ai/tlm] | Hosted real-time `trustworthiness_score`; works without logprobs | Closest "confidence dial," but cloud-hosted, pay-per-token, black-box (no hidden states), not user-owned |
| **Semantic Entropy / SEP** — [arxiv.org/abs/2406.15927] | Cluster generations by NLI meaning; SEP approximates from a single generation's hidden states | Stronger signal; SEP is single-pass + on-device-feasible but **needs hidden states** → reinforces our local-first thesis. We should adopt it locally |
| **SelfCheckGPT** — [aclanthology.org/2023.emnlp-main.557] | Multi-sample self-consistency, no logprobs | Works on black-box but N extra generations (latency/cost); detects inconsistency, not calibrated surprise |
| **Patronus Lynx 8B/70B** — [huggingface.co/PatronusAI/...Lynx-8B] | Open-weight RAG-faithfulness judge; on-device-capable | A real on-device detector — but reference-based NLI judge (needs source doc), heavy, not a per-token surprise dial |
| **Vectara HHEM-Open** — [huggingface.co/vectara/hallucination_evaluation_model] | Open-weight factual-consistency cross-encoder | Needs a reference; evaluator model, not a live free-form confidence dial |
| **NeMo Guardrails / Guardrails AI** — [docs.nvidia.com/nemo/guardrails] | Self-hostable self-check rails, AlignScore, Lynx | Self-hostable so "local" isn't unique; but dev-config policy engines, extra LLM calls, not a per-token surprise flag |
| **Conformal abstention / TECP** — [arxiv.org/pdf/2405.01563] | Token-entropy nonconformity → calibrated abstention with coverage guarantees | The calibration layer our raw AUROC *lacks*; we are methodologically behind — adopt split-conformal |
| **Perplexity AI** — [suprmind.ai/hub/perplexity] | Citations as grounding | External grounding, not intrinsic; ~37% citation hallucination (CJR); cloud — complementary |

### 3b. Demand

**Strength: Moderate.**

**Segments.** Developers running local/self-hosted coding agents (Ollama + Cline/OpenCode/ADK) — the beachhead; regulated on-prem/air-gapped teams (legal, healthcare, finance); privacy/sovereignty enterprises; GPAI/high-risk EU providers needing Art. 14/15 uncertainty-surfacing; guardrail vendors needing an edge-deployable detector tier.

**Drivers.** Agent reliability (the #1 production blocker; vendors ship sub-200ms inline guardrails; Gartner: 40% of enterprise apps include task-specific agents by end of 2026). Privacy/data-sovereignty (a detector that *also* runs locally preserves the air-gap a cloud judge-API would break). Cost/latency (lightweight residual+logprob probes read risk "orders of magnitude cheaper than token generation"). Regulation/liability. **Calibration framing**: NIST reframes hallucination as "confidently stated but erroneous content" and asks orgs to measure the rate of confidently-wrong outputs and surface uncertainty — nearly a verbatim spec for this canary.

**Regulation (with citations).**

| Regulation | Relevance | Source |
|---|---|---|
| EU AI Act Art. 15 (accuracy/robustness) | Mandates documented accuracy + resilience; runtime canary is a *means*, not a literal requirement; Annex III delayed to Dec 2, 2027 | https://artificialintelligenceact.eu/article/15/ |
| EU AI Act Art. 14 (human oversight) | A real-time unanchored flag tells the human *when* to intervene | https://artificialintelligenceact.eu/article/14/ |
| EU AI Act GPAI obligations + Code of Practice | In force since Aug 2, 2025; relevant to providers more than local-agent end-users | https://artificialintelligenceact.eu/code-of-practice-overview/ |
| NIST AI RMF GenAI Profile (AI 600-1) | **Strongest conceptual match**: confabulation = "confidently stated but erroneous"; measure rate of confidently-wrong outputs, surface uncertainty | https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence |
| US legal Model Rules 3.3/1.1 + sanctions trend | 1,313+ AI-fabrication cases (Apr 2026); 87 sanctions in 2025; direct on-prem legal-research pull | https://www.nexlaw.ai/blog/ai-hallucination-sanctions-2026/ |
| Fed/OCC/FDIC MRM (SR 11-7 rescinded Apr 2026 → principles-based) | Applied by analogy to LLM copilots; indirect financial-services pull | https://www.occ.gov/news-issuances/bulletins/2026/bulletin-2026-13.html |

**Wedge.** **Local AI coding-agent developers (Ollama/Cline/OpenCode).** Already on on-device models, feel tool-call/file-content hallucination acutely, gate autonomy on "trust," no procurement cycle, and a real-time flag is the cheapest way to let the agent act with less babysitting at ~zero added latency. Then expand to on-prem legal research (highest WTP, citation-fabrication sanctions).

### 3c. Design

**Loop stage strengthened: VERIFY.** It adds the one signal the existing canary is blind to: *was the model internally uncertain about the specific tokens it asserted so fluently?*

The plumbing is already built and dormant. `groundedness-canary.js` scores the "42-state" (assertive × unanchored) from text alone; it accepts an optional `tokenSurprise` arg that **RAISE-ONLY** sharpens risk inside the unanchored corner, and an absent signal leaves scores byte-identical (graceful no-op for cloud/Anthropic). `canary.js::runCanaries` forwards `tokenSurprise`. **The only missing wire is at `stream-chat.js:1213`**, where `runCanaries` is called *without* `tokenSurprise`, so `modelUncertainty` is permanently 0. The design closes that gap end-to-end: (1) the local Ollama decode path requests logprobs and returns a per-token `bits` field; (2) `token-surprise.js` is recalibrated (the `tailMass` field is **degenerate ~0.50 chance** per the AB harness — separation lives in mean/p90 bits + split-conformal); (3) `stream-chat.js` passes the captured surprise into `runCanaries`, opening the valve; (4) the existing UI badges render the now-live signal.

#### Components

| Name | Path | Status |
|---|---|---|
| `token-surprise.js` — fix degenerate `tailMass`; re-weight to mean/p90 + split-conformal calibration | `lib/token-surprise.js` | extend |
| `groundedness-canary.js` — already consumes `tokenSurprise` RAISE-ONLY; verify `SURPRISE_ALPHA` vs new scale | `lib/groundedness-canary.js` | existing |
| `canary.js runCanaries` — add `surpriseField` to recorded event | `lib/canary.js` | extend |
| dream-chat.js local decode — request + capture per-token logprobs at the Ollama `/api/chat` calls; return `reply.surprise` | `lib/dream-chat.js` | extend (**highest-value wire**) |
| `serving-modes.js` — add logprobs request flags to Ollama (+ OpenAI non-reasoning) decode options | `lib/serving-modes.js` | extend |
| **stream-chat.js:1213** — pass `tokenSurprise` into `runCanaries` (the line that opens the valve) | `lib/stream-chat.js` | extend |
| dream-chat-ui.js grounding badge — render live `modelUncertainty` as a user-owned dial, labeled "first-line flag" | `public/js/dream-chat-ui.js` | extend |
| `surprise_leak_ab.py` — promote from worktree to mainline; per-model AUROC harness | `experiments/surprise_leak_ab.py` | extend |
| Surprise calibration store + fit (append-only `{field,label}` rows + fitted thresholds JSON) | `data/convergence/surprise-calibration.jsonl` | **new** |
| BENCHMARKS entry — register surprise-leak Layer-1 (AUROC, coverage) | `docs/BENCHMARKS.md` | extend |

**Data model.** Extends Tool output, ConvergenceRecord, canary-events — no new store. Reply object gains optional `surprise = { perToken?, field: {nTokens, meanBits, p90Bits, maxBits, tailMass, calibratedUncertainty} }` — only the compact `field` is logged; raw per-token bits stay in-memory (privacy + size). `sigma0_grounding` gains non-zero `modelUncertainty` + `surpriseField`. `canary-events.jsonl` `grounded.signals.modelUncertainty` starts carrying real values (`source="local-logprobs"`). NEW append-only `surprise-calibration.jsonl` feeds a periodic split-conformal fit (Memory reused, not a new system).

#### Build sequence

| Step | Loop stage | Effort |
|---|---|---|
| **Run the AB harness for real** (promote + 200-item run on local Ollama qwen2.5/ouro AND OpenAI non-reasoning); confirm mean/p90 separate while `tailMass` is degenerate. **Kill-switch gate** — if perplexity is ~chance, stop | Verify | low |
| Recalibrate `token-surprise.js` away from `tailMass` → mean/p90 + split-conformal; unit-test parity vs Python | Verify | medium |
| Add logprobs flags to `serving-modes.js`; capture per-token logprobs in dream-chat.js decode; return `reply.surprise` | Act | high |
| Thread surprise to `stream-chat.js:1213`; pass into `runCanaries` — **open the valve**; confirm non-zero on local, byte-identical (0) on Anthropic | Verify | medium |
| Surface the live dial in `dream-chat-ui.js` with honest "first-line flag, not an oracle" copy; drive through real UI | Converge | medium |
| Wire calibration store via file-queue + periodic split-conformal fit; log each event as ConvergenceRecord evidence | Remember | medium |
| Register in `docs/BENCHMARKS.md`; regression test that valve is a graceful no-op when logprobs absent | Converge | low |
| **STRETCH** (only if signal underperforms): local single-pass Semantic-Entropy Probe on hidden states as a stronger second signal feeding the same `modelUncertainty`; flag-gated, non-blocking | Verify | high |

#### Risks & mitigations

- **Headline moat refuted.** → Reframe defensibility as local-first + ownership + zero-latency + optional hidden-state (SEP); market the *product whitespace*, not vendor inability; Anthropic-class users stay "strictly ahead."
- **Signal strength.** AUROC ~0.76–0.81 is at/below NLI/semantic-entropy. → Ship as zero-latency first-line flag; split-conformal calibration for coverage; honest UI copy; keep NLI/reference path as a complementary future axis.
- **`tailMass` degenerate (~chance).** → M1 gate measures mean/p90 directly; recalibrate before opening the valve anywhere; do not ship the field as-is.
- **Ollama logprob availability/format drift; reasoning models suppress logprobs.** → `fromOllamaLogprobs/fromOpenAILogprobs` treat absent signals as graceful no-op; gate per-model via BENCHMARKS; never assume logprobs present.
- **Scope creep into a "separate hallucination engine."** → Every component is an EXTEND of a Verify-stage module; only new artifact is an append-only calibration JSONL reusing file-queue. SEP stays a flag-gated optional input.
- **Privacy/log bloat.** → Persist only the compact `surpriseField`; drop raw per-token bits before write; storage runtime-local.

#### Milestones

- **M1 — Evidence gate.** `surprise_leak_ab.py` run on real local + OpenAI logprobs; per-model AUROC in BENCHMARKS; go/no-go on which models open the valve; recalibration spec'd from measured numbers.
- **M2 — Valve open end-to-end (dev).** Logprobs captured; recalibrated uncertainty plumbed through `stream-chat.js`; `modelUncertainty` non-zero on local, no-op on Anthropic; canary tests green.
- **M3 — User-facing dial.** Calibrated confident-but-unanchored flag shown as a user-owned indicator, verified through the real chat UI on 4178; honest framing copy; calibration store appending.
- **M4 — Calibration + convergence loop.** Split-conformal fit running; coverage tracked; each event logged as ConvergenceRecord evidence; first precision/recall read; ship v1 to master.
- **M5–6 — Beachhead + (optional) stronger signal.** Package for the local-AI-coding-agent wedge; if raw surprise underperforms, prototype the local SEP hidden-state probe as a flag-gated second signal.

---

## 4. Direction 3 — BetterSafe: verifiable, local-first AI for social services / high-stakes care

**Thesis.** Wrap HFF's BetterSafe schema + local-first architecture in the cite-or-abstain loop so every recommendation carries `[claim, evidence, confidence, source]` and **ABSTAINS rather than guessing** on a vulnerable person's case.

### 4a. Novelty — verdict after verification

**Original headline (REFUTED):** *"AHEAD: the regulated wedge — EU AI Act / high-risk rules demand exactly this auditability + human oversight NOW; incumbents ship confident black boxes."*

**Corrected verdict: MIXED.** *Skeptics refuting "ahead": 3 of 3.* Two load-bearing pillars failed:

1. **Timing.** The EU Digital Omnibus (provisional, May 7, 2026) defers Annex III high-risk obligations from Aug 2, 2026 to **Dec 2, 2027** (~16 months). Aug 2026 keeps only Art. 50 transparency + GPAI. There is no imminent "demands exactly this NOW" hammer for social-services AI. [confidence 0.85, https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/]
2. **"Incumbents ship confident black boxes" is too absolute.** Salesforce Einstein Trust Layer already ships grounding + citations + data lineage + audit trails (parity on auditability), and explicitly evaluates **abstention** as a first-class trait "for trust-sensitive applications such as legal, financial, and healthcare domains." Cohere North ships grounded agentic AI on on-prem/air-gapped infra for govt/healthcare. **Each of the three claimed moat axes (abstain, per-decision evidence, local-first) is individually covered by a shipped incumbent.** Cite-or-abstain is even *deployed in production*: AVA (World Bank, arXiv 2604.17843) ran a 5-month deployment across 116 countries with mandatory source attribution + reasoned abstention. Per-decision evidence-to-legal-rule for benefits casework exists as a published artifact: the CalFresh/SNAP neuro-symbolic framework (arXiv 2512.12109) stores each rule with `"citation": "MPP 63-409.111"` and uses an SMT solver returning UNSAT to flag legally-unjustifiable explanations.

**What survives (narrow edge):** No single *shipped* product packages **all** of (a) cite-OR-ABSTAIN as default, (b) per-decision `[claim, evidence, confidence, source]`, AND (c) local-first/on-prem sovereignty, *specifically for vulnerable-person casework with consent-gated, signed determinations*. We are genuinely AHEAD of the **legacy black-box class** — TennCare Connect (Deloitte, ~$400M) was ruled (Aug 2024) to have illegally denied thousands via wrong, unexplained determinations. [confidence 0.93, https://gizmodo.com/judge-rules-400-million-algorithmic-system-illegally-denied-thousands-of-peoples-medicaid-benefits-2000492529]

**Completeness-critic corrections we adopt:**
- **The determination engine is a demo, not nearly-there.** `social_services.py._score_match` is a fuzzy heuristic (`match_score >= 2`) with no rule citations, no per-rule `{met|null}`, no evidence trail. The **legal-grade evaluator does not yet exist in any form.** Copy must say so.
- **Missing the legally load-bearing human path.** SB24-205 / EU AI Act Art. 22-style rules require a **human-in-the-loop appeal/override** on consequential decisions. Abstain is necessary but not sufficient — we need a human-review/appeal workflow, an impact-assessment artifact generator, and an adverse-action-notice path. The first step optimizes the automated path and skips this.
- **Map to named US-actionable obligations**, not generic "EU AI Act": **Colorado SB24-205** (covers essential government services), NIST AI RMF / ISO 42001 (compliance = rebuttable presumption of reasonable care — the actual affirmative defense), mandatory impact assessments + pre-adverse-action notice + right to human review.
- **Name the govtech incumbents** the thesis gestures at: Deloitte/Accenture state-benefits systems, Gainwell, Code for America (GetCalFresh), mRelief.

#### Competitor gap table

| Competitor | What they ship | Gap vs us |
|---|---|---|
| **EU AI Act Annex III + Arts. 12/13/14** — [artificialintelligenceact.eu/annex/3] | Eligibility-for-benefits AI = high-risk; logging + interpretability + override | Tailwind that *validates* the loop, but deferred to Dec 2027 → we are aligned-with, not ahead-of |
| **Salesforce Einstein Trust Layer** — [salesforce.com/.../trusted-ai] | Grounding + citations + lineage + audit; abstention as a first-class trust trait for healthcare | Strongest refutation of "black boxes." Cloud/Data-Cloud-bound; no hard cite-OR-abstain *default*; not local-first |
| **Deloitte TennCare/GovConnect** — [gizmodo.com] | $400M eligibility engines | The confident black box we *are* ahead of: judge-found wrong/unexplained denials, no abstention |
| **Tire Swing (YC W25)** — [ycombinator.com/companies/tire-swing] | AI affordable-housing eligibility/recert | Closest vertical; automation play, no public cite-or-abstain or local-first; but has real traction |
| **AVA (World Bank)** — [arxiv.org/abs/2604.17843] | Deployed multi-agent assistant w/ mandatory attribution + reasoned abstention (Coverage+Agreement gate) | Cite-or-abstain is *shipped in production* — refutes "our moat" |
| **CalFresh/SNAP neuro-symbolic** — [arxiv.org/html/2512.12109] | Per-rule citation metadata + SMT UNSAT flag for legally-unjustifiable explanations | Hits (a)+(b) in our exact vertical. Research-only, deterministic, not local-first |
| **Auditable clinical-RAG framework** — [pmc.ncbi.nlm.nih.gov/articles/PMC12913532] | RAG + provenance + GRADE + confidence + Hyperledger | No prototype; cloud/ledger; uses *warnings*, not hard abstention |
| **Cohere North** — [cohere.com/private-deployments] | Grounded agentic AI, on-prem/air-gapped (as few as 2 GPUs), govt/healthcare | Local-first sovereignty is table stakes, not uncovered |
| **NIST AI RMF** — [nist.gov/itl/ai-risk-management-framework] | Voluntary trustworthy-AI framework | A standard, not a competitor; conformance strengthens the wedge story |
| **Govtech incumbents (Deloitte/Accenture, Gainwell, Code for America, mRelief)** | State-benefits systems / navigation tools | Mostly automation/navigation; none combine abstain-default + per-decision evidence + local-first |

### 4b. Demand

**Strength: Strong** (because of one binding-NOW regulation, not the deferred EU hammer).

**Segments.** US behavioral-health / SUD treatment providers (bound by 42 CFR Part 2, compliance due **Feb 16, 2026**); HIPAA-covered provider orgs (HIPAA named the single biggest blocker to production AI; on-prem/air-gapped is a recognized compliant pattern); EU/national public-sector benefits/healthcare-eligibility bodies (Annex III 5(a) + Art. 27 FRIA; fines up to €15M / 3%); sovereignty-driven European public sector (EU sovereign-AI infra ~$5.1B in 2025; €180M sovereign-cloud framework; French state "Albert"); US state/local agencies (Texas HB 149 eff. Jan 1, 2026; Colorado SB 26-189 ADMT eff. Jan 1, 2027); nonprofit human-services (82% use AI, 70% privacy-worried, but sub-$500K budgets → strong need, weak ability to pay).

**Drivers.** Privacy/data-residency is the binding driver *today* (HIPAA BAA; 42 CFR Part 2 segmentation + consent-gating; GDPR). Agent reliability/verifiability is a quantified barrier (~32% cite quality as the #1 production barrier; buyers demand "audit-ready" AI that cites the exact source line + human review). Sovereignty/vendor independence (funded EU procurement). **Cost is a contra-driver outside compliance-forced segments** — cloud AI is $50–200/mo vs $2k–10k/mo self-hosted GPU — so local-first wins only where compliance overrides price.

**Regulation (with citations).**

| Regulation | Relevance | Source |
|---|---|---|
| EU AI Act Annex III 5(a) | Names benefit/healthcare eligibility as high-risk; **deferred to Dec 2, 2027** | https://artificialintelligenceact.eu/annex/3/ |
| EU AI Act Art. 27 (FRIA) | Pre-deployment fundamental-rights assessment; notify market surveillance; fines up to €15M/3% | https://artificialintelligenceact.eu/article/27/ |
| EU Digital Omnibus delay | Annex III deferred Dec 2, 2027; transparency still Aug 2026 | https://www.consilium.europa.eu/en/press/press-releases/2026/05/07/... |
| HIPAA + BAA for PHI | Binding today; HIPAA is the biggest blocker to production healthcare AI | https://www.techaheadcorp.com/blog/hipaa-compliant-ai-architecture/ |
| **42 CFR Part 2 (compliance due Feb 16, 2026)** | **Strongest near-term forcing function**: SUD-record segmentation + valid-consent verification before AI processing; cloud AI structurally cannot meet it | https://www.hhs.gov/hipaa/for-professionals/regulatory-initiatives/fact-sheet-42-cfr-part-2-final-rule/index.html |
| NIST AI RMF + GenAI Profile | De facto US standard; conformance = rebuttable presumption of reasonable care | https://www.nist.gov/itl/ai-risk-management-framework |
| Colorado SB24-205 / Texas HB 149 | Consequential-decision coverage incl. essential government services | https://www.multistate.ai/artificial-intelligence-ai-legislation |
| GDPR + EU Data Act / sovereign cloud | Every external-LLM call with personal data is a regulated transfer; on-prem = strongest posture | https://www.orrick.com/en/Insights/2026/01/Data-Localization-and-the-Sovereign-Cloud... |

**Wedge.** **US SUD / behavioral-health providers.** The single sharpest beachhead because 42 CFR Part 2 (binding Feb 2026) legally mandates record segmentation + consent verification + re-disclosure controls — requirements general cloud LLMs structurally cannot satisfy — making "verifiable + local-first" a compliance *necessity*, not a preference. It combines (1) a today-binding regulation, (2) genuine ability to pay, (3) acute OCR-enforcement exposure, and (4) demand for exactly our differentiators. Then expand to broader HIPAA healthcare, then EU public-sector as Annex III lands in Dec 2027.

### 4c. Design

**Loop stage strengthened: VERIFY.** Pure extension — no new memory system, no new agent ecosystem.

The chat verify pass (`dream-chat.js verifyResponse`) already extracts claims, grounds each into a `[claim, evidence, confidence, source]` record in `data/convergence/records.jsonl` (`lib/convergence-records.js`, schema-locked to `src/convergence/objects.py::ConvergenceRecord`), then `lib/claim-draft.js::draftClaimsFromRecords` bridges packet-worthy records into the consent-gate (`lib/consent-gate.js`): a validated `lantern.claim_packet.v1` in `draft` status, inert until a human operator approves, at which point it is ed25519-signed and immutable. That is already cite-or-abstain + per-claim confidence + human override + cryptographic audit (the Art. 12/14 bundle) — but it only fires on free-text chat and does no domain reasoning about benefits rules.

The BetterSafe loop: **Observe** = intake profile + local `social_services_registry`. **Remember** = registry + each rule's authoritative citation (e.g. "MPP 63-409.111", "42 CFR Part 2") as the evidence corpus. **Reason** = a deterministic per-rule evaluator (extends `_score_match`) attaching the rule's citation. **Verify** (load-bearing) = a hard data/consent floor → `abstain` instead of a verdict + `groundedness-canary` scoring; an uncited recommendation is ungrounded → downgraded to abstain. **Act** = emit one ConvergenceRecord per determination, draft a claim packet for caseworker review/sign. **Converge** = the signed packet log is the FRIA/Art. 12 trail; abstention + override rates are the metrics.

**Honest positioning:** MIXED/parity-leaning. We are AHEAD only of the legacy black-box class. **Abstain defaults to "route to human caseworker," never to "deny."**

#### Components

| Name | Path | Status |
|---|---|---|
| SocialServicesEligibility — `_score_match` → deterministic per-rule `{met:bool|null, rule_citation, evidence_used, data_present}` | `apps/bettersafe/modules/social_services.py` | extend |
| `bettersafe_db` registry — non-null `citation` per rule + consent/Part-2 segmentation flag | `apps/bettersafe/bettersafe_db.py` | extend |
| `casework_verify` — abstention gate (hard data/consent floor → `abstain`; cap confidence; emit `[claim,evidence,confidence,source]`) | `apps/bettersafe/modules/casework_verify.py` | **new** |
| ConvergenceRecord emitter (schema-locked, cross-language) | `lib/convergence-records.js` | existing |
| Claim-packet bridge — generalize hardcoded chat fields to parameters | `lib/claim-draft.js` | extend |
| Consent gate (ed25519 sign/approve/immutable) | `lib/consent-gate.js` | existing |
| Groundedness canary — uncited recommendation → forced abstain | `lib/groundedness-canary.js` | existing |
| Claims API + review queue — add a determination filter | `routes/claims.js` | extend |
| Council exec-verify — re-run rule evaluator as `execVerdict`; non-reproducible → refuted | `lib/council-review.js` | extend |
| BetterSafe casework UI — intake → per-rule grid with prominent ABSTAIN; declare `extension(verify)` | `apps/bettersafe/index.html` | extend |
| Casework HTTP route — `/api/bettersafe/screen` plain handler | `routes/bettersafe.js` | **new** |
| Authoritative rule corpus — require per-rule citation + Part-2/consent marker; seed SUD rules | `apps/bettersafe/README.md` (social-services registry section) | extend |
| **(critic add) Human-review/appeal workflow + impact-assessment artifact + adverse-action-notice path** | *(to be specified)* | **new — currently missing** |

**Data model.** Four core objects by extension. **Memory:** `social_services_registry` becomes the rule/evidence corpus; each rule gains a REQUIRED `rule_citation` + `authority_source` (a rule with no citation is *not usable evidence* — this makes cite-or-abstain structural). Intake rows gain `consent_verified`, `part2_segmented`. **Task:** one screening = existing `Task` object. **Tool:** the rule evaluator is a Tool; each evaluation = `ToolResult {outcome: met|not_met|insufficient}`. **ConvergenceRecord (spine):** one per determination — `hypothesis` = the eligibility claim, `evidence_ids` = registry rule ids, `result` = determination (**`abstain` is a first-class result value** with `source: insufficient_data|unverified_consent|no_authoritative_rule`), `confidence` capped ≤0.85, `source` = the authoritative citation. **Claim packet (audit artifact):** each non-abstain determination drafts `lantern.claim_packet.v1` in draft; caseworker approval ed25519-signs it → the FRIA/Art. 12-14 record. Abstentions are logged but never drafted as approvable recommendations.

#### Build sequence

| Step | Loop stage | Effort |
|---|---|---|
| Spike: registry `rule_citation` + `_score_match` → per-rule `{met|null, rule_citation, evidence_used}`; prove one determination flows registry→evaluator | Reason | medium |
| Write `casework_verify.py` (hard floor → `abstain`; cap ≤0.85; emit tuple); unit-test the abstain boundary | Verify | high |
| Each determination emits a ConvergenceRecord (abstain first-class); add Python writer matching the schema | Converge | medium |
| Generalize `claim-draft.js buildDraftPacket`; confirm it validates through `consent-gate` as draft | Act | medium |
| `routes/bettersafe.js` `/api/bettersafe/screen`: intake → evaluator → verify → record → draft packet → return grid; run canary | Verify | medium |
| Wire `council-review.js execVerdict` to a re-run of the evaluator; non-reproducible → refuted | Verify | low |
| **Caseworker review surface + human-override/appeal** (the legally load-bearing path the critic flagged) | Act | high |
| Seed SUD/behavioral-health corpus with real 42 CFR Part 2 + state citations + consent flags | Remember | medium |
| Convergence metrics: abstention rate, override rate, % with authoritative citation | Converge | low |
| Package signed packet log as exportable Art. 12/FRIA bundle; pilot with one provider's anonymized intake | Verify | medium |

#### Risks & mitigations

- **Novelty is MIXED, not AHEAD** (abstention, per-decision evidence, local-first each shipped by incumbents). → Position as an execution *bundle*; lead with the legacy black-box class we beat + the 42 CFR Part 2 forcing function, not novelty.
- **Regulatory timing softened** (EU Annex III → Dec 2027). → Anchor the beachhead on 42 CFR Part 2 + HIPAA (binding now); treat EU AI Act as a 2027 expansion lane.
- **Wrong abstention calibration causes real harm** (too-eager = denial of service; too-loose = the TennCare failure). → Abstain = "route to human," never "deny"; abstention can never *terminate* a benefit; tune from real override feedback; confidence hard-capped (health-journal `MIN_N` discipline).
- **Rule corpus accuracy/freshness** — a mis-cited rule makes a wrong answer look *more* trustworthy. → Require `authority_source` + `last_updated`; abstain on stale rules; never auto-scrape into the live evidence path without operator sign-off.
- **Missing human-appeal path is itself a compliance gap.** → Build the human-review/appeal + impact-assessment + adverse-action-notice path explicitly; do not ship abstain-only as "compliant."
- **Scope creep into the dormant tkinter home-automation app** (fridge/appliances/meals). → Build ONLY the casework/eligibility verify path on the web serving surface; leave tkinter modules dormant.

#### Milestones

- **M1 — Cited rule evaluator + abstention floor.** Per-rule `{met|abstain}` with required citation; `casework_verify.py` abstains below the data/consent floor; unit tests pin the boundary; missing inputs → ABSTAIN grid.
- **M2 — Full verify-loop wiring.** Schema-locked ConvergenceRecord + inert draft packet via consent-gate; canary forces abstain on any uncited recommendation; a confident-but-uncited claim is auto-downgraded.
- **M3 — Caseworker review surface + human override.** `/api/bettersafe/screen` serves the grid; approval ed25519-signs an immutable packet (Art. 12 record) or returns it; council exec-verify catches non-reproducible determinations.
- **M4 — SUD/behavioral-health beachhead.** Real 42 CFR Part 2 + state corpus; consent-unverified cases correctly abstain — the binding-NOW wedge.
- **M5 — Convergence metrics + FRIA audit export.** Abstention/override/citation-coverage metrics live; signed packet log exports as a tamper-evident Art. 12/FRIA bundle; pilot on anonymized data.

---

## 5. Direction 4 — Self-improving autonomous coding that proves its own work

**Thesis.** The autowork loop (issue→research→plan→patch→test→draft-PR→council exec-verify) already grounds verdicts on real test runs. Frontier step: measurable self-improvement against an external benchmark (SWE-bench harness).

### 5a. Novelty — verdict after verification

**Original headline (REFUTED):** *"PARITY-to-slightly-behind Devin/SWE-agent on raw capability, but AHEAD on verification-trail-per-change."*

**Corrected verdict: MIXED** — and on the capability leg, **currently behind, not parity.** *Skeptics refuting the headline: 2 of 3* (the third confirmed MIXED outright; `verify.survives = false`).

- **Capability leg — UNSUBSTANTIATED, not parity.** Our own `docs/BENCHMARKS.md` (line 37) lists SWE-bench Lite as 🟡 Partial; the only measured number is **Qwen single-shot 0/3** (2 applied-but-wrong); the agentic loop "landed" with **no measured resolved%**; SWE-bench Verified is 📋 Planned. Devin 2.0 measures ~45.8% Verified; the public board runs 77–95% (with contamination caveats); mini-swe-agent (~100 lines) >74%. **You cannot claim parity on a mark you have never measured.** [confidence 0.97 internal; 0.82 Devin, https://cognition.com/blog/devin-2]
- **Provenance leg — at parity-at-best, not ahead.** Verification trails are table stakes: Google Jules attaches test+lint output to every PR; Devin 2.2 self-verifies via computer-use with screen recordings and "logs every action for audit"; OpenHands records all actions/observations as immutable, deterministically-replayable events; SWE-agent ships trajectory logs + Docker grading. On the *exact* axis we lean on, the field is **ahead**: OpenFang/Hermes ship SHA-256 Merkle hash-chained tamper-evident logs, while **our `data/convergence/records.jsonl` is plain mutable JSONL (grep `prev_hash|merkle|sha256` = 0 hits)**; `src/convergence/objects.py::ConvergenceRecord.to_jsonl()` (lines 183–199) emits plain JSON with no chain/signature. [confidence 0.85, https://github.com/NousResearch/hermes-agent/issues/487]
- **The "frontier step" is already published.** The Darwin Gödel Machine recursively self-improves a coding agent on SWE-bench (20%→50%) [confidence 0.9, https://arxiv.org/abs/2505.22954]; Absolute Zero / RLVR use execution-pass as verifiable reward.
- **Strategy is sound, though.** Raw SWE-bench Verified is increasingly discredited — OpenAI stopped reporting it (Feb 2026) over contamination; Rollout Cards shows reporting-rule changes alone swing scores 20.9pp. Leaning on provenance is the right bet — **but it is not yet won.**

**Completeness-critic corrections we adopt:**
- **Drop "parity" from external copy** until `leaderboard.jsonl` has a real resolved% row. The honest framing is "far behind on capability, betting on provenance."
- **Provenance has incumbents we omitted:** GitHub/CI attestations + SLSA provenance, Sigstore/cosign artifact signing, reproducible-build verification — all already give "a cryptographically verifiable trail per change." We must show why a hash-chained ConvergenceRecord *composes with* SLSA/Sigstore, or the moat is asserted.
- **The abstention valve is installed-but-unspent:** `groundedness-canary.js` fires only when `opts.tokenSurprise != null`, and the live `runCanaries()` at `stream-chat.js:1199` passes no surprise — only test files do. The `SURPRISE_ALPHA` axis is never fed in production. (Same wire as Direction 2.)

#### Competitor gap table

| Competitor | What they ship | Gap vs us |
|---|---|---|
| **Devin (Cognition)** — [cognition.com/blog/devin-2] | ~45.8% Verified; computer-use self-verification w/ screen recordings; logs every action | Richer productized trail + a measured score we lack. We are behind on score, parity-at-best on trail richness |
| **Google Jules** — [jules.google] | Runs test+lint before PR; attaches test output | Ships "prove-the-work-in-the-PR" at scale today. We are not ahead here |
| **OpenHands** — [arxiv.org/abs/2407.16741] | Immutable event log, deterministic replay; 15+ benchmark harness w/ Docker grading | Stronger reproducibility than our plain JSONL; more mature harness. Lacks our explicit abstention gate + `[claim,evidence,confidence,source]` schema |
| **SWE-agent / SWE-bench (Princeton)** — [github.com/swe-agent/swe-agent] | Reference agent + benchmark; trajectory logs + Docker execution grading | Defines the discipline we treated as novel; has measured resolved% we lack |
| **OpenAI Codex / Claude Code** — [code.claude.com/docs] | "Writer ≠ grader"; evidence-in-transcript verification; Spotify Honk merges 1,500+ PRs | Our council exec-verify pattern, generalized + in production. Our distinct piece is the *durable schema-locked cross-language record* |
| **DGM / Absolute Zero / RLVR** — [arxiv.org/abs/2505.22954] | Measurable self-improvement on SWE-bench (20%→50%) | This *is* the thesis's "frontier step," already demonstrated. We are behind on a measured delta |
| **OpenFang / Hermes / SLSA / in-toto / Sigstore / Rollout Cards** — [arxiv.org/html/2605.12131v1] | SHA-256 Merkle hash-chained logs; signed code-provenance attestation; per-run reproducibility | Most direct refutation of "ahead on provenance." We do NOT hash-chain or sign — must add it to make any provenance claim credible |

### 5b. Demand

**Strength: Strong.**

**Segments.** Engineering/platform teams at regulated financial institutions (SR 11-7, EU AI Act Art. 14, MAS FEAT; **BFSI = 27% of the AI-agent audit market in 2026**); enterprise AI-governance owners (60% of large enterprises in production; budget stalls where they can run an agent but can't show the audit trail); DevSecOps / supply-chain security teams (SLSA/in-toto, signed provenance for agent code); healthcare/life-sciences software vendors (FDA SDLC docs); public-sector / govt contractors (NIST AI RMF-referencing RFPs).

**Drivers.** Agent-reliability/trust gap (~2/3 name security/risk as the #1 blocker; "can't tell outputs that look right from outputs that are actually right"). Regulatory forcing function (per-stage evidence artifacts). **Auditability as a budget unlock** ("most enterprises can stand up an agent… far fewer can show the audit trail — this gap is where 2026 budgets stall"). Supply-chain provenance. Independent-assurance economics ($0.6B in 2026 → $23B in 2036, 44% CAGR). Risk of cancellation (Gartner: >40% of agentic projects canceled by 2027 over unclear value/risk controls).

**Regulation (with citations).**

| Regulation | Relevance | Source |
|---|---|---|
| EU AI Act high-risk (Art. 12/14 + tech docs + post-market) | Forces the verification trail; Annex III deadline in flux (Omnibus → Dec 2, 2027); treat Aug 2026 as operative until adoption | https://artificialintelligenceact.eu/implementation-timeline/ |
| Fed SR 11-7 / OCC 2011-12 (MRM) | **Strongest near-term US forcing function**; LLMs = "models" requiring independent validation, model cards, monitoring — exactly the per-stage evidence we auto-generate; no deferral | https://www.the-algo.com/insights/ai-governance-financial-services-sr1107 |
| NIST AI RMF + GenAI Profile | MEASURE/MANAGE require continuous eval + documented provenance; referenced in 2026 RFPs | https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence |
| MAS FEAT / Bank of Thailand 2025 / ISO 42001 | Graduated oversight + per-tier evidence artifacts for agentic code generation | https://arxiv.org/html/2606.22484 |
| FDA SDLC documentation | Validation master plans for AI components (healthcare secondary segment) | https://7wdata.be/data-governance/ai-compliance-regulated-sectors/ |
| SLSA / in-toto provenance | De-facto requirement: non-human agent identities + signed build provenance | https://cloudsmith.com/blog/the-2026-guide-to-software-supply-chain-security... |

**Wedge.** **BFSI / regulated-fintech engineering teams (SR 11-7 + EU AI Act).** Hardest, most explicit forcing function: every LLM/agent touching a credit/fraud/operational decision is already a "model" requiring validation evidence; code-gen must emit per-stage evidence artifacts. BFSI is the single largest segment (27% in 2026), has a compliance line item, and "proof not parity" maps 1:1 to artifacts auditors must produce. Make the verification trail (hypothesis→evidence→result→confidence, append-only) directly exportable as SR 11-7 / EU AI Act conformity evidence; then expand to healthcare/FDA and public-sector/NIST.

### 5c. Design

**Loop stage strengthened: VERIFY → CONVERGE.** Extension, not addition.

Today autowork (`routes/convergence-dispatch.js`) runs Observe(issue)→Remember(research)→Reason(plan)→Act(patch)→Verify(`runTests` + `councilReview execVerdict` via `lib/council-review.js` + `lib/exec-verify.js`), then writes an **ungraded** convergence record to `data/convergence-autonomous-work.jsonl` + `data/agi-benchmark.jsonl`. Two gaps, both real-but-unwon: (1) **capability** — never posted a measured SWE-bench resolved% (`scripts/swe_agent_loop.py`'s own header says live wiring "is the next step"); (2) **provenance** — `records.jsonl` is plain mutable JSONL. The design closes both against the *same* loop: make SWE-bench the external terminal condition grading the Verify stage, and make the Converge stage emit a **hash-chained, deterministically-replayable** ConvergenceRecord series so resolved% delta over epochs *is* the measured self-improvement signal. The defensible seam we **don't** touch (execution-overrides-text council verdict + 4-way answerability gate + cross-language schema-locked record) stays as-is; we add a chain on top and a measured score under it. **Self-improvement is defined operationally:** resolved% on a *frozen* SWE-bench slice rises across record-chain epochs, with each gain traceable to a retrieved memory or plan change — living entirely inside the existing Memory + ConvergenceRecord objects.

#### Components

| Name | Path | Status |
|---|---|---|
| `swe_agentic_run` live wiring — connect `propose()`/`apply_and_test()` to the live stack (propose on host; `git apply` + FAIL_TO_PASS test in WSL2/Docker) | `scripts/swe_agentic_run.py` + `scripts/swe_agent_loop.py` | extend |
| `eval_swebench_chat` grade + leaderboard — run a FROZEN slice, emit resolved% tagged with the epoch's chain head; never fabricate | `scripts/eval_swebench_chat.py` | extend |
| BENCHMARKS registry row — flip SWE-bench Lite 🟡→✅ only when a real resolved% lands | `docs/BENCHMARKS.md` | extend |
| Hash-chained ConvergenceRecord (JS) — add `prev_hash` + `record_hash` (sha256 over canonical-JSON incl. `prev_hash`) | `lib/convergence-records.js` | extend |
| Hash-chained ConvergenceRecord (Python parity) — same fields in `to_jsonl()`; reuse `_evidence_hash` from `verify.py` | `src/convergence/objects.py` | extend |
| Chain verifier + replay — verify `record_hash` chain end-to-end; deterministic replay | `lib/replay.js` | extend |
| Autowork → schema-locked record bridge — Converge step also calls `emitConvergenceRecord()` (collapse the ad-hoc logs into the canonical stream) | `routes/convergence-dispatch.js` | extend |
| Self-improvement delta tracker — resolved% delta between chain epochs; one Converge record per epoch citing changed Memory ids | `scripts/update_convergence_records.py` | extend |
| Surprise-leak valve — plumb propose() logprobs into `runCanaries(tokenSurprise)` so low-confidence patches abstain (`seam_open`) instead of opening a bad PR | `lib/groundedness-canary.js` + `lib/stream-chat.js:1199` | extend |
| SR 11-7 / EU AI Act conformity export — read-only chain-verified projection (hypothesis→evidence→result→confidence→source + chain hashes) | `routes/convergence-dispatch.js` (new GET) + `lib/convergence-records.js` | **new** |

**Data model.** Extends the four core objects; no new top-level object. ConvergenceRecord gains `prev_hash` (record_hash of prior record, null for genesis) + `record_hash` (sha256 of canonical-JSON of all fields incl. `prev_hash`) → `records.jsonl` becomes a Merkle-style chain (any edit/reorder breaks every downstream hash); old records load as genesis (backward-compatible); schema stays cross-language-locked by `tests/test_convergence_records.py`. A **SWE-bench Verify record** = ConvergenceRecord with `source='swebench:<dataset>@<slice_hash>'`, `result={resolved, instance_id, attempts}`, confidence grounded by test pass. An **epoch record** = Converge-stage record: `result={resolved_pct, delta_vs_prev_epoch, n_instances, frozen_slice_hash}`, `evidence_ids` → the Memory entries that differed (so a gain is *traceable*, not asserted). `leaderboard.jsonl` rows gain `chain_head`, binding score to chain state. The idempotent confidence fold (`verify.py _evidence_hash`) prevents a replayed pass from ratcheting confidence to 1.0.

#### Build sequence

| Step | Loop stage | Effort |
|---|---|---|
| **FIRST:** live-wire `swe_agent_loop`; run `eval_swebench_chat.py --grade` on a small frozen slice (10–30) in WSL2/Docker; post the **first real resolved%**; flip BENCHMARKS.md to ✅. Until a real number exists, everything else is decoration | Verify | high |
| Freeze the slice + define the epoch convention (same N, `slice_hash`, one leaderboard row per epoch tagged with chain head) | Converge | low |
| Add `prev_hash`/`record_hash` to JS + Python record; lock cross-language schema in `test_convergence_records.py` | Converge | medium |
| Extend `replay.js` to verify the chain + deterministically replay; CI chain-integrity check | Verify | medium |
| Bridge autowork Converge (~line 1161) to also call `emitConvergenceRecord` | Converge | medium |
| Plumb propose() logprobs into `runCanaries(tokenSurprise)` at `stream-chat.js:1199`; low-confidence patch → `seam_open` (no PR) | Verify | medium |
| Extend `update_convergence_records.py` to emit an epoch Converge record with resolved% delta + `evidence_ids` to changed retrieval/plan Memory | Converge | medium |
| Close the loop: persist refuted-instance failures as Memory the next epoch retrieves; re-measure to show the delta moved | Remember | high |
| Add the read-only SR 11-7 / EU AI Act conformity export over a chain-verified slice | Converge | medium |
| Scale the frozen slice toward SWE-bench Verified; post the measured number | Verify | high |

#### Risks & mitigations

- **SWE-bench Verified partly discredited** (OpenAI abandoned it Feb 2026 over ~60% broken tests + contamination). → Lead with the provenance story; treat resolved% as a secondary anchor on a *frozen, slice-hashed* subset where the *delta-over-epochs* (not the absolute number) is the claim; cross-check on Lite.
- **WSL2/Docker grading is heavy/flaky on Windows.** → Keep a small frozen slice always-on; reserve full runs for milestones; use grade-later mode (predict, then `--grade` separately).
- **Hash-chaining a hot append-only log races on the chain head.** → Compute `prev_hash` inside the existing `appendJsonlQueued` single-writer serialization (per `file-queue.js`); read the head at enqueue-dequeue, not by callers; add the CI chain-integrity check.
- **Self-improvement could be illusory** (overfitting the frozen slice). → Require every epoch gain to cite the specific Memory/plan `evidence_ids` that changed; hold out a rotating unseen slice; keep the idempotent confidence fold.
- **Scope creep into a "self-improvement engine" subsystem.** → Every component is `status=extend`; self-improvement is a delta over the existing ConvergenceRecord chain — no new top-level object or engine.

#### Milestones

- **M1 — MEASURED BASELINE.** Live-wire the loop; run a frozen 10–30 instance Lite slice end-to-end in WSL2/Docker; post the first real resolved% to `leaderboard.jsonl`; flip BENCHMARKS.md to ✅. The "unmeasured/behind" leg becomes a real number.
- **M2 — TAMPER-EVIDENT CHAIN.** `prev_hash`/`record_hash` in JS + Python with locked cross-language tests; chain verifier + replay; CI chain-integrity gate. Closes the provenance leg vs OpenFang/Hermes/OpenHands.
- **M3 — ONE STREAM + ABSTENTION.** Bridge autowork Converge into the canonical chained stream; open the surprise-leak valve so low-confidence patches abstain instead of opening bad PRs.
- **M4 — MEASURED SELF-IMPROVEMENT.** Persist refuted-instance failures as retrievable Memory; run epoch N+1; emit an epoch Converge record showing a resolved% delta traceable to the changed retrieval/plan.
- **M5–6 — REGULATED-WEDGE EXPORT + VERIFIED SCALE.** Ship the SR 11-7 / EU AI Act conformity export over the chained series; scale the frozen slice toward SWE-bench Verified with a posted measured number.

---

## 6. Cross-cutting: shared infrastructure, sequencing, and the "do NOT build" list

### Shared infrastructure (build once, reuse across directions)

1. **Hash-chained ConvergenceRecord** is the single most reused primitive. Direction 4 needs it (provenance leg); Direction 1's `SealRecord` and Direction 3's signed claim packets compose with it. **Build `prev_hash`/`record_hash` once** in `lib/convergence-records.js` + `src/convergence/objects.py`, schema-locked by `tests/test_convergence_records.py`, and all four directions inherit tamper-evidence.
2. **The Ed25519 + Merkle integrity engine** (`src/hff-api/cryptographic_proof.py`) is shared by Direction 1 (sealer/verifier) and Direction 3 (consent-gate signing). Promote it out of hff-api isolation **first**.
3. **External anchoring** (RFC-3161 / CT-style Merkle-root publication) is the *real* moat for Direction 1 and strengthens Direction 4's conformity export. Build it once as a generic anchor service over any record-chain head.
4. **The surprise-leak valve** (`stream-chat.js:1213`/`:1199`) is literally the same wire for Direction 2 (user dial) and Direction 4 (patch abstention). Open it once; both consume it.
5. **The cite-or-abstain / consent-gate / claim-packet stack** is shared by Direction 3 (casework) and the chat verify pass it already serves.

### Sequencing — what unblocks what

```
[Promote cryptographic_proof.py to shared]  ──┬──► Direction 1 (Vault sealer/verifier)
                                              └──► Direction 3 (consent-gate signing already uses ed25519)

[Hash-chain ConvergenceRecord once]  ──┬──► Direction 4 (provenance leg)
                                       ├──► Direction 1 (SealRecord composes)
                                       └──► Direction 3 (signed claim packets)

[Run surprise_leak_ab.py — kill-switch gate]  ──► gates BOTH Direction 2 and Direction 4's abstention valve
   (if perplexity ~chance on our models, DO NOT open the valve in either direction)

[External anchoring service]  ──┬──► Direction 1 moat (RFC-3161 / CT)
                                └──► Direction 4 conformity export credibility

[SWE-bench measured baseline (Direction 4 M1)]  ──► unblocks ALL "self-improving" claims
   (no measured resolved% = no honest capability claim anywhere)
```

**Recommended global order:** (1) run the surprise AB harness (cheap, gates two directions); (2) hash-chain the record stream (one change, four beneficiaries); (3) promote the crypto engine; (4) post the SWE-bench baseline; (5) build external anchoring; then fan out into the per-direction product surfaces.

### Honest "do NOT build" list

- **Do NOT publish any "category of one," "ahead," or "parity on capability" copy.** All four headlines were refuted (2–3/3). Public copy must use the corrected verdicts (parity/mixed + narrow execution edge).
- **Do NOT build a separate dream engine, memory system, agent ecosystem, or "self-improvement engine."** Every direction is a VERIFY/CONVERGE-stage *extension* of the one loop. (Σ₀ constraint.)
- **Do NOT build Shamir escrow / dead-man switch / TPM sealing / BFT consensus** for the Vault's 6-month version — defer explicitly in the doctrine.
- **Do NOT claim tamper-*proof*.** Only "local tamper-*evidence*," and only with external anchoring for any third-party-verifiable claim.
- **Do NOT sell the surprise canary as general "hallucination detection."** Scope it to degeneration/anchoring; state it does NOT catch fluent factual hallucination unless a semantic-entropy axis is added.
- **Do NOT revive the dormant tkinter BetterSafe home-automation modules** (fridge/appliances/meals). Build only the casework verify path.
- **Do NOT ship abstain-only BetterSafe as "compliant."** The human-review/appeal + impact-assessment + adverse-action-notice paths are legally load-bearing and currently missing.
- **Do NOT bet the BetterSafe roadmap on an imminent EU hammer** (deferred to Dec 2027). Anchor on 42 CFR Part 2 (Feb 2026).
- **Do NOT ship the degenerate `tailMass` field.** Recalibrate to mean/p90 + split-conformal first.

---

## 7. Appendix — Open questions / unverified claims

The completeness critic flagged the following. None should appear in customer-facing copy until resolved.

| # | Item | Status | Required resolution |
|---|---|---|---|
| 1 | "A category of one against MemGPT/Letta/MemOS" (Vault) | **Refuted** | C2PA + memory-vault/LeanCTX/Cathedral fuse the same properties. Remove the claim |
| 2 | "Memory you can *prove* was never silently rewritten" (Vault) | **Unverified** | No external time-anchor exists. Add RFC-3161 / CT before any non-rewriting claim |
| 3 | "Cloud vendors structurally can't hand the user raw token-logprobs" (Canary) | **Factually wrong** | OpenAI (non-reasoning) + Gemini/Vertex expose logprobs; vLLM fully. Reframe moat as local-first ownership |
| 4 | "Parity on capability" (Self-improving coding) | **Unverified / contradicted** | Only Qwen 0/3 measured; agentic loop has no resolved%. Post a real number first |
| 5 | "AUROC ~0.76–0.81 as a durable canary capability" | **Known ceiling, not wired** | `tailMass` degenerate; no calibrated in-product detector yet. Recalibrate + wire before quoting |
| 6 | "BetterSafe is ahead / regulated wedge demands it NOW" | **Unverified** | Evaluator is a fuzzy 2-criteria matcher; no citations/abstention/appeal/impact-assessment yet. EU deferred to Dec 2027 |
| 7 | "500-Year hardening" durability | **Unverified / unfalsifiable** | No format-migration test, no anchoring, no key-succession threat model. Survive one operator handoff first |
| 8 | All four Part-1 "ahead/parity" verdicts | **(assert), `verify.survives=false`** | None grounded with `[claim, evidence, confidence, source]` in prior copy. This document is the regrounding |

**Missing competitors the analysis must still quantify before any comparative claim ships:** C2PA / Content Authenticity Initiative (Vault); Sigstore/cosign + SLSA (coding provenance); RFC 3161 + CT-style transparency logs (Vault durability); semantic-entropy + HALT/EPR/SelfDoubt (Canary SOTA); Cleanlab TLM / Patronus Lynx / Galileo / Vectara HHEM / NeMo Guardrails / Deepchecks (Canary "shipped products"); MemGPT/Letta, MemOS, Mem0 LongMemEval/PersonaMem numbers (which we have **not** measured against — `docs/BENCHMARKS.md` shows LongMemEval still 🟡 synthetic-only); GLM-5.2 (~62% Verified) / Qwen3-Coder-Next / OpenHands / Aider (coding capability baselines); Deloitte/Accenture / Gainwell / Code for America (GetCalFresh) / mRelief (BetterSafe govtech incumbents).
