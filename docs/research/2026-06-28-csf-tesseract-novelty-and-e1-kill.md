# CSF / Tesseract / Lapse — novelty review, external validation, and the E1 kill

**Date:** 2026-06-28
**Type:** Review + external validation + experiment (E1/E2 run) + salvage
**Status:** Closed. This note **closes** the "higher-dimensional / tesseract / lapse compression" research branch with evidence, and records the one piece worth carrying forward. No new subsystem. Supersedes the open kill-tables in [`2026-06-20-lapse-tesseract.md`](2026-06-20-lapse-tesseract.md) §6 (E1/E2) and [`2026-06-19-convergence-tesseract-spiral.md`](2026-06-19-convergence-tesseract-spiral.md) §6 (E2).

**Grounding contract — External Reality Rule.** Every load-bearing claim is tagged **[implemented]**, **[measured — this note]**, **[grounded]** (external peer literature, verified URL), or **[killed]** (a falsifiable claim run and refuted). Metaphor is labelled metaphor.

**Artifacts (reproducible):** [`experiments/lapse_e1_ouro_coder.py`](../../experiments/lapse_e1_ouro_coder.py) · [`experiments/lapse_e1_contraction_diag.py`](../../experiments/lapse_e1_contraction_diag.py) · [`experiments/ouro_adaptive_compute_probe.py`](../../experiments/ouro_adaptive_compute_probe.py) → `data/lapse_e1_ouro_coder_report.json`, `data/lapse_e1_contraction_diag.json`, `data/ouro_adaptive_compute_probe.json`. Run on Ouro-1.4B (n_ut=4), RTX 3070, `.venv-train`.

---

## TL;DR

> The "CSF higher-dimensional / tesseract / quantum" compression work is **conventional sparse-delta coding in metaphorical dress** — externally validated as such. The one research thread with real legs (the **Lapse Tesseract**: use Ouro's recurrent compute-depth as a per-cell code-length field) was the load-bearing experiment, so I **ran it (E1) on the real model**. It is **killed**: an Ouro coder beats CSF-Omni only on prose *raw rate* (the textbook DeepMind result), loses on structured data, and dies by ~6 orders of magnitude once the 2.87 GB model is counted; and the headline *mechanism* — compute-depth ↔ code length — is **refuted** (the loop does not contract within its 4 steps; depth and code length do not correlate). The salvage is real but modest: the **trained Q-exit gate** gives ~25–43% recurrent-compute savings at 95–98% token fidelity — i.e. Ouro's depth is a **parameter/compute-efficiency knob, not a storage trick or a test-time-scaling axis**. The only thing carried into the product is a **model-agnostic per-token surprise signal** feeding the existing groundedness canary (Verify stage).

---

## 0. What is real vs. what this note contributes

| Claim | Status | Source |
|---|---|---|
| CSF-Pack/Omni is a working lossless archive (zstd-19 + best-fit brotli panel) | **[implemented]** | `src/csf/csf_pack.py`, `src/csf/omni.py` |
| CSF-Omni only *ties* brotli (upper envelope of off-the-shelf codecs, not a novel coder) | **[grounded]** | [`CSF-FORMAT-SPECIFICATION.md`](../CSF-FORMAT-SPECIFICATION.md) §2.7.1 |
| The 3¹² "tesseract" is a balanced-ternary sparse-delta store, not 4D/quantum | **[implemented]** | `src/csf/v07/*`, `src/converged_tesseract.py` |
| Higher-dimensional geometry confers **no** entropy advantage (Shannon/Kolmogorov) | **[grounded]** | §2.1 |
| "model + arithmetic coder = SOTA lossless compressor" is mature prior art | **[grounded]** | §2.2 |
| Fisher–Rao/MDL code-length geometry is real; the relativity framing is costume | **[grounded]** | §2.4 |
| **Lapse Tesseract E1** (Ouro converged-depth coder beats CSF-Omni, amortized) | **[killed]** | §3 |
| **Depth ↔ code-length warp** (E2, the headline mechanism) | **[killed]** | §4 |
| Adaptive compute via the **trained gate** (the salvage) works | **[measured — this note]** | §5 |
| Ouro recurrent depth = parameter-efficiency, not test-time-compute scaling | **[measured + grounded]** | §6 |

The contribution of this note is the **external validation** (§2) + the **run experiments** (§3–5) + the **branch-closing synthesis** (§6). Everything else is pre-existing code or cited literature.

---

## 1. The three layers wearing one name

1. **Shipping codec (real, conventional).** CSF-Pack v0.8: lossless, zstd-19 backend (zlib fallback), per-file SHA-256. CSF-Omni: best-fit panel that ties brotli. Measured: 2.73× on repo files (≈ zip), 362× on a 4 MB JSONL memory log. **No novelty, none claimed.**
2. **The 3¹² ternary lattice ("tesseract", real engineering, decorative branding).** Sparse baseline+delta store, base-3 delta codec, cluster-to-baseline promotion. "Qutrit" = a classical 6-bit (amp, phase) slot; "quantum dust" = implicit zero-cost positions. Its `base3_cyclic` codec **loses to generic `delta+varint+zstd` by 1–8%** on real streams ([`data/sigma0_delta_codec_benchmark_report.json`](../../data/sigma0_delta_codec_benchmark_report.json)); the "8.55× vs naive JSON" game-save figure is schema-aware, not vs a codec.
3. **The research thread (where the only novelty lived).** CSF≡Tesseract unification; convergence-exit spiral; and the **Lapse Tesseract** — attach a per-cell code-length field `L(x)=−log₂p(x)` to the lattice, with Ouro's recurrent depth as the predictor. This is what §3–4 test.

---

## 2. External validation (deep-research, 25/25 verified claims; + web)

Adjudicated against primary literature. Full provenance in §7.

### 2.1 4D storage cannot beat Shannon — **[grounded]**
Lossless compression is bounded by Shannon entropy; the counting/pigeonhole argument (Kolmogorov incompressibility, Vitányi–Li) shows no bijection compresses all inputs. **Higher-dimensional geometric arrangement is a reindexing of the same bit-set — zero entropy advantage.** The repo, to its credit, never claims otherwise.

### 2.2 Model-as-compressor is mature prior art — **[grounded]**
"Probabilistic predictor + arithmetic coding = SOTA lossless compressor" is established (DeepMind *Language Modeling Is Compression*, arXiv:2309.10668; LLMZip 2306.04050; Bellard NNCP; PAQ/cmix on the Large Text Compression Benchmark; Witten–Neal–Cleary 1987). A "per-cell code-length field + neural predictor" **re-derives this known class.** Decisive caveat: the headline neural-compression ratios are *raw rate excluding the model*; the **adjusted rate** (model counted) is catastrophic (Chinchilla 14008% vs gzip 32% on enwik9).

### 2.3 Balanced ternary — **[grounded, conflation trap]**
Radix economy is minimized at e, nearest integer 3 (American Scientist *Third Base*); BitNet b1.58 {−1,0,+1} is real (arXiv:2402.17764). **But this is digit/hardware economy, not compression ratio** — base-3 gives no lossless-compression advantage over binary.

### 2.4 Compression⇄geometry — **[grounded core, fringe metaphor]**
Real: optimal `L=−log₂p` (Shannon/Kraft); Fisher metric is the unique invariant Riemannian metric (Chentsov); Rissanen MDL contains the Riemannian volume `∫√det I(θ)dθ`; Balasubramanian's curvature-in-code-length. **All positive-definite Riemannian.** The "gravitational time dilation = compression / spacetime curvature" framing maps to **no Lorentzian metric in any source** — costume. (A real-but-speculative program derives the Einstein tensor *from* Fisher information, Matsueda 1310.1831, but it makes **zero contact with compression/MDL** and does not rescue the analogy.)

### 2.5 "Higher-dimensional compression" is an occupied name — **[grounded]**
In the literature it means **tensor decomposition** — Tucker, CP/PARAFAC, and especially Tensor-Train (Oseledets 2011) / tensor networks: low-rank factorization of multi-way arrays. The ternary sparse-delta store is **unrelated** and ignores that field.

---

## 3. E1 — the load-bearing experiment, run **[killed]**

**Method.** Teacher-force Ouro-1.4B over each corpus in independent context windows; sum the next-token code length `L=−log₂p*` (the rate an arithmetic coder realizes to <2 bits/window) at full depth R4. latin-1 makes bytes↔text a bijection; tokenizer round-trip verified. Baseline = round-trip-verified CSF-Omni. Report RAW (model resident) and ADJUSTED (+2.87 GB model). `data/lapse_e1_ouro_coder_report.json`.

| Corpus | raw | CSF-Omni | Ouro raw | Ouro adjusted | |
|---|---|---|---|---|---|
| cube-delta (3¹² storage face) | 66,960 B | **3,686 B** | 4,105 B | +2.87 GB | Ouro **loses** |
| kalshi memory log (256 KB) | 262,144 B | **8,736 B** | 27,242 B | +2.87 GB | Ouro **loses 3×** |
| README (prose) | 29,832 B | 8,765 B | **3,254 B** | +2.87 GB | Ouro **wins raw 2.7×**, loses adjusted |

**Verdict.** RAW: Ouro beats CSF-Omni *only on prose* (9.2× vs 3.4×) and loses on structured data — exactly DeepMind's known result, **reproduced, not novel.** ADJUSTED: loses by ~6 orders everywhere. The kill criterion ("must strictly beat CSF-Omni amortized on ≥1 corpus") is **not met**.

---

## 4. E2 — the depth↔code-length warp, refuted **[killed]**

The Lapse Tesseract's premise is "compute-depth *is* the bit-cost warp." Measured directly (`data/lapse_e1_contraction_diag.json`):

- **The loop does not converge in its 4 trained steps.** Per-step contraction `‖Δh‖/‖h‖` is still **0.18–0.22 at the final step** (means: README 0.89→0.53→0.22; cube 0.48→0.31→0.18); min ever ~0.022. At the doc's ε=0.05, **convergence-exit never fires** — depth pins at 4.0/4.
- **Where ε forces depth to vary, it does not track surprise.** `corr(exit-depth, code-length)` is **~0 to negative** at every non-degenerate ε (cube −0.19 to −0.30; README −0.12 to 0.00), positive only at ε≥0.3 where 38–91% exit degenerately. The hypothesis needs a clean *positive* coupling; there is none.

So the lapse *field* (data predictability variance, the one measured thing in the original note) is real — but it **does not come from compute-depth.** The mechanism is dead.

---

## 5. The salvage — adaptive compute via the **trained gate** **[measured]**

E2 killed `‖Δh‖`-convergence as an exit signal. The model's **trained Q-exit gate** is a different, better signal. `data/ouro_adaptive_compute_probe.json` (teacher-forced; gate picks per-token depth):

| q | mean depth | recurrent compute saved | greedy agreement w/ R4 | KL(R4‖exit) |
|---|---|---|---|---|
| 0.2 | 2.3–2.5 / 4 | **~37–43%** | 95–96% | ~0.02 |
| 0.4 | 2.9–3.1 / 4 | ~23–27% | **98%** | <0.01 |
| 0.6 | ~3.5 / 4 | ~10% | 99.8% | 0.001 |

Two realizations: **lossy gate-trust** (ship via `loop_lm.generate(mode="qexit", q≈0.4)`, ~25% recurrent-compute cut at ~98% fidelity) and **lossless self-speculative** (shallow draft + parallel R4 verify; ~95% acceptance ⇒ ~1.5–1.7× — needs a draft-verify loop, deferred). Savings are on the recurrent block, which dominates a UT model's inference cost.

---

## 6. Synthesis — recurrent depth is parameter-efficiency, not a scaling axis

Three independent lines converge:
- **This note (E2):** the looped latent state does not contract within its budget; the trained gate, not `‖Δh‖`, is the usable exit signal.
- **This note (E1):** depth buys nothing for compression.
- **Parallel deep-research** ([`ouro-looplm-research`](ouro-looplm-research.md), 2026-06-28): Ouro's "small beats big" is *parameter*-not-compute (~4× FLOPs at R=4); test-time scaling **collapses past T≈4**; loses to Qwen3-8B on AIME/GPQA in ByteDance's own table.

**Conclusion:** Ouro's recurrent depth is a baked-in parameter-efficiency mechanism, not a test-time-compute scaling lever and not a storage geometry. You cannot iterate it to a fixed point, cannot scale it past ~4, and cannot turn it into compression. The looped-LM-as-capability-frontier branch is **closed with evidence.**

---

## 7. What's dead, what carries forward

**Dead (stop investing):** compression-by-geometry, the tesseract/qutrit/quantum framing, base-3-as-compression, depth-as-code-length, the relativity analogy.

**Carries forward to the product (Verify stage):** the **per-token surprise signal** `−log₂p` is a real, model-agnostic groundedness primitive — it corroborates the existing 42-state groundedness canary (`lib/groundedness-canary.js`) from *inside* the model (high surprise on the very tokens carrying checkable facts = confident phrasing, uncertain internals). Wired as an optional raise-only sharpening; graceful no-op when logprobs are absent (cloud). Grounded in the semantic-entropy hallucination literature (Farquhar et al., *Nature* 2024).

**Carries forward to research-front (not product now):** the adaptive-compute gate (§5) — if a looped model is ever served at scale, the lossless self-speculative draft-verify loop is the build.

**Reusable:** the teacher-forced kill-criteria harness (§3–5) is how to vet *any* candidate model/technique before wiring it into the product.

---

## 8. Citations (verified)

- Shannon source coding; Kraft–McMillan; arithmetic coding (Witten–Neal–Cleary, CACM 1987).
- Kolmogorov complexity / incompressibility — Vitányi & Li, [homepages.cwi.nl/~paulv/kolmogorov.html](https://homepages.cwi.nl/~paulv/kolmogorov.html); [en.wikipedia.org/wiki/Incompressibility_method](https://en.wikipedia.org/wiki/Incompressibility_method).
- DeepMind, *Language Modeling Is Compression*, [arXiv:2309.10668](https://arxiv.org/abs/2309.10668); LLMZip, [arXiv:2306.04050](https://arxiv.org/abs/2306.04050); Bellard NNCP, [bellard.org/nncp](https://bellard.org/nncp/); Large Text Compression Benchmark, [mattmahoney.net/dc/text.html](https://www.mattmahoney.net/dc/text.html).
- Rissanen, *Fisher information and stochastic complexity*, IEEE TIT 42(1) 1996, [doi:10.1109/18.481776](https://doi.org/10.1109/18.481776); Balasubramanian, Neural Computation 9(2) 1997, [arXiv:adap-org/9601001](https://arxiv.org/pdf/adap-org/9601001); Chentsov / Fisher metric uniqueness, [Lê arXiv:1306.1465](https://arxiv.org/pdf/1306.1465).
- Matsueda, *Einstein equation from Fisher information*, [arXiv:1310.1831](https://arxiv.org/pdf/1310.1831) (no compression contact).
- Radix economy — American Scientist, *Third Base*; BitNet b1.58, [arXiv:2402.17764](https://arxiv.org/abs/2402.17764).
- Tensor-Train — Oseledets 2011; Tucker; CP/PARAFAC.
- Adaptive compute — CALM [arXiv:2207.07061](https://arxiv.org/abs/2207.07061); PonderNet [arXiv:2107.05407](https://arxiv.org/abs/2107.05407); Mixture-of-Depths [arXiv:2404.02258](https://arxiv.org/abs/2404.02258); Ouro LoopLM [arXiv:2510.25741](https://arxiv.org/abs/2510.25741).
- Semantic entropy / uncertainty for hallucination — Farquhar et al., *Nature* 2024.

## 9. Honest scope
- One checkpoint (Ouro-1.4B base, n_ut=4 — coarse). A model trained for many more recurrent steps *might* contract; that is a different engine than the project has, and the doc specified E1/E2 on this one.
- E1 reports the information-theoretic **rate** (arithmetic-coder overhead <2 bits/window, omitted; tokenizer round-trip verified exact on README, near-exact on logs). A bit-exact coder cannot change a verdict decided by a 2.7×-or-6-orders gap.
- The salvage numbers are teacher-forced; autoregressive serving uses the same gate (already in `loop_lm.generate`).
