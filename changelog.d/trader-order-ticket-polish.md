Polished the stock-trader order ticket: the header's **✕ close button is gone** —
the docked panel is now dismissed only via Esc or the phone bottom-sheet backdrop
tap (comments/#1694 flow updated) — and in its place the header carries a **live
quote readout** (last price + day % change, colored, same `chg_pct` the watchlist
shows). The ticket now **re-renders on the 3s price poll**, so its Buy/Sell prices,
trade value, and header quote tick live instead of freezing at open time; a guard
keeps the armed "Confirm …" two-step label and the "Placing…" state from being
clobbered by those re-renders. Also removed the hardcoded fake "Spread 0.00" row
(the feed has no bid/ask — showing a permanent 0.00 spread was noise), tidied the
exit labels ("Take profit, price" → "Take profit"), sentence-cased the risk-sizing
hints, and deduped a double `.ot-field:disabled` rule. Verified in a real browser
signed in as the test account: no ✕, live header quote ticking, armed confirm
survives polls, Esc closes / BUY reopens, zero console errors. (Improves Act —
truthful, live order surface.)
