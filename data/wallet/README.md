# Lantern Local Wallet

Generated: 2026-05-26.

Purpose: hold the factual cash state for the COMET LEAP 11-day sprint.

This is a local operating wallet, not a bank account, crypto wallet, Stripe
account, or legal accounting system. It records only evidence-backed cash
events:

- invoice drafted;
- invoice sent;
- payment promised;
- payment cleared;
- refund or cancellation;
- objection recorded.

## Rules

- Existing offers only.
- Do not mark revenue as received until funds clear.
- Keep draft invoices separate from cleared cash.
- Record every event in `ledger.jsonl`.
- Keep payment links, private customer details, and secrets out of Git.
- If a real payment provider is added later, store credentials outside this
  repo and record only non-secret references here.

## Current Wallet

Primary state file:

```text
data/wallet/local-cash-wallet.json
```

Ledger:

```text
data/wallet/ledger.jsonl
```

Invoice drafts:

```text
data/wallet/invoices/
```
