# Lantern OS Apple Pay License Wallet Report

**Status:** design report / not a live payment integration  
**Branch:** `master`  
**Prepared:** 2026-05-26 America/New_York  
**Scope:** Apple Pay intake for per-license Lantern OS internal wallets

---

## Executive Summary

Lantern OS does not currently have a verified Apple Pay intake path in the repo.

The safe design is not a user-deposit wallet. The safe design is:

```text
Apple Pay / card / PayPal checkout
  -> payment processor merchant account
  -> settled business funds
  -> license entitlement event
  -> per-user internal Lantern license wallet ledger
```

The Lantern license wallet is an **internal entitlement ledger**, not stored value, not a bank account, not crypto custody, not a transferable balance, and not withdrawable cash.

Each licensed user can have one internal license wallet record that tracks:

- license state;
- cleared payments;
- invoices;
- refunds;
- access entitlements;
- usage credits if any;
- audit trail events.

Payment credentials, Apple Pay tokens, PayPal secrets, card data, seed phrases, government identifiers, and raw PIID must never be committed to Git.

---

## Current Repo Evidence

Existing wallet state:

```text
data/wallet/local-cash-wallet.json
```

Current repo wallet policy already defines the wallet as a local ledger, not a bank or crypto wallet, and says secrets/payment credentials must stay out of Git.

New repo additions in this convergence:

```text
.gitignore
data/private/README.md
data/wallet/license-wallet.schema.json
docs/LANTERN-LICENSE-WALLETS-APPLE-PAY.md
```

---

## Apple Pay Intake Options

### Option A - Stripe Checkout / Payment Links

Use Stripe-hosted Checkout or Payment Links with Apple Pay enabled where eligible.

Pros:

- fastest production path;
- hosted checkout reduces PCI/payment-token handling;
- can map successful payment events into license-wallet ledger events;
- supports subscriptions/invoicing flows depending on configuration.

Repo mapping:

```text
paymentProvider: "stripe"
acceptedMethods: ["apple_pay", "card"]
```

### Option B - PayPal Apple Pay Checkout

Use PayPal's Apple Pay checkout path only after merchant onboarding and domain verification.

Pros:

- can sit beside PayPal checkout;
- may fit existing PayPal operator habits.

Caveats:

- still requires live merchant setup;
- Apple Pay cannot work on an unregistered/unverified merchant domain;
- PayPal credentials and client secrets must never enter Git.

Repo mapping:

```text
paymentProvider: "paypal"
acceptedMethods: ["apple_pay", "paypal", "card"]
```

### Option C - Manual Invoice First

Use manual invoice and ledger entries until checkout infrastructure exists.

Pros:

- lowest engineering risk;
- keeps cash proof honest;
- avoids pretending a live Apple Pay flow exists.

Repo mapping:

```text
paymentProvider: "manual_invoice"
acceptedMethods: ["manual_invoice"]
```

---

## License Wallet Schema

Canonical schema:

```text
data/wallet/license-wallet.schema.json
```

Required invariants:

```json
{
  "walletType": "internal_entitlement_ledger_not_stored_value",
  "currency": "USD",
  "transferable": false,
  "withdrawable": false,
  "redeemableForCash": false
}
```

A license wallet may track payment events, but it must not become a cash-equivalent deposit account.

---

## Safe Event Flow

```text
1. license_created
2. invoice_drafted
3. invoice_sent
4. payment_pending
5. payment_cleared
6. entitlement_granted
7. refund_recorded / entitlement_revoked if needed
```

Only `payment_cleared` can raise `clearedCashUsd`.

Drafts, pending checkout sessions, failed payments, and projections do not count as cleared cash.

---

## PIID and Private House Rule

Private identifier material belongs only in a local encrypted private house.

Repo-safe committed policy stub:

```text
data/private/README.md
```

Local-only recommended path:

```text
C:\tmp\lantern-os\data\private\piid-vault\
```

Never commit:

- raw PIID/PII;
- private social feed exports;
- patient-style private evidence;
- Apple Pay payment tokens;
- card data;
- PayPal secrets;
- Stripe secrets;
- seed phrases;
- government IDs;
- bank account data.

---

## Legal / Compliance Boundary

This report is not legal advice.

The design intentionally avoids stored-value, transferable, withdrawable, or redeemable balances. If Lantern OS wallets ever allow user deposits, transfers between users, withdrawals, cash redemption, or custody of money/crypto, stop and get qualified legal/compliance review before building.

Safe wording:

```text
Lantern license wallet = internal entitlement and audit ledger.
```

Unsafe wording unless counsel approves:

```text
user deposit account
stored balance
cash wallet
transferable funds
withdrawable user balance
investment wallet
crypto custody wallet
```

---

## P0-P3 Fixes

| Priority | Fix | Status |
|---|---|---|
| P0 | No raw PIID in Git | Fixed with `.gitignore` private vault rules and `data/private/README.md` policy stub |
| P0 | No stored-value wallet claim | Fixed with schema invariants: non-transferable, non-withdrawable, not redeemable for cash |
| P1 | Per-user license wallet model | Fixed with `license-wallet.schema.json` |
| P1 | Apple Pay intake architecture | Fixed as processor -> settled funds -> entitlement ledger |
| P2 | Manual invoice fallback | Fixed as safe default before live payment integration |
| P2 | Evidence/event model | Fixed through event types and cleared-cash rule |
| P3 | Repo documentation | Fixed with this report |

---

## Next 2-4 Actions

1. Choose processor path: Stripe Checkout / Payment Links, PayPal Apple Pay, or manual invoice first.
2. Create a sample redacted license wallet JSON fixture under `data/wallet/examples/`.
3. Add a local-only `.env.example` with placeholder variable names only, not secrets.
4. Add webhook design doc before implementing payment event ingestion.

---

## Held Until Explicit Approval

- Live Apple Pay merchant onboarding.
- Stripe/PayPal API secret handling.
- Webhook implementation.
- Any user deposit, transfer, withdrawal, cash redemption, investment, or crypto custody feature.
- Storage of raw PIID in committed repo files.

---

## Source Notes

Primary public sources used for the accompanying PDF/report response:

- Apple Developer: Apple Pay overview.
- Stripe Docs: Apple Pay support for Checkout, Payment Links, subscriptions, invoicing, and related payment flows.
- PayPal Developer: Apple Pay setup and domain registration requirements.
- FinCEN guidance: accepting/transmitting value can trigger money transmission analysis.
