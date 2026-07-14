### Changed

- The home page (`/` and `/index.html`) now redirects an unknown first-time visitor to `/auth.html` to make an entry choice — sign in (user) or "Continue without an account" (guest). Signed-in users, chosen guests (`ln_guest=1`), and the local operator/desktop pass straight through; other public pages stay openly reachable.
