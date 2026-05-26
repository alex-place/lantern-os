# Satoshi-Style Local Wallet Principles

Generated: 2026-05-26.

Sources:

- operator-provided Satoshi Nakamoto article excerpt;
- local Bitcoin PDF at `C:\Users\alexp\Downloads\bitcoin.pdf`;
- Lantern OS local cash sprint requirements.

Validated local PDF:

```text
Header:  %PDF-1.4
Size:    184292 bytes
SHA256:  B1674191A88EC5CDD733E4240A81803105DC412D6C6708D53AB94FC248F4F553
```

This file uses the Satoshi story as design inspiration, not as an identity
claim and not as investment advice.

## Principles For Lantern

1. Keep the ledger local-first and auditable.
2. Separate identity claims from cryptographic or file evidence.
3. Treat untouched balances as proof of discipline, not proof of ownership.
4. Do not count pending promises as cleared cash.
5. Keep public proof assets separate from private keys, payment links, and
   customer details.
6. Prefer simple text ledgers, hashes, and reproducible artifacts before
   complex financial infrastructure.
7. Build trust through before/after work, invoices, and delivery evidence.
8. Make every wallet state reproducible from local files and event history.

## Applied To The COMET LEAP Cash Sprint

- `local-cash-wallet.json` is the state snapshot.
- `ledger.jsonl` is the append-only event stream.
- `invoices/` holds draft and sent invoice records.
- Cleared cash stays at `$0` until money actually clears.
- The first invoice is a $199 Local RAG / Repo Cleanup Sprint pilot.

## Not Included

- No cryptocurrency wallet keys.
- No speculative token issuance.
- No fake revenue.
- No customer secrets committed to Git.
