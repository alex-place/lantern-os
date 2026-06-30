# The loop is a pumped, lossy resonator — a laser, not an echo chamber

**Date:** 2026-06-30
**Status:** research note (design principle) — feeds [ADR-0011](../adr/0011-proprietary-sigma0-base-model.md), the two-canary axes, and the Verify stage.
**Loop stages:** Reason (resonance) · Observe (pump) · Verify (leak).

## The principle, stated as physics not metaphor

A mirror cavity that only bounces is a **resonator**, and a resonator does two real
things — neither of them "create energy":

1. **It selects.** Round-trips reinforce the modes that constructively interfere
   (standing waves that fit the room) and cancel the rest. A smear of light becomes
   a few sharp, coherent modes. That is *coherence + selection*, not amplification.
2. **It stores with loss.** Real mirrors leak; "bounce forever" is really "bounce
   until it decays." The cavity's Q is just how slowly it loses.

A cavity **lases** — light that grows on each pass — only with a **gain medium and an
external pump**, bled by a **leak**. The round-trips don't make the energy; the pump
does, and the leak is what keeps the beam anchored instead of runaway. Pull the pump
and the most perfect mirror room rings down to dark. Seal the leak and it is not a
laser — it is an echo chamber that converges, beautifully, on nothing.

## The exact mapping to the Convergence loop

| Optics | Loop | Mechanism (real, in-repo) |
|---|---|---|
| Bouncing / re-circulation | recurrence | recurrent depth (Ouro Q-exit; PLT 2-loop, ADR-0011), re-circulated memory + context |
| **Resonance** (what bouncing buys) | Reason | amplifies claims that mutually reinforce **and** fit the room; damps noise → coherence + selection |
| **Pump** (external energy in) | **Observe** | external evidence entering the cavity — the External Reality Rule made physical |
| **Leak** (loss term) | **Verify** | continuously bleeds off modes that resonate internally but anchor to nothing |

The whole difference between a laser and an echo chamber is the last row. A cavity with
**gain but no loss term** does not amplify signal — it amplifies *runaway internal
consistency*: maximally coherent, maximally self-reinforcing, anchored to nothing. That
is exactly the **confident-but-unanchored** axis of the groundedness canary
([[sigma0-two-canary-axes]]) — i.e. hallucination. Recurrence without a pump and a leak
is the precise mechanism the North Star forbids; recurrence *with* them is "high
exploration + mandatory verification" restated in physics.

## The concrete leak handle already exists — and is unspent

The loss term is not hypothetical. It is the per-token **surprise** signal:

- `surprise_i = −log₂ p(token_i)` [bits] — the per-token code length — implemented in
  [`token-surprise.js`](../../apps/lantern-garage/lib/token-surprise.js) and wired into
  the groundedness canary as `signals.modelUncertainty`
  ([`groundedness-canary.js:148`](../../apps/lantern-garage/lib/groundedness-canary.js)).
  High surprise concentrated on content tokens = the model was *guessing the specifics
  it stated fluently* (token-level reading of semantic-entropy confabulation, Farquhar
  et al., Nature 2024). It is the one live carry-forward from the E1 kill doc
  (`docs/research/2026-06-28-csf-tesseract-novelty-and-e1-kill.md` §7 — "the lapse FIELD
  is real even though depth-as-storage was killed").

**But the valve is closed.** No production caller parses provider logprobs into it —
`fromOpenAILogprobs` / `fromOllamaLogprobs` are referenced only by the module and its
tests, so `modelUncertainty` is **always 0** in the live loop. The leak is installed and
plumbed to the canary, but no energy bleeds through it. The resonator is, today, a
sealed room.

## Why our owned local model is the cavity that can lase

The leak only opens where we can read the light leaving the mirrors — the per-token
logprobs. By that module's own design note, **Anthropic exposes none** (graceful no-op).
A **local PLT decode stream emits them natively.** So the model verified under ADR-0011
is not merely the resonator (recurrence); it is the only member whose decode we control
well enough to **open the leak**. Owning the model is what lets us close the loop:
recurrence (resonance) + Observe (pump) + surprise-damped Verify (leak), in one cavity
we own end to end.

## The actionable hypothesis (do NOT build yet — Stage-0 faithful parity first)

> Opening the leak — feeding real per-token surprise into the groundedness canary so it
> continuously damps confident-but-unanchored generation — raises verified-pass-rate and
> lowers the groundedness-canary firing rate on held-out tasks, **versus** the same loop
> with the valve closed (`modelUncertainty = 0`).

- **Pump (Observe):** evidence retrieval already feeds the loop; keep it the energy source.
- **Leak (Verify):** parse the local decode's logprobs → `surpriseField` → `modelUncertainty`;
  let it down-weight / re-route resonant-but-surprised spans, not just score them.
- **Guardrail:** the leak must never be the *only* term — a loss term with no pump just
  damps to silence. Resonance is kept; the room is simply not sealed.

This is a Reason/Verify research thread that rides the existing canary + surprise
primitives and the owned looped model. It adds **no** subsystem. Capture the resonance;
do not seal the room.

## Evidence

| Claim | Evidence (file:line) | Confidence | Source |
|---|---|---|---|
| Per-token surprise `−log₂p` is implemented as the Verify/groundedness primitive | [`token-surprise.js:8`](../../apps/lantern-garage/lib/token-surprise.js) | High | repo |
| It feeds the groundedness canary as `modelUncertainty` | [`groundedness-canary.js:148`](../../apps/lantern-garage/lib/groundedness-canary.js) | High | repo |
| The valve is closed — no production caller plumbs real logprobs | grep: `fromOpenAILogprobs`/`fromOllamaLogprobs` only in module + tests | High | repo (2026-06-30) |
| Two collapse axes: degeneration + confident-but-unanchored | `collapse-canary.js`, `groundedness-canary.js`; [[sigma0-two-canary-axes]] | High | repo |
| Anthropic exposes no logprobs; local decode does | [`token-surprise.js:18-19`](../../apps/lantern-garage/lib/token-surprise.js) | High | repo |
| Elevated generation uncertainty predicts confabulation | Farquhar et al., *Nature* 2024 (semantic entropy) | Med | external |
| Recurrence is the resonance/exploration lever | [[sigma0-coder-spiral-consolidation]], ADR-0011 | Med | repo research |
