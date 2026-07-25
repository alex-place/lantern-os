# Reading pack — the reliable-computation lineage (ingested 2026-07-24)

Papers pulled into `F:\arxiv-corpus` this session to widen the register from protein folding to
the full *reliable-computation-from-unreliable-components* canon behind the oracle-machine
end-state. All are BM25-retrievable (`KEYSTONE_ARXIV_RETRIEVAL`; reindexed to 115,757 papers).
**★ = full-text PDF pulled** to `pdfs\<id>.pdf`. Synthesis:
[`2026-07-24-oracle-machine-threshold-theorem-for-reasoning.md`](2026-07-24-oracle-machine-threshold-theorem-for-reasoning.md).

## The threshold theorem — CS side (the twin of K_c ≈ 1/q)
- **★ [1608.08228](https://arxiv.org/abs/1608.08228)** — High-Threshold Low-Overhead Fault-Tolerant
  Classical Computation (von Neumann multiplexing; p < 5.5% constant threshold, moderate code
  sizes). *The load-bearing support-vs-supplant reference: below a constant threshold, arbitrary
  depth is reliable — my 1/q is the R=1 corner.*
- **[1310.2984](https://arxiv.org/abs/1310.2984)** — Fault-Tolerant Quantum Computation with
  Constant Overhead (the quantum threshold theorem, overhead side).
- **[1809.09748](https://arxiv.org/abs/1809.09748)** — Reliable Computation with Asymmetric Gate
  Noise (tight limits; the noise-model dependence of the threshold).

## The restoration mechanism — kinetic proofreading (drives effective q below threshold)
- **★ [1504.02494](https://arxiv.org/abs/1504.02494)** — Thermodynamics of Accuracy in Kinetic
  Proofreading (the dissipation–speed–accuracy trade-off; the *energy cost* of a checkpoint).
- **[1710.06038](https://arxiv.org/abs/1710.06038)** — Energy–Speed–Accuracy relation in complex
  networks for biological discrimination.
- **[2606.10636](https://arxiv.org/abs/2606.10636)** — Compositional proofreading through critical
  self-tuning (recent; self-tuned checkpoint depth — relevant to learned foldon boundaries).
- **[2104.05683](https://arxiv.org/abs/2104.05683)** — The long and short of templated copying
  (accuracy/speed of molecular copying — the DNA-replication analogue of segment repair).

## The biological threshold + the optimal noise rate (Eigen)
- **★ [2406.14516](https://arxiv.org/abs/2406.14516)** — Extended Error Threshold Mechanism in
  Quasispecies Theory (the biological twin of K_c ≈ 1/q; error catastrophe).
- **[1205.3435](https://arxiv.org/abs/1205.3435)** — Critical Population and Error Threshold on the
  Sharp Peak Landscape (Moran model; finite-population threshold — the small-N regime).

## The generation side — controlled lying + exploration noise
- **★ [2502.03407](https://arxiv.org/abs/2502.03407)** — Detecting Strategic Deception Using Linear
  Probes. *This IS the v1.10 honesty probe: activation probes catch sandbagging / insider-trading
  deception. The honest, un-foolable verifier.*
- **★ [2604.04788](https://arxiv.org/abs/2604.04788)** — From Hallucination to Scheming: taxonomy +
  benchmark for LLM deception. *The map of "LLMs that specialize in lying" — the adversarial
  hard-negative generator the honesty corpus needs.*
- **★ [2509.18058](https://arxiv.org/abs/2509.18058)** — Strategic Dishonesty Undermines AI Safety
  Evaluations. *The error-catastrophe case: what happens when the VERIFIER is fooled — why lying
  must stay on the generation side only.*
- **[2511.15992](https://arxiv.org/abs/2511.15992)** — Detecting Sleeper Agents via Semantic Drift
  (already in corpus; persistence-of-deception detection).
- **★ [2410.15226](https://arxiv.org/abs/2410.15226)** — On the Diversity of Synthetic Data and its
  Impact on Training LLMs. *The exploration-noise / "shake the champion" side, ML-instrumented.*

## Foundational, cited but pre-arXiv (not ingestable by id; named for provenance)
- von Neumann 1956, *Probabilistic Logics and the Synthesis of Reliable Organisms from Unreliable
  Components*; Turing 1939 oracle machines; Hopfield 1974 / Ninio 1975 kinetic proofreading;
  Eigen 1971 quasispecies; Winfree & Bekbolatov 2003 proofreading tile sets; Aharonov–Ben-Or
  quant-ph/9906129 + Gottesman 0904.2557 (pre-2015 arXiv, rejected by the id-dating tool).

*Provenance: ingested per operator request to "pull relevant biology and research into the arxiv
corpus and download key full text reports to support or supplant." The verdict (synthesis §6):
the threshold-theorem lineage **supports and extends** K_c ≈ 1/q as its unprotected corner; it
does not supplant it. The novel object is the instantiation on reasoning chains.*
