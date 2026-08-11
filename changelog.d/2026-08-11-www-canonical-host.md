### Fixed

- **auth: signing in from www.unisona.ai no longer fails at Google with
  "Error 400: redirect_uri_mismatch".** OAuth redirect URIs are minted from the
  request Host and only the apex callback is registered with Google, so the
  `www.` host produced an unregistered `https://www.unisona.ai/...` callback.
  The server now 308-redirects any `www.`-prefixed Host to the apex before
  routing, which also keeps sessions and cookies on a single origin.
  (`cloud.lantern-os.net` sign-in still requires its callback to be registered
  in the Google Console — operator action.)
