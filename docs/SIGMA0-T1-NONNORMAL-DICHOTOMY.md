# Theorem 1 (non-normal) — the spectral-dichotomy extension + HANDOFF

**Status: DRAFT / IN PROGRESS — core empirically confirmed, proof + machine-check not yet landed.**
This closes (or aims to close) the **contraction half of [#768]**: Theorem 1's collapse-onto-the-
manifold guarantee, which the [Collapse Certificate](SIGMA0-COLLAPSE-CERTIFICATE.md) §1 proves only
for **normal `A`**. The C3 *anti-freeze* half of #768 is already closed (see
[SIGMA0-C3-NONCOLLAPSE-NORMAL.md](SIGMA0-C3-NONCOLLAPSE-NORMAL.md) §7); this doc is the **other**
half — the *drift* question, not the *rescue*.

> **Do not cite as PROVEN.** Claim (a) is verified to machine precision; claims (b)/(c) are
> confirmed on three designed cases; the randomized machine-check has a known check-bug (below) and
> the suite tests + certificate function + full proof are **not yet written**. This is a handoff.

---

## 0. The idea (why the symmetric split was the wrong tool)

Theorem 1 splits state space by the **symmetric part** `A_s = ½(A+Aᵀ)` (orthogonal eigenbasis) and
runs a Lyapunov energy `V = ½‖P_M x‖²` on the active modes. For non-normal `A` the cross-term
`P_M A P_N ≠ 0` (the §1.1 obstruction) breaks `V̇ ≤ 2αV`, and worse — §2 already notes the
`A_s`-null manifold isn't even invariant under the real flow. So "collapse onto the `A_s`-null
manifold" is genuinely **false** for non-normal `A`, not merely unproven. The `A_s` split is an
artifact that is exact only when `A` is normal (`A = A_s`).

**The fix: split by `A`'s own spectrum (the oblique Riesz projector), not `A_s`'s.**

---

## 1. Theorem (non-normal contraction dichotomy)

Let `ẋ = Ax`, `A ∈ ℝⁿˣⁿ` (possibly non-normal). Fix `δ > 0` with no eigenvalue on the line
`Re λ = −δ` (a spectral gap). Let `Π_M` be the **Riesz spectral projector** onto
`M = ⊕{generalized eigenspaces with Re λ < −δ}`, `N` the complementary invariant subspace
(`Re λ ≥ −δ`), `Π_N = I − Π_M`.

**(a) Invariance — the cross-term vanishes.** `AM ⊆ M`, `AN ⊆ N`, so `Π_M A = A Π_M` and hence
`Π_M A Π_N = 0`. The obstruction that defeats the §1 energy proof is *identically zero* in `A`'s
own spectral basis. *(Verified: `‖Π_M A − A Π_M‖ ≤ 3e-11` over 600 random non-normal `A`.)*

**(b) Active decay with bounded transient.** `A_M := A|_M` (the active block in an orthonormal
basis of `M`, `A_M = BᵀAB`) has spectral abscissa `< −δ` — Hurwitz. The Lyapunov equation
`A_Mᵀ P + P A_M = −I` has a unique `P ≻ 0`; with `V(ξ)=ξᵀPξ`, `V̇ = −‖ξ‖² ≤ −V/λ_max(P)`, so

> `‖Π_M x(t)‖ ≤ √(cond(P)) · e^{−t / (2 λ_max(P))} · ‖Π_M x(0)‖ → 0`.

The prefactor `√cond(P)` is the **transient overshoot**: for non-normal `A_M` it can be `≫ 1` but
is always finite, and is equivalently bounded by the Kreiss constant
`K(A_M) ≤ sup_t‖e^{tA_M}‖ ≤ e·n·K(A_M)`. *The active modes always die; non-normality shows up only
as a bounded overshoot, never as a failure to contract.*

**(c) Dichotomy — fate decided purely by the slow block.** Let `β = max{Re λ : λ ∈ spec(A_N)}`
(the slow-block spectral abscissa).
- `β > 0` ⟹ a mode in the open RHP ⟹ `‖x(t)‖ → ∞` (generic `x0`): **divergence**.
- `β ≤ 0` and `A_N` semisimple on the imaginary axis ⟹ `sup_t‖e^{tA_N}‖ < ∞` ⟹ `‖Π_N x(t)‖`
  bounded; with (b), `x(t) → N`: **collapse onto the center/slow manifold** (the generalized
  42-state).

By (b) the active part *always* decays, so only `sign(β)` decides the fate — **no third option**:
no trajectory both keeps the active part alive and avoids the collapse/diverge dichotomy.

**Caveat (the honest edge).** A *defective* (Jordan) eigenvalue exactly on `Re λ = 0` gives
polynomial growth — a measure-zero, non-generic boundary; conservatively classify it as
non-collapse. And `Π_M` is ill-conditioned when an eigenvalue sits within `~GAP` of the split line
`−δ`; choose `δ` in a spectral gap.

**Relation to Theorem 1.** For normal `A`, `A_s = A`, the Riesz projector *is* the orthogonal
`A_s`-projector, and this reduces to Theorem 1 exactly. So T1-NN is a strict generalization, and
Theorem 1 is its normal-`A` special case.

---

## 2. Evidence so far

| Claim | Status | Artifact |
|---|---|---|
| (a) invariance `‖[Π_M,A]‖≈0` | **verified** (≤3e-11, 600 random non-normal A) | `experiments/prove_t1_nonnormal_dichotomy.py` |
| (b) active decays, bounded transient | confirmed on 3 designed cases; sweep check-buggy | `experiments/explore_nonnormal_contraction.py` |
| (c) dichotomy, no third fate | confirmed on 3 designed cases (collapse×2, diverge×1); sweep check-buggy | both scripts |
| small-gain `alpha` over-rejects these | shown (+26, +18, +8.7 on genuinely-contracting non-normal A) | `explore_nonnormal_contraction.py` |

`explore_nonnormal_contraction.py` (the 3 designed cases) is **clean and passing**. The randomized
sweep `prove_t1_nonnormal_dichotomy.py` currently **FAILS its own (b)/(c) asserts** — not because the
theorem is wrong, but because the *check* is wrong (see §3).

---

## 3. HANDOFF — exact remaining work

**3.1 Fix `experiments/prove_t1_nonnormal_dichotomy.py` (the check-bugs, diagnosed):**
- **Evolve via reduced dynamics, not the full `expm(A·t)·Π x0`.** Evolving the full propagator and
  projecting amplifies projector roundoff in the unstable direction (observed blow-up ratio ~1e38).
  Instead: `B = ON basis of range(Π_M)` (SVD), `A_M = BᵀAB`, evolve `c(t) = expm(A_M·t)·(Bᵀx0)`;
  likewise `C, A_N` for the slow block. Both stay inside their invariant subspace — no leakage.
- **Use the correct Lyapunov envelope.** The bound is `‖e^{tA_M}‖ ≤ √cond(P)·e^{−t/(2λ_max(P))}`
  with `P` solving `A_MᵀP+PA_M=−I` — decay rate `1/(2λ_max(P))`, **not** `−max Re λ`. (The current
  script used `−max Re λ` as the rate, which is asymptotically right but not a valid finite-`t`
  envelope with the `√cond(P)` constant.)
- **Classify fate as collapse(bounded)-vs-diverge, not decay-to-zero.** Slow modes at
  `Re λ ∈ (−δ, 0]` stay *bounded*, they don't reach 0 in finite time. Check `sup_t‖e^{tA_N}c‖`
  bounded (β ≤ 0) vs blow-up (β > 0).

**3.2 Add `dichotomy_certificate(A, delta)` to `src/cio_sde/collapse.py`.** Returns the spectral
split (via ordered real Schur `scipy.linalg.schur` + reordering, or `eig` for diagonalizable `A`),
`active_abscissa`, `transient_bound = √cond(P_M)`, `slow_abscissa = β`, and
`fate ∈ {COLLAPSE, DIVERGE, BOUNDARY}`. **Reuse the existing machinery:** `stability_gates()` already
computes the Lyapunov `P`, `√cond(P)`, and the Kreiss bound — apply it to the active **block** `A_M`
instead of the full `A`. This is mostly wiring, not new code.

**3.3 Suite tests (`tests/test_cio_sde.py`):**
- `test_t1_nonnormal_invariance` — `‖Π_M A − A Π_M‖ < 1e-8` on a designed non-normal `A`.
- `test_t1_nonnormal_active_decays` — active component within the certified envelope; final ≪ initial.
- `test_t1_nonnormal_dichotomy` — fate matches `sign(β)` on a designed collapse case and a diverge case.

**3.4 Promote this doc** DRAFT → PROVEN-in-regime once 3.1–3.3 are green; write the full proof (the
§1 statements are proof-complete modulo standard Lyapunov/Riesz facts — Daleckii–Krein exponential
dichotomy, Coppel). Then update [SIGMA0-COLLAPSE-CERTIFICATE.md](SIGMA0-COLLAPSE-CERTIFICATE.md) §1:
add §1.4 "non-normal via spectral dichotomy", and move the [#768] *contraction* frontier from open to
closed (Theorem 1's `A_s` split becomes the normal-`A` special case).

**3.5 Scope honesty (carry forward).** This is *contraction-onto-the-manifold for the local linear
Jacobian*. It is NOT a global non-collapse guarantee — grounding remains the safety mechanism. And
"machine-checked" here will mean closed-form algebra + sweep + pytest, **not** Lean.

---

*Source of record for the math: this doc + `experiments/explore_nonnormal_contraction.py` (clean) +
`experiments/prove_t1_nonnormal_dichotomy.py` (needs the §3.1 fix). The reusable Lyapunov/Kreiss
machinery is `stability_gates()` in `src/cio_sde/collapse.py`.*
