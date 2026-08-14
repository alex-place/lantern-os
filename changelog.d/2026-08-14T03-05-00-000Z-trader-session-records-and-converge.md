### Added

- trader: a session record per trading day (`event:'session'` in the existing trade ledger) — closing equity, cash, the day's P&L on the same basis the panel showed, tier splits, exits by mechanism, slot high-water mark and the book carried overnight. Nothing had ever stored closing equity, which is why verifying a day meant reconstructing yesterday's from bar closes
- trader: convergence records for the stock autopilot — each entry emits a falsifiable claim (reaches target1 before its stop, confidence = the engine's own p_win) and each exit grades it, verified by the broker fill (`exec:<order_id>`). The store held 1,804 records with `verified:true` on none of them; these are the first with a receipt
