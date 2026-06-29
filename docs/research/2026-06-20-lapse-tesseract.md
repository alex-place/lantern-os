# The Lapse Tesseract — a code-length metric that warps CSF's Convergence Tesseract

**Date:** 2026-06-20
**Type:** Research proposal + first measurement (the novel *shape*; the production coder is a falsifiable hypothesis)
**Status:** Draft. Contribution is a **storage-geometry** reframing + one measured field + a kill-criteria table. No model is trained; no ratio is claimed to beat the frontier; one demo script is added ([`experiments/lapse_field_demo.py`](../../experiments/lapse_field_demo.py)).

> **⛔ SUPERSEDED 2026-06-28 — E1 and E2 RUN AND REFUTED.** On the real Ouro-1.4B: the converged-depth coder beats CSF-Omni only on prose *raw rate* (loses on structured data, loses by ~6 orders adjusted), and the depth↔code-length warp does not exist (the loop does not contract in 4 steps; `corr(depth, bits)` ~0/negative). The lapse *field* is real; compute-depth is not its source. Full evidence + the salvage: [`2026-06-28-csf-tesseract-novelty-and-e1-kill.md`](2026-06-28-csf-tesseract-novelty-and-e1-kill.md). The §6 kill-table below is retained as the original specification.
**Grounding contract — External Reality Rule.** Every load-bearing claim is tagged **[implemented]**, **[measured — this doc]**, **[grounded]** (external peer literature), **[hypothesis — to be measured]**, or **[metaphor]**. Metaphor is labelled as metaphor and the *place the analogy breaks* is stated mechanically, per [`SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md`](../SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md).

**Reads first:** [`TESSERACT-CSF-SINGULARITY.md`](../TESSERACT-CSF-SINGULARITY.md) (CSF ≡ Tesseract = one 3¹² lattice) · [`research/2026-06-19-convergence-tesseract-spiral.md`](2026-06-19-convergence-tesseract-spiral.md) (the flat 3-cube × ℝ depth axis this doc warps) · [`CSF-FORMAT-SPECIFICATION.md`](../CSF-FORMAT-SPECIFICATION.md) §2.7.1 (the real codec, CSF-Omni) · [`OURO-LOOPLM.md`](../OURO-LOOPLM.md) (the recurrent-depth engine).

---

## TL;DR

> CSF's tesseract is **flat**: the existing object is a 3-cube (Status-Cube: belief × observer × state) × a recurrent-depth axis τ, with τ a plain time→position hash and every cell a fixed 6-bit qutrit slot ([`converged_tesseract.py`](../../src/converged_tesseract.py), [`qutrit_delta.py`](../../src/csf/v07/qutrit_delta.py)). This doc **warps** it. Give each cell a scalar **lapse field**
> `N(x) = compressed/raw ∈ (0,1]`, equivalently the **code length** `L(x) = −log₂ p(x | context)` bits, so the 4th-axis "thickness" of a cell is *how many bits it actually costs*. Predictable cells become **deep wells** (few bits, strong dilation); random cells stay **flat** (incompressible); perfectly-predicted "dust" cells are **horizons** (0 bits, a frozen clock). The novelty is **not** a theorem, new physics, or a new format — it is operationalising the known compression⇄geometry correspondence (Shannon · Fisher–Rao/MDL) as a *stored, round-trip-verified* metric on the **one** canonical CSF lattice, with retrieval as minimal-description-length pathfinding. The relativity reading is **labelled metaphor**; the math underneath is Riemannian, not Lorentzian.

---

## 0. What is real vs. what is the contribution

| Component | Status | Source |
|---|---|---|
| 3¹² lattice = CSF storage face = Tesseract motion face (one object) | **[implemented]** | [`qutrit_delta.py`](../../src/csf/v07/qutrit_delta.py), [`quantum_dust.py`](../../src/csf/v07/quantum_dust.py), [`converged_tesseract.py`](../../src/converged_tesseract.py) |
| The tesseract is **flat** today (τ = LCG time-hash `pos=(tick·7919)%3¹²`; cell = fixed amp 0-7 × phase 0-7) | **[implemented]** | [`converged_tesseract.py:124-185`](../../src/converged_tesseract.py), [`qutrit_delta.py:15-26`](../../src/csf/v07/qutrit_delta.py) |
| Optimal code length `L(x) = −log₂ p(x)`; arithmetic/ANS realises it to < 2 bits / stream | **[grounded]** | Shannon source coding; Kraft–McMillan; §5 |
| "Model = compressor"; LLM + arithmetic coder is a shipped lossless codec | **[grounded]** | DeepMind *LM is Compression*; ts_zip/cmix; §5 |
| Code length carries the Fisher–Rao **Riemannian volume** ∫√det I(θ) and (higher order) the **scalar curvature** | **[grounded]** | Rissanen stochastic complexity; Balasubramanian's razor; §5 |
| Adaptive recurrent depth (more compute on hard inputs) exists as a real engine | **[implemented]** | Ouro LoopLM; [`loop_lm.py`](../../src/sigma0/loop_lm.py); §5 |
| **The lapse field `L(x)=−log₂p` is real + non-uniform on CSF data** | **[measured — this doc]** | §4, [`lapse_field_demo.py`](../../experiments/lapse_field_demo.py) |
| **Warp CSF's flat τ axis by the per-cell code-length field → the Lapse Tesseract** | **[contribution — this doc]** | §2–3 |
| Production lapse = Ouro converge-depth → arithmetic-coded bits, beating CSF-Omni | **[hypothesis — to be measured]** | §6, E1 |
| `depth τ ↔ code length L` correlation on real Ouro | **[hypothesis — to be measured]** | §6, E2 |
| "Time dilation," "gravitational well," "event horizon" | **[metaphor]** (Riemannian, not Lorentzian; §3.3) | §3 |

The contribution is the **shape** (§2–3) + the **field measurement** (§4) + the **kill table** (§6). Everything else is pre-existing code or 30-to-75-year-old literature, cited so this doc does not re-import the unsourced-claim mistake the repo has twice corrected.

---

## 1. The flat tesseract, and the one thing it is missing

The repo already proved CSF and the Tesseract are **one** `3¹² = 531,441`-cell ternary lattice — CSF *stores* a point (baseline + delta "dust"), the Tesseract *moves* it (observer-collapsed wavefront → convergence-exit fixed point) ([`TESSERACT-CSF-SINGULARITY.md`](../TESSERACT-CSF-SINGULARITY.md)). That object is **deliberately flat**: "(3-cube) × ℝ … a precise geometric object … any 4-D-physics reading is metaphor and out of scope." Each cell is a **fixed-width** 6-bit qutrit slot; the depth/4th axis is a uniform time→position hash. **[implemented]**

What it has *no* notion of: **how many bits a given cell is worth.** A converged, predictable confirmation and a high-surprise novel delta occupy the *same* fixed slot. The lattice has a position metric (ternary Hamming distance) but no **information metric**. That missing scalar — the per-cell code length — is the only new quantity this doc introduces, and it is exactly the quantity that turns a flat hypercube into a curved one.

---

## 2. The shape: warp the 4th axis by code length

Attach to every cell `x` a scalar **lapse**:

```
   L(x)  = −log₂ p(x | context)              bits        "information proper-length"
   N(x)  = 2^(−(L₀ − L(x)))  ≈  compressed/raw   ∈ (0,1]  the dilation / lapse factor
```

where `L₀` is the raw slot width and `p(·|context)` is a causal predictive model over the lattice's delta stream. Render `L(x)` as the cell's **thickness along the 4th (depth) axis**:

- **Predictable cell → deep well.** `p→1`, `L→0`, `N→0`: the cell collapses to a sliver. Most of the lattice (converged "dust") is here.
- **Random cell → flat space.** `p→2^(−L₀)`, `L→L₀`, `N→1`: full thickness, incompressible.
- **Perfectly-predicted "dust" cell → horizon.** `L=0`, `N=0`: zero-thickness, a frozen clock. This is the repo's "no-change is free" observation ([`quantum_dust.py`](../../src/csf/v07/quantum_dust.py)) made **quantitative** — and §4 measures literal `L=0.00` cells.

The whole tesseract is therefore **pinched** toward structured regions and **bulges** at random ones — a discrete gravitational lens whose geometry *is* the predictive model. Two faces fall out, both extensions of existing code, **not** a new subsystem:

1. **Storage face (CSF).** Store `L(x)` per active cell (the arithmetic/ANS code) instead of a fixed slot. Variable-thickness cells = a real entropy stage, which CSF lacks today ([`omni.py`](../../src/csf/omni.py) is a best-fit panel of *off-the-shelf* codecs; there is no `−log₂p` coder in `src/`).
2. **Motion face (Tesseract).** A **geodesic** = a minimal-description-length path. Retrieval/reasoning that follows low-`L` (deep-well) routes is following the cheapest-to-describe trajectory — the natural metric generalisation of the existing wavefront's "rank by information density" heuristic ([`converged_tesseract.py:51-62`](../../src/converged_tesseract.py)).

---

## 3. Time dilation as compression — the one honest correspondence, and where it breaks

### 3.1 The rigorous core (Riemannian) **[grounded]**

Three textbook facts make "code length is a metric" an *identity*, not a vibe:

- **Shannon + Kraft–McMillan:** the optimal codeword length is `L(x) = −log₂ p(x)`, and `Σ 2^(−Lᵢ) ≤ 1` makes lengths ↔ probabilities a **bijection**. So a length field and a probability model are the *same object* viewed two ways.
- **Cross-entropy split:** `H(p,q) = H(p) + D_KL(p‖q)`. The irreducible `H(p)` is the proper length; `D_KL` is the **excess** charged for a wrong model — a clean "extra dilation from imperfect curvature."
- **Information geometry (the metric is real):** on a model manifold `p(x|θ)`, the **Fisher information** `g_jk(θ)=E[∂_j log p · ∂_k log p]` is a genuine Riemannian metric and is the **Hessian of KL** (`D_KL(θ‖θ+dθ)=½ g_jk dθ^j dθ^k`). Chentsov's theorem makes it the *unique* such metric. Rissanen/Balasubramanian then show the **MDL code length contains the Riemannian volume** `∫√det I(θ) dθ` and, at higher order, the **scalar curvature** of that metric. *"The curvature of a compression model is a real, bit-controlling quantity"* is established fact.

### 3.2 The relativity map (the analogy that names the shape) **[metaphor scaffolding]**

In GR the dilation factor is `dτ/dt = √(g₀₀(x))`, a per-event scalar; weak-field `g₀₀ = 1 + 2Φ/c²`, so the **gravitational potential** is `Φ/c² ≈ ½ ln g₀₀ = ln√g₀₀`. The honest alignment — the *only* dimensionally clean one — is therefore:

| Relativity | Compression | Why it lines up |
|---|---|---|
| lapse / dilation factor `√g₀₀ ∈ (0,1]` | compression ratio `N = compressed/raw` | both multiplicative warp factors in `(0,1]` |
| gravitational potential `Φ/c² = ln√g₀₀` | **`−L·ln2` = log-probability** | `L=−log₂p` is *additive bits*; it maps to the **log** of the lapse, not the lapse itself |
| redshift `z ≈ ΔΦ/c²` (a **difference** of potentials) | **log-likelihood ratio** = `L(a)−L(b)` between two contexts | a difference of code lengths is exactly a difference of potentials |
| deep well `g₀₀→0`, clock slow | predictable cell, `L→0`, few bits | strong dilation = strong compression |
| flat spacetime `g₀₀≈1` | Kolmogorov-random `K(x)≥|x|−O(1)` | incompressible = no dilation |
| **event horizon** `g₀₀=0` | **"dust" cell** `L=0` (free confirmation) | the frozen clock = the zero-bit cell |

So: **compression ratio is the lapse; code length is the potential (a log of the lapse).** Getting this log right is the load-bearing hinge — mapping `L ↔ √g₀₀` directly would be dimensionally wrong (one is additive bits, the other a bounded ratio).

### 3.3 Where the analogy breaks — stated mechanically, not waved away **[metaphor]**

Per the repo's convention (give the *reason* a physics map fails, like the α/Aₛ argument in [`SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md`](../SIGMA0-QUANTUM-RELATIVITY-ANALYSIS.md)):

1. **Signature.** Fisher–Rao geometry is **positive-definite Riemannian** (`ds² ≥ 0`). Relativity needs an **indefinite Lorentzian** metric. There is **no light cone, no causal structure, no geodesic *action*, no conserved quantity** here unless one is separately constructed. "Spacetime" is therefore costume; "Riemannian metric of code length" is the substance.
2. **Domain.** The rigorous Fisher metric lives on **model/parameter space**, not the **data-cell index space** the tesseract warps. Calling the per-cell `L(x)` field "the metric" requires an explicit **pullback** through the encoder; we *assert* that pullback, we do not derive it. (Honest status: the per-cell field is a real scalar; its identification with a curvature tensor is the unproven step.)
3. **Nothing is trained behind CSF today.** The shipping compressor is the off-the-shelf [CSF-Omni](../CSF-FORMAT-SPECIFICATION.md) panel — no `p(x|context)`, no arithmetic/ANS coder anywhere in `src/`. "Curvature **is** the trained model" is a *target*, not a current state.

Consequently this doc claims a **designed metric and a logarithmic correspondence**, and explicitly **not** an isomorphism to Schwarzschild spacetime. A fringe preprint already asserts the bare "time dilation = compression"; the contribution here is not that slogan but the *stored, measured, CSF-attached* construction.

---

## 4. Measurement: the warp is real on CSF data **[measured — this doc]**

[`experiments/lapse_field_demo.py`](../../experiments/lapse_field_demo.py) runs a plain adaptive order-3 byte model (a *causal, losslessly-decodable* arithmetic-coding model — the decoder rebuilds the same counts from already-decoded bytes) over real corpora and reports the per-byte field `L = −log₂ p`. The toy model is **not** a frontier coder; its only job is to expose the field. Verified codec sizes are a reality check.

| Corpus (raw) | field mean | field **std** | horizon cells `L<1` | flat cells `L>7` | toy size | verified frontier |
|---|---|---|---|---|---|---|
| cube-delta — 3¹² storage face (25,420 B) | 1.61 b/B | **2.30** | **62.4 %** | 9.6 % | 4.98× | brotli 17.2×, zstd 16.0× |
| JSONL memory log (1.0 MB) | 0.82 b/B | **1.28** | **70.4 %** | 0.8 % | 9.79× | brotli 114.8×, lzma 104.4× |
| README prose (25,926 B) | 4.26 b/B | **3.03** | 15.9 % | **33.2 %** | 1.88× | brotli 3.5× |

Readings:
- **The field is strongly non-uniform** (std 1.28–3.03 bits/byte): the metric is *curved*, not flat — the warp exists on real data.
- **Curvature tracks structure.** The 3¹² lattice's own delta stream is **62 %** deep-well cells; prose is **33 %** flat/random. Structured CSF data lives in the wells.
- **Literal horizons exist.** `min L = 0.00` bits on the memory log — perfectly-predicted "dust" cells that cost zero bits, the frozen-clock end of the dilation scale, made quantitative.
- **Honesty.** The toy order-3 model is *worse* than the frontier codecs everywhere (4.98× vs 17.2× on cube-delta). This doc measures the **field**, not a winning codec; the production predictor (§6, E1) is unrun.

---

## 5. External grounding (every URL verified)

**Code length is a metric (the rigorous core):**
- Shannon source coding theorem — optimal length `−log₂p`, `H ≤ L̄ < H+1`. [en.wikipedia.org/wiki/Shannon's_source_coding_theorem](https://en.wikipedia.org/wiki/Shannon%27s_source_coding_theorem)
- Kraft–McMillan inequality — lengths ↔ distributions bijection. [en.wikipedia.org/wiki/Kraft–McMillan_inequality](https://en.wikipedia.org/wiki/Kraft%E2%80%93McMillan_inequality)
- Arithmetic coding — realises `−log₂p` to < 2 bits/stream. [en.wikipedia.org/wiki/Arithmetic_coding](https://en.wikipedia.org/wiki/Arithmetic_coding)
- Kolmogorov complexity / MDL (Rissanen) — intrinsic proper length + computable two-part code. [en.wikipedia.org/wiki/Kolmogorov_complexity](https://en.wikipedia.org/wiki/Kolmogorov_complexity)

**Curvature of a compression model is real (info geometry):**
- Fisher information metric = Hessian of KL; Chentsov uniqueness. [en.wikipedia.org/wiki/Fisher_information_metric](https://en.wikipedia.org/wiki/Fisher_information_metric)
- Rissanen stochastic complexity = `−log p + (k/2)log(n/2π) + log∫√det I(θ)dθ` (Riemannian volume). [arXiv:1808.00212](https://arxiv.org/pdf/1808.00212), [Sun, PMLR v37](http://proceedings.mlr.press/v37/suna15.pdf)
- Balasubramanian, *Occam's razor / statistical mechanics on probability space* — scalar curvature in code length. [arXiv:adap-org/9601001](https://arxiv.org/pdf/adap-org/9601001)

**Model = compressor; variable compute per token (the engine):**
- DeepMind, *Language Modeling Is Compression* (ICLR 2024). [arXiv:2309.10668](https://arxiv.org/abs/2309.10668)
- Bellard, *ts_zip* (LLM + arithmetic coder). [bellard.org/ts_zip](https://bellard.org/ts_zip/)
- PonderNet [arXiv:2107.05407](https://arxiv.org/abs/2107.05407); CALM [arXiv:2207.07061](https://arxiv.org/abs/2207.07061); Mixture-of-Depths [arXiv:2404.02258](https://arxiv.org/abs/2404.02258)
- Ouro LoopLM (the project's own coder) [arXiv:2510.25741](https://arxiv.org/abs/2510.25741)

**Closest prior to the *composite* (so novelty is stated honestly):**
- Fisher-metric MDL geometry (above) is the nearest antecedent to "metric = code-length field" — a 30-year-old result. The genuinely unclaimed piece is *attaching* it to CSF's 3¹² Status-Cube×τ tesseract as a stored, round-trip-verified format with MDL-geodesic retrieval. A bare "time dilation = compression" slogan exists as a fringe preprint and is **not** cited as support.

---

## 6. Falsify before you believe

Per the repo's standard (trust the table over the prose). Both kills require a small instrumentation change first: [`loop_lm.generate`](../../src/sigma0/loop_lm.py) returns only aggregates (`mean_depth`, `mean_contraction`) — it must surface **per-token** converged depth τ *and* per-token `L = −log₂ p*` before either experiment can even be computed (itself the tell that the bridge is unmeasured today).

| # | Claim under test | Method | Kills the claim if… |
|---|---|---|---|
| **E1** (load-bearing) | Compute-depth dilation **buys** bit dilation | Ouro `--mode converge`, emit bits/cell from converged `p*` via a real arithmetic/ANS coder, **round-trip verify lossless**, compare total bytes (incl. model/header amortization) to the **round-trip-verified CSF-Omni** baseline on the three corpora | the adaptive-depth coder does **not** strictly beat CSF-Omni's verified bytes on ≥1 corpus → it is just a costlier path to the same frontier |
| **E2** (the geometry) | `depth τ ↔ code length L` (the warp is the model) | instrument `generate()` for per-token τ and `L=−log₂p*`; test `corr(τ, L) > 0` on real Ouro | τ and L are uncorrelated → "depth ↔ bits" is empty and the warped-metric reading is decoration |
| **E3** | The field is a real, non-uniform metric | [`lapse_field_demo.py`](../../experiments/lapse_field_demo.py) field std + horizon/flat split on real corpora | **already run (§4): passes** — std 1.28–3.03 b/B, 62–70 % wells on lattice data |
| **E4** | Geodesics (low-L paths) beat the flat wavefront for retrieval | route retrieval by cumulative `L` vs the current information-density heuristic on the eval set | equal/worse retrieval at equal budget → the metric adds nothing operationally |

**E1 is the load-bearing experiment.** If converge-depth coding does not beat CSF-Omni's verified bytes, the entire "compute-depth dilation" thesis collapses to a relabeling, exactly as the spiral paper's E2 would collapse it to a relabeling of Q-exit. Numbers for E1/E2/E4 **do not exist yet**; until they land on the leaderboard this document is a *design with one measured field*, not a result — by design.

---

## 7. Honest scope

- **Not new physics, not new information theory.** Shannon (1948), Kraft (1949), Kolmogorov (1965), Rissanen (1978), Amari/Chentsov, Balasubramanian (1996) own the rigorous core. The contribution is the **applied data structure** + the CSF attachment + the measured field.
- **The relativity layer is metaphor scaffolding** with a stated mechanical failure point (signature + domain, §3.3). "Time dilation," "well," "horizon" are intuition pumps; the substance is a Riemannian code-length metric.
- **No ratio is claimed to beat the frontier.** CSF-Omni only *ties* brotli (it is the upper envelope + a 7-byte header); the toy lapse model is worse than all frontier codecs (§4). Any future win is E1's to earn, round-trip-verified.
- **Extension, not sprawl.** The Lapse Tesseract is a **metric on the one canonical 3¹² lattice** (qutrit_delta + quantum_dust + converged_tesseract), not a second CSF/tesseract thread — consistent with the North Star and the two prior consolidations.
- **The bridge is unbuilt and unmeasured.** `converge_step` depth is never fed to a bit-counter; `mean_contraction` is null on every real leaderboard row; the real-Ouro contraction run is still blocked on a `huggingface-hub` conflict. The honest status of the headline mechanism is **[hypothesis]**.
