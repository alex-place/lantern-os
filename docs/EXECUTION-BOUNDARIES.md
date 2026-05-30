# Execution Boundaries

Status: master-branch release guard until v1.0.0.

Lantern OS should not split into hidden execution lanes. The only execution
lanes allowed from this repo before v1.0.0 are:

1. **AWS-safe deploy and operations checks**: build, start, health, mirror, and
   read-only cloud status validation.
2. **Kalshi public-data research**: unauthenticated market snapshots, watchlists,
   reports, and manual-review packets.

## Explicitly Blocked

- hidden miners;
- autostart miners;
- bundled third-party miner binaries;
- wallet custody;
- seed phrase or private-key handling;
- payout address collection as a required setup step;
- authenticated Kalshi order placement;
- automated trade execution;
- pooled capital;
- guaranteed-profit or payback claims.

Investor, stakeholder, or operator pressure does not bypass these gates. A
future issue can propose a visible opt-in adapter, but it must be local-first,
stoppable, logged, dry-run capable, and separately approved before runtime code
is added.

## Allowed Executable Work

Executable scripts may:

- validate the chat entrypoint;
- inspect local health and AWS mirror state;
- pull public Kalshi market data without authentication;
- calculate watchlist/research metrics;
- inventory owned hardware read-only;
- estimate mining economics from explicit CSV inputs.

Executable scripts must not start miners, install miners, custody wallets, place
orders, or claim live revenue.
