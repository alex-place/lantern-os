# Handoff: Can Ouro L1–L4 be hot-swapped agents/providers via PCSF?

**Date:** 2026-06-19
**Repo:** `C:\dev\lantern-os` (never the OneDrive copy)
**Research question:** "Can L1–4 be represented by hot-swapped agents or providers on our version of Ouro using PCSF? — we designed CSF and PCSF to have VM hot-swapping."

## TL;DR — yes, at the CIO-SDE VM layer, gated by drift-equivalence

The hot-swap was **designed in** ([`src/cio_sde/engine.py`](../../src/cio_sde/engine.py): *"hot-swappable graph, deterministic (replayable) rollout"*) and is **tested both ways** ([`tests/test_cio_sde.py`](../../tests/test_cio_sde.py)). The trick is the **layer**: the handoff between L1–L4 is a **format-defined state vector `x ∈ R^d`**, not a provider-specific hidden tensor — so a different agent/provider can take over a step as long as it operates on the same state ABI and preserves behaviour.

| Layer | L1–L4 means | Hot-swap via PCSF? |
|---|---|---|
| **CIO-SDE VM** ([`cio_sde/engine.py`](../../src/cio_sde/engine.py)) | rollout steps over state vector `x` (+ `Σ`); each step = a `Dynamics` node | **Yes** — `GraphController.hot_swap()` swaps the node iff drift-equivalent. **This is the "VM hot-swap" the design means.** |
| **API re-prompt loop** ([`lib/loop-reasoner.js`](../../apps/lantern-garage/lib/loop-reasoner.js)) | 4 text round-trips (`MAX_LOOPS=4`) | **Yes** — text boundary, route each step to any provider (allows *behavioral diversity*, unlike the VM). |
| **Native Ouro tensor loop** ([`src/sigma0/loop_lm.py`](../../src/sigma0/loop_lm.py)) | 4 weight-tied recurrent steps passing **Ouro's hidden tensors** | **No** — no shared ABI across providers; weight-tied latent space is Ouro-specific. |

## The VM, concretely (the "yes" path)

- **Register file** = state vector `x ∈ R^d` (+ covariance `Σ`). Handoff is a **format-defined state**, not a provider hidden tensor — this is why the VM swaps where raw Ouro tensors can't.
- **Swappable execution unit** = `Dynamics` node (drift `f`, diffusion `g`). L1–L4 = rollout steps; each step's node may be a different agent/provider.
- **Hot-swap** = `GraphController.hot_swap()` ([engine.py:177](../../src/cio_sde/engine.py)). σ: v₁→v₂ valid **iff** `‖f_old(x,u) − f_new(x,u)‖ / ‖f_old‖ < tol` (tol=0.25) on a probe batch, under `no_grad` (swap is a discrete outer event, off the SDE gradient tape). Tested: accepts identical twin (`drift_delta < 1e-5`), rejects divergent stranger.
- **PCSF** = `PCSFController` policy (`u* = argmin H`, NAP-clamped) that drives each step.
- **CSF** = serialization of `x` + the **replayable `Trace`** (Invariant 2, `test_rollout_is_replayable`) = the **migratable VM snapshot**.

## ⚠️ PCSF is overloaded — two distinct things (flag for handoff)

| Expansion | File | Role |
|---|---|---|
| **Priority Constraint Satisfaction Framework** | [`cio_sde/engine.py:80`](../../src/cio_sde/engine.py) | SDE control policy `u* = argmin H` — **this is the VM-hotswap PCSF** |
| **Provider Capacity State Format** | [`convergence_io/pcsf.py`](../../src/convergence_io/pcsf.py) | text-boundary provider routing/fallback (circuit breakers, quota, tiers) |

Both are relevant but operate at different layers. The VM hot-swap uses the first; per-turn cloud-vs-local provider routing uses the second.

## Two conditions that bound the "yes"

1. **The swap gate is behaviour-PRESERVING.** It swaps in an *equivalent* node (route around an unavailable/expensive provider with one computing the same step). **"L1=Claude-reasoning, L2=DeepSeek-doing-something-different" FAILS the gate by design** (drift delta ≥ tol). Swap-for-**equivalence/availability/cost**, not swap-for-**behavioral-diversity**. If you want diverse-per-layer behavior, use the text-boundary re-prompt lane, not the VM.
2. **Nodes must share the `d`-dim state ABI** — exactly what CSF provides, exactly what Ouro's weight-tied hidden tensors do *not* provide across providers.

## The one honest gap (the actual build task)

The VM-hotswap machinery is real and tested, but it operates on the **abstract SDE state `x`**. **Ouro's concrete `loop_lm.py` recurrence is NOT routed through `CIO_SDE`** — no import path connects them (verified by grep 2026-06-19). So "Ouro L1–L4 → CIO-SDE rollout steps with hot-swapped provider nodes" is **designed-for but not yet wired**.

### Build steps for whoever picks this up
1. Define the **state ABI**: map an Ouro recurrent step's carry into the `d`-dim `x` (or wrap Ouro as a `Dynamics` node whose `drift` advances one recurrence). This is the hard part — Ouro's hidden state ≠ a clean `R^d` vector today.
2. Register candidate provider/agent steps as `Dynamics` nodes over that shared `x`; gate insertion through `GraphController.hot_swap()` (equivalence probe already implemented + tested).
3. Drive the rollout with `PCSFController`; persist `x` + `Trace` as a **CSF snapshot** for migrate/resume.
4. Decide cross-provider routing (which equivalent node to try) from the **Provider Capacity State Format** PCSF (`pcsf.py` `get_routable_chain()`) + the `compositeScore` leaderboard ([`leaderboard-routing.js`](../../apps/lantern-garage/lib/leaderboard-routing.js)) — so an unavailable/`QUOTA_HIT` provider's step routes to a routable equivalent.
5. **Open question to settle first:** is there a *meaningful* set of cross-provider nodes that pass the drift-equivalence gate (tol=0.25)? If no two providers are behaviourally equivalent on `x`, the VM hot-swap reduces to "swap your own cheaper/cached implementation," and cross-provider diversity must live in the text-boundary lane instead. Probe this before building.

## Grounding / honest scope
- "oura" = **Ouro** (LoopLM, [arXiv:2510.25741](https://arxiv.org/abs/2510.25741)); see [OURO-LOOPLM.md](../OURO-LOOPLM.md).
- Hot-swap + replay are tested in [`test_cio_sde.py`](../../tests/test_cio_sde.py) (`test_hot_swap_accepts_equivalent_node`, `test_hot_swap_rejects_divergent_node`, `test_rollout_is_replayable`).
- Ouro↔CIO_SDE wiring, and any CSF snapshot of `x`/`Trace`, are **not implemented** — this handoff is a feasibility verdict + build plan, not a shipped feature.
