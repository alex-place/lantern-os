- **IBKR auth switched to the hosted Web API + bearer key.** `lib/ibkr-cpapi.js`
  now talks to `https://api.ibkr.com/v1/api` with an OAuth bearer token
  (`IBKR_API_KEY`) + the `/tickle` session cookie, per the IBKR Web API docs —
  replacing the local Client Portal Gateway (browser-SSO session) that ADR-0019
  assumed. Endpoints are unchanged (identical hosted vs. gateway); set
  `IBKR_BASE_URL` to a `localhost:5000` gateway URL to use that instead. Corrects
  ADR-0020, `docs/IBKR-API-SETUP.md`, and `.env.example`.
