# Lantern Local Wallet

Purpose: hold the factual local cash state (originally created 2026-05-26 for
the COMET LEAP sprint).

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

## Principles

(Satoshi-style design *inspiration* — not an identity claim, not investment
advice. Provenance: local `bitcoin.pdf`, SHA256
`B1674191A88EC5CDD733E4240A81803105DC412D6C6708D53AB94FC248F4F553`, 184292 bytes.)

1. Keep the ledger local-first and auditable.
2. Separate identity claims from cryptographic or file evidence.
3. Treat untouched balances as proof of discipline, not proof of ownership.
4. Keep public proof assets separate from private keys, payment links, and
   customer details.
5. Prefer simple text ledgers, hashes, and reproducible artifacts before
   complex financial infrastructure.
6. Build trust through before/after work, invoices, and delivery evidence.
7. Make every wallet state reproducible from local files and event history.

## Not Included

- No cryptocurrency wallet keys.
- No speculative token issuance.
- No fake revenue.
- No customer secrets committed to Git.

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

## Payment Integration

Stripe invoicing runs through the payment bridge — see
[apps/lantern-garage/payment-bridge/README.md](../../apps/lantern-garage/payment-bridge/README.md).
