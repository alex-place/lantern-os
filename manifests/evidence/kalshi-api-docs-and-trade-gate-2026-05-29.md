# Kalshi API Docs And Trade Gate - 2026-05-29

Status: Lantern Reader evidence card for Kalshi public data, authentication,
and order lifecycle docs.

Scope: four user-pasted Kalshi documentation excerpts stored in Codex
attachments. This card records operational implications only; it does not store
private API keys, signatures, account data, or order credentials.

## Source Receipts

| Attachment | Signal |
|---|---|
| `3de0d78d-c02d-4a14-9368-75f5c762d4c1/pasted-text.txt` | Public market data endpoints can be used without authentication. |
| `e6fcc338-7e5e-4e4f-8f9a-a8d1c65357ff/pasted-text.txt` | Authenticated requests require API key id, timestamp, and RSA-PSS signature. |
| `32f6f40a-81ac-444b-b60d-89af58358822/pasted-text.txt` | Order lifecycle docs show find-market, create-order, status, and cancel flow. |
| `9dfa1a44-9b07-4909-a3b5-aa1004067374/pasted-text.txt` | Duplicate order-lifecycle excerpt; used as confirmation, not new authority. |

## Lantern Decision

Promote:

- unauthenticated public data loading;
- deeper pagination before ranking;
- orderbook/depth research as the next data layer;
- paper-trade tickets for human review;
- custom HFT/spread-capture simulation as a research lane.

Block:

- live authenticated orders from chat;
- storing private keys in Lantern RAG;
- trading without independent probability;
- trading without fee, slippage, queue-position, and max-loss models;
- automated HFT without human approval and explicit operator risk policy.

## Current Trade Gate

Lantern may create paper tickets after loading public data. It may not place
live orders in pre-v1.

Required before any real order:

1. Verified demo/live environment selected by the operator.
2. API keys stored outside repo and outside RAG.
3. Explicit market ticker, side, count, limit price, max loss, and environment.
4. Independent probability note.
5. Orderbook/depth and spread-capture analysis.
6. Human approval recorded immediately before submission.

## Reader Link

```text
http://127.0.0.1:4177/view?path=manifests/evidence/kalshi-api-docs-and-trade-gate-2026-05-29.md
```
