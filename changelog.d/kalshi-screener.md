### Added — Σ₀ Screener (the board, ranked by our edge not just volume)

`kalshi-screener.html` + `GET /api/trading/kalshi/screener` list every open Kalshi market and
rank them by **our grounded edge**, not price-change/volume like a data terminal. `lib/kalshi-
screener.js` attaches the edge badge (cached grounding + fees + Brier) to each market and sorts
fee-adjusted edge first, so the top of the board is where our web-grounded P(YES) disagrees with
the market past the fee hurdle. Ungrounded markets still list (price/volume) but claim no edge
and sink below. Filters: `sort=edge|volume|close`, `groundedOnly`, `minEdge`, search, category.
Verified live (pulled 300 open markets, 150-row table, no console errors); 6 unit tests. Linked
from the terminal nav.
