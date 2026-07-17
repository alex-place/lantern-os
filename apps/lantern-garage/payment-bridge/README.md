# Lantern Payment Bridge

Small Node service that converts wallet invoice drafts into Stripe invoices and
records payment events back into the local wallet ledger (`data/wallet/`).

Files:

- `index.js` — the bridge server (default port 3000; `PAYMENT_BRIDGE_PORT` / `STRIPE_*` env vars override config)
- `stripe-invoice-converter.js` — wallet-draft → Stripe invoice conversion
- `config.example.json` — configuration template
- `package.json`

## Setup

```bash
cd apps/lantern-garage/payment-bridge
npm install
cp config.example.json config.json   # then add your Stripe keys
npm start
curl http://localhost:3000/api/payment/health
```

Get Stripe credentials (manual): Dashboard → Developers → API keys (copy
`pk_test_…` and `sk_test_…` into `config.json`).

## Webhook

Stripe Dashboard → Developers → Webhooks → Add endpoint:

- Endpoint URL: `https://your-domain.com/api/payment/webhook` (local test: `http://localhost:3000/api/payment/webhook`)
- Events: `invoice.payment_succeeded`, `invoice.payment_failed`, `payment_intent.succeeded`, `payment_intent.payment_failed`
- Copy the signing secret (`whsec_…`) into `config.json`

## Endpoints

- `GET /api/payment/health` — service health
- `POST /create-invoice` — create a Stripe invoice from a wallet draft
- `GET /wallet-status` — current wallet state
- `POST /api/payment/webhook` — Stripe webhook receiver

## Security

- Never commit `config.json` (only `config.example.json` is tracked)
- Never share API keys; use test mode until fully operational
- Enable webhook signature verification in production
