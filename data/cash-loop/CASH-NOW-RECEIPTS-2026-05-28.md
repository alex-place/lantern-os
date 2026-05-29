# Cash Now Receipts — 2026-05-28

Status: active receipt tracker; no cleared cash recorded.

Purpose: track the cash-now payment/request loop for the current outreach sprint
without storing secrets, customer private data, card/bank data, tax IDs, or raw
private messages.

## Privacy And Storage Boundary

Do not store any of the following in this file or related Git-tracked cash-loop
artifacts:

- credentials, API keys, recovery codes, or payment-provider secrets;
- customer private data, legal names, addresses, phone numbers, or email
  addresses;
- card numbers, bank account details, routing numbers, tax IDs, or tax forms;
- raw private messages, screenshots of private conversations, or private notes
  that could identify a recipient.

Use redacted lead labels only.

## Payment / Request Platform

| Field | Value |
|---|---|
| Selected payment/request platform | Pending founder selection / approval. |
| Non-secret payment/request URL | Not stored yet. Store only if founder approves and the URL contains no credentials, tokens, customer private data, or bank/card data. |
| Storage approval status | pending_founder_approval |

## Offer And Terms

| Field | Value |
|---|---|
| Offer name | Lantern Local RAG / Repo Cleanup Sprint |
| Price / pay-what-you-want terms | Entry pilot target: `$199`; acceptable pilot range: `$199-$499` depending on scope, unless founder explicitly approves pay-what-you-want terms before send. |
| Refund / terms note | Pilot terms must be confirmed before payment request is sent. If the engagement cannot be delivered after payment clears, refund or replacement-work handling requires founder approval and must be recorded without private customer details. |

## Outreach Contact Tracker

Allowed statuses: `drafted`, `sent`, `replied`, `invoice_sent`, `paid_pending`,
`payment_cleared`, `rejected`.

| Contact label | Offer | Status | Last safe note | Wallet ledger event path |
|---|---|---|---|---|
| warm-contact-01 | Lantern Local RAG / Repo Cleanup Sprint | drafted | Draft outreach only; no private details stored. | `data/wallet/ledger.jsonl` |
| warm-contact-02 | Lantern Local RAG / Repo Cleanup Sprint | drafted | Draft outreach only; no private details stored. | `data/wallet/ledger.jsonl` |
| warm-contact-03 | Lantern Local RAG / Repo Cleanup Sprint | drafted | Draft outreach only; no private details stored. | `data/wallet/ledger.jsonl` |
| warm-contact-04 | Lantern Local RAG / Repo Cleanup Sprint | drafted | Draft outreach only; no private details stored. | `data/wallet/ledger.jsonl` |
| warm-contact-05 | Lantern Local RAG / Repo Cleanup Sprint | drafted | Draft outreach only; no private details stored. | `data/wallet/ledger.jsonl` |

## Wallet Ledger Event Path

Ledger events for outreach, invoice, paid-pending, and cleared-payment milestones
belong in:

```text
data/wallet/ledger.jsonl
```

Use factual, redacted evidence strings only, for example:

```text
Sent warm message to warm-contact-01; no private details in Git.
```

## No-Cleared-Cash Boundary

No contact may be marked `payment_cleared`, and no ledger event may record
cleared revenue, until funds are externally confirmed as settled and available
by the selected payment/request platform or bank.

Before confirmed settlement:

- use `drafted` for unsent outreach;
- use `sent` after founder/operator sends the message;
- use `replied` only for a safe, non-identifying response summary;
- use `invoice_sent` only after the payment request or invoice is sent;
- use `paid_pending` only if payment is initiated but not cleared;
- keep wallet balance and cleared-cash claims at `$0`.
