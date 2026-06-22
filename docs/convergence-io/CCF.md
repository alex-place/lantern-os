# CCF — Capability Claim Format

**Module:** [`src/convergence_io/ccf.py`](../../src/convergence_io/ccf.py) · **Principle:** P4 (Capability Constraints) · **Consumed by:** P5 (Boundary), P8 (Vendor Chain), P10 (Supply Chain) · **Tests:** [`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py)

**Status:** Built and unit-tested. Python reference version; not on the live chat path — see the [README](README.md#status-honest).

## In one sentence

Before an agent is allowed to do something, CCF makes it **prove it can actually do that thing right now** — capability is never assumed from a job title or a config file.

## The everyday version

Think of a **bartender checking your ID** instead of taking your word for it. Claiming something isn't enough; you have to show a valid, current proof. An expired ID doesn't count — and being good at spotting fakes matters too.

That's CCF. An agent says "I can do X." CCF checks that the claim is real, hasn't expired, comes from a provider that's actually up, and that the agent has a track record of telling the truth. Only then does the action go ahead. This is how the system enforces **"no overclaiming."**

## What's in the toolkit

**The claim — `CapabilityClaim`.** What an agent says it can do, plus the supporting details: which provider and model back it, what tools it has, whether it runs locally or in the cloud, and — crucially — **a clock.** Claims are time-boxed (60 seconds by default), so a stale claim isn't a live one. A claim can `verify()` itself (stamping the expiry), report `is_expired()`, and answer `has_capability(x)`.

**The honesty tracker — `HonestyTracker`.** Remembers, per agent, how often what it *claimed* matched what it *actually did* (`record_result`), and turns that into a rolling **honesty score** over recent actions (`score`). An agent that keeps overclaiming watches its score fall.

**The checkpoint — `CapabilityGate`.** The thing that actually says yes or no:

- It's wired to [PCSF](PCSF.md), so a claim whose provider is currently down gets rejected.
- It enforces an **honesty floor** — agents below the trust threshold are refused outright.
- It enforces **tiers** — some capabilities (like unlimited art generation) require a high enough user tier.
- `register_claim(...)` files a claim; `check(...)` returns a **`GateResult`** (`allowed`, plus the reason and the current honesty score).

## Where it sits in the safety stack

CCF runs **after** classification ([DCF](DCF.md)) and denials ([NAP](NAP.md)), and **alongside** routing ([PCSF](PCSF.md)). The question it answers: *does this agent provably hold the capability needed for this kind of data — is it honest enough, and is its provider actually live?* Concerns further out (boundaries, vendor chain, supply chain) read these claims to reason about who and what is in the loop.

## Status & gaps

- **Working and tested:** time-boxed claims, an honesty floor, the PCSF link, and a clear gate result, directly unit-tested ([`tests/test_pcsf_ccf.py`](../../tests/test_pcsf_ccf.py)).
- **The honesty score is only as good as its feed.** Something has to tell the tracker what actually happened (`record_result`); it's a feedback contract, not a mind-reader, and nothing auto-fills it on the live path yet.
