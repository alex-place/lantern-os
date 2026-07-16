### Fixed

- auth: a browser hitting `/accounts.html` without staff access now gets the styled gate page (or a sign-in redirect when signed out) instead of raw `{"error":"Staff access required."}` JSON in the tab (#2472). The `/api/accounts/*` endpoints keep their JSON contract.
