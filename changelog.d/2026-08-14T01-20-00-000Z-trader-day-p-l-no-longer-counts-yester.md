### Fixed

- trader: Day P&L no longer counts yesterday's gains twice — a lot carried in from an earlier day booked its full lifetime P&L to today, so the 2026-08-13 header read +$7,653.13 for a +$2,533.54 day. Realized is now attributed on the same basis the unrealized term already used (opened today counts whole, carried counts only from yesterday's close), shared by both call sites in `lib/day-pnl.js`
