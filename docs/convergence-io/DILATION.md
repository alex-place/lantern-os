# TDF — Time Dilation Field

**Module:** [`src/convergence_io/dilation.py`](../../src/convergence_io/dilation.py) · **Role:** the **`D`** in CEG's `G=(V,E,D,τ,S,H)` · **Tests:** [`tests/test_dilation.py`](../../tests/test_dilation.py)

**Status:** Built and unit-tested. This is the piece whose *idea* most clearly reaches the live site — the JavaScript [`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) mirrors its "more unsure ⇒ check harder" mapping (see the [README](README.md#status-honest)).

## In one sentence

TDF is a per-step **"how hard should I think about this?" dial** — the system slows down and digs deeper where it's unsure, and speeds through where it's confident.

## The everyday version

Think of how you **take an exam**: you blow through the easy questions and spend the time you save on the hard ones. Same total effort, aimed where it actually matters. (The name nods to *gravitational time dilation* — time running slower in a stronger field — but you don't need the physics; "slow down on the hard parts" is the whole idea.)

Each step gets a number, `D`:

```
D > 1   →  unsure       →  slow down, explore, double-check
D = 1   →  normal pace
D < 1   →  confident (or under cost pressure)  →  go fast
```

That number then literally stretches or shrinks how much time and budget the step gets:

```
how long this step may take   =  base time  ×  D
how expensive its next move is      ×=  D
```

## The clever bit: it knows when *not* to slow down

There's a trap here. Right when the system is about to be **confidently wrong**, it's both very unsure *and* very low on confidence — exactly the combination that would crank the dial to maximum and leave it stuck deliberating forever (a "frozen, never-decides" loop).

So TDF has a release valve. When a step is near that frozen point, the dial is pushed **back down toward fast** — because the right move there isn't to think harder, it's to **go look** (act, or re-check against the outside world). There's also a hard backstop: any step stuck on "slow" for too many ticks in a row is forced back to fast. *Think when you're productively unsure; go look when you're stuck.*

## What's in the toolkit

**The dial itself — `dilation(...)`.** Takes uncertainty, cost pressure, confidence (and nearness-to-frozen) and returns the `D` number.

**The load-bearing bridge — `grounding_policy(D)`.** Turns that dial into a concrete **research budget**: how many sources to pull, how much corroboration to require, and whether to escalate to a deep mode. High `D` (genuinely unsure) ⇒ reach out and verify harder; low `D` ⇒ answer fast from what's already on hand. **This is the exact piece the live JavaScript path reimplements.**

**The per-graph state — `DilationField`.** Holds the dial for every step, recomputes it each tick from live signals (`update_node`, or `update_from_health` straight from health + latency readings), writes the values onto the graph (`apply_to_graph`), and enforces the anti-stall cap.

**The anti-thrash guard — `SwapConvergenceGuard`.** Stops the system from flip-flopping between two providers forever when the dial keeps re-routing — if the same swap happens too often in a short window, it's blocked.

## How it composes

`D` is what couples the plan to reality. Live health and latency from [PCSF](PCSF.md) feed in; the resulting `D` reshapes the time targets and costs the [CEG](CEG.md) optimizer uses; and `grounding_policy(D)` decides how hard the **Verify** stage works. More uncertainty ⇒ slower, more grounded execution — the project's "verification is mandatory" rule expressed as a single dial.

## Status & gaps

- **Working and tested** — the dial, the grounding-budget mapping, the anti-freeze release valve, health-driven updates, and the anti-thrash guard are all directly unit-tested.
- **The live consumer is the JavaScript version.** [`grounding-policy.js`](../../apps/lantern-garage/lib/grounding-policy.js) is what actually runs on the site; this Python module is its twin. They encode the same idea and should be kept in step, but they're separate code.
