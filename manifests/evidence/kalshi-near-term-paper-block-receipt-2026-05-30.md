# Kalshi Near-Term Paper Block Receipt - 2026-05-30

Status: near-term paper block executed locally; live trading remains blocked.

## Window

| Field | Value |
|---|---:|
| Window minutes | 20 |
| Markets pulled | 5000 |
| Candidates within window | 8 |
| Paper orders opened | 8 |
| Paper risk allocated | $2.99 |
| Real money spent | $0.00 |

## Boundary

- No authenticated Kalshi request was made.
- No real order was submitted.
- Only markets with a future known/expiry time inside the next window were eligible.
- Orders are paper maker limits at public YES bid and may be unfilled in simulation.

## Paper Block

| Rank | Ticker | Title | Limit | Max Loss | Minutes | Known Time | Status |
|---:|---|---|---:|---:|---:|---|---|
| 1 | KXETH15M-26MAY300015-15 | ETH price up in next 15 mins? | 1c | $0.01 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |
| 2 | KXSOL15M-26MAY300015-15 | SOL price up in next 15 mins? | 46c | $0.46 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |
| 3 | KXNCAASBGAME-26MAY292130UCLAARK-UCLA | Will UCLA win the Arkansas vs UCLA softball game? | 99c | $0.99 | 16.61 | 2026-05-30T04:30:00.0000000Z | paper_open_unfilled |
| 4 | KXBTC15M-26MAY300015-15 | BTC price up in next 15 mins? | 1c | $0.01 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |
| 5 | KXDOGE15M-26MAY300015-15 | DOGE price up in next 15 mins? | 35c | $0.35 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |
| 6 | KXHYPE15M-26MAY300015-15 | HYPE price up in next 15 mins? | 8c | $0.08 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |
| 7 | KXXRP15M-26MAY300015-15 | XRP price up in next 15 mins? | 10c | $0.10 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |
| 8 | KXBNB15M-26MAY300015-15 | BNB price up in next 15 mins? | 99c | $0.99 | 1.61 | 2026-05-30T04:15:00.0000000Z | paper_open_unfilled |

## Files

| Artifact | Path |
|---|---|
| Near-term paper block JSON | data/kalshi/kalshi-near-term-paper-block-latest.json |