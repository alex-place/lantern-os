# CSF-Converge — a retrieval-anchored, surprise-routed compression mechanism

**Date:** 2026-07-22
**Type:** Mechanism design. Not a codec bolt-on — a *pipeline* that composes cross-domain
techniques and this project's own research into one compressor that uses assets a generic
compressor structurally cannot: a retrieval index over all prior memory, a resident predictive
model, and the loop's surprise field.
**Status:** Design + falsification plan. Each tier is grounded in a measured result or a named
technique; the *composition* is the contribution.
**Loop stage:** Remember (this is how the Memory object is stored).

**Grounding contract — External Reality Rule.** Every tier is tagged **[shipped]** (already in
CSF), **[measured]** (a number from this repo's experiments), **[grounded]** (external
technique, cited), or **[design — falsifiable]** (proposed here with a kill criterion).

**Reads first:** [`2026-06-29-csf-beating-zstd.md`](2026-06-29-csf-beating-zstd.md) (the #1593–1596
techniques this unifies) · [`2026-07-21-tesseract-application-map.md`](2026-07-21-tesseract-application-map.md)
§K1 (the surprise field) · [`2026-07-21-csf-cosmological-frontier.md`](2026-07-21-csf-cosmological-frontier.md)
(generative members) · [`2026-07-22-csf-patent-prior-art.md`](2026-07-22-csf-patent-prior-art.md)
(prior art per part).

---

## 0. The thesis a generic compressor can't touch

zstd/brotli/lzma are **stateless and windowed**: they compress a blob against *itself* within a
bounded window (32 KB–2 GB), with a fixed model, and they can't reach outside it. This project's
Remember stage has three assets none of them has:

1. **A retrieval index over the entire corpus** — every prior memory, convergence record, and
   ledger line, content-addressable by BM25 + embedding (`csf-memory.js`, `memory_engine.py`).
2. **A resident predictive model** — Ouro is loaded for reasoning anyway; its next-token
   distribution is a compressor's ideal arithmetic-coding model, at **zero marginal weight cost**.
3. **The loop's surprise field** — a per-unit signal (`token-surprise.js`, the dilation field)
   that already routes chat grounding and trade polling, and can route *bits*.

**CSF-Converge is the compressor that uses all three.** Its dictionary is the whole corpus (via
retrieval), its predictor is the resident model (amortized), and its effort is routed by surprise.
That is the genuine cross-domain synthesis — information retrieval + neural prediction + transform
coding + control theory — and it is exactly what a generic codec is architecturally unable to be.

---

## 1. The mechanism: a routed tier ladder

Each record enters a **cheapest-sufficient-tier router** and exits at the first tier that clears
a byte/latency threshold. Descending tiers cost more compute and win more only on *surprising*
data — so predictable records exit cheap, and the resident model is spent only where the cheap
tiers left real entropy. One member format, one decode contract.

```
 record ─► T0 route ─► T∞? ─► T1 RKD ─► T2 col ─► T3 omni floor ─► T4 GRC (cold)
           (classify)  recipe?  retrieval  schema    entropy         model-amortized
           transform   ∞ ratio  -anchored  columnar  best-fit        residual coder
                                 delta                (shipped)       (offline only)
              └──────────── surprise field decides how far to descend ─────────────┘
```

### T0 — Type routing (predict the transform, don't brute-force it) [measured + design]
A cheap content classifier (magic bytes, entropy of byte-planes, JSON-shape probe) picks the
**cross-domain transform** instead of running the whole omni panel: executable → **BCJ-x86**
(measured +16.45% on ooffice); fixed-width numeric array → **byte-shuffle** at the detected
stride (measured +7.7% on 4-byte arrays); JSONL → **shape-keyed columnar** (Col v2, shipped);
smooth 16-bit → **shuffle+delta** (SPDP, measured +0.85%); else passthrough. This is the
speed fix from the omni work made *predictive* — one transform chosen, not eight tried.
*Grounded in:* the cross-domain probe (this repo) + Blosc/HDF5 filter-routing + xz BCJ.

### T∞ — Generative members (recompute-as-storage) [shipped]
If a registered generator reproduces the record byte-for-byte (verified by materialize-then-sha),
store the **recipe**, not the bytes: `{kind, params, sha256}`. Already shipped (`csf_pack`, v0.9):
a 16 MiB lawful stream → ~3.5 KB. The router tries this first for recipe-bearing data (zeros,
counters, lawful/simulated streams, deterministic derivations of other members).

### T1 — Retrieval-keyed delta (RKD): the dust principle, globalized [design — falsifiable, #1594]
The core novelty. For a new record, query the **retrieval index** for its nearest prior
record across the *entire corpus*, and store a **lossless structural delta** against it
`{base_ref, delta}`. zstd's window can't reference a match 10 GB back; retrieval can reach an
*arbitrarily distant* base, so for the append-only ledgers — measured **70% "horizon" cells
(< 1 bit/byte)** on the 1 MB memory log ([lapse field](2026-06-20-lapse-tesseract.md) §4) — the
delta is often near-empty. This is the tesseract "dust" principle (*no-change is free*) made
**global and content-addressed** instead of window-bounded. Decode: fetch `base_ref` from the
index, apply the delta, verify the sha. *Constraint:* the base must be retained + the index
deterministic (see §3).

### T2 — Schema-columnar + typed coding [shipped, #1593]
The structural residual of the four canonical objects (Memory, Task, Tool, ConvergenceRecord)
goes through Col v2: row→shape-keyed-column transpose + typed per-column coding (epoch-delta
timestamps, dictionary enums, raw-FP confidence). Shipped; measured +5.2% over zstd-19 on
`records.jsonl`.

### T3 — Entropy floor (omni best-fit) [shipped]
Whatever structure the upper tiers exposed is handed to omni — the panel picks the strict-min
codec (zstd/brotli/lzma/bz2 + the domain transforms), self-describing header, integrity-checked.
This is the guaranteed floor: CSF-Converge is **never worse than shipped omni**, because omni is
the fallback tier.

### T4 — Grounded residual coding (GRC): the resident model as an arithmetic coder [design, #1595]
**Cold/offline archival only.** For the *surprising* residual the cheap tiers couldn't crush
(high-entropy free-text columns, novel deltas), use the **resident model** as the
arithmetic-coding predictor — DeepMind's "a predictor is a compressor" ([arXiv:2309.10668](https://arxiv.org/abs/2309.10668))
— fed **retrieved grounding context** so its distribution doesn't collapse, and gated by the
**Σ₀ NIS/anisotropy canary** as the per-token depth-exit (deeper is *worse* past collapse,
proven — [collapse cert](../SIGMA0-COLLAPSE-CERTIFICATE.md)). Weight cost is **zero** (resident),
which is the project-specific escape from the "LLM compression only pays at TB scale" wall
([arXiv:2601.02875](https://arxiv.org/html/2601.02875v1)) — and it *only* runs on the residual
above the T3 floor, so most tokens never touch the model. Model id+version stamped; a member can
always be **losslessly re-expanded to T3** on model swap (honors "models are interchangeable").

### The router = the surprise field [design — falsifiable, K1]
The same `dilation(uncertainty, …)` signal that decides chat grounding and trade polling decides
**how far a record descends**: low surprise ⇒ exit at T1 (a near-duplicate ledger line is a
reference + nothing); high surprise ⇒ descend to T3, and in cold mode to T4. Effort follows
entropy. This is control theory (spend where the innovation is) applied to the storage tier.

---

## 2. Container format (fits CSF-Pack, one byte of overhead)

CSF-Pack already carries per-member `{codec, sha256, offset}`. CSF-Converge adds a 1-byte
**tier tag** + a tiny tier-header per member; everything else is the existing container:

| Tier | tag | member header | decode |
|---|---|---|---|
| T∞ generative | `0xF` | `{kind, params}` | materialize → verify sha |
| T1 RKD | `0x1` | `{base_ref, delta_codec}` | fetch base by ref → apply delta → verify sha |
| T0/T2/T3 | `0x3` | `{transform_id, codec_id}` (omni method byte) | inverse-transform(decode) |
| T4 GRC | `0x4` | `{model_id, model_ver, ctx_ref}` | model+ctx → arithmetic-decode → verify sha |

Every member still carries its **sha-256**; decode of *any* tier ends in a hash check — the CSF
integrity contract is unchanged, so a tier bug can at worst refuse to decode, never corrupt.

---

## 3. Decode: deterministic, verifiable, degrade-safe

- **T∞/T0/T2/T3** decode with no external state (self-contained), exactly like today.
- **T1 RKD** needs its `base_ref` present — so a solid/framed archive keeps bases in the same
  container (or a referenced one), and packing orders bases before deltas. If a base is missing,
  the member reports a clean integrity error (never silent corruption).
- **T4 GRC** needs the stamped model. If unavailable, the member is un-decodable *as GRC* — so
  GRC is opt-in cold storage with a documented **rehydrate-to-T3** migration (decode once with the
  model, re-store at T3). This is the honest cost of model-coded data and is fenced accordingly.

Determinism is the load-bearing contract for T1/T4 (same base + same model + same params →
same bytes), verified per-member by the sha. No tier is trusted; every tier is checked.

---

## 4. Why this is novel (honest, and constructive)

Each *tier* is a known technique — RKD ≈ delta-against-a-dictionary, GRC ≈ LM-as-compressor,
T0 ≈ Blosc/omni transform routing, T∞ ≈ generative storage (all named with prior art in the
[patent review](2026-07-22-csf-patent-prior-art.md)). **The composition is the contribution,
and it is genuinely unoccupied:** no generic or published compressor routes each record — by a
loop-derived surprise signal — between a *retrieval-anchored global delta*, a *resident-model
residual coder*, and a *recompute-as-storage tier*, because no generic compressor **has** a
corpus-wide retrieval index or a resident model to amortize. That coupling is the project's own —
it turns the Memory object's two assets (the index, the model) into compression primitives.

Honest grade (consistent with the IP register): **systems-composition novelty**, defensive-
publication material, **not** a patentable algorithm. The gain is real and measurable; the moat
is the composition + the owned corpus it feeds on, not a new coding theorem.

---

## 5. Falsification plan (build order = ascending confidence)

Per the repo standard: state the kill before building. Measure whole-corpus bytes on
`data/csf_memory/*.jsonl` + `data/convergence/records.jsonl`, decode-verified, vs the shipped
**solid+omni** baseline.

| # | Tier | Claim | Kill criterion |
|---|---|---|---|
| C1 | T0 predictive route | Predicting the transform matches brute-force omni ratio at ≥2× speed | ratio drops >0.5% vs full-panel omni, or no speed win |
| C2 | **T1 RKD** (build first — highest EV) | Retrieval-anchored delta beats solid+omni on the append-only ledgers | RKD+omni ≤ solid+omni bytes on the real logs (then retrieval adds nothing over the window) |
| C3 | Surprise router | Routing by the field beats always-descend at equal ratio | routed pipeline slower *and* no better than fixed T3 |
| C4 | T4 GRC (cold) | Resident-model residual coding beats brotli-11 on the residual, model counted | doesn't beat T3 on the residual at usable cold-decode throughput (the E1 verdict at small scale — only reopens past the amortization corpus size) |

**Build C2 first.** The lapse field already measured the target (70% horizon cells on the memory
log) — RKD is where the retrieval index turns that structural redundancy into near-zero deltas,
and it's the one tier no generic compressor can replicate.

**C2 RUN 2026-07-22 → RKD is a SCALE tier, not a small-corpus tier [measured].**
[`experiments/csf_converge_rkd_probe.py`](../../experiments/csf_converge_rkd_probe.py) built a
real retrieval-anchored structural delta (global nearest-prior by token overlap + prefix/suffix
elision, round-trip verified) and measured it on the real ledgers:

| Corpus | solid+omni | RKD+zstd19 | verdict |
|---|---|---|---|
| `convergence/records.jsonl` (975 KB, 1215 lines) | 120,964 B | 138,351 B | **RKD loses −12.6%** |
| `csf_memory/raw.jsonl` (2.08 MB, 1590 lines) | 156,646 B | 180,783 B | **RKD loses −13.4%** |

The kill criterion **fires — for the data, not the law**: at 1–2 MB the ledgers fit *entirely*
inside zstd-19+LDM's window, so global retrieval reaches nothing the window doesn't already see,
and the per-record delta *fragments* the contiguous stream (back-refs + middles interleaved),
which the entropy coder likes *less* than the raw JSONL. This matches the 2026-06-29 research's
own deferral of RKD ("no headroom while logs fit zstd's window") — now measured, not assumed.

**What this means for the mechanism (honest).** At current corpus scale the *winning* CSF-Converge
tiers are the ones already **shipped** — T0 cross-domain transforms, T2 Col v2, T3 omni, T∞
generative — which win by exposing more structure to a *whole-corpus* coder. The novel tiers pay
only where their premise holds: **RKD when the corpus exceeds the coder's window** (the retrieval
index's whole reason to exist), and **T4 GRC only cold + past the model-amortization scale**. The
mechanism is correct; its scale tiers are simply premature at 2 MB, and the design says so up
front rather than shipping a fragmenting transform that loses. Re-run C2 when a ledger crosses
~a few hundred MB (beyond the LDM window) — that is RKD's real test.

## 6. Anti-sprawl

This is **one mechanism** that *unifies* the four scattered #1593–1596 techniques (Col shipped,
RKD/GRC/hybrid deferred) into a single routed pipeline, plus the shipped generative tier and the
surprise-field router — not four subsystems. It extends the one canonical CSF module
(`src/csf/`), reuses the existing retrieval index and resident model, and adds no new memory
system. Every tier terminates in the existing per-member sha. It strengthens exactly one loop
stage — Remember — which is the feature gate.
