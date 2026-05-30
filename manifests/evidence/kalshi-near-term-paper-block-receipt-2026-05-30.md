# Kalshi Near-Term Paper Block Receipt - 2026-05-30

Status: near-term paper block executed locally; live trading remains blocked.

## Window

| Field | Value |
|---|---:|
| Window minutes | 20 |
| Markets pulled | 5000 |
| Candidates within window | 7 |
| Paper orders opened | 7 |
| Paper risk allocated | $2.94 |
| Real money spent | $0.00 |

## Boundary

- No authenticated Kalshi request was made.
- No real order was submitted.
- Only markets with a future known/expiry time inside the next window were eligible.
- Orders are paper maker limits at public YES bid and may be unfilled in simulation.

## Paper Block

| Rank | Ticker | Title | Limit | Max Loss | Minutes | Known Time | Status |
|---:|---|---|---:|---:|---:|---|---|
| 1 | KXSOL15M-26MAY301330-30 | SOL price up in next 15 mins? | 36c | $0.36 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |
| 2 | KXETH15M-26MAY301330-30 | ETH price up in next 15 mins? | 52c | $0.52 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |
| 3 | KXBTC15M-26MAY301330-30 | BTC price up in next 15 mins? | 63c | $0.63 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |
| 4 | KXXRP15M-26MAY301330-30 | XRP price up in next 15 mins? | 46c | $0.46 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |
| 5 | KXHYPE15M-26MAY301330-30 | HYPE price up in next 15 mins? | 60c | $0.60 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |
| 6 | KXDOGE15M-26MAY301330-30 | DOGE price up in next 15 mins? | 33c | $0.33 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |
| 7 | KXBNB15M-26MAY301330-30 | BNB price up in next 15 mins? | 4c | $0.04 | 10.86 | 2026-05-30T17:30:00.0000000Z | paper_open_unfilled |

## Files

| Artifact | Path |
|---|---|
| Near-term paper block JSON | data/kalshi/kalshi-near-term-paper-block-latest.json |