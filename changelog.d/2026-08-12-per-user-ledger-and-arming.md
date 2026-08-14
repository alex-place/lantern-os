### Changed

- trader: **every user's trades are now their own.** The autopilot drives every connected account, but the ledger was one undifferentiated book — a row recorded *what* was traded and never *for whom*, so a user's journal could only ever be answered with everyone's. Each row now carries the account it was traded for, and the record, scorecard, breakdown slices and skip log are all scoped to the requesting account. The Journal tab and the chat tools therefore show **your** trades; a user with no trades gets an honest empty state instead of somebody else's results. Rows written before this existed carry no account and are read as the house book, so nothing is dropped and nothing is misattributed.

### Added

- chat: **`trader_start`** — arm the autopilot from conversation by choosing which book runs (`intraday` or `champion`), alongside the existing `trader_pause`. Gated on the Pilot `ai_trader` capability, acts only on the caller's own account, and never touches the server-side real-money switches: the reply states plainly whether autonomous execution and live orders are actually armed, so selecting a book is never mistaken for real money being at stake. Stopping stays ungated — someone whose account is being traded must always be able to stop it.
- chat: `trader_journal` and `trader_skips` now cross the signed-in tier, because they finally read per-user data.
