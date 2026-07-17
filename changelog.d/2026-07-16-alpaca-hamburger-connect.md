# feat(trader): one-click "⚡ Connect Alpaca" in the trader ☰ menu

The stock-trader header/hamburger now carries a direct one-click Alpaca connect
button (ADR-0027). For entitled traders it starts the OAuth flow immediately
(`/api/broker/alpaca/connect?returnTo=/stock-trader.html` → sign in at Alpaca →
approve → bounced back to the trader with a confirmation). States:

- connected → green `⚡ Alpaca · <acct> (paper)`, click manages on orchestration#broker
- configured, not connected → `⚡ Connect Alpaca` is the OAuth start itself
- server not configured (missing `ALPACA_OAUTH_CLIENT_ID/_SECRET`) → points at the
  broker card, which explains the pending setup and offers IBKR

Guests never see it (same `body.guest` gate as the IBKR link). The OAuth return
param (`?alpaca=connected|error`) is announced once and scrubbed from the URL.
