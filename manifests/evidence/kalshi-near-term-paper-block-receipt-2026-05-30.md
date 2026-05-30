# Kalshi Near-Term Paper Block Receipt - 2026-05-30

Status: near-term paper block executed locally; live trading remains blocked.

## Window

| Field | Value |
|---|---:|
| Window minutes | 20 |
| Markets pulled | 5000 |
| Candidates within window | 8 |
| Paper orders opened | 8 |
| Paper risk allocated | $3.69 |
| Real money spent | $0.00 |

## Boundary

- No authenticated Kalshi request was made.
- No real order was submitted.
- Only markets with a future known/expiry time inside the next window were eligible.
- Orders are paper maker limits at public YES bid and may be unfilled in simulation.

## Paper Block

| Rank | Ticker | Title | Limit | Max Loss | Minutes | Known Time | Status |
|---:|---|---|---:|---:|---:|---|---|
| 1 | KXETH15M-26MAY300030-30 | ETH price up in next 15 mins? | 44c | $0.44 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 2 | KXSOL15M-26MAY300030-30 | SOL price up in next 15 mins? | 44c | $0.44 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 3 | KXNCAASBGAME-26MAY292130UCLAARK-UCLA | Will UCLA win the Arkansas vs UCLA softball game? | 99c | $0.99 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 4 | KXBTC15M-26MAY300030-30 | BTC price up in next 15 mins? | 43c | $0.43 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 5 | KXDOGE15M-26MAY300030-30 | DOGE price up in next 15 mins? | 34c | $0.34 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 6 | KXHYPE15M-26MAY300030-30 | HYPE price up in next 15 mins? | 33c | $0.33 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 7 | KXXRP15M-26MAY300030-30 | XRP price up in next 15 mins? | 42c | $0.42 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 8 | KXBNB15M-26MAY300030-30 | BNB price up in next 15 mins? | 30c | $0.30 | 14.42 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |

## Files

| Artifact | Path |
|---|---|
| Near-term paper block JSON | data/kalshi/kalshi-near-term-paper-block-latest.json |