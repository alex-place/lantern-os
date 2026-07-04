Desktop Phase-0 G3/G4 wiring: the DPAPI key vault and the per-boot loopback token
are now live in the request path (#1946). G3 — `POST /api/providers/keys` persists
keys DPAPI-encrypted in the OS vault on desktop instead of plaintext Windows env;
`GET` reports a `vaulted` flag. G4 — the launcher mints `UNISONA_LOCAL_TOKEN`,
opens the browser at `?__lt=<token>`, `server.js` converts it to a `SameSite=Strict;
HttpOnly` cookie, and `request-auth.requestToken()` reads header → cookie → `?__lt=`
so EventSource (no headers) can still authenticate. Loopback alone is no longer
operator on the desktop; servers unchanged. Strengthens Act (local trust boundary).
