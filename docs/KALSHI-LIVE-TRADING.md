# Kalshi Live Trading

Status: live execution implemented, disarmed by default
Owner: operator (Alex)
Script: `scripts/Invoke-KalshiLiveOrder.ps1`
Related: `skills/trade/SKILL.md`, `scripts/New-KalshiEventPaperOrder.ps1`

---

## Simple answer

This is the **real-money** Kalshi order path. It is built to be hard to fire by
accident: dry-run is the default, a kill switch blocks live orders, and risk caps
are enforced before any request is sent.

It is not financial advice and not a promise of profit. You accept full financial
risk when you arm and run it live.

---

## What it actually does

`Invoke-KalshiLiveOrder.ps1` builds and (only when explicitly armed) submits one
authenticated order to the Kalshi trade API v2 (`POST /portfolio/orders`), using
RSA-PSS request signing.

- Without `-Live`: prints the exact request it *would* send, runs every risk
  check, logs a `dry_run` ledger row, and exits. **Sends nothing.**
- With `-Live`: only after all gates pass, it does a balance preflight, submits a
  real order, writes a real-money receipt, and logs a `live` ledger row.

---

## Evidence / source discipline

- API auth scheme confirmed against Kalshi docs: three headers
  (`KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE`),
  signature = base64(RSA-PSS-SHA256(`timestamp + METHOD + path`)).
- Signing verified locally (self-verify true) and against the Kalshi **demo**
  endpoint, which parsed a signed request and rejected only the throwaway
  credentials — proving URL/path/headers/signature are wired correctly.

---

## Proven / held / local-only

- Proven: dry-run, per-order cap, daily-risk cap, daily-trade-count gate, kill
  switch, and request signing.
- Held: an actual filled live order has **not** been placed from here. That
  requires your real API key and you deleting the kill switch.
- Local-only: credentials live in environment variables, never in the repo.

---

## Next safe action

1. Create a Kalshi API key (Account & security → API Keys → Create Key). Save the
   Key ID and the downloaded private key.
2. Provide them to Devin as secrets (never paste into the repo):
   `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` (PEM text) or
   `KALSHI_PRIVATE_KEY_PATH`.
3. Dry-run first:
   ```powershell
   pwsh -File scripts/Invoke-KalshiLiveOrder.ps1 -Ticker <TICKER> -LimitCents 35
   ```
4. Validate against demo with real demo creds and `-Environment demo -Live`.
5. Only then, to trade real money: `rm data/kalshi/LIVE-KILL-SWITCH`, then run with
   `-Live -Environment prod`. Re-create that file (or set `KALSHI_KILL_SWITCH=1`)
   to disarm instantly.

---

## Validation path

- Lint: `pwsh -NoProfile -Command "Invoke-ScriptAnalyzer -Path scripts/Invoke-KalshiLiveOrder.ps1"`
  (0 warnings/errors).
- Safety tests: `python -m pytest tests/test_kalshi_live_order_safety.py -q`.

---

## Risk caps (defaults)

| Cap | Flag | Default |
|---|---|---|
| Capital at risk per order | `-MaxPerOrderUsd` | $40 |
| Capital at risk per day | `-MaxDailyLossUsd` | $40 |
| Live trades per day | `-MaxTradesPerDay` | 1 |
| Environment | `-Environment` | `demo` |

For a binary Kalshi contract, a buy's max loss equals its cost, so
`capital at risk = count * limitCents / 100`.

---

## Appendix: credentials

| Variable | Meaning |
|---|---|
| `KALSHI_API_KEY_ID` | API Key ID (UUID) from Kalshi |
| `KALSHI_PRIVATE_KEY` | RSA private key PEM text |
| `KALSHI_PRIVATE_KEY_PATH` | Path to the `.key`/`.pem` file (alternative to above) |
| `KALSHI_KILL_SWITCH` | Set to `1` to disarm live trading via env |
