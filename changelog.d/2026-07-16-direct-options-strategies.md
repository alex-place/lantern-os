Added the **direct options-strategy PROPOSAL engine** (#2589) on top of the
options data layer: `lib/options-strategies.js` — pure, deterministic functions
over a normalized chain (no network in the module) proposing **covered calls,
cash-secured puts, and collars only**; naked short options are permanently out
of scope and refused (shares < 100, or cash that can't fully collateralize one
contract, come back as honest `{ ok:false, reason }`). Strikes are picked by
|delta| closest to target inside the DTE window (default 21-60), **falling back
to ~3-7% OTM moneyness ranking when the chain carries no greeks — the output
says which path was used**. Premiums are quote MARKS ((bid+ask)/2), never
fills; the half-spread is an explicit cost line (real option spreads are the
dominant execution cost, arXiv:2511.02518); assignment risk is a labeled proxy
(|delta| or moneyness), and every proposal carries a decision-support
disclaimer. When the delta came from the keyless Yahoo path it is labeled
`model(bs-from-iv)` (vs `provider` for real feed greeks) on the proposal, its
legs, and the risk proxy. Exposed at
`GET /api/trading/options/strategies?symbol=&strategy=` (underlying price:
explicit `price=`, else the provider's own quote, else put-call parity at the
ATM strike) and as the `options_strategy` chat tool (loopback; NO API key
required — provider failures are relayed honestly). ADVISORY ONLY: nothing is
placed, simulated, or recommended for execution — Act stays behind the
ADR-0020 gates. Offline suite `tests/test_options_strategies.js`; verified
end-to-end against the real keyless SPY Yahoo chain (1,945 contracts).
(Improves Reason — strategy proposals grounded in real chain evidence.)
