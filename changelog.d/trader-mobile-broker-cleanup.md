feat(trader,broker): mobile + read-only perspective for the stock trader, and a clear IBKR broker setup.

**Stock trader (`stock-trader.html`)** — responsive + read-only-viewer perspective (#2301):
- Viewport-tiered chart cap so small screens behave like "auto" (phone → 1, tablet → 2, ≤1440 → 4, larger → uncapped) instead of tiling charts into unreadable slivers; fixes the 22px chart collapse.
- Empty logged-in account (no equity, no positions) collapses the balance/positions/orders/history footer to just its tab strip and dims the duplicate header stats — on BOTH the mobile flex layout and the desktop/tablet grid (the grid footer-row is collapsed too) — reclaiming ~35% of the screen for charts. Re-expands automatically once there's equity or a position.
- Signal chip (▼ SHORT/▲ LONG) is a compact inline pill, not a loud full-width bar; BUY/SELL are small neutral ghost buttons (favored side gets only a faint tint) since the viewer is browsing signals, not actively trading.
- Click a chart to FOCUS it in the grid (darker-grey selected state + peripherals — details/order/watchlist — follow it); click the already-focused chart again to go fullscreen. Controls (buy/sell, change-symbol, drag) don't trigger it.

**Broker setup (`orchestration.html` #broker)** — added the missing Step 2 (register with IBKR) with the real IBKR OAuth URL and the 5 upload/register steps; de-jargoned Step 3 to 4 plain fields with hints; collapsed the auto-filled crypto keys (PEM/DH/realm) behind an advanced disclosure so it isn't a wall of crypto.

Verified across mobile/tablet/desktop/wide viewports in the preview.
