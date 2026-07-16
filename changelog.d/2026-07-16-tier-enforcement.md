### Added

- **Server-side subscription-tier enforcement.** A new default-deny `premiumApiGuard` in `server.js` ties every premium feature to its Patreon tier server-side — Creator Suite, image/vision/document generation, and wide research require **Pro** ($20); Alpaca broker connect requires the trade entitlement; file upload/extract requires a signed-in account; and `/api/code/apply` (which writes arbitrary repo files and was reachable unauthenticated) requires **admin**. The paywall previously lived only in the UI, so the premium data plane was reachable by a guest — or an anonymous caller on the cloud deploy. (#2563)
- **$200 Pilot tier** (role `pilot`) and a **$5 Member tier** (`supporter`). The autonomous AI trader's real control endpoints (`scanner/start|stop`, `signals/generate`, `trades`) now require the `ai_trader` entitlement (Pilot+) — previously only the cosmetic `/trades` log-write was gated, so a $20 user could drive the $200 bot. Per-tier daily chat caps (Guest 10 / Free 50 / Member 100 / Pro 250 / Pilot ∞) are enforced server-side via new `chat-quota.js`. (#2563)

### Changed

- Tier display names unified to **Guest / Free / Member / Pro / Pilot** across pricing, the gate/upgrade pages, and profile labels (reconciling with the earlier Business rename in #2470). `admin` is non-purchasable — a Patreon pledge can never resolve to `admin` (capped to `pilot`); staff gates show "Staff access required" with no buy CTA. (#2563)

### Security

- `/api/dreamer/upload` now binds to the authenticated session id, not a caller-supplied `?user=` — which previously let one account stage a video into another user's notebook. (#2563)
